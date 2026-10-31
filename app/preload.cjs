'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const methods=['getState','importText','importFile','selectBook','saveProgress','translate','getAlignment','preparePassage','setTranslation','saveSettings','testConnection','exportBackup','importBackup','openDataFolder'];
const api={};
for(const method of methods){api[method]=async payload=>{const result=await ipcRenderer.invoke('novel:'+method,payload);if(!result.ok)throw new Error(result.error);return result.value;};}
api.onBeforeClose=handler=>{ipcRenderer.on('novel:before-close',async()=>{try{await handler();ipcRenderer.send('novel:close-ready',true);}catch{ipcRenderer.send('novel:close-ready',false);}});};
contextBridge.exposeInMainWorld('novel',Object.freeze(api));
