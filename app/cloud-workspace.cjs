'use strict';
const fs=require('node:fs'),path=require('node:path');
const {CloudClient}=require('./cloud-client.cjs');
const {Library}=require('./library.cjs');
const {GameStore}=require('./game-store.cjs');
const {AlignmentCache}=require('./alignment.cjs');
const {getDemoAlignment}=require('./demo-alignment.cjs');
const {libraryEntities,hydrateLibrary,applyChanges,progress,chunk}=require('./cloud-library.cjs');
function save(file,value){const tmp=file+'.tmp';let fd;try{fs.mkdirSync(path.dirname(file),{recursive:true});fd=fs.openSync(tmp,'w',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,file);}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
class CloudWorkspace{
 constructor({directory,cipher,fetchImpl,onSwitch,allowHttpForTests=false}){
  this.root=directory;this.client=new CloudClient({directory:path.join(directory,'cloud-account'),cipher,fetchImpl,allowHttpForTests});this.onSwitch=onSwitch||(()=>{});this.error='';this.syncing=null;
 }
 connected(){return this.client.public().connected;}
 directory(){return this.connected()?this.client.accountDirectory():this.root;}
 status(){const p=this.client.public();return {...p,error:this.error,conflictItems:p.connected?this.client.conflicts().map(({mutationId,kind,key})=>({mutationId,kind,key})):[]};}
 open(){
  const dir=this.directory();this.library=new Library(dir);this.games=new GameStore(dir);const disk=new AlignmentCache(dir);
  this.cache={get:(s,t)=>disk.get(s,t)||getDemoAlignment(s,t),set:(...args)=>disk.set(...args)};
  this.settingsFile=path.join(dir,'server-settings.json');this.settings=fs.existsSync(this.settingsFile)?JSON.parse(fs.readFileSync(this.settingsFile,'utf8')):{provider:'glm',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-5.3',hasKey:false};
  this.onSwitch(this.library,this.games,this.cache);this.recoverDirty();
 }
 savePublic(settings){const next={provider:settings.provider,baseUrl:settings.baseUrl,model:settings.model,hasKey:!!settings.hasKey};save(this.settingsFile,next);this.settings=next;return this.settings;}
 dirtyFile(){return path.join(this.directory(),'cloud-dirty.json');}
 appliedFile(){return path.join(this.directory(),'cloud-applied.json');}
 applied(){const file=this.appliedFile();return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};}
 enqueue(kind,key,value){return this.client.enqueue(kind,key,value,{baseRevision:this.applied()[`${kind}/${key}`]||0});}
 mark(kind,key){if(!this.connected())return;const file=this.dirtyFile(),rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];if(!rows.some(e=>e.kind===kind&&e.key===key)){rows.push({kind,key,baseRevision:this.applied()[`${kind}/${key}`]||0});save(file,rows);}}
 value(kind,key){
  if(kind==='selection')return {bookId:this.library.state.activeBookId};
  if(kind==='games')return this.games.get(key);
  if(kind==='chunk'){const cut=key.lastIndexOf(':'),id=key.slice(0,cut),index=Number(key.slice(cut+1))*128;return chunk(this.library._book(id),index);}
  if(kind==='progress')return progress(this.library._book(key));
  throw new Error('同步记录类型不正确。');
 }
 recoverDirty(){if(!this.connected()||!fs.existsSync(this.dirtyFile()))return;const rows=JSON.parse(fs.readFileSync(this.dirtyFile(),'utf8'));for(const row of rows)this.client.enqueue(row.kind,row.key,this.value(row.kind,row.key),{baseRevision:row.baseRevision??this.applied()[`${row.kind}/${row.key}`]??0});fs.unlinkSync(this.dirtyFile());}
 changed(kind,key,action){this.mark(kind,key);const result=action();this.recoverDirty();return result;}
 publishAlignments(book){for(const [index,segment] of book.segments.entries()){if(!segment.translation)continue;const alignment=this.cache.get(segment.source,segment.translation);if(alignment)this.enqueue('alignment',`${book.id}:${index}`,{source:segment.source,translation:segment.translation,alignment});}}
 publishLocal(){for(const e of libraryEntities(this.library.exportData(),this.games))this.enqueue(e.kind,e.key,e.value);this.enqueue('games','sample',this.games.get('sample'));for(const book of this.library.state.books)this.publishAlignments(book);}
 publishBook(bookId){const book=this.library._book(bookId);for(const e of libraryEntities({books:[book],activeBookId:bookId},this.games))this.enqueue(e.kind,e.key,e.value);this.publishAlignments(book);}
 async sync({apply=false}={}){
  if(!this.connected())return this.status();if(this.syncing)return this.syncing;
  this.syncing=(async()=>{
   this.recoverDirty();let response,turns=0;const changed=new Map();
   do{response=await this.client.sync(async incoming=>{if(incoming.accepted.length){const applied=this.applied();for(const e of incoming.accepted)applied[`${e.kind}/${e.key}`]=Math.max(applied[`${e.kind}/${e.key}`]||0,e.revision);save(this.appliedFile(),applied);}});for(const item of response.changes)changed.set(`${item.kind}/${item.key}`,item);if(++turns>3000)throw new Error('本轮同步内容较多，请再次同步。');}while(response.hasMore||this.client.outbox().some(op=>!op.dependsOn));
   if(apply&&this.client.conflicts().length===0){
    const entities=this.client.entities(),books=entities.filter(e=>e.kind==='book');
    const newBook=books.some(e=>!this.library.state.books.some(b=>b.id===e.key));
    const appliedFile=this.appliedFile();
    const applied=this.applied();
    const unseen=entities.filter(e=>(applied[`${e.kind}/${e.key}`]||0)<e.revision);
    if(newBook||!fs.existsSync(appliedFile))hydrateLibrary(this.library,this.games,this.cache,entities);else applyChanges(this.library,this.games,this.cache,unseen);
    for(const e of entities)applied[`${e.kind}/${e.key}`]=e.revision;
    save(appliedFile,applied);
   }
   this.savePublic(await this.client.settings());this.error='';return this.status();
  })().catch(error=>{this.error=error.message;throw error;}).finally(()=>{this.syncing=null;});return this.syncing;
 }
 async login(input){
  const migrateLocal=!this.connected(),old=this.library,oldGames=this.games,oldCache=this.cache;
  const checkpoint=this.client.sessionCheckpoint();
  try{
   await this.client.login(input);this.open();await this.sync();
   if(!this.client.entities().some(e=>e.kind==='book')){
    if(migrateLocal){this.library.importData(old.exportData());for(const book of old.state.books){this.games.importProgress(book.id,oldGames.get(book.id));for(const segment of book.segments){if(!segment.translation)continue;const alignment=oldCache.get(segment.source,segment.translation);if(alignment)this.cache.set(segment.source,segment.translation,alignment);}}this.games.importProgress('sample',oldGames.get('sample'));}
    this.publishLocal();
   }
   await this.sync({apply:true});return this.status();
  }catch(error){
   this.client.restoreSession(checkpoint);this.open();this.error=error.message;throw error;
  }
 }
 async logout(){if(this.syncing)await this.syncing;await this.client.logout();this.open();this.error='';return this.status();}
 resolve({mutationId,choice}){if(choice==='local')return this.client.resolveLocal(mutationId);if(choice==='remote')return this.client.resolveRemote(mutationId);throw new Error('请选择要保留的进度。');}
}
module.exports={CloudWorkspace};
