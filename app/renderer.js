import { TypingSession, charactersMatch } from './typing.mjs';
import { initialRange, extendRange, nextPosition } from './stream.mjs';
import { setupAccount } from './account-ui.mjs';
import { alignmentAtCursor, targetOffset } from './alignment.mjs';
import { createGamesUI } from './games-ui.mjs';
import { createTypingFeedback } from './typing-feedback.mjs';
import { createChapterIndex } from './chapters.mjs';
import { createChapterFeedback } from './chapter-feedback.mjs';
const $=id=>document.getElementById(id);
const api=window.novel;
let gamesUI,activeView='reading',viewBusy=false;
let readingChangedInGame=false;
const presets={glm:{label:'智谱 GLM',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4.7-flash'},deepseek:{label:'DeepSeek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},openai:{label:'OpenAI',baseUrl:'https://api.openai.com/v1',model:'gpt-4o-mini'},custom:{label:'自定义服务',baseUrl:'',model:''}};
let state={books:[],activeBookId:null,settings:{}};
let session=null,busy=false,explicitPause=false,settingsBusy=false,editContext=null;
let continuousEnabled=false,translationTask=null,translationIndex=null,translationBookId=null,translationEpoch=0;
let manualTranslationRetry=false;
let saveTimer,savePromise=null,saveFailure=false,movingInput=false,range={start:0,end:0};
let liveTotals={characters:0,seconds:0,attempts:0,errors:0};
const savePending=[];
const rows=new Map();
const alignmentEntries=new Map();
const currentBook=()=>state.books.find(book=>book.id===state.activeBookId);
const currentSegment=()=>currentBook()?.segments[currentBook().position];
const now=()=>performance.now();
const typingFeedback=createTypingFeedback({panel:$('typing-panel')});
const chapterFeedback=createChapterFeedback(),chapterIndexes=new WeakMap(),chapterReceipts=new WeakMap();
const chapterNodes={panel:$('chapter-notice'),title:$('chapter-notice-title'),chapter:$('chapter-notice-chapter'),next:$('chapter-notice-next'),mark:$('chapter-notice-mark')};
const chapterReducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
let chapterAnimation=null;
let activeRow=null;
function chaptersFor(book){let index=chapterIndexes.get(book.segments);if(!index){index=createChapterIndex(book.segments);chapterIndexes.set(book.segments,index);}return index;}
function cancelChapterAnimation(){chapterAnimation?.cancel();chapterAnimation=null;}
function hideChapterFeedback(){cancelChapterAnimation();chapterNodes.panel.hidden=true;}
function resetChapterFeedback(){chapterFeedback.reset(state.activeBookId);hideChapterFeedback();}
function captureChapterCompletion(book,index,token){return chapterFeedback.capture({bookId:book.id,transition:chaptersFor(book).transitionAt(index),total:book.segments.length,token});}
function showChapterFeedback(message){
  if(!message)return;
  const host=activeView==='reading'?$('stream-toolbar'):$('game-result');
  if(!host)return;
  cancelChapterAnimation();host.append(chapterNodes.panel);
  chapterNodes.title.textContent=message.title;chapterNodes.chapter.textContent=message.chapter;
  chapterNodes.next.textContent=message.next;chapterNodes.next.hidden=!message.next;
  chapterNodes.mark.textContent=message.complete?'✓':'→';chapterNodes.panel.dataset.complete=String(message.complete);
  chapterNodes.panel.hidden=false;
  if(!chapterReducedMotion.matches&&!['reduced','off'].includes(document.documentElement.dataset.motion)){
    chapterAnimation=chapterNodes.panel.animate([{opacity:.4,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing:'cubic-bezier(.16,1,.3,1)'});
    chapterAnimation.finished.catch(()=>{});
  }
}
$('chapter-notice-dismiss').addEventListener('click',hideChapterFeedback);
window.addEventListener('noveltype:motion-change',cancelChapterAnimation);
chapterReducedMotion.addEventListener('change',cancelChapterAnimation);
// The chapter card can change the sticky toolbar's height. Keep paragraph
// navigation below it without measuring layout in the typing handler.
new ResizeObserver(entries=>{const height=entries[0]?.borderBoxSize?.[0]?.blockSize;if(height)document.documentElement.style.setProperty('--stream-toolbar-height',`${Math.ceil(height)}px`);}).observe($('stream-toolbar'));
function setText(element,text){if(element.textContent!==text)element.textContent=text;}
const providerName=()=>presets[state.settings.provider]?.label||'自定义服务';
const errorText=error=>error?.message||'操作未完成，请重试。';
function alignmentEntry(book,index){
  const segment=book.segments[index],key=`${book.id}:${index}`;
  let entry=alignmentEntries.get(key);
  if(!entry||entry.source!==segment.source||entry.translation!==segment.translation){
    entry={source:segment.source,translation:segment.translation,alignment:null,loaded:false,promise:null};
    alignmentEntries.set(key,entry);
  }
  // Only keep a small working set; durable maps live in the main-process cache.
  if(alignmentEntries.size>128){for(const [oldKey,oldEntry] of alignmentEntries){if(oldKey!==key&&!oldEntry.promise){alignmentEntries.delete(oldKey);break;}}}
  return entry;
}
async function readAlignment(book,index){
  const entry=alignmentEntry(book,index);
  if(!entry.translation||entry.loaded)return;
  if(entry.promise)return entry.promise;
  entry.promise=api.getAlignment({bookId:book.id,index}).then(alignment=>{
    const local=state.books.find(item=>item.id===book.id);
    if(!local||local.segments[index]?.source!==entry.source||local.segments[index]?.translation!==entry.translation)return;
    // A freshly prepared map can arrive while this older cache read is in flight.
    if(alignmentEntry(local,index)!==entry)return;
    if(!entry.alignment)entry.alignment=alignment;
    entry.loaded=true;
  }).finally(()=>{entry.promise=null;});
  return entry.promise;
}
async function readAlignmentWindow(book){
  await Promise.all(Array.from({length:Math.min(4,book.segments.length-book.position)},(_,offset)=>readAlignment(book,book.position+offset)));
}
function renderSourceGuide(){
  const book=currentBook(),row=rows.get(book?.position);if(!row)return null;
  const segment=currentSegment(),entry=alignmentEntry(book,book.position),input=$('typing-input');
  const hit=alignmentAtCursor(segment.translation,session?.value||'',input.selectionStart,entry.alignment);
  const source=row.querySelector('.stream-source'),status=row.querySelector('.guide-status');
  status.hidden=false;
  setText(status,entry.alignment?'中文词句同步对照':translationBookId===book.id&&translationIndex===book.position?'正在准备中文对照…':explicitPause?'中文对照已暂停；点击继续准备':'点击开始练习，准备中文对照');
  const key=hit?`${hit.span.sourceStart}:${hit.span.sourceEnd}`:'';
  if(row.guideRange!==key){
    if(hit){
      const mark=document.createElement('mark');mark.className='source-highlight';mark.textContent=segment.source.slice(hit.span.sourceStart,hit.span.sourceEnd);
      source.replaceChildren(document.createTextNode(segment.source.slice(0,hit.span.sourceStart)),mark,document.createTextNode(segment.source.slice(hit.span.sourceEnd)));
    }else source.textContent=segment.source;
    row.guideRange=key;
  }
  return hit;
}
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=!message;}
function formMessage(id,message,error=false){$(id).textContent=message;$(id).classList.toggle('error',error);}
function normalizeState(next){state=next;const note=document.querySelector(".local-note");if(note){note.querySelector("strong").textContent=state.account?.connected?"故事，随账号同步":"故事，留在这台电脑";note.querySelector("p").textContent=state.account?.connected?"小说与进度在本机缓存，并同步到你的服务器。":"书库与进度保存在本机，开始练习后按需翻译相邻短段。";}if(!state.books.some(book=>book.id===state.activeBookId))state.activeBookId=state.books[0]?.id||null;}
function stopContinuous(){continuousEnabled=false;translationEpoch++;session?.pause(now());}
function saveError(error){saveFailure=true;stopContinuous();explicitPause=true;$('save-state').textContent='保存失败 · 待重试';notice('进度仍在等待保存：'+errorText(error)+' 点击继续可重试，请暂时不要关闭软件。',true);renderControls();}
function progressSnapshot(){const book=currentBook();if(!book)return null;book.draft=session?.value??book.draft??'';return {bookId:book.id,position:book.position,draft:book.draft};}
function drainSaves(){
  if(savePromise)return savePromise;
  savePromise=(async()=>{
    while(savePending.length){
      const snapshot=savePending[0];
      const saved=await api.saveProgress(snapshot);
      if(saved.bookId!==snapshot.bookId)throw new Error('进度保存响应不一致，请重试。');
      const local=state.books.find(book=>book.id===snapshot.bookId);
      // A save can finish after more typing or an automatic advance. Merge durable
      // totals only; an older acknowledgement must never replace the live draft.
      if(local){local.stats=saved.stats;local.completed=[...new Set([...local.completed,...saved.completed])].sort((a,b)=>a-b);}
      savePending.shift();
      if(snapshot.completed!==undefined){renderLibrary();renderOverview();}
      showChapterFeedback(chapterFeedback.confirm(chapterReceipts.get(snapshot),saved.completed));
    }
    saveFailure=false;$('save-state').textContent='✓ 已保存到本机';
  })().finally(()=>{savePromise=null;});
  return savePromise;
}
function queueSave(snapshot,completion=null){
  if(!snapshot)return;
  if(completion){const book=currentBook();if(book?.id===snapshot.bookId){const receipt=captureChapterCompletion(book,snapshot.position,completion);if(receipt)chapterReceipts.set(snapshot,receipt);}}
  const last=savePending.at(-1);
  // Only collapse an unstarted plain draft; never drop a completion or the head in flight.
  if(last&&savePending.length>1&&last.completed===undefined&&snapshot.completed===undefined&&!chapterReceipts.has(last)&&!chapterReceipts.has(snapshot)&&last.bookId===snapshot.bookId&&last.position===snapshot.position)savePending[savePending.length-1]=snapshot;
  else savePending.push(snapshot);
  $('save-state').textContent='正在保存…';
  if(!saveFailure)void drainSaves().catch(saveError);
}
function scheduleSave(){clearTimeout(saveTimer);setText($('save-state'),saveFailure?'保存失败 · 待重试':'等待保存…');saveTimer=setTimeout(()=>{saveTimer=null;queueSave(progressSnapshot());},400);}
async function flushSave(){clearTimeout(saveTimer);saveTimer=null;if(activeView==='reading')queueSave(progressSnapshot());if(savePromise)await savePromise.catch(()=>{});if(savePending.length)await drainSaves();}
function renderLibrary(){
  $('book-count').textContent=String(state.books.length).padStart(2,'0');const fragment=document.createDocumentFragment();
  for(const book of state.books){const button=document.createElement('button');button.className='book-button';button.type='button';button.setAttribute('aria-current',String(book.id===state.activeBookId));button.disabled=busy;button.title=book.title;const spine=document.createElement('span');spine.className='book-spine';spine.setAttribute('aria-hidden','true');const info=document.createElement('span');info.className='book-info';const title=document.createElement('strong');title.textContent=book.title;const meta=document.createElement('small');meta.textContent=`${book.demo?'示例 · ':''}${book.completed.length} / ${book.segments.length} 段已完成`;info.append(title,meta);button.append(spine,info);button.addEventListener('click',()=>selectBook(book.id));fragment.append(button);}
  $('book-list').replaceChildren(fragment);$('provider-badge').textContent=state.settings.hasKey?providerName():'未配置';
}
function renderOverview(){const book=currentBook();if(!book)return;const total=book.segments.length,completed=book.completed.length,percentage=Math.round(completed/total*100);$('book-title').textContent=book.title;$('demo-label').hidden=!book.demo;$('book-meta').textContent=`连续长卷 · ${total} 段 · ${book.demo?'原创双语示例':'本机书库，自动保存'}`;$('book-progress-label').textContent=`已完成 ${percentage}%`;$('book-progress').value=percentage;$('completed-count').textContent=`${completed} / ${total} 段`;$('stream-position').textContent=`正在输入 第 ${book.position+1} / ${total} 段`;$('footer-total').textContent=`已完成 ${book.stats.sessions} 次段落练习 · 累计输入 ${book.stats.characters} 字符`;const chapter=chaptersFor(book).chapterAt(book.position);$('current-chapter').hidden=!chapter;setText($('current-chapter'),chapter?.label||'');}
function renderControls(){
  const book=currentBook(),translated=Boolean(currentSegment()?.translation),finished=Boolean(session?.complete&&book?.position===book?.segments.length-1);
  $('translate').disabled=busy||(!book)||(!explicitPause&&continuousEnabled);
  $('translate').textContent=continuousEnabled?'连续练习中':translated?'开始连续练习':'翻译并连续练习';
  $('pause').disabled=busy||!book||(finished&&!saveFailure);
  $('pause').textContent=explicitPause?'▷ 继续':'Ⅱ 暂停';$('pause').setAttribute('aria-pressed',String(explicitPause));
  $('typing-input').disabled=busy||!translated;
  $('typing-input').readOnly=Boolean(explicitPause||session?.complete);
  $('typing-panel').classList.toggle('is-paused',explicitPause);
  $('typing-input').placeholder=!translated?'译文准备好后会在这里接着输入…':explicitPause?'已暂停，点击「继续」恢复练习。':'从第一个字符开始，一直打下去…';
  $('input-status').textContent=finished?'已到故事结尾':!translated?(translationBookId===book?.id&&translationIndex===book?.position?'正在翻译这一小段…':'这一段还没有译文'):explicitPause?'已暂停':'正在输入 · 打完自动接续';
  $('reset').disabled=busy||!translated;$('edit-translation').disabled=busy||Boolean(translationTask&&translationBookId===book?.id&&translationIndex===book?.position);
  $('book-finished').hidden=!finished;
  $('session-note').textContent=explicitPause?'已暂停；不会再安排新翻译。':'打完自动接续；上下滚动不改变输入位置。';
  for(const id of ['import-file','empty-import','open-paste','export-backup','import-backup'])$(id).disabled=busy;
  for(const row of rows.values())for(const button of row.querySelectorAll('.practice-here,.race-here'))button.disabled=busy||viewBusy;
  renderSourceGuide();
}
function renderMetrics(){if(activeView!=='reading'||document.hidden)return;const snap=session?.snapshot(now());const seconds=liveTotals.seconds+(snap?.seconds||0),characters=liveTotals.characters+(snap?.characters||0),attempts=liveTotals.attempts+(snap?.attempts||0),errors=liveTotals.errors+(snap?.errors||0);setText($('wpm'),String(seconds>=1?Math.round(characters/5/(seconds/60)):0));setText($('accuracy'),String(attempts?Math.round((attempts-errors)/attempts*100):100));setText($('elapsed'),`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(Math.floor(seconds%60)).padStart(2,'0')}`);}
function createParagraph(index){
  const book=currentBook(),segment=book.segments[index],row=document.createElement('article');row.className='story-passage';row.dataset.index=String(index);
  const heading=document.createElement('div');heading.className='story-passage-heading';const label=document.createElement('span');label.className='paragraph-number';label.textContent=String(index+1).padStart(3,'0');const status=document.createElement('span');status.className='paragraph-status';const select=document.createElement('button');select.type='button';select.className='practice-here button text-button';select.textContent='从这里练习';select.addEventListener('click',()=>chooseParagraph(index));heading.append(label,status,select);
  const race=document.createElement('button');race.type='button';race.className='race-here button text-button';race.textContent='用此段竞速';race.addEventListener('click',()=>switchView('games',{index,mode:'race'}));heading.append(race);
  const source=document.createElement('p');source.className='stream-source';source.textContent=segment.source;
  const guide=document.createElement('p');guide.className='guide-status';guide.hidden=true;
  const english=document.createElement('p');english.className='stream-english';english.lang='en';row.append(heading,guide,source,english);rows.set(index,row);updateParagraph(index);return row;
}
function updateParagraph(index){const row=rows.get(index),book=currentBook();if(!row||!book)return;const segment=book.segments[index],active=index===book.position;row.classList.toggle('is-complete',book.completed.includes(index));row.classList.toggle('is-active',active);row.querySelector('.paragraph-status').textContent=active?'当前输入':book.completed.includes(index)?'已练习':segment.translation?'译文已就绪':'待练习时翻译';row.querySelector('.practice-here').hidden=active;if(!active){row.querySelector('.stream-english').textContent=segment.translation||'开始练习后，将按顺序准备英文译文。';row.querySelector('.stream-english').classList.toggle('untranslated',!segment.translation);row.querySelector('.stream-source').textContent=segment.source;row.querySelector('.guide-status').hidden=true;row.guideRange='';row.targetCache=null;}}
function renderTarget(){
  const book=currentBook(),row=rows.get(book?.position);if(!row)return;
  const translation=currentSegment()?.translation||'',valueText=session?.value||'',selection=$('typing-input').selectionStart;
  const alignment=alignmentEntry(book,book.position).alignment,target=row.querySelector('.stream-english');
  let cache=row.targetCache;
  // A single key can dispatch input, keyup and select. Keep unchanged nodes and
  // skip repeated work without deferring the real input or caret update.
  if(cache&&cache.translation===translation&&cache.value===valueText&&cache.selection===selection&&cache.alignment===alignment&&cache.complete===session?.complete)return;
  if(!cache||cache.translation!==translation){
    const characters=Array.from(translation),nodes=[],offsets=[],fragment=document.createDocumentFragment();let offset=0;
    for(const character of characters){const node=document.createElement('span');node.className='target-char';node.textContent=character;nodes.push(node);offsets.push(offset);offset+=character.length;fragment.append(node);}
    target.replaceChildren(fragment);if(!characters.length)target.textContent='这一段的英文译文还在等待准备。';
    target.classList.toggle('untranslated',!characters.length);
    cache=row.targetCache={translation,characters,nodes,offsets,classes:[],extra:null};
  }
  const hit=renderSourceGuide(),value=Array.from(valueText),cursor=targetOffset(translation,valueText,selection);
  for(let index=0;index<cache.characters.length;index++){
    const character=cache.characters[index],offset=cache.offsets[index];let className='target-char';
    if(index<value.length)className+=charactersMatch(value[index],character)?' correct':' wrong';
    if(offset===cursor&&!session?.complete)className+=' caret';
    if(character===' ')className+=' space';
    if(hit&&offset>=hit.word.start&&offset<hit.word.end)className+=' aligned-word';
    if(cache.classes[index]!==className){cache.nodes[index].className=className;cache.classes[index]=className;}
  }
  const overflow=value.slice(cache.characters.length).join('');
  if(overflow){if(!cache.extra){cache.extra=document.createElement('span');cache.extra.className='target-char wrong';target.append(cache.extra);}setText(cache.extra,overflow);}
  else if(cache.extra){cache.extra.remove();cache.extra=null;}
  Object.assign(cache,{value:valueText,selection,alignment,complete:session?.complete});
  setText($('character-count'),`${value.length} / ${cache.characters.length}`);
}
function loadMore(direction){
  const book=currentBook();if(!book)return;const next=extendRange(range,direction,book.segments.length);if(next.start===range.start&&next.end===range.end)return;
  const anchor=direction<0?$('story-stream').firstElementChild:null;const top=anchor?.getBoundingClientRect().top;const fragment=document.createDocumentFragment();
  if(direction<0){for(let i=next.start;i<range.start;i++)fragment.append(createParagraph(i));$('story-stream').prepend(fragment);}else{for(let i=range.end;i<next.end;i++)fragment.append(createParagraph(i));$('story-stream').append(fragment);}
  range=next;
  if(anchor)window.scrollBy(0,anchor.getBoundingClientRect().top-top);
  renderSentinels();
}
function renderSentinels(){$('stream-top').textContent=range.start>0?'向上滚动，继续阅读前文':'故事从这里开始';$('stream-bottom').textContent=range.end<(currentBook()?.segments.length||0)?'向下滚动，故事继续':'已到故事末尾';}
function ensureRow(index){while(index>=range.end)loadMore(1);while(index<range.start)loadMore(-1);}
function revealInput(focus=true){const row=rows.get(currentBook()?.position);if(!row)return;row.scrollIntoView({block:'start',behavior:'auto'});if(focus&&!$('typing-input').disabled)$('typing-input').focus({preventScroll:true});}
function mountActive({focus=false,scroll=false}={}){
  const book=currentBook();if(!book)return;ensureRow(book.position);movingInput=true;
  if(activeRow){for(const selector of ['.stream-source','.stream-english','.guide-status'])activeRow.querySelector(selector).removeAttribute('id');updateParagraph(Number(activeRow.dataset.index));}
  updateParagraph(book.position);activeRow=rows.get(book.position);
  const row=rows.get(book.position);row.querySelector('.stream-source').id='source-text';row.querySelector('.stream-english').id='translation-text';row.querySelector('.guide-status').id='guide-status';row.append($('typing-panel'));$('typing-input').value=session?.value||'';$('typing-input').setSelectionRange($('typing-input').value.length,$('typing-input').value.length);renderTarget();renderOverview();renderControls();renderMetrics();movingInput=false;
  if(scroll)revealInput(focus);else if(focus&&!$('typing-input').disabled)$('typing-input').focus({preventScroll:true});
  void readAlignmentWindow(book).then(()=>{if(currentBook()?.id===book.id)renderTarget();}).catch(()=>{if(currentBook()?.id===book.id)notice('中文对照缓存暂时无法读取，可以继续打字；点击开始练习可重试。',true);});
}
function renderPassage(){
  resetChapterFeedback();$('stream-toolbar').append(chapterNodes.panel);
  stopContinuous();typingFeedback.reset();explicitPause=false;const book=currentBook();$('reading-view').hidden=!book;$('empty-state').hidden=Boolean(book);movingInput=true;$('input-parking').append($('typing-panel'));rows.clear();activeRow=null;$('story-stream').replaceChildren();movingInput=false;liveTotals={characters:0,seconds:0,attempts:0,errors:0};
  if(!book){session=null;renderControls();return;}
  range=initialRange(book.segments.length,book.position);for(let i=range.start;i<range.end;i++)$('story-stream').append(createParagraph(i));session=new TypingSession(currentSegment().translation||'',book.draft||'');renderSentinels();mountActive({scroll:book.position>0});
}
function advanceCompleted(){
  const book=currentBook();if(!book||!session?.complete)return false;const next=nextPosition(book.position,book.segments.length,true);if(next===book.position){stopContinuous();renderControls();return false;}
  clearTimeout(saveTimer);saveTimer=null;const snapshot=session.snapshot(now());const completion=session.claimCompletion(now());
  queueSave({...progressSnapshot(),...(!book.completed.includes(book.position)?{completed:book.position,...(completion?{session:completion}:{})}:{})},completion);
  if(!book.completed.includes(book.position))book.completed.push(book.position);
  liveTotals.characters+=snapshot.characters;liveTotals.seconds+=snapshot.seconds;liveTotals.attempts+=snapshot.attempts;liveTotals.errors+=snapshot.errors;
  book.position=next;book.draft='';session=new TypingSession(currentSegment().translation||'');mountActive({focus:true,scroll:true});queueSave(progressSnapshot());renderLibrary();
  if(!currentSegment().translation&&!continuousEnabled)notice('已自动接到下一段。点击「翻译并连续练习」后，将按需准备后续译文。');
  if(continuousEnabled)void ensureTranslations();return true;
}
async function ensureTranslations(){
  if(translationTask)return translationTask;
  const book=currentBook();if(!book||!continuousEnabled||explicitPause||busy||document.hidden)return;
  const bookId=book.id,epoch=translationEpoch;
  let prepared=false;
  translationTask=(async()=>{
    try{
      await readAlignmentWindow(book);
      if(currentBook()?.id!==bookId||translationEpoch!==epoch||!continuousEnabled||explicitPause||busy||document.hidden)return;
      let candidate=null;
      for(let index=book.position;index<Math.min(book.segments.length,book.position+4);index++){if(!book.segments[index].translation||!alignmentEntry(book,index).alignment){candidate=index;break;}}
      if(candidate===null)return;
      if(!state.settings.hasKey){stopContinuous();notice('翻译或中文词句对照需要 AI。请在左侧「翻译设置」保存 API Key，再点击开始连续练习；已有译文仍可直接练习。');return;}
      const source=book.segments[candidate].source,previousTranslation=book.segments[candidate].translation;
      translationIndex=candidate;translationBookId=bookId;renderControls();
      const retryFailed=manualTranslationRetry;manualTranslationRetry=false;
      const result=await api.preparePassage({bookId,index:candidate,retryFailed});const local=state.books.find(item=>item.id===bookId);if(!local||local.segments[candidate]?.source!==source||local.segments[candidate]?.translation!==previousTranslation)return;local.segments[candidate].translation=result.translation;
      const entry=alignmentEntry(local,candidate);entry.alignment=result.alignment;entry.loaded=true;prepared=true;
      if(currentBook()?.id===bookId){updateParagraph(candidate);if(currentBook().position===candidate&&!session?.target){session=new TypingSession(result.translation,currentBook().draft||'');mountActive({focus:continuousEnabled&&epoch===translationEpoch&&!explicitPause});}else if(currentBook().position===candidate)renderTarget();}
    }catch(error){if(currentBook()?.id===bookId&&epoch===translationEpoch){stopContinuous();notice('翻译与中文对照已停止：'+errorText(error)+' 点击开始练习可手动重试。',true);}}
    finally{translationTask=null;translationIndex=null;translationBookId=null;renderControls();if(continuousEnabled&&!explicitPause&&!busy&&(prepared||translationEpoch!==epoch))void ensureTranslations();}
  })();renderControls();return translationTask;
}
async function startPractice(){
  if(busy||!currentBook())return;
  if(saveFailure){try{await flushSave();}catch(error){saveError(error);return;}}
  explicitPause=false;continuousEnabled=true;manualTranslationRetry=true;translationEpoch++;notice('');
  if(session?.complete)advanceCompleted();renderControls();revealInput();void ensureTranslations();
}
async function runStateAction(action,successMessage=''){
  if(busy)return;if(activeView!=='reading'&&!(await switchView('reading')))return;resetChapterFeedback();stopContinuous();busy=true;renderControls();renderLibrary();try{await flushSave();const result=await action();if(result){normalizeState(result);renderLibrary();renderPassage();if(successMessage)notice(successMessage);}}catch(error){notice(errorText(error),true);}finally{busy=false;renderLibrary();renderControls();}
}
async function selectBook(id){if(activeView!=='reading'&&!(await switchView('reading')))return;if(id!==state.activeBookId)await runStateAction(()=>api.selectBook(id));}
async function chooseParagraph(position){const book=currentBook();if(!book||busy)return;if(position===book.position){revealInput();return;}resetChapterFeedback();stopContinuous();busy=true;renderControls();try{await flushSave();const saved=await api.saveProgress({bookId:book.id,position,draft:''});if(saved.bookId!==book.id)throw new Error('进度保存响应不一致，请重试。');typingFeedback.reset();book.position=saved.position;book.draft=saved.draft;book.stats=saved.stats;book.completed=[...new Set([...book.completed,...saved.completed])].sort((a,b)=>a-b);explicitPause=false;session=new TypingSession(currentSegment().translation||'',book.draft);liveTotals={characters:0,seconds:0,attempts:0,errors:0};mountActive({focus:true,scroll:true});notice('');}catch(error){notice(errorText(error),true);}finally{busy=false;renderLibrary();renderControls();if(!explicitPause&&!$('typing-input').disabled)$('typing-input').focus({preventScroll:true});}}
function pauseForDialog(){stopContinuous();gamesUI?.pause();explicitPause=true;renderControls();}
window.addEventListener('noveltype:appearance-open',pauseForDialog);
function lockImportDialog(id,locked){for(const control of $(id).querySelectorAll('button,input,textarea'))control.disabled=locked;$(id).dataset.saving=String(locked);}
function openSettings(message=''){pauseForDialog();$('provider').value=state.settings.provider||'glm';$('base-url').value=state.settings.baseUrl||presets.glm.baseUrl;$('model').value=state.settings.model||presets.glm.model;$('api-key').value='';$('clear-key').checked=false;updateKeyHelp();formMessage('settings-message',message);$('settings-dialog').showModal();}
function updateKeyHelp(){if(state.account?.connected){$("key-status").textContent=state.settings.hasKey?"（服务器已保存，留空保留）":"（服务器尚未设置）";$("api-key").placeholder="留空保留服务器上的 Key";$("key-help").textContent="API Key 加密保存在你的服务器，同一账号的其他电脑自动共用。更换接口需重新填写 Key。";return;}const changed=$('provider').value!==state.settings.provider;$('key-status').textContent=state.settings.hasKey&&!changed?'（已保存，留空保留）':'（尚未设置）';$('api-key').placeholder=state.settings.hasKey&&!changed?'留空保留已保存的 Key':'输入此服务商的 API Key';$('key-help').textContent=$('provider').value==='glm'?'使用智谱「标准 API Key」，Coding Plan 套餐 Key 不通用。API Key 仅在本机加密保存。':'密钥由 Windows 加密保存在本机，不包含在导出备份中。更换服务商时需重新输入。';}
$('typing-input').addEventListener('input',event=>{
  if(!session||busy||explicitPause||session.complete)return;
  if(/insertFromPaste|insertFromDrop|insertReplacementText/.test(event.inputType||'')){$('typing-input').value=session.value;return;}
  const before=session.value,errorsBefore=session.errors;
  session.resume(now());session.input($('typing-input').value,now());currentBook().draft=session.value;renderTarget();renderMetrics();
  typingFeedback.input({before,value:session.value,target:session.target,complete:session.complete,error:session.errors>errorsBefore,nodes:rows.get(currentBook().position)?.targetCache?.nodes});
  if(session.complete){if(advanceCompleted())return;const book=currentBook(),completion=session.claimCompletion(now());queueSave({...progressSnapshot(),...(!book.completed.includes(book.position)?{completed:book.position,...(completion?{session:completion}:{})}:{})},completion);if(!book.completed.includes(book.position))book.completed.push(book.position);renderLibrary();renderOverview();renderControls();}else scheduleSave();
});
for(const name of ['select','keyup','click'])$('typing-input').addEventListener(name,()=>{if(!movingInput&&session)renderTarget();});
for(const name of ['paste','drop'])$('typing-input').addEventListener(name,event=>{event.preventDefault();notice('练习区只接受逐字键盘输入。自己的译文可粘贴到「编辑本段译文」。');});
$('typing-input').addEventListener('beforeinput',event=>{if(/insertFromPaste|insertFromDrop|insertReplacementText/.test(event.inputType||''))event.preventDefault();});
$('typing-input').addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});
$('typing-input').addEventListener('focus',()=>{if(!movingInput&&!explicitPause)session?.resume(now());});
$('typing-input').addEventListener('blur',()=>{if(!movingInput){session?.pause(now());if(session?.hasStarted)scheduleSave();}});
window.addEventListener('blur',()=>{session?.pause(now());});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopContinuous();});
$('pause').addEventListener('click',()=>{if(explicitPause){void startPractice();return;}stopContinuous();explicitPause=true;renderControls();renderMetrics();});
$('translate').addEventListener('click',startPractice);
$('return-to-input').addEventListener('click',()=>revealInput());
$('reset').addEventListener('click',()=>{const book=currentBook();if(!book)return;resetChapterFeedback();stopContinuous();typingFeedback.reset();book.draft='';explicitPause=false;session=new TypingSession(currentSegment().translation||'');mountActive({focus:true});scheduleSave();});
for(const id of ['import-file','empty-import'])$(id).addEventListener('click',()=>runStateAction(()=>api.importFile(),'小说已加入长卷。开始连续练习后，会按顺序翻译并接续。'));
const observer=new IntersectionObserver(entries=>{if(activeView!=='reading')return;for(const entry of entries){if(entry.isIntersecting)loadMore(entry.target.id==='stream-top'?-1:1);}},{rootMargin:'600px 0px'});
observer.observe($('stream-top'));observer.observe($('stream-bottom'));


