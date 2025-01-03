import _ from 'lodash'
import { defineStore } from 'pinia'
import { FeatureIdent } from 'src/app/models/FeatureIdent'
import { useUtils } from 'src/core/services/Utils'
import { useFeaturesStore } from 'src/features/stores/featuresStore'
import { Window } from 'src/windows/models/Window'
import { WindowAction, WindowHolder } from 'src/windows/models/WindowHolder'
import IndexedDbWindowsPersistence from 'src/windows/persistence/IndexedDbWindowsPersistence'
import throttledQueue from 'throttled-queue'
import { computed, ref } from 'vue'

/**
 * a pinia store for "Windows".
 *
 * Elements are persisted to the storage provided in the initialize function
 */

let storage = IndexedDbWindowsPersistence

function closeTabWithTimeout(timeout: number, tabToCloseId: number | undefined = undefined): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (tabToCloseId) {
        chrome.tabs.remove(tabToCloseId).catch((err) => console.debug(err))
      }
      resolve('Success!')
    }, timeout)
  })
}

export const useWindowsStore = defineStore('windows', () => {
  const { inBexMode, sendMsg, calcHostList } = useUtils()

  const onCreatedListener = () => setup('onCreated')
  const onRemovedListener = (windowId: number) => onRemoved(windowId)
  const onBoundsChangedListener = (window: chrome.windows.Window) => onUpdate(window.id || 0)
  const onFocusChangedListener = (windowId: number) => {
    /** noop */
  }

  /**
   * the map of all 'ever used' Chrome windows, even if they are not currently in use,
   * using the id as key.
   *
   * Initialized at start with all windows from "windows" storage, on "onCreated" event and on
   * "onRemoved" event (where a window without title is removed again, including storage)
   */
  const allWindows = ref<Map<number, Window>>(new Map())

  /**
   * the array all actually currently opened Chrome windows.
   *
   * Initialized at start (from chrome.windows.getAll) and on "onCreated" and "onRemoved" events.
   */
  const currentChromeWindows = ref<chrome.windows.Window[]>([])

  /**
   * the result of 'chrome.windows.getCurrent'
   *
   * Initialized at start and on "onCreated" and "onRemoved" events.
   */
  const currentChromeWindow = ref<chrome.windows.Window>(null as unknown as chrome.windows.Window) //null as unknown as chrome.windows.Window

  /**
   * updated from 'allWindows' data when currentWindows is set.
   */
  const currentWindowName = ref<string | undefined>(undefined)

  /**
   * Set of all names for windows from all tabsets, initialized when
   * tabsets are added during startup (tabsStore#addTabset)
   */
  const windowSet = ref<Set<string>>(new Set())

  const getWindowsForMarkupTable = computed(() => (fnc: (name: string) => WindowAction[] = (a: string) => []) => {
    const result: WindowHolder[] = _.map(
      currentChromeWindows.value as chrome.windows.Window[],
      (cw: chrome.windows.Window) => {
        const windowFromStore: Window | undefined = useWindowsStore().windowForId(cw.id || -2)
        const windowName = useWindowsStore().windowNameFor(cw.id || 0) || cw.id!.toString()

        if (windowFromStore) {
          windowFromStore.title = windowName
          return WindowHolder.of(windowFromStore, cw, cw.id || -3, fnc(windowName))
        } else {
          return WindowHolder.of(null as unknown as Window, cw, cw.id || -3, fnc(windowName))
        }
      },
    )

    const otherWindows = _.map(
      _.filter([...allWindows.value.values()], (w: Window) => {
        return result.findIndex((wh: WindowHolder) => w.id === wh.holderId) < 0 && w.hostList.length > 0
      }),
      (w: Window) => {
        const windowFromStore: Window | undefined = useWindowsStore().windowForId(w.id || -2)
        const windowName = useWindowsStore().windowNameFor(w.id || 0) || w.id.toString()
        if (windowFromStore) {
          windowFromStore.title = windowName
          return WindowHolder.of(windowFromStore, undefined, windowFromStore ? windowFromStore.id : -4, fnc(windowName))
        } else {
          return WindowHolder.of(null as unknown as Window, undefined, -5, fnc(windowName))
        }
      },
    )

    return _.sortBy(result.concat(otherWindows), 'index')
  })

  /**
   * initialize store
   */
  async function initialize() {
    storage = IndexedDbWindowsPersistence
    console.debug(` ...initializing windowsStore (${storage.getServiceName()})`)
    await storage.init()
    // TODO remove after version 0.5.0
    await storage.migrate()
    await setup('initialization')
  }

  async function setup(trigger: string = '', keepWindowsFromStorage = false) {
    if (!useFeaturesStore().hasFeature(FeatureIdent.WINDOWS_MANAGEMENT) || !inBexMode()) {
      return
    }
    console.debug(` init chrome windows listeners with trigger ${trigger}`)

    const browserWindows: chrome.windows.Window[] = await chrome.windows.getAll({ populate: true })
    currentChromeWindows.value = browserWindows
    console.debug(` initializing current chrome windows with ${currentChromeWindows.value?.length} window(s)`)

    if (!keepWindowsFromStorage) {
      // adding potentially new windows to storage
      for (const browserWindow of browserWindows) {
        const hostList = calcHostList(browserWindow.tabs || [])
        const newWindow = new Window(browserWindow.id || 0, browserWindow, undefined, 0, false, hostList)
        await storage.addWindow(newWindow)
      }
    }

    // setting all (new and older) windows to 'allWindows':
    //await Promise.all(res)
    allWindows.value = new Map()
    let index = 0

    const storedWindows: Window[] = await storage.getWindows()

    const sortedStoredWindows = _.sortBy(storedWindows, 'index')
    //sortedStoredWindows.forEach(tabsetWindowFromStorage => {
    for (const tabsetWindowFromStorage of sortedStoredWindows) {
      // index handling
      const indexFromDb = tabsetWindowFromStorage.index
      const indicesDiffer = indexFromDb !== index
      const indexToUse = index++

      if (indicesDiffer) {
        try {
          await updateWindowIndex(tabsetWindowFromStorage.id, indexToUse)
        } catch (err) {
          //.then(() => console.log("done with updating window", tabsetWindowFromStorage.id, indexToUse))
          console.error('error when updating window', tabsetWindowFromStorage.id, indexToUse, err)
        }
        tabsetWindowFromStorage.index = indexToUse
        allWindows.value.set(tabsetWindowFromStorage.id || 0, tabsetWindowFromStorage)

        // const inCurrentWindows = browserWindows.find(w => w.id === tabsetWindowFromStorage.id) !== undefined
        // console.debug(`assigned window #${tabsetWindowFromStorage.id} (name: ${tabsetWindowFromStorage.title}): ${indexFromDb} -> ${tabsetWindowFromStorage.index}, open: ${inCurrentWindows}`)
      } else {
        allWindows.value.set(tabsetWindowFromStorage.id || 0, tabsetWindowFromStorage)
      }
      //console.log("allwindows set to ", allWindows.value)
    }
    for (const id of allWindows.value.keys()) {
      const w = allWindows.value.get(id)
      if (w && w.title) {
        windowSet.value.add(w.title)
      }
    }
    //console.log("%callWindows assigned", "color:green", allWindows.value, windowSet.value)

    chrome.windows.getCurrent({ windowTypes: ['normal'], populate: true }, (window: chrome.windows.Window) => {
      currentChromeWindow.value = window
      if (currentChromeWindow.value && currentChromeWindow.value.id) {
        currentWindowName.value = windowNameFor(currentChromeWindow.value.id)
      }
    })

    // add context menus for moving to other window
    if (chrome && chrome.contextMenus) {
      //chrome.windows.getCurrent().then(currentWindow => {
    }
  }

  async function onRemoved(windowId: number) {
    // remove only if window does not have a title
    const w = await storage.getWindow(windowId)
    //console.debug("on removed", w, windowId)
    if (w && !w.title) {
      await removeWindow(windowId)
    }
    setup('onRemove')
  }

  /**
   * we've only listening onBoundsChanged (of active windows),
   * so title and index should not change!
   * @param windowId
   */
  async function onUpdate(windowId: number) {
    if (windowId >= 0) {
      const windowFromDb: Window | undefined = windowForId(windowId)
      if (windowFromDb) {
        console.debug(`updating window #${windowId}: title='${windowFromDb?.title}', index=${windowFromDb?.index}`)
        const chromeWindow = await chrome.windows.get(windowId, { populate: true })
        const hostList = calcHostList(chromeWindow.tabs || [])
        const newWindow = new Window(
          windowId,
          chromeWindow,
          windowFromDb.title,
          windowFromDb.index,
          windowFromDb.open,
          hostList,
        )
        console.log('updated to ', newWindow.toString())
        await storage.updateWindow(newWindow)
        refreshCurrentWindows()
      } else {
        console.log(`could not update window #${windowId}`)
      }
    }
  }

  function initListeners() {
    if (inBexMode()) {
      console.debug(' ...initializing windowsStore Listeners')
      chrome.windows.onCreated.addListener(onCreatedListener)
      chrome.windows.onRemoved.addListener(onRemovedListener)
      chrome.windows.onFocusChanged.addListener(onFocusChangedListener)
      if (chrome.windows.onBoundsChanged) {
        // not defined on firefox
        chrome.windows.onBoundsChanged.addListener(onBoundsChangedListener)
      }
    }
  }

  function resetListeners() {
    chrome.windows.onCreated.removeListener(onCreatedListener)
    chrome.windows.onRemoved.removeListener(onRemovedListener)
    chrome.windows.onFocusChanged.removeListener(onFocusChangedListener)
    if (chrome.windows.onBoundsChanged) {
      // not defined on firefox
      chrome.windows.onBoundsChanged.removeListener(onBoundsChangedListener)
    }
  }

  function windowForId(id: number): Window | undefined {
    return allWindows.value.get(id)
  }

  function windowNameFor(id: number) {
    //console.log("windowNameFor", id, allWindows.value)
    return allWindows.value.get(id)?.title
  }

  function windowIdFor(name: string): number | undefined {
    return _.find([...allWindows.value.keys()], (key: number) => {
      const val = allWindows.value.get(key)
      return val?.title === name
    })
  }

  async function currentWindowFor(windowToOpen: string): Promise<chrome.windows.Window | undefined> {
    if (windowToOpen === 'current' && chrome && chrome.windows) {
      return await chrome.windows.getCurrent()
    } else if (windowIdFor(windowToOpen)) {
      const potentialWindowId = windowIdFor(windowToOpen)
      // console.log("windowFor2", potentialWindowId)
      if (potentialWindowId) {
        try {
          return await chrome.windows.get(potentialWindowId, { populate: true })
        } catch (err) {
          return Promise.resolve(undefined)
        }
      }
    }
    return Promise.resolve(undefined)
  }

  async function windowFor(title: string): Promise<Window | undefined> {
    if (!storage) {
      return undefined
    }
    const windowsFromDb = await storage.getWindows()
    for (const w of windowsFromDb) {
      if (w['title' as keyof object] === title) {
        return w
      }
    }
    return undefined
  }

  function addToWindowSet(windowName: string) {
    if (windowName !== 'current') {
      windowSet.value.add(windowName)
    }
  }

  async function upsertWindow(
    window: chrome.windows.Window | void,
    holderId: number | undefined,
    title: string | undefined,
    index: number = 0,
  ) {
    if (window) {
      const hostList = calcHostList(window.tabs || [])
      console.log(
        `upserting window: id=${window.id}, title=${title}, index=${index}, open=default(false), #hostList=${hostList.length}`,
      )
      const tabsetsWindow = new Window(window.id || 0, window, title, index, false, hostList)
      if (window.id) {
        allWindows.value.set(window.id, tabsetsWindow)
      }
      await storage.upsertWindow(tabsetsWindow)
    } else {
      const windowFromStorage: Window | undefined = _.find(
        [...useWindowsStore().allWindows.values()],
        (w: Window) => w.id === holderId,
      )
      if (windowFromStorage) {
        windowFromStorage.title = title
        await storage.upsertWindow(windowFromStorage)
      }
    }
    sendMsg('window-updated', { initiated: 'WindowsStore#upsertWindow' })
  }

  async function upsertTabsetWindow(window: Window) {
    console.debug(
      `upserting window: id=${window.id}, title=${window.title}, index=${window.index}, open=${window.open}, #hostList=${window.hostList.length}`,
    )
    await storage.upsertWindow(window)
  }

  async function removeWindow(windowId: number) {
    await storage
      .removeWindow(windowId)
      .catch((err: any) => console.warn('could not delete window ' + windowId + ' due to: ' + err))
  }

  async function removeWindowByTitle(title: string) {
    storage.getWindows().then((windows: Window[]) => {
      windows.forEach((w) => {
        if (w.title === title) {
          storage
            .removeWindow(w.id)
            .catch((err: any) => console.debug('could not delete window ' + w.id + ' due to: ' + err))
        }
      })
    })
  }

  function openThrottledInWindow(
    urls: string[],
    windowCreateData: object = { focused: true, width: 1024, height: 800 },
  ) {
    console.log('%copenThrottledInWindow...', 'color:green')
    const throttleOnePerXSeconds = throttledQueue(1, 1000, true)
    chrome.windows.create(windowCreateData, (window: any) => {
      //console.log("%cgot window", "color:green", window.id)
      useWindowsStore().removeWindowByTitle('%monitoring%')
      useWindowsStore().upsertWindow(window, window.id, '%monitoring%')

      const promises: Promise<any>[] = []
      for (const u of urls) {
        if (u.indexOf('${') >= 0) {
          console.debug('not monitoring url due to placeholder(s)', u)
          break
        }
        const p = throttleOnePerXSeconds(async () => {
          const createProperties = { windowId: window.id, url: u }
          //console.log("createProperties", createProperties)
          chrome.tabs.create(createProperties, (tab: chrome.tabs.Tab) => {
            closeTabWithTimeout(2000, tab.id)
          })
          return closeTabWithTimeout(1000)
        })
        promises.push(p)
      }

      Promise.all(promises).then(() => {
        setTimeout(() => {
          //console.log("setting timeout")
          chrome.windows.remove(window.id)
        }, 2000)
      })
    })
  }

  async function refreshCurrentWindows() {
    console.debug('refreshCurrentWindows')
    currentChromeWindows.value = await chrome.windows.getAll({ populate: true })
  }

  async function updateWindowIndex(windowId: number, indexToUse: number) {
    //console.log("updating window index", windowId, indexToUse)
    return storage.getWindow(windowId).then((w: Window | undefined) => {
      if (w) {
        w.index = indexToUse
        const allWindow = allWindows.value.get(windowId)
        if (allWindow) {
          allWindow.index = indexToUse
        }
        return storage.updateWindow(w)
        //.then(() => sendMsg('window-updated', {initiated: "WindowsStore#updateWindowIndex"}))
      } else {
        return Promise.reject('window for #' + windowId + ' not found')
      }
    })
  }

  async function refreshTabsetWindow(windowId: number) {
    try {
      //console.log("refreshing tabset window", windowId)
      const tabsetWindow = await storage.getWindow(windowId)
      const chromeWindow = await chrome.windows.get(windowId, { populate: true })
      if (tabsetWindow && chromeWindow) {
        tabsetWindow.hostList = calcHostList(chromeWindow.tabs || [])
        await storage.updateWindow(tabsetWindow)
      }
    } catch (err) {
      console.log('got error', err)
    }
  }

  return {
    getWindowsForMarkupTable,
    initialize,
    initListeners,
    resetListeners,
    setup,
    currentChromeWindows,
    currentChromeWindow,
    currentWindowName,
    windowNameFor,
    windowSet,
    upsertWindow,
    removeWindow,
    removeWindowByTitle,
    refreshCurrentWindows,
    windowFor,
    currentWindowFor,
    windowForId,
    allWindows,
    addToWindowSet,
    upsertTabsetWindow,
    refreshTabsetWindow,
    openThrottledInWindow,
  }
})
