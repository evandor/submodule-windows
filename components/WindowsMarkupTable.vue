<template>
  <div class="col-12 text-right">
    <Transition name="bounceInLeft" appear>
      <q-markup-table class="q-ma-none" dense flat>
        <thead>
          <tr>
            <!--                    <th></th>-->
            <th class="text-left">Window Name</th>
            <th class="text-right">#Tabs</th>
            <th class="text-right q-pr-none" v-if="windowsToOpenOptions.length > 0">
              <span class="cursor-pointer"><q-icon name="open_in_new" class="q-mr-xs" />Open Window </span>
              <q-menu :offset="[0, 7]" fit>
                <q-list dense style="min-width: 250px">
                  <q-item clickable v-close-popup>
                    <q-item-section @click="openNewWindow({ label: ' > open new Window', value: 'newWindow' })"
                      >Open new Window
                    </q-item-section>
                  </q-item>
                  <q-separator v-if="windowsToOpenOptions.length > 0" />
                  <q-item clickable v-close-popup v-for="w in windowsToOpenOptions">
                    <q-item-section @click="openNewWindow(w)">{{ w['label' as keyof object] }}</q-item-section>
                  </q-item>
                </q-list>
              </q-menu>
            </th>
            <th class="text-right q-pr-none" v-else>
              <span class="cursor-pointer" @click="openNewWindow({ label: ' > open new Window', value: 'newWindow' })"
                ><q-icon name="open_in_new" class="q-mr-xs" />Open Window
              </span>
            </th>
          </tr>
        </thead>

        <vue-draggable-next
          class="q-ma-none"
          tag="tbody"
          :list="props.rows"
          :group="{ name: 'tabs', pull: 'clone' }"
          @change="(event: any) => handleDragAndDrop(event)">
          <tr
            v-for="row in props.rows"
            :key="row.index"
            @mouseover="hoveredWindow = row.holderId"
            @mouseleave="hoveredWindow = undefined"
            style="max-height: 15px">
            <!--                        <td>{{ row.getIndex() }}</td>-->
            <!--            <td>{{ row['state' as keyof object] }}</td>-->
            <td
              class="text-left"
              :class="windowNameRowClass(row)"
              @dblclick.stop="openRenameWindowDialog(row.holderId, row.getName(), row.getIndex())"
              @click.prevent.stop="openWindow(row)">
              <q-icon v-if="props.rows.length > 1" name="drag_indicator" class="q-mr-sm" style="cursor: move">
                <q-tooltip class="tooltip-small" v-if="devMode">{{ row.getIndex() }}</q-tooltip>
              </q-icon>
              <span class="cursor-pointer" :data-testid="'windowDataColumn_name_' + row.holderId">
                {{ row.getName() }}
                <q-tooltip class="tooltip-small" v-if="devMode">{{ row.holderId }}</q-tooltip>
              </span>
            </td>
            <td :data-testid="'windowDataColumn_tabsCount_' + row.holderId">
              {{ row.getTabsCount() }}
            </td>
            <td>
              <template v-if="hoveredWindow === row.holderId">
                <q-icon
                  v-if="'minimized' !== row['state' as keyof object]"
                  name="visibility_off"
                  :color="row.cw ? 'warning' : 'grey'"
                  class="q-ml-sm"
                  :class="row.cw ? 'cursor-pointer' : ''"
                  @click="row.cw ? minimizeWindow(row.holderId) : ''">
                  <q-tooltip :delay="500" class="tooltip-small">Hide Window{{ hoveredWindow }}/{{ row.cw }}</q-tooltip>
                </q-icon>

                <q-icon
                  name="edit"
                  class="q-ml-sm text-accent cursor-pointer"
                  @click="openRenameWindowDialog(row.holderId, row.getName(), row.getIndex())">
                  <q-tooltip :delay="500" class="tooltip-small">Edit Window Name</q-tooltip>
                </q-icon>

                <template v-for="item in row.additionalActions" :key="item.icon">
                  <q-icon
                    @click.stop="emits('wasClicked', { action: item.action, window: row })"
                    :name="item.icon"
                    :disable="item.disabled"
                    size="xs"
                    class="q-ml-sm"
                    :class="item.disabled ? item.color : item.color + ' cursor-pointer'">
                    <q-tooltip v-if="item.tooltip" :delay="500" class="tooltip-small"
                      >{{ item.tooltip }}/{{ item.disabled }}
                    </q-tooltip>
                  </q-icon>
                </template>

                <q-icon
                  v-if="useWindowsStore().currentChromeWindows.length === 1 && row.cw"
                  name="o_close"
                  class="q-ml-sm text-red-8"
                  :disabled="true">
                  <q-tooltip :delay="500" class="tooltip-small">Last Window cannot be closed</q-tooltip>
                </q-icon>
                <q-icon v-else name="o_close" class="q-ml-sm text-red-8 cursor-pointer" @click="closeWindow(row)">
                  <q-tooltip :delay="500" class="tooltip-small">Close this window</q-tooltip>
                </q-icon>
              </template>
              <template v-else>
                <div>&nbsp;</div>
              </template>
            </td>
          </tr>
        </vue-draggable-next>
      </q-markup-table>
    </Transition>
  </div>