$('open-paste').addEventListener('click', async () => {
  if(activeView!=='reading'&&!(await switchView('reading')))return;
  pauseForDialog();
  formMessage('paste-message', '');
  $('paste-dialog').showModal();
});
$('paste-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  lockImportDialog('paste-dialog', true);
  formMessage('paste-message', '正在导入并分段…');
  try {
    await flushSave();
    const result = await api.importText({ title: $('paste-name').value.trim(), text: $('paste-text').value });
    normalizeState(result);
    renderLibrary();
    renderPassage();
    $('paste-dialog').close();
    $('paste-form').reset();
    notice('文字已加入长卷。点击「翻译并连续练习」，之后会自动接续。');
  } catch (error) {
    formMessage('paste-message', errorText(error), true);
  } finally {
    busy = false;
    lockImportDialog('paste-dialog', false);
    renderLibrary();
    renderControls();
  }
});

for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => {
  $('api-key').value = '';
});
for (const id of ['paste-dialog', 'edit-dialog']) $(id).addEventListener('cancel', (event) => {
  if ($(id).dataset.saving === 'true') event.preventDefault();
});
$('open-settings').addEventListener('click', () => openSettings());
$('provider').addEventListener('change', () => {
  const preset = presets[$('provider').value];
  $('base-url').value = preset.baseUrl;
  $('model').value = preset.model;
  $('api-key').value = '';
  $('clear-key').checked = false;
  updateKeyHelp();
  formMessage('settings-message', '服务商已更改，请检查地址并重新输入该服务商的 API Key。');
});
$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (settingsBusy) return;
  settingsBusy = true;
  $('save-settings').disabled = true;
  $('test-connection').disabled = true;
  formMessage('settings-message', '正在安全保存…');
  try {
    const payload = { provider: $('provider').value, baseUrl: $('base-url').value.trim(), model: $('model').value.trim() };
    if ($('api-key').value.trim()) payload.apiKey = $('api-key').value.trim();
    if ($('clear-key').checked) payload.clearKey = true;
    state.settings = await api.saveSettings(payload);
    $('api-key').value = '';
    $('clear-key').checked = false;
    updateKeyHelp();
    renderLibrary();
    $('translation-disclosure').textContent = '开始练习后准备英文和中文词句对照，提前缓存后面 3 小段；可随时暂停。滚动不请求 AI，API 可能计费。';
    formMessage('settings-message', state.settings.hasKey ? '设置已保存。可测试连接，或关闭后开始连续练习。' : '设置已保存。尚未保存 API Key；添加后才可请求翻译。');
  } catch (error) {
    formMessage('settings-message', errorText(error), true);
  } finally {
    $('api-key').value = '';
    settingsBusy = false;
    $('save-settings').disabled = false;
    $('test-connection').disabled = false;
  }
});
$('test-connection').addEventListener('click', async () => {
  if (settingsBusy) return;
  const changed = $('api-key').value || $('clear-key').checked || $('provider').value !== state.settings.provider || $('base-url').value.trim().replace(/\/$/, '') !== (state.settings.baseUrl || '').replace(/\/$/, '') || $('model').value.trim() !== state.settings.model;
  if (changed) return formMessage('settings-message', '请先保存更改，再测试连接。');
  settingsBusy = true;
  $('save-settings').disabled = true;
  $('test-connection').disabled = true;
  formMessage('settings-message', '正在发送一个最小测试请求，可能产生少量 API 费用…');
  try {
    const result = await api.testConnection();
    formMessage('settings-message', result.message || '连接成功，可开始翻译。');
  } catch (error) {
    formMessage('settings-message', errorText(error), true);
  } finally {
    settingsBusy = false;
    $('save-settings').disabled = false;
    $('test-connection').disabled = false;
  }
});

