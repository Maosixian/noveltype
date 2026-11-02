'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {validateResult}=require('./game-store.cjs');
const {fullPassageId,progressHash}=require('./game-content.cjs');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const progress=book=>({bookId:book.id,position:book.position,draft:book.draft,completed:[...book.completed],stats:{...book.stats}});
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}}
function read(file){if(!fs.existsSync(file))return null;if(fs.statSync(file).size>65536)throw Error('竞速保存凭据过大，请保留数据目录。');try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('竞速保存凭据损坏，原记录已保留。');}}
function matches(value,target){const a=Array.from(value),b=Array.from(target);return a.length===b.length&&a.every((c,i)=>c.toLowerCase()===b[i].toLowerCase());}
function prune(directory){
 const files=fs.readdirSync(directory).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).map(name=>({file:path.join(directory,name),time:fs.statSync(path.join(directory,name)).mtimeMs})).sort((a,b)=>a.time-b.time);
 // Preserve every unfinished result. A finished ticket may only claim one run;
 // expired receipts cannot recreate a new request after the bounded ticket cache expires.
 let remaining=files.length;
 for(const item of files){if(remaining<=256)break;const value=read(item.file);if(value?.done){fs.unlinkSync(item.file);remaining--;}}
}
/** Durable two-store completion; receipts stay in the active account's private directory. */
function saveRaceResult({directory,library,games,registry,change,input}){
 const result=validateResult(input);
 if(input.readingAdvance===undefined){registry.validate(library.state,input);return change('games',result.bookId,()=>games.save(result));}
 const advance=input.readingAdvance;
 if(!advance||typeof advance!=='object'||Object.keys(advance).sort().join(',')!=='index,ticket,typed'||typeof advance.ticket!=='string'||!/^[a-f0-9-]{36}$/.test(advance.ticket)||!Number.isInteger(advance.index)||typeof advance.typed!=='string'||advance.typed.length>10000||result.mode!=='race'||result.levelId!==null)throw Error('完整段落的竞速结果格式不正确。');
 const receipts=path.join(directory,'race-results'),file=path.join(receipts,hash(result.runId)+'.json'),requestHash=hash({result,advance:{ticket:advance.ticket,index:advance.index,typed:advance.typed}});
 let record=read(file);
 if(record&&record.requestHash!==requestHash)throw Error('同一局的结果与上次请求不一致，请保留原结果重试。');
 let book=library.state.books.find(b=>b.id===result.bookId);
 if(!record){
  const issued=registry.validate(library.state,input);
  if(result.won&&!matches(advance.typed,issued.translation))throw Error('必须完整输入原段落，空格、换行和标点需一致。');
  let plan=null;
  if(result.won&&book&&result.bookId!=='sample'){
   const next=Math.min(advance.index+1,book.segments.length-1),characters=Array.from(issued.translation).length;
   const readingInput={bookId:book.id,position:next,draft:next===advance.index?advance.typed:'',completed:advance.index,session:{characters,seconds:result.seconds,accuracy:result.accuracy,wpm:result.seconds?Math.min(10000,Math.round(characters/5/(result.seconds/60))):0}};
   const after=progress(book);delete after.bookId;after.position=readingInput.position;after.draft=readingInput.draft;
   if(!after.completed.includes(advance.index)){after.completed.push(advance.index);after.completed.sort((a,b)=>a-b);after.stats.sessions++;after.stats.characters+=characters;after.stats.seconds+=result.seconds;}
   plan={baseline:issued.baseline,activeBookId:issued.activeBookId,targetId:issued.id,index:advance.index,input:readingInput,afterHash:progressHash(after)};
  }
  record={version:1,requestHash,result,plan,readingApplied:false,readingStatus:'unchanged',done:false};
  fs.mkdirSync(receipts,{recursive:true});
  const unfinished=fs.readdirSync(receipts).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).reduce((n,name)=>n+(!read(path.join(receipts,name))?.done?1:0),0);
  if(unfinished>=16)throw Error('尚有未保存的竞速结果，请先重试保存。');
  atomic(file,record);
 }
 if(record.version!==1||!record.result||record.result.bookId!==result.bookId)throw Error('竞速保存凭据无法读取，原记录已保留。');
 if(!record.done){
  change('games',result.bookId,()=>games.save(result));
  const plan=record.plan;
  if(plan&&book){
   const segment=book.segments[plan.index],sameTarget=segment&&fullPassageId(plan.index,segment.source,segment.translation)===plan.targetId;
   if(record.readingApplied||progressHash(book)===plan.afterHash){
    // The journal can be durable before the receipt/outbox acknowledgement.
    // Recover cloud dirty state using today's progress; never replay an old bookmark.
    change('progress',book.id,()=>progress(book));record.readingApplied=true;record.readingStatus='advanced';
   }else if(sameTarget&&library.state.activeBookId===plan.activeBookId&&progressHash(book)===plan.baseline){
    change('progress',book.id,()=>{const ack=library.saveProgress(plan.input);record.readingApplied=true;record.readingStatus='advanced';atomic(file,record);return ack;});
   }else record.readingStatus='context-changed';
  }
  record.done=true;atomic(file,record);prune(receipts);
 }
 return {...games.get(result.bookId),readingStatus:record.readingStatus,readingProgress:['advanced','context-changed'].includes(record.readingStatus)&&book?progress(book):null};
}
module.exports={saveRaceResult};
