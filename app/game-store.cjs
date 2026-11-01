'use strict';
const fs=require('node:fs');
const path=require('node:path');
const clone=value=>structuredClone(value);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const range=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const empty=()=>({levels:{},bestRaces:{},recent:[]});
function validateResult(input){
  if(!plain(input)||!safeId(input.bookId)||!safeId(input.runId)||!['race','defense'].includes(input.mode)
    ||!(input.levelId===null||(Number.isInteger(input.levelId)&&range(input.levelId,1,12)))
    ||!(input.passageId===null||(typeof input.passageId==='string'&&/^[a-f0-9]{64}$/.test(input.passageId)))
    ||typeof input.won!=='boolean'||!Number.isInteger(input.stars)||!range(input.stars,0,3)
    ||(input.won?(input.stars<1):(input.stars!==0))||!range(input.score,0,10000000)
    ||!range(input.seconds,0,3600)||!range(input.accuracy,0,100)||!range(input.wpm,0,100000)
    ||(input.mode==='race'&&!input.passageId)
    ||(input.levelId&&input.mode!==(input.levelId%2?'race':'defense')))
    throw new Error('游戏成绩格式不正确，记录未保存。');
  const {bookId,runId,mode,levelId,passageId,stars,score,seconds,accuracy,wpm,won}=input;
  return {bookId,runId,mode,levelId,passageId,stars,score,seconds,accuracy,wpm,won};
}
function validateData(data){
  if(!plain(data)||data.version!==1||!plain(data.books)||Object.keys(data.books).length>101||!Array.isArray(data.seen)||data.seen.length>256||data.seen.some(id=>!safeId(id)))throw new Error('invalid games');
  for(const [id,progress] of Object.entries(data.books)){
    if(!safeId(id)||!plain(progress)||!plain(progress.levels)||!plain(progress.bestRaces)||Object.keys(progress.levels).length>12||Object.keys(progress.bestRaces).length>40||!Array.isArray(progress.recent)||progress.recent.length>20)throw new Error('invalid progress');
    for(const [level,entry] of Object.entries(progress.levels)){
      if(!/^(?:[1-9]|1[0-2])$/.test(level)||!plain(entry)||!Number.isInteger(entry.stars)||!range(entry.stars,1,3)||!range(entry.score,0,10000000)||!range(entry.seconds,0,3600)||!range(entry.accuracy,0,100))throw new Error('invalid level');
      if(Number(level)>1&&!progress.levels[Number(level)-1])throw new Error('invalid unlock');
    }
    for(const [key,entry] of Object.entries(progress.bestRaces))if(!/^[a-f0-9]{64}$/.test(key)||!plain(entry)||!range(entry.seconds,0,3600)||!range(entry.wpm,0,100000)||!range(entry.accuracy,0,100))throw new Error('invalid race');
    for(const result of progress.recent){validateResult(result);if(result.bookId!==id)throw new Error('invalid book');}
  }
  return data;
}
class GameStore{
  constructor(directory){
    this.file=path.join(directory,'games.json');this.data={version:1,books:{},seen:[]};
    if(fs.existsSync(this.file))try{
      if(fs.statSync(this.file).size>2*1024*1024)throw new Error('too large');
      this.data=validateData(JSON.parse(fs.readFileSync(this.file,'utf8')));
    }catch{throw new Error('游戏记录无法读取，原文件已保留；阅读书库不受影响。请备份数据目录后联系维护者。');}
  }
  get(bookId){if(!safeId(bookId))throw new Error('书籍标识无效。');return clone(Object.hasOwn(this.data.books,bookId)?this.data.books[bookId]:empty());}
  importProgress(bookId,progress){
    if(!safeId(bookId)||['__proto__','constructor','prototype'].includes(bookId))throw new Error('书籍标识无效。');
    const next=clone(this.data);Object.defineProperty(next.books,bookId,{value:clone(progress),writable:true,enumerable:true,configurable:true});validateData(next);
    fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.sync.tmp';let fd;
    try{fd=fs.openSync(temp,'w',0o600);fs.writeFileSync(fd,JSON.stringify(next));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,this.file);this.data=next;}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
    return this.get(bookId);
  }
  save(input){
    const result=validateResult(input);
    if(this.data.seen.includes(result.runId))return this.get(result.bookId);
    const next=clone(this.data),progress=Object.hasOwn(next.books,result.bookId)?next.books[result.bookId]:empty();
    if(!Object.hasOwn(next.books,result.bookId)&&Object.keys(next.books).length>=101)throw new Error('游戏记录已达容量上限，请先备份数据目录。');
    if(result.levelId>1&&!progress.levels[result.levelId-1]?.stars)throw new Error('请先完成上一关。');
    if(result.levelId&&result.won){
      const old=progress.levels[result.levelId];
      if(!old||result.stars>old.stars||(result.stars===old.stars&&result.score>old.score))progress.levels[result.levelId]={stars:result.stars,score:result.score,seconds:result.seconds,accuracy:result.accuracy};
    }
    if(result.mode==='race'&&result.won){
      const old=progress.bestRaces[result.passageId];
      if(!old||result.seconds<old.seconds)progress.bestRaces[result.passageId]={seconds:result.seconds,wpm:result.wpm,accuracy:result.accuracy};
      while(Object.keys(progress.bestRaces).length>40)delete progress.bestRaces[Object.keys(progress.bestRaces)[0]];
    }
    progress.recent=[result,...progress.recent].slice(0,20);next.books[result.bookId]=progress;
    next.seen=[...next.seen,result.runId].slice(-256);
    const text=JSON.stringify(next),temporary=this.file+'.tmp';
    if(Buffer.byteLength(text)>2*1024*1024)throw new Error('游戏记录超出容量限制。');
    let fd;
    try{
      fd=fs.openSync(temporary,'w');fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      if(fs.existsSync(this.file))fs.copyFileSync(this.file,this.file+'.bak');
      fs.renameSync(temporary,this.file);
    }catch{throw new Error('游戏成绩未保存，请检查磁盘空间和文件权限后点击重试。');}
    finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    this.data=next;return this.get(result.bookId);
  }
}
module.exports={GameStore};