</template>

<script lang="ts" setup>
import _ from 'lodash'
import { uid, useQuasar } from 'quasar'
import AppEventDispatcher from 'src/app/AppEventDispatcher'
import BrowserApi from 'src/app/BrowserApi'
import ChromeApi from 'src/app/BrowserApi'
import { FeatureIdent } from 'src/app/models/FeatureIdent'
import { useNotificationHandler } from 'src/core/services/ErrorHandler'
import { useEntityRegistryStore } from 'src/core/stores/entityRegistryStore'
import { useFeaturesStore } from 'src/features/stores/featuresStore'
import { Tab } from 'src/tabsets/models/Tab'
import { Tabset } from 'src/tabsets/models/Tabset'
import RenameWindowDialog from 'src/windows/dialogues/RenameWindowDialog.vue'
import { Window } from 'src/windows/models/Window'
import { WindowHolder } from 'src/windows/models/WindowHolder'
import { useWindowsStore } from 'src/windows/stores/windowsStore'
import { onMounted, PropType, ref, watch, watchEffect } from 'vue'
import { VueDraggableNext } from 'vue-draggable-next'

const { handleError } = useNotificationHandler()

const props = defineProps({
  rows: { type: Object as PropType<WindowHolder[]>, required: true },
})

const emits = defineEmits(['wasClicked', 'recalculateWindows'])

const $q = useQuasar()

const windowRows = ref<object[]>([])
const currentWindowName = ref('---')

const windowsToOpen = ref<string>('')
const windowsToOpenOptions = ref<object[]>([])
const tabsetsMangedWindows = ref<object[]>([])
const hoveredWindow = ref<number | undefined>(undefined)
const devMode = ref<boolean>(useFeaturesStore().hasFeature(FeatureIdent.DEV_MODE))

onMounted(() => {
  windowRows.value = calcWindowRows()
})

watch(
  () => useWindowsStore().currentChromeWindows,
  (newWindows, oldWindows) => {
    //console.log("windows changed", newWindows, oldWindows)
    windowRows.value = calcWindowRows()
  },
)