$('edit-translation').addEventListener('click', () => {
  pauseForDialog();
  editContext = { bookId: currentBook().id, index: currentBook().position };
  $('edit-text').value = currentSegment().translation || '';
  formMessage('edit-message', '');
  $('edit-dialog').showModal();
});
$('edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editContext || busy) return;
  busy = true;
  lockImportDialog('edit-dialog', true);
  formMessage('edit-message', '正在保存译文…');
  try {
    await flushSave();
    normalizeState(await api.setTranslation({ ...editContext, translation: $('edit-text').value.trim() }));
    renderLibrary();
    renderPassage();
    $('edit-dialog').close();
    notice('译文已保存，当前段落可以重新练习。');
  } catch (error) {
    formMessage('edit-message', errorText(error), true);
  } finally {
    busy = false;
    lockImportDialog('edit-dialog', false);
    renderLibrary();
    renderControls();
  }
});
$('export-backup').addEventListener('click', () => runStateAction(async () => {
  const result = await api.exportBackup();
  if (result) notice('备份已导出，包含书库和进度，不含 API Key。');
  return null;
}));
$('import-backup').addEventListener('click', () => runStateAction(() => api.importBackup(), '备份已恢复。API Key 不包含在备份内，请按需检查翻译设置。'));
$('open-folder').addEventListener('click', async () => {
  try { await api.openDataFolder(); } catch (error) { notice(errorText(error), true); }
});

