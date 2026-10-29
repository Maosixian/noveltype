import { TypingSession, charactersMatch } from './typing.mjs';
import { initialRange, extendRange, nextPosition, translationCandidate } from './stream.mjs';
const $=id=>document.getElementById(id);
const api=window.novel;
const presets={glm:{label:'智谱 GLM',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4.7-flash'},deepseek:{label:'DeepSeek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},openai:{label:'OpenAI',baseUrl:'https://api.openai.com/v1',model:'gpt-4o-mini'},custom:{label:'自定义服务',baseUrl:'',model:''}};
let state={books:[],activeBookId:null,settings:{}};
let session=null,busy=false,explicitPause=false,settingsBusy=false,editContext=null;
let continuousEnabled=false,translationTask=null,translationIndex=null,translationBookId=null,translationEpoch=0;
let saveTimer,savePromise=null,saveFailure=false,movingInput=false,range={start:0,end:0};
let liveTotals={characters:0,seconds:0,attempts:0,errors:0};
const savePending=[];
const rows=new Map();
const currentBook=()=>state.books.find(book=>book.id===state.activeBookId);
const currentSegment=()=>currentBook()?.segments[currentBook().position];
const now=()=>performance.now();
const providerName=()=>presets[state.settings.provider]?.label||'自定义服务';
const errorText=error=>error?.message||'操作未完成，请重试。';
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=!message;}
function formMessage(id,message,error=false){$(id).textContent=message;$(id).classList.toggle('error',error);}
function normalizeState(next){state=next;if(!state.books.some(book=>book.id===state.activeBookId))state.activeBookId=state.books[0]?.id||null;}
function stopContinuous(){continuousEnabled=false;translationEpoch++;session?.pause(now());}
function saveError(error){saveFailure=true;stopContinuous();explicitPause=true;$('save-state').textContent='保存失败 · 待重试';notice('进度仍在等待保存：'+errorText(error)+' 点击继续可重试，请暂时不要关闭软件。',true);renderControls();}
function progressSnapshot(){const book=currentBook();if(!book)return null;book.draft=session?.value??book.draft??'';return {bookId:book.id,position:book.position,draft:book.draft};}
function drainSaves(){
  if(savePromise)return savePromise;
  savePromise=(async()=>{
    while(savePending.length){
      const snapshot=savePending[0];
      const saved=await api.saveProgress(snapshot);
      const local=state.books.find(book=>book.id===snapshot.bookId),persisted=saved.books.find(book=>book.id===snapshot.bookId);
      if(local&&persisted){local.stats=persisted.stats;local.completed=[...new Set([...local.completed,...persisted.completed])].sort((a,b)=>a-b);}
      savePending.shift();
      if(snapshot.completed!==undefined){renderLibrary();renderOverview();}
    }
    saveFailure=false;$('save-state').textContent='✓ 已保存到本机';
  })().finally(()=>{savePromise=null;});
  return savePromise;
}
function queueSave(snapshot){
  if(!snapshot)return;
  const last=savePending.at(-1);
  // Only collapse an unstarted plain draft; never drop a completion or the head in flight.
  if(last&&savePending.length>1&&last.completed===undefined&&snapshot.completed===undefined&&last.bookId===snapshot.bookId&&last.position===snapshot.position)savePending[savePending.length-1]=snapshot;
  else savePending.push(snapshot);
  $('save-state').textContent='正在保存…';
  if(!saveFailure)void drainSaves().catch(saveError);
}
function scheduleSave(){clearTimeout(saveTimer);$('save-state').textContent=saveFailure?'保存失败 · 待重试':'等待保存…';saveTimer=setTimeout(()=>{saveTimer=null;queueSave(progressSnapshot());},400);}
async function flushSave(){clearTimeout(saveTimer);saveTimer=null;queueSave(progressSnapshot());if(savePromise)await savePromise.catch(()=>{});if(savePending.length)await drainSaves();}
function renderLibrary(){
  $('book-count').textContent=String(state.books.length).padStart(2,'0');const fragment=document.createDocumentFragment();
  for(const book of state.books){const button=document.createElement('button');button.className='book-button';button.type='button';button.setAttribute('aria-current',String(book.id===state.activeBookId));button.disabled=busy;button.title=book.title;const spine=document.createElement('span');spine.className='book-spine';spine.setAttribute('aria-hidden','true');const info=document.createElement('span');info.className='book-info';const title=document.createElement('strong');title.textContent=book.title;const meta=document.createElement('small');meta.textContent=`${book.demo?'示例 · ':''}${book.completed.length} / ${book.segments.length} 段已完成`;info.append(title,meta);button.append(spine,info);button.addEventListener('click',()=>selectBook(book.id));fragment.append(button);}
  $('book-list').replaceChildren(fragment);$('provider-badge').textContent=state.settings.hasKey?providerName():'未配置';
}
function renderOverview(){const book=currentBook();if(!book)return;const total=book.segments.length,completed=book.completed.length,percentage=Math.round(completed/total*100);$('book-title').textContent=book.title;$('demo-label').hidden=!book.demo;$('book-meta').textContent=`连续长卷 · ${total} 段 · ${book.demo?'原创双语示例':'本机书库，自动保存'}`;$('book-progress-label').textContent=`已完成 ${percentage}%`;$('book-progress').value=percentage;$('completed-count').textContent=`${completed} / ${total} 段`;$('stream-position').textContent=`正在输入 第 ${book.position+1} / ${total} 段`;$('footer-total').textContent=`已完成 ${book.stats.sessions} 次段落练习 · 累计输入 ${book.stats.characters} 字符`;}
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
  for(const row of rows.values())row.querySelector('.practice-here').disabled=busy;
}
function renderMetrics(){const snap=session?.snapshot(now());const seconds=liveTotals.seconds+(snap?.seconds||0),characters=liveTotals.characters+(snap?.characters||0),attempts=liveTotals.attempts+(snap?.attempts||0),errors=liveTotals.errors+(snap?.errors||0);$('wpm').textContent=String(seconds>=1?Math.round(characters/5/(seconds/60)):0);$('accuracy').textContent=String(attempts?Math.round((attempts-errors)/attempts*100):100);$('elapsed').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;}
function createParagraph(index){
  const book=currentBook(),segment=book.segments[index],row=document.createElement('article');row.className='story-passage';row.dataset.index=String(index);
  const heading=document.createElement('div');heading.className='story-passage-heading';const label=document.createElement('span');label.className='paragraph-number';label.textContent=String(index+1).padStart(3,'0');const status=document.createElement('span');status.className='paragraph-status';const select=document.createElement('button');select.type='button';select.className='practice-here button text-button';select.textContent='从这里练习';select.addEventListener('click',()=>chooseParagraph(index));heading.append(label,status,select);
  const source=document.createElement('p');source.className='stream-source';source.textContent=segment.source;
  const english=document.createElement('p');english.className='stream-english';english.lang='en';row.append(heading,source,english);rows.set(index,row);updateParagraph(index);return row;
}
function updateParagraph(index){const row=rows.get(index),book=currentBook();if(!row||!book)return;const segment=book.segments[index],active=index===book.position;row.classList.toggle('is-complete',book.completed.includes(index));row.classList.toggle('is-active',active);row.querySelector('.paragraph-status').textContent=active?'当前输入':book.completed.includes(index)?'已练习':segment.translation?'译文已就绪':'待练习时翻译';row.querySelector('.practice-here').hidden=active;if(!active){row.querySelector('.stream-english').textContent=segment.translation||'开始练习后，将按顺序准备英文译文。';row.querySelector('.stream-english').classList.toggle('untranslated',!segment.translation);}}
function renderTarget(){const row=rows.get(currentBook()?.position);if(!row)return;const target=row.querySelector('.stream-english'),expected=Array.from(currentSegment()?.translation||''),value=Array.from(session?.value||'');target.classList.toggle('untranslated',!expected.length);const frag=document.createDocumentFragment();if(!expected.length){target.textContent='这一段的英文译文还在等待准备。';}else{expected.forEach((character,index)=>{const span=document.createElement('span');span.textContent=character;span.className='target-char';if(index<value.length)span.classList.add(charactersMatch(value[index],character)?'correct':'wrong');if(index===value.length&&!session?.complete)span.classList.add('caret');if(character===' ')span.classList.add('space');frag.append(span);});if(value.length>expected.length){const extra=document.createElement('span');extra.className='target-char wrong';extra.textContent=value.slice(expected.length).join('');frag.append(extra);}target.replaceChildren(frag);}$('character-count').textContent=`${value.length} / ${expected.length}`;}
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
  for(const [index,row] of rows){row.querySelector('.stream-source').removeAttribute('id');row.querySelector('.stream-english').removeAttribute('id');updateParagraph(index);}
  const row=rows.get(book.position);row.querySelector('.stream-source').id='source-text';row.querySelector('.stream-english').id='translation-text';row.append($('typing-panel'));$('typing-input').value=session?.value||'';$('typing-input').setSelectionRange($('typing-input').value.length,$('typing-input').value.length);renderTarget();renderOverview();renderControls();renderMetrics();movingInput=false;
  if(scroll)revealInput(focus);else if(focus&&!$('typing-input').disabled)$('typing-input').focus({preventScroll:true});
}
function renderPassage(){
  stopContinuous();explicitPause=false;const book=currentBook();$('reading-view').hidden=!book;$('empty-state').hidden=Boolean(book);movingInput=true;$('input-parking').append($('typing-panel'));rows.clear();$('story-stream').replaceChildren();movingInput=false;liveTotals={characters:0,seconds:0,attempts:0,errors:0};
  if(!book){session=null;renderControls();return;}
  range=initialRange(book.segments.length,book.position);for(let i=range.start;i<range.end;i++)$('story-stream').append(createParagraph(i));session=new TypingSession(currentSegment().translation||'',book.draft||'');renderSentinels();mountActive({scroll:book.position>0});
}
function advanceCompleted(){
  const book=currentBook();if(!book||!session?.complete)return false;const next=nextPosition(book.position,book.segments.length,true);if(next===book.position){stopContinuous();renderControls();return false;}
  clearTimeout(saveTimer);saveTimer=null;const snapshot=session.snapshot(now());const completion=session.claimCompletion(now());
  queueSave({...progressSnapshot(),...(!book.completed.includes(book.position)?{completed:book.position,...(completion?{session:completion}:{})}:{})});
  if(!book.completed.includes(book.position))book.completed.push(book.position);
  liveTotals.characters+=snapshot.characters;liveTotals.seconds+=snapshot.seconds;liveTotals.attempts+=snapshot.attempts;liveTotals.errors+=snapshot.errors;
  book.position=next;book.draft='';session=new TypingSession(currentSegment().translation||'');mountActive({focus:true,scroll:true});queueSave(progressSnapshot());renderLibrary();
  if(!currentSegment().translation&&!continuousEnabled)notice('已自动接到下一段。点击「翻译并连续练习」后，将按需准备后续译文。');
  if(continuousEnabled)void ensureTranslations();return true;
}
async function ensureTranslations(){
  if(translationTask)return translationTask;
  const book=currentBook();if(!book||!continuousEnabled||explicitPause||busy||document.hidden)return;
  const candidate=translationCandidate(book.segments,book.position,true);if(candidate===null)return;
  if(!state.settings.hasKey){stopContinuous();notice('下一小段需要翻译。请在左侧「翻译设置」保存 API Key，再点击开始连续练习；也可编辑译文。');renderControls();return;}
  const bookId=book.id,source=book.segments[candidate].source,epoch=translationEpoch;translationIndex=candidate;translationBookId=bookId;
  translationTask=(async()=>{
    try{const result=await api.translate({bookId,index:candidate});const local=state.books.find(item=>item.id===bookId);if(!local||local.segments[candidate]?.source!==source)return;local.segments[candidate].translation=result.translation;
      if(currentBook()?.id===bookId){updateParagraph(candidate);if(currentBook().position===candidate&&!session?.target){session=new TypingSession(result.translation,currentBook().draft||'');mountActive({focus:continuousEnabled&&epoch===translationEpoch&&!explicitPause});}else if(currentBook().position===candidate)renderTarget();}
    }catch(error){if(currentBook()?.id===bookId&&epoch===translationEpoch){stopContinuous();notice('翻译已停止：'+errorText(error)+' 点击「翻译并连续练习」手动重试。',true);}}
    finally{translationTask=null;translationIndex=null;translationBookId=null;renderControls();if(continuousEnabled&&!explicitPause&&!busy)void ensureTranslations();}
  })();renderControls();return translationTask;
}
async function startPractice(){
  if(busy||!currentBook())return;
  if(saveFailure){try{await flushSave();}catch(error){saveError(error);return;}}
  explicitPause=false;continuousEnabled=true;translationEpoch++;notice('');
  if(session?.complete)advanceCompleted();renderControls();revealInput();void ensureTranslations();
}
async function runStateAction(action,successMessage=''){
  if(busy)return;stopContinuous();busy=true;renderControls();renderLibrary();try{await flushSave();const result=await action();if(result){normalizeState(result);renderLibrary();renderPassage();if(successMessage)notice(successMessage);}}catch(error){notice(errorText(error),true);}finally{busy=false;renderLibrary();renderControls();}
}
async function selectBook(id){if(id!==state.activeBookId)await runStateAction(()=>api.selectBook(id));}
async function chooseParagraph(position){const book=currentBook();if(!book||busy)return;if(position===book.position){revealInput();return;}stopContinuous();busy=true;renderControls();try{await flushSave();normalizeState(await api.saveProgress({bookId:book.id,position,draft:''}));explicitPause=false;session=new TypingSession(currentSegment().translation||'');liveTotals={characters:0,seconds:0,attempts:0,errors:0};mountActive({focus:true,scroll:true});notice('');}catch(error){notice(errorText(error),true);}finally{busy=false;renderLibrary();renderControls();if(!explicitPause&&!$('typing-input').disabled)$('typing-input').focus({preventScroll:true});}}
function pauseForDialog(){stopContinuous();explicitPause=true;renderControls();}
function lockImportDialog(id,locked){for(const control of $(id).querySelectorAll('button,input,textarea'))control.disabled=locked;$(id).dataset.saving=String(locked);}
function openSettings(message=''){pauseForDialog();$('provider').value=state.settings.provider||'glm';$('base-url').value=state.settings.baseUrl||presets.glm.baseUrl;$('model').value=state.settings.model||presets.glm.model;$('api-key').value='';$('clear-key').checked=false;updateKeyHelp();formMessage('settings-message',message);$('settings-dialog').showModal();}
function updateKeyHelp(){const changed=$('provider').value!==state.settings.provider;$('key-status').textContent=state.settings.hasKey&&!changed?'（已保存，留空保留）':'（尚未设置）';$('api-key').placeholder=state.settings.hasKey&&!changed?'留空保留已保存的 Key':'输入此服务商的 API Key';$('key-help').textContent=$('provider').value==='glm'?'使用智谱「标准 API Key」，Coding Plan 套餐 Key 不通用。API Key 仅在本机加密保存。':'密钥由 Windows 加密保存在本机，不包含在导出备份中。更换服务商时需重新输入。';}
$('typing-input').addEventListener('input',event=>{
  if(!session||busy||explicitPause||session.complete)return;
  if(/insertFromPaste|insertFromDrop|insertReplacementText/.test(event.inputType||'')){$('typing-input').value=session.value;return;}
  session.resume(now());session.input($('typing-input').value,now());currentBook().draft=session.value;renderTarget();renderMetrics();
  if(session.complete){if(advanceCompleted())return;const book=currentBook(),completion=session.claimCompletion(now());queueSave({...progressSnapshot(),...(!book.completed.includes(book.position)?{completed:book.position,...(completion?{session:completion}:{})}:{})});if(!book.completed.includes(book.position))book.completed.push(book.position);renderLibrary();renderOverview();renderControls();}else scheduleSave();
});
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
$('reset').addEventListener('click',()=>{const book=currentBook();if(!book)return;stopContinuous();book.draft='';explicitPause=false;session=new TypingSession(currentSegment().translation||'');mountActive({focus:true});scheduleSave();});
for(const id of ['import-file','empty-import'])$(id).addEventListener('click',()=>runStateAction(()=>api.importFile(),'小说已加入长卷。开始连续练习后，会按顺序翻译并接续。'));
const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting)loadMore(entry.target.id==='stream-top'?-1:1);}},{rootMargin:'600px 0px'});
observer.observe($('stream-top'));observer.observe($('stream-bottom'));


$('open-paste').addEventListener('click', () => {
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
    if (!currentSegment()?.translation) $('translation-disclosure').textContent = `连续练习时只准备当前及下一小段；可随时暂停。API 服务商可能计费。`;
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
  session?.pause(now());
  await flushSave();
});
setInterval(renderMetrics, 500);

async function initialize() {
  try {
    if (!api) throw new Error('请通过 NovelType 桌面应用打开此页面。');
    normalizeState(await api.getState());
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
