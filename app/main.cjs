'use strict';
const {app,BrowserWindow,ipcMain,dialog,safeStorage,shell,session,net}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const {Library}=require('./library.cjs');
const {translateText,testConnection,validateSettings}=require('./translation.cjs');
const {SettingsStore,decodeText}=require('./security.cjs');
const {AlignmentCache}=require('./alignment.cjs');
const {getDemoAlignment}=require('./demo-alignment.cjs');
const {preparePassage}=require('./practice.cjs');
const entry=path.join(__dirname,'index.html');
const entryUrl=pathToFileURL(entry).href;
let win,library,settings,alignmentCache,busy=false,closing=false,closePending=false,closeTimer;
if(!app.isPackaged&&process.env.NOVELTYPE_TEST_DATA)app.setPath('userData',process.env.NOVELTYPE_TEST_DATA);
app.setName('NovelType');
if(process.platform==='win32')app.setAppUserModelId('io.github.maosixian.noveltype');
const lock=app.requestSingleInstanceLock();
if(!lock)app.quit();
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
const state=()=>library.getState(settings.public());
function bind(name,fn){ipcMain.handle('novel:'+name,async(event,payload)=>{
  if(!win||event.sender!==win.webContents||event.senderFrame?.url!==entryUrl)return {ok:false,error:'不允许的操作来源。'};
  try{return {ok:true,value:await fn(payload)};}catch(error){return {ok:false,error: error.code&&/^E[A-Z]+$/.test(error.code)?'无法读写本机文件，请检查磁盘空间和文件权限。':(error.message||'操作失败，请重试。')};}
});}
function register(){
  ipcMain.on('novel:close-ready',(event,ok)=>{if(!win||event.sender!==win.webContents||event.senderFrame?.url!==entryUrl||!closePending)return;clearTimeout(closeTimer);closePending=false;if(ok){closing=true;win.close();}else{dialog.showMessageBox(win,{type:'error',message:'练习进度未能保存，请重试。',buttons:['返回软件']});}});
  bind('getState',state);
  bind('importText',input=>{library.importText(input);return state();});
  bind('selectBook',id=>{library.selectBook(id);return state();});
  bind('saveProgress',input=>library.saveProgress(input));
  bind('setTranslation',input=>{library.setTranslation(input);return state();});
  bind('getAlignment',({bookId,index}={})=>{const segment=library.getSegment(bookId,index);return segment.translation?alignmentCache.get(segment.source,segment.translation):null;});
  bind('preparePassage',async({bookId,index}={})=>{
    if(busy)throw new Error('已有 AI 请求进行中，请稍候。');
    busy=true;
    try{return await preparePassage({library,cache:alignmentCache,bookId,index,getCredentials:()=>({settings:settings.public(),apiKey:settings.key()}),fetchImpl:(url,options)=>net.fetch(url,options)});}
    finally{busy=false;}
  });
  bind('saveSettings',input=>{if(busy)throw new Error('翻译进行中，请完成后再修改设置。');validateSettings(input);return settings.save(input);});
  bind('importFile',async()=>{
    const pick=await dialog.showOpenDialog(win,{title:'导入中文小说',properties:['openFile'],filters:[{name:'TXT 文本',extensions:['txt']}]});
    if(pick.canceled)return null;
    const file=pick.filePaths[0];if(path.extname(file).toLowerCase()!=='.txt')throw new Error('第一版支持 TXT 文件，请先将小说另存为 TXT。');
    if(fs.statSync(file).size>10*1024*1024)throw new Error('请选择 10 MB 以内的 TXT 文件。');
    library.importText({title:path.basename(file,path.extname(file)),text:decodeText(fs.readFileSync(file))});return state();
  });
  bind('translate',async({bookId,index}={})=>{
    const segment=library.getSegment(bookId,index);
    if(segment.translation)return {translation:segment.translation,cached:true};
    if(busy)throw new Error('已有翻译请求进行中，请稍候。');
    const apiKey=settings.key();busy=true;
    try {const translation=await translateText({source:segment.source,settings:settings.public(),apiKey,fetchImpl:(url,options)=>net.fetch(url,options)});const current=library.getSegment(bookId,index);if(current.source!==segment.source||current.translation)throw new Error('段落内容已更改，请重新打开当前段落。');library.setTranslation({bookId,index,translation});return {translation,cached:false};}
    finally{busy=false;}
  });
  bind('testConnection',async()=>{if(busy)throw new Error('已有请求进行中，请稍候。');const apiKey=settings.key();busy=true;try{return await testConnection({settings:settings.public(),apiKey,fetchImpl:(url,options)=>net.fetch(url,options)});}finally{busy=false;}});
  bind('exportBackup',async()=>{
    const pick=await dialog.showSaveDialog(win,{title:'导出书库备份（不含密钥）',defaultPath:'NovelType-backup.json',filters:[{name:'NovelType 备份',extensions:['json']}]});
    if(pick.canceled)return null;fs.writeFileSync(pick.filePath,JSON.stringify(library.exportData(),null,2),'utf8');return state();
  });
  bind('importBackup',async()=>{
    if(busy)throw new Error('请等翻译完成后再导入备份。');
    const pick=await dialog.showOpenDialog(win,{title:'恢复书库备份',properties:['openFile'],filters:[{name:'NovelType 备份',extensions:['json']}]});
    if(pick.canceled)return null;
    if(fs.statSync(pick.filePaths[0]).size>80*1024*1024)throw new Error('备份过大，最多支持 80 MB。');
    let data;try{data=JSON.parse(fs.readFileSync(pick.filePaths[0],'utf8'));}catch{throw new Error('备份不是有效的 JSON 文件。');}
    const confirm=await dialog.showMessageBox(win,{type:'question',buttons:['取消','恢复备份'],defaultId:0,cancelId:0,title:'恢复书库',message:'恢复备份会替换当前书库和进度。',detail:'当前书库会先自动备份到数据目录，API 设置保持不变。'});
    if(confirm.response!==1)return null;
    fs.writeFileSync(path.join(app.getPath('userData'),'before-restore-'+Date.now()+'.json'),JSON.stringify(library.exportData()));library.importData(data);return state();
  });
  bind('openDataFolder',async()=>{const error=await shell.openPath(app.getPath('userData'));if(error)throw new Error('无法打开数据目录。');});
}
async function create(){
  try{
    settings=new SettingsStore(app.getPath('userData'),safeStorage);library=new Library(app.getPath('userData'));
    const diskCache=new AlignmentCache(app.getPath('userData'));
    alignmentCache={get:(source,translation)=>diskCache.get(source,translation)||getDemoAlignment(source,translation),set:(...args)=>diskCache.set(...args)};
    register();
    session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    win=new BrowserWindow({width:1380,height:930,minWidth:880,minHeight:680,title:'NovelType · 逐页',backgroundColor:'#f5f3ed',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(url!==entryUrl)event.preventDefault();});
    win.on('close',async event=>{
      if(closing||win.webContents.isCrashed())return;
      event.preventDefault();if(closePending)return;closePending=true;
      if(busy){const pick=await dialog.showMessageBox(win,{type:'question',message:'AI 请求仍在进行。',detail:'建议等待结果保存。现在退出会丢失本次结果，服务商仍可能计费。',buttons:['继续等待','仍然退出'],defaultId:0,cancelId:0});if(pick.response!==1){closePending=false;return;}}
      win.webContents.send('novel:before-close');
      closeTimer=setTimeout(async()=>{closePending=false;const pick=await dialog.showMessageBox(win,{type:'warning',message:'保存进度没有及时响应。',detail:'返回软件可以继续等待；直接退出可能丢失最后输入的几个字符。',buttons:['返回软件','直接退出'],defaultId:0,cancelId:0});if(pick.response===1){closing=true;win.close();}},4000);
    });
    await win.loadFile(entry);
  }catch{const result=await dialog.showMessageBox({type:'error',title:'NovelType 启动失败',message:'无法读取本机书库或设置，原数据已保留。',detail:'请先复制整个数据目录备份。请成套保留 library 开头的书库、备份和进度日志文件，不要只替换单个文件；可联系维护者检查或恢复已导出的完整书库。设置损坏时可将 settings.json 改名后重新输入 Key。\n数据目录：'+app.getPath('userData'),buttons:['退出','打开数据目录'],defaultId:0});if(result.response===1)await shell.openPath(app.getPath('userData'));app.quit();}
}
if(lock)app.whenReady().then(create);
app.on('window-all-closed',()=>app.quit());

