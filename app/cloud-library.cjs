'use strict';
const CHUNK_SIZE=128;
function progress(book){return {position:book.position,draft:book.draft,completed:[...book.completed],stats:{...book.stats}};}
function chunk(book,index){const start=Math.floor(index/CHUNK_SIZE)*CHUNK_SIZE;return {bookId:book.id,start,segments:structuredClone(book.segments.slice(start,start+CHUNK_SIZE))};}
function libraryEntities(data,games){
 const entities=[];
 for(const book of data.books){
  entities.push({kind:'book',key:book.id,value:{id:book.id,title:book.title,demo:book.demo,segmentCount:book.segments.length}});
  for(let index=0;index<book.segments.length;index+=CHUNK_SIZE)entities.push({kind:'chunk',key:`${book.id}:${index/CHUNK_SIZE}`,value:chunk(book,index)});
  entities.push({kind:'progress',key:book.id,value:progress(book)},{kind:'games',key:book.id,value:games.get(book.id)});
 }
 entities.push({kind:'selection',key:'active',value:{bookId:data.activeBookId}});return entities;
}
function hydrateLibrary(library,games,cache,entities){
 const values=new Map(entities.map(e=>[`${e.kind}/${e.key}`,e.value]));
 const books=entities.filter(e=>e.kind==='book').map(({key,value:meta})=>{
  if(meta.id!==key||!Number.isInteger(meta.segmentCount)||meta.segmentCount<1||meta.segmentCount>100000)throw new Error('云端书籍格式不正确。');
  const segments=[];
  for(let start=0;start<meta.segmentCount;start+=CHUNK_SIZE){const c=values.get(`chunk/${key}:${start/CHUNK_SIZE}`);if(!c||c.bookId!==key||c.start!==start||!Array.isArray(c.segments)||c.segments.length!==Math.min(CHUNK_SIZE,meta.segmentCount-start))throw new Error('云端小说尚未同步完整，请再次同步。');segments.push(...c.segments);}
  const p=values.get(`progress/${key}`)||{position:0,draft:'',completed:[],stats:{sessions:0,characters:0,seconds:0}};
  return {id:meta.id,title:meta.title,demo:meta.demo,segments,...p};
 });
 if(!books.length)return false;
 const selected=values.get('selection/active')?.bookId;
 library.importData({version:1,books,activeBookId:books.some(b=>b.id===selected)?selected:books[0].id});
 for(const e of entities){if(e.kind==='games')games.importProgress(e.key,e.value);if(e.kind==='alignment')cache.set(e.value.source,e.value.translation,e.value.alignment);}
 return true;
}
function applyChanges(library,games,cache,entities){
 // Only called at a paused UI boundary. Importing a new book uses hydrateLibrary once.
 const order={chunk:0,alignment:1,progress:2,games:3,selection:4,book:5};
 for(const e of [...entities].sort((a,b)=>order[a.kind]-order[b.kind])){
  const v=e.value;
  if(e.kind==='chunk')for(let j=0;j<v.segments.length;j++){
   const index=v.start+j,old=library.getSegment(v.bookId,index),next=v.segments[j];
   if(old.source!==next.source)throw new Error('云端原文与本机不同，请保留备份后重新同步。');
   if(next.translation&&next.translation!==old.translation)library.setTranslation({bookId:v.bookId,index,translation:next.translation});
  }
  if(e.kind==='progress')library.applySyncedProgress({bookId:e.key,...v});
  if(e.kind==='games')games.importProgress(e.key,v);
  if(e.kind==='alignment')cache.set(v.source,v.translation,v.alignment);
  if(e.kind==='selection')library.selectBook(v.bookId);
 }
}
module.exports={CHUNK_SIZE,progress,chunk,libraryEntities,hydrateLibrary,applyChanges};
