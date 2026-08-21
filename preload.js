'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshApp', {
  onStatus(cb) {
    const listener = (_event, status) => cb(status)
    ipcRenderer.on('app-status', listener)
    return () => ipcRenderer.removeListener('app-status', listener)
  },
  openLogDir() {
    return ipcRenderer.invoke('open-log-dir')
  },
})
