'use strict';
const {createHash,randomUUID}=require('node:crypto');
const {demoData}=require('./library.cjs');
const digest=text=>createHash('sha256').update(text).digest('hex');
const passageId=(index,part,source,translation)=>digest(index+'\0'+part+'\0'+source+'\0'+translation);
const fullPassageId=(index,source,translation)=>digest('full\0'+index+'\0'+source+'\0'+translation);
const progressHash=book=>digest(JSON.stringify({position:book.position,draft:book.draft,completed:book.completed,stats:book.stats}));
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
  return {bookId:bookId==='sample'?'sample':book.id,title:bookId==='sample'?'灯塔来信 · 原创示例':book.title,position:book.position,total,passages};
}

// A preparation request already in flight can add a cached translation while a
// game is running. Preserve issued targets independently of the moving 48-item
// picker, then validate only the original segment when its result is saved.
class GameContentRegistry{
  #issued=new Map();
  #tickets=new Map();
  issuePassage(state,bookId,index){
    const book=gameBook(state,bookId),key=bookId==='sample'?'sample':book.id;
    index=index===undefined?book.position:index;
    if(!Number.isInteger(index)||index<0||index>=book.segments.length)throw new Error('段落位置不正确。');
    const segment=book.segments[index],content={bookId:key,title:key==='sample'?'灯塔来信 · 原创示例':book.title,position:book.position,total:book.segments.length,index,source:segment.source,pending:!segment.translation,passage:null,excerpt:null};
    if(!segment.translation)return content;
    const id=fullPassageId(index,segment.source,segment.translation),ticket=randomUUID();
    this.#tickets.set(ticket,{book:key==='sample'?null:book,bookId:key,index,id,baseline:progressHash(book),activeBookId:state.activeBookId,runId:null});
    while(this.#tickets.size>128)this.#tickets.delete(this.#tickets.keys().next().value);
    content.passage={id,index,source:segment.source,translation:segment.translation,full:true,ticket};
    const translation=excerpts(segment.translation)[0];
    if(translation){content.excerpt={id:passageId(index,0,segment.source,translation),index,part:0,source:segment.source,translation,full:false};this.#remember(key,content.excerpt,key==='sample'?null:book);}
    return content;
  }
  #remember(bookId,passage,book){const key=bookId+'\0'+passage.id;this.#issued.delete(key);this.#issued.set(key,{index:passage.index,part:passage.part,book});while(this.#issued.size>512)this.#issued.delete(this.#issued.keys().next().value);}
  issue(state,bookId){
    const content=gameContent(state,bookId);
    const book=content.bookId==='sample'?null:gameBook(state,content.bookId);
    for(const passage of content.passages)this.#remember(content.bookId,passage,book);
    return content;
  }
  validate(state,input){
    const book=gameBook(state,input?.bookId);
    if(input?.readingAdvance!==undefined){
      const advance=input.readingAdvance,ticket=advance&&this.#tickets.get(advance.ticket);
      if(input.mode!=='race'||input.levelId!==null||!ticket||ticket.bookId!==input.bookId||ticket.index!==advance.index||ticket.id!==input.passageId||(ticket.book&&ticket.book!==book))throw new Error('完整段落的练习凭据已过期或内容发生变化，请重新打开这一段。');
      const segment=book.segments[ticket.index];
      if(!segment||fullPassageId(ticket.index,segment.source,segment.translation)!==ticket.id)throw new Error('本段译文已更改，请重新打开游戏。');
      if(ticket.runId&&ticket.runId!==input.runId)throw new Error('这一局结果已保存，请为新一局重新打开段落。');
      ticket.runId=input.runId;
      return {...ticket,full:true,translation:segment.translation};
    }
    if(input?.mode!=='race')return;
    const issued=this.#issued.get(input.bookId+'\0'+input.passageId);
    if(!issued||(issued.book&&issued.book!==book))throw new Error('这段游戏素材未打开或已过期，请重新打开游戏。');
    const segment=book.segments[issued.index];
    const translation=typeof segment?.translation==='string'?excerpts(segment.translation)[issued.part]:undefined;
    if(!translation||passageId(issued.index,issued.part,segment.source,translation)!==input.passageId)
      throw new Error('本段译文已更改，请重新打开游戏。');
  }
}
module.exports={gameContent,GameContentRegistry,fullPassageId,progressHash};