chrome.tabs.onRemoved.addListener((tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => {
  //console.log("***here we are", tabId, removeInfo)
  useWindowsStore()
    .setup('on removed listener in WindowsMarkupTable')
    .then(() => (windowRows.value = calcWindowRows()))
    .catch((err) => handleError(err))
})

chrome.tabs.onCreated.addListener((tab: chrome.tabs.Tab) => {})

watchEffect(() => {
  // adding potentially new windows from 'open in window' logic
  windowsToOpenOptions.value = []
  tabsetsMangedWindows.value = []
  const registry = useEntityRegistryStore()
  for (const ts of registry.tabsetRegistry) {
    if (ts.window && ts.window !== 'current' && ts.window.trim() !== '') {
      tabsetsMangedWindows.value.push({ label: ts.window, value: ts.id })
      const found = _.find(windowRows.value, (r: object) => ts.window === r['name' as keyof object])
      if (!found) {
        windowsToOpenOptions.value.push({ label: ts.window, value: ts.id })
      }
    }
  }
  windowsToOpenOptions.value = _.sortBy(windowsToOpenOptions.value, ['label'])
})

watchEffect(() => {
  const res =
    useWindowsStore().currentChromeWindow && useWindowsStore().currentChromeWindow.id
      ? useWindowsStore().windowNameFor(useWindowsStore().currentChromeWindow.id || 0) || 'n/a'
      : 'n/a'
  currentWindowName.value = res
})

const openNewWindow = (w: object) => {
  console.log('windows to open set to ', w)
  const label = w['label' as keyof object] as string
  const tsId = w['value' as keyof object] as string
  if (tsId === 'newWindow') {
    chrome.windows.create()
    windowsToOpen.value = ''
  } else if (label && label.trim() !== '') {
    //sendMsg('restore-tabset', {tabsetId: tsId, label: label})
    //useCommandExecutor().execute(new RestoreTabsetCommand(tsId, label, true))
    AppEventDispatcher.dispatchEvent('restore-tabset', {
      tabsetId: tsId,
      label: label,
    })
    windowsToOpen.value = ''
  }
}

const openWindow = (window: WindowHolder) => {
  console.log('window', window)
  if (useWindowsStore().currentChromeWindow?.id !== window.holderId) {
    if (window.holderId && window.holderId >= 0) {
      chrome.windows.update(window.holderId, { drawAttention: true, focused: true }, (callback) => {
        console.warn('could not open window for', window)
      })
    } else {
      const dummyTabs = _.map(window.hostList, (url: string) => {
        return new Tab(uid(), BrowserApi.createChromeTabObject('', url))
      })
      const dummyTabset = new Tabset(uid(), 'dummy', dummyTabs)
      ChromeApi.restore(dummyTabset, undefined, true)
      //NavigationService.openOrCreateTab(window.hostList, undefined, [], false, false)
    }
  }
}

const minimizeWindow = (windowId: number) => {
  console.log('hier')
  chrome.windows.update(windowId, { state: 'minimized' })
  useWindowsStore().refreshCurrentWindows()
}

const closeWindow = (windowHolder: WindowHolder) => {
  console.log('closing', windowHolder)
  if (windowHolder.cw && windowHolder.cw.id) {
    chrome.windows.remove(windowHolder.cw.id)
    useWindowsStore().refreshCurrentWindows()
  } else if (!windowHolder.cw) {
    useWindowsStore().removeWindow(windowHolder.holderId)
    // useWindowsStore().refreshCurrentWindows()
    // rows.value = calcWindowRows()
    emits('recalculateWindows')
  }
}

const calcWindowRows = () => {
  //console.log("calculating window Rows")
  const result = _.map(
    useWindowsStore().currentChromeWindows as chrome.windows.Window[],
    (cw: chrome.windows.Window) => {
      const windowFromStore: Window | undefined = useWindowsStore().windowForId(cw.id || -2)

      // console.debug(`setting window ${cw.id} ['${windowFromStore?.title}'] (#${cw.tabs?.length} tabs, #${windowFromStore?.hostList.size} hosts) -> #${windowFromStore?.index}`)

      return {
        id: cw.id,
        index: windowFromStore?.index || 0,
        tabsCount: cw.tabs?.length || 0,
        name: useWindowsStore().windowNameFor(cw.id || 0) || cw.id!.toString(),
        windowHeight: cw['height' as keyof object],
        windowWidth: cw['width' as keyof object],
        focused: cw.focused,
        alwaysOnTop: cw.alwaysOnTop,
        incognito: cw.incognito,
        sessionId: cw.sessionId,
        state: cw.state,
        type: cw.type,
        windowIcon: '*',
        hostList: windowFromStore?.hostList,
      }
    },
  )

  return _.sortBy(result, 'index')
}

const handleDragAndDrop = async (event: any) => {
  const { moved } = event

  if (moved) {
    console.log(`moved event: '${moved.element.id}' ${moved.oldIndex} -> ${moved.newIndex}`, props.rows, event)
    // //useWindowsStore().moveWindow(rows.value, moved.element.id, moved.oldIndex, moved.newIndex)
    // const windowIndex = moved.element.id
    // //console.log("moving window", windowIndex)
    // //const theWindows = getSortedWindows(windowForId);
    //
    // //console.log("*** theWindows", theWindows)
    // const oldIndex = moved.oldIndex
    // const newIndex = moved.newIndex
    //
    // //console.log("moving", windowIndex, oldIndex, newIndex)
    // if (oldIndex >= 0 && rows.value.length > 0) {
    //   console.log("old rows", _.map(rows.value, r => r['id' as keyof object] + "("+r['name' as keyof object]+"):" + r['index' as keyof object]))
    //   const newOrder = _.map(rows.value, r => r['id' as keyof object] as number)
    //   const startIndex = rows.value[0]['index' as keyof object]
    //   let index = 0//
    //   console.log("newOrder", newOrder, startIndex)
    //   for (const r of newOrder) {
    //     await useWindowsStore().updateWindowIndex(r, index++)
    //   }
    // }
    // rows.value = calcWindowRows()
    // sendMsg('window-updated', {initiated: "SidePanelWindowMarkupTable#handleDragAndDrop"})

    //useWindowsStore().refreshCurrentWindows()
  } else {
    console.log('unhandled event!', event)
  }
}

const openRenameWindowDialog = (windowId: number, currentName: string, index: number) => {
  $q.dialog({
    component: RenameWindowDialog,
    componentProps: { windowId, holderId: windowId, currentName, index },
  }).onOk((name: string) => {
    emits('recalculateWindows')
  })
}

const windowNameRowClass = (row: WindowHolder) => {
  if (!row.cw) {
    return 'text-grey-8'
  }
  if (useWindowsStore().currentChromeWindow?.id === row.holderId) {
    return row['focused' as keyof object] ? 'text-bold text-italic' : 'text-bold'
  }
  if (row['focused' as keyof object]) {
    return 'text-italic'
  }
  return ''
}
</script>

<style scoped>
.q-table th,
.q-table td {
  padding-top: 0;
  padding-bottom: 0;
}
</style>
