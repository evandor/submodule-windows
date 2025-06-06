import Command from 'src/core/domain/Command'
import { ExecutionResult } from 'src/core/domain/ExecutionResult'
import { useWindowsStore } from 'src/windows/stores/windowsStore'

export class RenameWindowCommand implements Command<string> {
  constructor(
    public windowId: number,
    public holderId: number | undefined,
    public newName: string,
    public index: number,
  ) {}

  async execute(): Promise<ExecutionResult<string>> {
    console.log('setWindowName', this.windowId, this.newName)
    if (this.newName && this.newName.toString().trim().length > 0) {
      const existingWindowNames: Set<String> = useWindowsStore().windowSet
      if (existingWindowNames.has(this.newName)) {
        return Promise.reject('window name already exists')
      }

      const cw = await chrome.windows
        .get(this.windowId, { populate: true })
        .catch((err) => console.info('no window for this.windowId'))
      //console.log('cw', cw)

      return useWindowsStore()
        .upsertWindow(cw, this.holderId, this.newName.toString().trim(), this.index)
        .then((res) => {
          //sendMsg('tabset-renamed', {tabsetId: this.tabsetId, newName: this.newName, newColor: this.newColor})
          return this.newName.toString().trim()
        })
        .then((newName: any) => Promise.resolve(new ExecutionResult(newName, 'Window Name Updated')))
        .catch((err) => Promise.reject(err))
    }
    return Promise.reject('name was not valid')
  }
}

RenameWindowCommand.prototype.toString = function cmdToString() {
  return `RenameWindowCommand: {windowId=${this.windowId}, holderId=${this.holderId}, newName: ${this.newName}, index: ${this.index}`
}