api?.onBeforeClose?.(async () => {
  stopContinuous();
  gamesUI?.pause();
  session?.pause(now());
  await flushSave();
  await gamesUI?.flush();
});
setInterval(renderMetrics, 500);

async function switchView(view,options={}){
  if(viewBusy||busy)return false;
  viewBusy=true;
  try{
    resetChapterFeedback();
    gamesUI?.pause();stopContinuous();explicitPause=true;renderControls();
    await flushSave();await gamesUI?.flush();
    if(view==='reading')await gamesUI?.close();
    activeView=view;
    $('reading-area').hidden=view!=='reading';$('games-view').hidden=view==='reading';
    if(view==='reading')$('stream-toolbar').append(chapterNodes.panel);
    document.body.dataset.view=view;
    for(const name of ['reading','games','map'])$('nav-'+name).setAttribute('aria-current',name===view?'page':'false');
    $('view-title').textContent={reading:'阅读与练习',games:'打字游戏',map:'故事闯关'}[view];
    $('font-toggle').hidden=view!=='reading';notice('');window.scrollTo(0,0);
    if(view!=='reading')await gamesUI.open({bookId:state.activeBookId,view,...options});
    else if(readingChangedInGame){renderPassage();explicitPause=true;renderControls();readingChangedInGame=false;}
    return true;
  }catch(error){notice(errorText(error),true);return false;}
  finally{viewBusy=false;renderControls();}
}
gamesUI=createGamesUI({root:$('games-view'),api,onRead:()=>switchView('reading'),onContextChange:resetChapterFeedback,onReadingCompletion:({bookId,index,runId})=>{
  const book=currentBook();return book?.id===bookId?captureChapterCompletion(book,index,runId):null;
},onProgress:(saved,completion)=>{
  const book=state.books.find(item=>item.id===saved.bookId);if(!book)return;
  book.position=saved.position;book.draft=saved.draft;book.completed=saved.completed;book.stats=saved.stats;
  if(book.id===state.activeBookId){session=new TypingSession(book.segments[book.position].translation||'',book.draft||'');liveTotals={characters:0,seconds:0,attempts:0,errors:0};typingFeedback.reset();}
  readingChangedInGame=true;renderLibrary();renderOverview();
  if(book.id===state.activeBookId&&completion?.status==='advanced')showChapterFeedback(chapterFeedback.confirm(completion.chapterReceipt,saved.completed));
},onTranslation:({bookId,index,translation})=>{
  const book=state.books.find(item=>item.id===bookId);if(!book?.segments[index])return;
  book.segments[index].translation=translation;readingChangedInGame=true;
  // Explicit game preparation may finish after the user has returned to reading.
  // Install the cached target without resuming practice or making another request.
  if(activeView==='reading'&&book.id===state.activeBookId){
    updateParagraph(index);
    if(index===book.position&&!session?.target){session=new TypingSession(translation,book.draft||'');mountActive({focus:false});}
    else if(index===book.position)renderTarget();
    readingChangedInGame=false;renderControls();
  }
},onViewChange:view=>{
  if(activeView==='reading')return;
  activeView=view;document.body.dataset.view=view;
  for(const name of ['reading','games','map'])$('nav-'+name).setAttribute('aria-current',name===view?'page':'false');
  $('view-title').textContent=view==='map'?'故事闯关':'打字游戏';
}});
for(const view of ['reading','games','map'])$('nav-'+view).addEventListener('click',()=>switchView(view));
function preference(key,fallback){try{return localStorage.getItem(key)||fallback;}catch{return fallback;}}
function storePreference(key,value){try{localStorage.setItem(key,value);}catch{/* Appearance remains usable if browser storage is unavailable. */}}
document.body.dataset.theme=preference('noveltype-theme',matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
document.body.dataset.font=['normal','large','largest'].includes(preference('noveltype-font','normal'))?preference('noveltype-font','normal'):'normal';
$('theme-toggle').addEventListener('click',()=>{document.body.dataset.theme=document.body.dataset.theme==='dark'?'light':'dark';storePreference('noveltype-theme',document.body.dataset.theme);});
$('font-toggle').addEventListener('click',()=>{const sizes=['normal','large','largest'];document.body.dataset.font=sizes[(sizes.indexOf(document.body.dataset.font)+1)%3];storePreference('noveltype-font',document.body.dataset.font);});
$('focus-toggle').addEventListener('click',()=>{const focus=document.body.classList.toggle('focus-mode');$('focus-toggle').setAttribute('aria-pressed',String(focus));$('focus-toggle').textContent=focus?'退出专注':'专注';});

async function changeAccount(action){
  if(busy)throw new Error('请等待当前操作完成。');
  if(activeView!=='reading'&&!(await switchView('reading')))throw new Error('请先暂停游戏。');
  stopContinuous();await flushSave();busy=true;renderControls();
  try{normalizeState(await action());renderLibrary();renderPassage();}
  catch(error){normalizeState(await api.getState());renderLibrary();renderPassage();throw error;}
  finally{busy=false;renderControls();}
}
setupAccount({api,changeAccount,beforeOpen:pauseForDialog,settingsChanged:value=>{state.settings=value;renderLibrary();}});
async function initialize() {
  try {
    if (!api) throw new Error('请通过 NovelType 桌面应用打开此页面。');
    normalizeState(await api.getState());
    if(state.account?.connected){$('save-state').textContent='正在同步账号…';try{normalizeState(await api.syncAccount());}catch(error){notice('当前使用本机缓存：'+errorText(error),true);}}
    renderLibrary();
    renderPassage();
    if (session?.complete && currentBook().position < currentBook().segments.length - 1) advanceCompleted();
    $('save-state').textContent = savePending.length ? '正在保存…' : '✓ 本机书库已就绪';
  } catch (error) {
    $('save-state').textContent = '打开失败';
    notice(errorText(error), true);
  }
}
initialize();
