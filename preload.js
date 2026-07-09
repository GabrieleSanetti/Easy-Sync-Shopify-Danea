const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
  processFiles: (daneaPath, shopifyPath) => ipcRenderer.invoke('process-files', daneaPath, shopifyPath),
  generateProducts: (daneaPath) => ipcRenderer.invoke('generate-products', daneaPath),
  readHeaders: (filePath, type) => ipcRenderer.invoke('read-headers', filePath, type),
  saveSettings: (settingsData) => ipcRenderer.invoke('save-settings', settingsData),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  copyTemplate: (filePath, templateType) => ipcRenderer.invoke('copy-template', filePath, templateType),
  importSettings: () => ipcRenderer.invoke('import-settings'),
  exportSettings: () => ipcRenderer.invoke('export-settings'),
  calculatePrices: (data) => ipcRenderer.invoke('calculate-prices', data),
  evalFormula: (formula) => ipcRenderer.invoke('eval-formula', formula)
});
