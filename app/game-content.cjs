'use strict';
const {createHash}=require('node:crypto');
const {demoData}=require('./library.cjs');
const digest=text=>createHash('sha256').update(text).digest('hex');
const passageId=(index,part,source,translation)=>digest(index+'\0'+part+'\0'+source+'\0'+translation);
function gameBook(state,bookId){
  const book=bookId==='sample'?demoData().books[0]:state.books.find(item=>item.id===(bookId||state.activeBookId));
  if(!book)throw new Error('找不到这本书，请返回阅读重新选择。');
  return book;
}
function excerpts(translation){
  let remaining=translation.replace(/\s+/g,' ').trim();const output=[];
  while(remaining&&output.length<48){
    if(remaining.length<=260){output.push(remaining);break;}
    const head=remaining.slice(0,261);let end=-1;
    for(const match of head.matchAll(/[.!?]["']?\s/g))if(match.index>=60)end=match.index+match[0].length;
    if(end<0)end=head.lastIndexOf(' ');
    // An unbroken token larger than a round cannot be typed reasonably.
    if(end<1)break;
    output.push(remaining.slice(0,end).trim());remaining=remaining.slice(end).trimStart();
  }
  return output;
}

// Read the merged in-memory Library, never the stale on-disk checkpoint.
// Return a bounded copy; gameplay cannot mutate a book or request translation.
function gameContent(state,bookId){
  const book=gameBook(state,bookId);
  const passages=[],start=book.position||0,total=book.segments.length;
  for(let offset=0;offset<total&&passages.length<48;offset++){
    const index=(start+offset)%total,segment=book.segments[index];
    if(!segment.translation?.trim()||!/[A-Za-z]/.test(segment.translation))continue;
    // Short excerpts keep a beginner round achievable. Only this game copy's
    // whitespace is flattened; the Library translation remains unchanged.
    for(const [part,translation] of excerpts(segment.translation).entries()){
      if(passages.length>=48)break;
      passages.push({id:passageId(index,part,segment.source,translation),index,part,source:segment.source,translation});
    }
  }
  return {bookId:bookId==='sample'?'sample':book.id,title:bookId==='sample'?'灯塔来信 · 原创示例':book.title,passages};
}

// A preparation request already in flight can add a cached translation while a
// game is running. Preserve issued targets independently of the moving 48-item
// picker, then validate only the original segment when its result is saved.
class GameContentRegistry{
  #issued=new Map();
  issue(state,bookId){
    const content=gameContent(state,bookId);
    for(const passage of content.passages){
      const key=content.bookId+'\0'+passage.id;
      this.#issued.delete(key);
      this.#issued.set(key,{index:passage.index,part:passage.part});
    }
    while(this.#issued.size>512)this.#issued.delete(this.#issued.keys().next().value);
    return content;
  }
  validate(state,input){
    const book=gameBook(state,input?.bookId);
    if(input?.mode!=='race')return;
    const issued=this.#issued.get(input.bookId+'\0'+input.passageId);
    if(!issued)throw new Error('这段游戏素材未打开或已过期，请重新打开游戏。');
    const segment=book.segments[issued.index];
    const translation=typeof segment?.translation==='string'?excerpts(segment.translation)[issued.part]:undefined;
    if(!translation||passageId(issued.index,issued.part,segment.source,translation)!==input.passageId)
      throw new Error('本段译文已更改，请重新打开游戏。');
  }
}
module.exports={gameContent,GameContentRegistry};
