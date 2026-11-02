import {buildWordPool, RaceSession, DefenseSession, LEVELS, isLevelUnlocked, levelStars, paragraphRaceTimeLimit} from './games.mjs';
import {charactersMatch} from './typing.mjs';

const terminal = state => ['won','lost','ended'].includes(state);
const clock = () => performance.now();
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function button(text, id, action, className='game-button') {
  const node = el('button', className, text); node.type = 'button';
  if (id) node.id = id;
  if (action) node.addEventListener('click', action);
  return node;
}
function svg(paths, viewBox='0 0 24 24') {
  const node = document.createElementNS('http://www.w3.org/2000/svg','svg');
  node.setAttribute('viewBox', viewBox); node.setAttribute('aria-hidden','true');
  for (const d of paths) {
    const path = document.createElementNS(node.namespaceURI,'path'); path.setAttribute('d',d); node.append(path);
  }
  return node;
}
const icons = {
  race:['M4 19V4m0 1c5-4 10 4 16 0v9c-6 4-11-4-16 0'],
  defense:['M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7L12 3Z','m8 12 3 3 5-6'],
  map:['m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z','M9 3v16m6-14v16'],
};

/** Game UI owns round state. Durable reading progress comes only from a validated full-race result. */
export function createGamesUI({root, api, onRead, onViewChange, onProgress, onTranslation}) {
  let data=null, requestedBookId=null, view='games', engine=null, mode=null, level=null, passage=null;
  let runId=null, raf=null, active=false, generation=0, finished=false, lastSnapshot=null;
  let pending=null, savePromise=null, saveError=null, origin='games', opponent='35';
  let selected=null, selectionRevision=0, selectionBusy=false, preparing=false, prepareError=null, starting=false, readingStatus=null;
  let raceObserver=null, raceLayout=null, interactionEpoch=0;
  const $ = id => root.querySelector('#'+id);
  const nodes = new Map();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let lastRaceValue=null, raceChars=[], raceSpans=[], raceOverflow=null, previousRaceChars=[];
  let stageHeight=250, stageObserver=null, hud=new Map(), effects=new Set(), lastFeedbackAt=0, lastFrameAt=0;
  const motionLimited=()=>reducedMotion.matches||['off','reduced'].includes(document.documentElement.dataset.motion);
  const text=(id,value)=>{const next=String(value);if(hud.get(id)===next)return;const node=$(id);if(node){node.textContent=next;hud.set(id,next);}};
  function animate(node,keyframes,options={}){
    if(!node||motionLimited())return;
    const animation=node.animate(keyframes,{duration:180,easing:'cubic-bezier(.16,1,.3,1)',...options});
    effects.add(animation);animation.finished.catch(()=>{}).finally(()=>effects.delete(animation));return animation;
  }
  function clearEffects(){for(const effect of effects)effect.cancel();effects.clear();root.querySelectorAll('.game-impact').forEach(node=>node.remove());}
  function impact(node,good=true){
    if(!node||clock()-lastFeedbackAt<70)return;lastFeedbackAt=clock();
    animate(node,good?[{scale:'.94'},{scale:'1'}]:[{transform:'translateX(0)'},{transform:'translateX(-3px)'},{transform:'translateX(2px)'},{transform:'translateX(0)'}],{duration:good?130:160});
  }
  function hitEffect(node){
    if(!node||motionLimited())return;
    const burst=el('span','game-impact');burst.append(svg(['M20 2v6m0 24v6M2 20h6m24 0h6M7 7l4 4m18 18 4 4M7 33l4-4m18-18 4-4'],'0 0 40 40'));burst.setAttribute('aria-hidden','true');burst.style.left=node.style.left;burst.style.transform=node.style.transform;
    $('game-enemies')?.append(burst);
    const animation=animate(burst,[{opacity:1,scale:'.5'},{opacity:.9,scale:'1.4',offset:.35},{opacity:0,scale:'1.9'}],{duration:360});
    animation?.finished.catch(()=>{}).finally(()=>burst.remove());
  }
  function invalidatePending(){interactionEpoch++;starting=false;selectionBusy=false;preparing=false;const control=$('game-start');if(control&&!engine)control.disabled=false;}
  function resetView(){invalidatePending();clearEffects();hud.clear();stageObserver?.disconnect();stageObserver=null;raceObserver?.disconnect();raceObserver=null;raceLayout=null;root.replaceChildren();}


  function message(text, error=false) {
    let node=$('game-notice');
    if (!node) {node=el('p','game-notice');node.id='game-notice';node.setAttribute('role','status');root.prepend(node);}
    node.textContent=text;node.classList.toggle('is-error',error);node.hidden=!text;
  }
  function saveStatus() {
    const node=$('game-save-status'); if (!node) return;
    node.textContent=saveError?'成绩或阅读进度尚未保存：'+(saveError.message||'本机写入失败。'):savePromise?'正在保存本局结果…':pending?'等待保存本局结果…':'成绩已保存到本机';
    node.classList.toggle('is-error',Boolean(saveError));
    const retry=$('game-retry-save');if(retry)retry.hidden=!saveError;
    for(const id of ['game-next','game-next-paragraph']){const next=$(id);if(next)next.disabled=Boolean(pending||savePromise||saveError);}
    if(!pending&&!savePromise&&!saveError&&readingStatus)node.textContent=readingStatus==='advanced'?'成绩与阅读进度已保存。':readingStatus==='context-changed'?'成绩已保存；阅读位置已在其他地方改变，保留当前阅读位置。':'成绩已保存；保留现有阅读位置。';
  }
  async function persist(retry=false) {
    if(savePromise)return savePromise;
    if(!pending)return;
    if(saveError&&!retry)throw saveError;
    const payload=pending;
    saveError=null;
    savePromise=api.saveGameResult(payload).then(progress=>{
      if(data?.bookId===payload.bookId){const {readingProgress,readingStatus:status,...gameProgress}=progress;data.progress=gameProgress;readingStatus=status||null;if(readingProgress){if(selected)selected.position=readingProgress.position;onProgress?.(readingProgress);}}
      if(pending===payload)pending=null;
    }).catch(error=>{saveError=error;throw error;}).finally(()=>{savePromise=null;saveStatus();});
    saveStatus();return savePromise;
  }
  async function flush(){if(savePromise)await savePromise;if(pending)await persist();}
  function cancelFrame(){if(raf!==null)cancelAnimationFrame(raf);raf=null;}
  function clearRun(){invalidatePending();cancelFrame();clearEffects();stageObserver?.disconnect();stageObserver=null;engine=null;mode=null;level=null;passage=null;nodes.clear();lastRaceValue=null;raceChars=[];raceSpans=[];previousRaceChars=[];finished=false;readingStatus=null;}
  async function navigate(fn) {
    invalidatePending();pause();
    try{await flush();await fn();}catch(error){message('请先重试保存本局成绩，再离开游戏。'+(error.message||''),true);}
  }
  function header(title, detail) {
    const head=el('header','game-heading'),copy=el('div');copy.append(el('h1','',title),el('p','game-description',detail));head.append(copy);root.append(head);
  }
  const selectedBook=()=>Boolean(selected&&data?.bookId!=='sample');
  const sourcePassages=(short=false)=>selectedBook()?(selected.passage?[short?selected.excerpt:selected.passage].filter(Boolean):[]):(data?.passages||[]);
  const fullRace=()=>mode==='race'&&!level&&selectedBook()&&passage?.full===true;
  const roundTime=()=>level?.timeLimit||(fullRace()?paragraphRaceTimeLimit(passage.translation):180);
  function sourceStrip() {
    const strip=el('div','game-source-strip'),copy=el('div');
    copy.append(el('span','game-kicker','练习素材'),el('strong','',data.title));
    strip.append(copy,el('span','game-source-count',selectedBook()?`第 ${selected.index+1} / ${selected.total} 段 · ${selected.pending?'尚未翻译':'本段英文已缓存'}`:`${data.passages.length} 段原创示例`));
    if(data.bookId!=='sample')strip.append(button('使用原创示例', 'game-use-sample',()=>navigate(()=>load('sample',view)),'game-link'));
    else if(requestedBookId&&requestedBookId!=='sample')strip.append(button('使用当前小说','game-use-book',()=>navigate(()=>load(requestedBookId,view)),'game-link'));
    root.append(strip);if(selectedBook())root.append(paragraphPicker());
  }
  function paragraphPicker(){
    const picker=el('div','game-paragraph-picker');
    const label=el('label','','小说段落');label.htmlFor='game-paragraph-index';
    const input=el('input');input.type='number';input.id='game-paragraph-index';input.min='1';input.max=String(selected.total);input.step='1';input.value=String(selected.index+1);input.setAttribute('aria-label',`选择小说段落，1 到 ${selected.total}`);
    const load=()=>{const value=Number(input.value);if(!Number.isInteger(value)||value<1||value>selected.total){message(`请输入 1 到 ${selected.total} 之间的段号。`,true);return;}void chooseParagraph(value-1);};
    input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();load();}});
    picker.append(label,input,el('span','game-paragraph-total',`/ ${selected.total}`),button('跳转','game-paragraph-load',load),button('当前阅读段','game-paragraph-current',()=>void chooseParagraph(undefined),'game-link'));
    const previous=button('上一段','game-paragraph-prev',()=>void chooseParagraph(selected.index-1),'game-link');previous.disabled=selected.index===0;
    const next=button('下一段','game-paragraph-next',()=>void chooseParagraph(selected.index+1),'game-link');next.disabled=selected.index>=selected.total-1;
    picker.append(previous,next);return picker;
  }
  function lockSelection(locked){
    for(const node of root.querySelectorAll('.game-paragraph-picker button,.game-paragraph-picker input'))node.disabled=locked;
    if(!locked&&selected){if($('game-paragraph-prev'))$('game-paragraph-prev').disabled=selected.index===0;if($('game-paragraph-next'))$('game-paragraph-next').disabled=selected.index>=selected.total-1;}
  }
  async function chooseParagraph(index){
    if(selectionBusy||preparing||starting)return;
    await navigate(async()=>{
      const token=++selectionRevision,context=generation,epoch=interactionEpoch,nextMode=mode,nextLevel=level,screen=root.dataset.screen;
      selectionBusy=true;lockSelection(true);
      try{
        const next=await api.getGamePassage({bookId:data.bookId,...(index===undefined?{}:{index})});
        if(token!==selectionRevision||context!==generation||epoch!==interactionEpoch||!active)return;
        selected=next;prepareError=null;clearRun();
        if(screen==='arena'){mode=nextMode;level=nextLevel;selectPassage(0);renderArena();}else if(screen==='map')renderMap();else renderHome();
      }catch(error){if(context===generation&&epoch===interactionEpoch)message('无法打开这一段：'+(error.message||''),true);}
      finally{if(context===generation&&epoch===interactionEpoch){selectionBusy=false;if(!engine&&!preparing)lockSelection(false);}}
    });
  }
  function renderPending(){
    const card=el('section','game-empty game-pending');card.append(el('h2','',`第 ${selected.index+1} 段还没有英文`),el('p','game-pending-source',selected.source||'这一段尚未准备译文。'),el('p','','点击下方按钮后，只准备当前这一段。切换段落和打开游戏不会请求 AI。'));
    const prepare=button(preparing?'正在准备本段…':prepareError?'重试准备本段译文':'准备本段译文','game-prepare',()=>void prepareSelected(),'game-button is-primary');prepare.disabled=preparing;
    card.append(prepare);if(prepareError){const error=el('p','is-error',prepareError);error.setAttribute('role','status');card.append(error);}
    root.append(card);
  }
  async function prepareSelected(){
    if(preparing||selectionBusy||starting||!selectedBook())return;
    const context=generation,epoch=interactionEpoch,index=selected.index,bookId=data.bookId,revision=selectionRevision,retryFailed=Boolean(prepareError);
    preparing=true;prepareError=null;lockSelection(true);const control=$('game-prepare');if(control){control.disabled=true;control.textContent='正在准备本段…';}
    try{
      const result=await api.preparePassage({bookId,index,retryFailed});
      onTranslation?.({bookId,index,translation:result.translation});
      if(context!==generation||epoch!==interactionEpoch||revision!==selectionRevision||!active)return;
      const refreshed=await api.getGamePassage({bookId,index});
      if(context!==generation||epoch!==interactionEpoch||revision!==selectionRevision||!active)return;
      selected=refreshed;
      const screen=root.dataset.screen;preparing=false;
      if(screen==='arena'){selectPassage(0);renderArena();}else if(screen==='map')renderMap();else renderHome();
    }catch(error){if(context===generation&&epoch===interactionEpoch&&revision===selectionRevision){prepareError=error.message||'准备失败。没有自动重试。';const screen=root.dataset.screen;preparing=false;if(screen==='arena')renderArena();else if(screen==='map')renderMap();else renderHome();}}
    finally{if(context===generation&&epoch===interactionEpoch){preparing=false;lockSelection(false);}}
  }
  function renderEmpty(){
    const block=el('section','game-empty');block.append(svg(icons.race),el('h2','','这本书还没有可用的英文素材'),el('p','','先回到阅读页翻译一小段，或立即用原创示例开始。打开游戏不会请求翻译。'));
    const actions=el('div','game-actions');actions.append(button('用原创示例开始','game-empty-sample',()=>navigate(()=>load('sample',view)),'game-button is-primary'),button('回到阅读','game-empty-read',()=>navigate(()=>onRead?.())));block.append(actions);root.append(block);
  }
  function renderHome(){
    clearRun();view='games';onViewChange?.(view);resetView();root.dataset.screen='home';root.dataset.paragraph=String(selectedBook());
    header('故事里的游乐场','沿着喜欢的文字，练出自己的节奏。');sourceStrip();
    if(!sourcePassages().length&&!selectedBook()){renderEmpty();return;}
    const stars=Object.values(data.progress.levels||{}).reduce((total,item)=>total+(item.stars||0),0);
    const hero=el('section','game-world-hero'),copy=el('div','game-world-copy');
    copy.append(el('span','game-world-label','故事远征 · 三章十二关'),el('h2','','下一程，\n向灯塔出发。'),el('p','','从晨光港湾到星夜灯塔，\n每一个敲下的词，都会让你更近一步。'),button(stars?'继续远征 →':'打开闯关地图 →','game-map-open',renderMap,'game-button is-primary'));
    hero.append(copy,el('span','game-world-progress',`已收集 ${stars} / 36 颗星`));root.append(hero);
    const choices=el('div','game-choices');
    for(const item of [{mode:'race',title:'沿海竞速',detail:'跟着故事加速，挑战自己的最佳节奏。',tag:'速度与准确',cta:'开始竞速 →'},{mode:'defense',title:'灯塔守卫',detail:'看准来袭的词，一次连击守住整片海湾。',tag:'反应与拼写',cta:'进入防御战 →'}]){
      const tile=el('section','game-choice game-choice-'+item.mode),content=el('div');
      content.append(el('span','game-choice-label',item.tag),el('h2','',item.title),el('p','',item.detail),button(item.cta,'game-'+item.mode+'-open',()=>launch(item.mode,null),'game-link'));tile.append(content);choices.append(tile);
    }
    root.append(choices,el('p','game-footnote',selectedBook()?'三个游戏都使用所选段落。完整段落竞速完成后保存阅读进度；防御与地图挑战只保存游戏成绩。':'原创示例可直接试玩。大小写自由，成绩单独保存。'));
  }
  function renderMap(){
    clearRun();view='map';onViewChange?.(view);resetView();root.dataset.screen='map';
    header('故事远征','十二站海岸旅程。完成一关，解锁下一段风景。');sourceStrip();
    if(!sourcePassages().length){selectedBook()?renderPending():renderEmpty();return;}
    const next=LEVELS.find(item=>!data.progress.levels?.[item.id]?.stars)||LEVELS[LEVELS.length-1];
    const wrap=el('div','game-map-scroll'),map=el('section','game-map-scene');map.setAttribute('aria-label','海岸闯关地图，可横向滚动');
    const caption=el('div','game-map-caption');caption.append(el('span','','当前目的地'),el('h2','',next.title),el('p','',`第 ${next.id} 关 · ${next.mode==='race'?'小说竞速':'单词防御'} · ${['晨光港湾','林间回声','星夜灯塔'][next.chapter-1]}`));map.append(caption);
    const points=[[22,74],[29,65],[34,57],[41,50],[47,44],[53,43],[59,39],[67,37],[75,36],[82,30],[87,24],[91,15]];
    const route=svg([points.map(([x,y],i)=>(i?'L':'M')+(x*10)+' '+(y*5)).join(' ')],'0 0 1000 500');route.classList.add('game-map-route');route.setAttribute('preserveAspectRatio','none');map.append(route);
    for(const [index,item]of LEVELS.entries()){
      const stars=data.progress.levels?.[item.id]?.stars||0,unlocked=isLevelUnlocked(item.id,data.progress.levels||{});
      const node=button('',null,()=>launch(item.mode,item),'game-map-node');node.dataset.levelId=String(item.id);node.disabled=!unlocked;node.style.left=points[index][0]+'%';node.style.top=points[index][1]+'%';
      node.setAttribute('aria-label',`第 ${item.id} 关 ${item.title}，${item.mode==='race'?'竞速':'防御'}，${unlocked?`${stars} 星`:'完成上一关解锁'}`);node.title=node.getAttribute('aria-label');
      node.append(el('span','game-node-number',String(item.id)),el('span','game-node-stars',stars?'★'.repeat(stars):unlocked?'出发':'·'));
      if(stars)node.classList.add('is-cleared');if(item.id===next.id)node.classList.add('is-current');map.append(node);
    }
    map.append(el('span','game-map-destination','星夜灯塔'));wrap.append(map);root.append(wrap);
    const legend=el('div','game-map-legend');legend.append(el('span','','晨光港湾 · 01—04'),el('span','','林间回声 · 05—08'),el('span','','星夜灯塔 · 09—12'));root.append(legend,button('← 返回游戏','game-home',renderHome,'game-link'),el('p','game-footnote','每本书分别保存星级。过关成绩保存成功后，下一关才会解锁。'));
  }
  function selectPassage(index){const passages=sourcePassages(Boolean(level));passage=passages[Math.max(0,index)%passages.length]||null;}
  function launch(nextMode,nextLevel){
    void navigate(()=>{
      origin=view;clearRun();mode=nextMode;level=nextLevel;finished=false;selectPassage(selectedBook()?0:nextLevel?nextLevel.id-1:0);
      renderArena();
    });
  }
  function metric(label,id,value){const node=el('div','game-metric');const number=el('strong','',value);number.id=id;node.append(number,el('span','',label));return node;}
  function renderArena(){
    cancelFrame();resetView();root.dataset.screen='arena';root.dataset.mode=mode;nodes.clear();lastRaceValue=null;window.scrollTo({top:0,behavior:'instant'});
    const top=el('div','game-arena-top');top.append(button('← 返回'+(origin==='map'?'地图':'游戏'),'game-leave',()=>navigate(()=>origin==='map'?renderMap():renderHome()),'game-link'));
    top.append(el('h1','',level?`第 ${level.id} 关 · ${level.title}`:mode==='race'?'小说竞速':'单词防御战'));root.append(top);
    const description=el('p','game-arena-description',level?level.mode==='race'?`在 ${level.timeLimit} 秒内完成原句，准确率至少 ${level.minAccuracy}%。`:`在 ${level.duration} 秒内击破 ${level.target} 个词，守住 3 次生命。`:mode==='race'?fullRace()?`第 ${selected.index+1} 段完整竞速。完成后保存阅读进度，下一段接着练。大小写自由，标点、空格和换行需一致。`:'完整输入目标句子。大小写自由，空格和标点需一致。':'60 秒内击破 12 个词。敲完整个词自动发射，漏过一个词扣除一次生命。');root.append(description);
    if(!passage){if(selectedBook()){root.append(paragraphPicker());if(selected.pending)renderPending();else message('这一段没有适合当前关卡的短句，请换一段或使用完整段落竞速。');}else renderEmpty();return;}
    if(mode==='race')renderRace();else {if(selectedBook())root.append(paragraphPicker());renderDefense();}
    top.append(root.querySelector('.game-metrics'));
    const control=el('div','game-controls');
    control.append(button('开始这一局','game-start',start,'game-button is-primary'),button('暂停','game-pause',togglePause),button('结束','game-end',end));root.append(control);
    if(mode==='defense')root.append($('game-feedback'),$('game-word-context'));
    $('game-pause').disabled=true;$('game-end').disabled=true;
    const result=el('section','game-result');result.id='game-result';result.hidden=true;result.setAttribute('aria-live','polite');root.append(result);
    root.append(el('p','game-footnote',mode==='race'?'完成挑战得 1 星；准确率达到 95% 得 2 星；达到 98% 且领先陪练节奏得 3 星。':'完成目标得 1 星；剩余至少 2 次生命且准确率达到 85% 得 2 星；满生命且准确率达到 95% 得 3 星。'));
    root.append(el('p','game-footnote','离开窗口或打开对话框会自动暂停。开始游戏后使用已经缓存的本段英文。'));
  }
  function renderRace(){
    const config=el('div','game-race-config'+(level?' is-level':selectedBook()?' is-full':''));
    if(!level&&selectedBook())config.append(paragraphPicker());
    if(!level&&!selectedBook()){
      const label=el('label','','练习段落');label.htmlFor='game-passage';const select=el('select');select.id='game-passage';
      data.passages.forEach((item,index)=>{const option=el('option','',`${index+1}. ${item.translation.slice(0,64)}`);option.value=String(index);select.append(option);});
      select.value=String(data.passages.indexOf(passage));
      select.addEventListener('change',()=>{selectPassage(Number(select.value));lastRaceValue=null;renderRacePreview();updateGhostOption();});config.append(label,select);
    }
    const label=el('label','','陪练节奏');label.htmlFor='game-opponent';const select=el('select');select.id='game-opponent';
    for(const [value,text]of [['20','轻松 · 20 WPM'],['35','标准 · 35 WPM'],['50','进阶 · 50 WPM'],['best','个人最佳平均节奏']]){const option=el('option','',text);option.value=value;select.append(option);}
    select.value=level?String(level.opponentWpm):opponent;
    if(level&&!['20','35','50'].includes(String(level.opponentWpm))){const option=el('option','',`本关电脑陪练 · ${level.opponentWpm} WPM`);option.value=String(level.opponentWpm);select.append(option);select.value=option.value;}
    select.disabled=Boolean(level);select.addEventListener('change',()=>{opponent=select.value;updateOpponentLabel();});config.append(label,select);root.append(config);
    const tracks=el('section','game-race-tracks');tracks.setAttribute('aria-label','竞速路线');
    for(const [id,label]of [['you','你'],['opponent','电脑陪练']]){
      const row=el('div','game-track-row'),name=el('span','game-track-label',label);name.id='game-'+id+'-label';
      const track=el('div','game-track'),fill=el('div','game-track-fill'),car=el('span','game-racer');fill.id='game-'+id+'-fill';car.id='game-'+id+'-racer';car.setAttribute('aria-hidden','true');track.append(fill,car);const percent=el('span','game-track-percent','0%');percent.id='game-'+id+'-percent';row.append(name,track,percent);tracks.append(row);
    }
    root.append(tracks);const stats=el('div','game-metrics');stats.append(metric('WPM','game-wpm','0'),metric('准确率','game-accuracy','100%'),metric('剩余秒','game-time',String(roundTime())));root.append(stats);
    const card=el('section','game-race-reading'+(fullRace()?' is-full-paragraph':'')),source=el('p','game-source-context');source.id='game-race-source';const text=el('p','game-race-text');text.id='game-race-text';text.setAttribute('aria-label','竞速英文目标');card.append(source,text);
    const labelInput=el('label','sr-only','输入竞速英文');labelInput.htmlFor='game-input';const input=el('textarea','game-input');input.rows=2;input.id='game-input';input.maxLength=10100;input.placeholder='点击开始后，从第一个字符输入…';input.disabled=true;configureInput(input);card.append(labelInput,input);root.append(card);renderRacePreview();updateGhostOption();
  }
  function renderRacePreview(){
    const target=$('game-race-text');if(!target)return;$('game-race-source').textContent=passage.source;
    raceChars=Array.from(passage.translation);raceSpans=raceChars.map(char=>el('span','',char));raceOverflow=el('span');previousRaceChars=[];lastRaceValue=null;
    target.replaceChildren(...raceSpans,raceOverflow);target.scrollTop=0;
    raceObserver?.disconnect();raceLayout=null;
    if(fullRace()){
      raceObserver=new ResizeObserver(()=>{raceLayout={tops:raceSpans.map(span=>span.offsetTop),height:target.clientHeight,lineHeight:parseFloat(getComputedStyle(target).lineHeight)};});raceObserver.observe(target);
    }
  }
  function updateGhostOption(){const select=$('game-opponent'),option=select?.querySelector('[value="best"]');if(!option)return;option.disabled=!data.progress.bestRaces?.[passage.id];if(option.disabled&&select.value==='best'){select.value='35';opponent='35';}updateOpponentLabel();}
  function updateOpponentLabel(){if(!$('game-opponent-label'))return;const selected=$('game-opponent').value;$('game-opponent-label').textContent=selected==='best'?'个人最佳平均节奏':`电脑 · ${selected} WPM`;}
  function renderDefense(){
    const stats=el('div','game-metrics');stats.append(metric('分数','game-score','0'),metric('剩余秒','game-time',String(level?.duration||60)),metric('生命','game-lives','3'),metric('连击','game-combo','0'),metric('目标','game-kills',`0 / ${level?.target||12}`));root.append(stats);
    const stage=el('section','game-defense-stage');stage.id='game-defense-stage';stage.setAttribute('aria-label','单词防御区域');
    const horizon=el('div','game-horizon');horizon.append(el('span','game-stage-label','看准一个词，开始输入'));const layer=el('div','game-enemies');layer.id='game-enemies';const base=el('div','game-defense-base');base.append(svg(icons.defense),el('span','','守住防线'));stage.append(horizon,layer,base);root.append(stage);stageObserver=new ResizeObserver(entries=>{stageHeight=entries[0].contentRect.height;});stageObserver.observe(layer);
    const label=el('label','sr-only','输入来袭的英文单词');label.htmlFor='game-input';const input=el('input','game-input');input.id='game-input';input.maxLength=80;input.placeholder='输入完整英文单词，自动发射…';input.disabled=true;configureInput(input);root.append(label,input);
    const context=el('aside','game-word-context');context.append(el('span','game-kicker','原句上下文'),el('p','', '输入后，这里会显示对应的小说原句。'));context.id='game-word-context';root.append(context);
    const feedback=el('p','game-feedback','大小写自由；Backspace 可以修改。');feedback.id='game-feedback';feedback.setAttribute('role','status');root.append(feedback);
  }
  function configureInput(input){
    input.lang='en';input.spellcheck=false;input.autocomplete='off';input.setAttribute('autocapitalize','off');input.setAttribute('autocorrect','off');
    for(const event of ['paste','drop'])input.addEventListener(event,e=>e.preventDefault());
    input.addEventListener('beforeinput',event=>{if(/insertFromPaste|insertFromDrop|insertReplacementText/.test(event.inputType||''))event.preventDefault();});
    input.addEventListener('keydown',event=>{
      if(event.key==='Enter'&&!fullRace())event.preventDefault();
      if(event.key==='Tab'&&fullRace()&&passage.translation.includes('\t')&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey){event.preventDefault();input.setRangeText('\t',input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new InputEvent('input',{inputType:'insertText',data:'\t',bubbles:true}));}
    });
    input.addEventListener('input',event=>{
      if(!engine||lastSnapshot?.status!=='running')return;
      if(event.isComposing)return;
      if(/insertFromPaste|insertFromDrop|insertReplacementText/.test(event.inputType||'')){input.value=lastSnapshot.value;return;}
      const previous=lastSnapshot;const snapshot=engine.input(input.value,clock());input.value=snapshot.value;
      if(mode==='defense'&&snapshot.matchedId)hitEffect(nodes.get(snapshot.matchedId));
      update(snapshot);
      if(mode==='defense'&&snapshot.matchedId){impact($('game-combo'));animate($('game-defense-base'),[{opacity:.5,transform:'scale(.96)'},{opacity:1,transform:'scale(1)'}]);text('game-feedback',`击破成功 · ${snapshot.combo} 连击`);}
      else if(snapshot.errors>previous.errors)impact(input,false);
      else if(mode==='race'&&snapshot.value.length>previous.value.length)impact($('game-you-racer'));
    });
  }
  async function start(){
    if(engine||savePromise||pending||starting||selectionBusy||preparing||!passage)return;
    starting=true;const context=generation,epoch=interactionEpoch,startButton=$('game-start'),index=selected?.index,bookId=data.bookId;startButton.disabled=true;
    try{
      if(fullRace()){
        const fresh=await api.getGamePassage({bookId,index});
        if(context!==generation||epoch!==interactionEpoch||$('game-start')!==startButton||!active||selected?.index!==index)return;
        if(!fresh.passage||fresh.passage.translation!==passage.translation||fresh.passage.source!==passage.source){selected=fresh;selectPassage(0);renderArena();message('本段内容已更新，请确认后重新开始。');return;}
        selected=fresh;passage=fresh.passage;
      }
      let options;
      if(mode==='race'){
        const selectedOpponent=$('game-opponent').value,best=data.progress.bestRaces?.[passage.id];
        options={text:passage.translation,opponentWpm:selectedOpponent==='best'?(best?.wpm||35):Number(selectedOpponent),timeLimit:roundTime(),minAccuracy:level?.minAccuracy||0};engine=new RaceSession(options);
      }else{
        options={words:buildWordPool(sourcePassages()),...(level||{}),duration:level?.duration||60,target:level?.target||12};
        if(!options.words.length){message('这一段没有可用于防御战的英文单词。请选择另一段，或使用原创示例。',true);return;}engine=new DefenseSession(options);
      }
      runId=crypto.randomUUID();finished=false;readingStatus=null;$('game-start').hidden=true;$('game-pause').disabled=false;$('game-end').disabled=false;
      for(const select of root.querySelectorAll('select'))select.disabled=true;lockSelection(true);
      update(engine.start(clock()));$('game-input').focus();scheduleFrame();
    }catch(error){if(context===generation&&epoch===interactionEpoch)message('无法开始这一局：'+(error.message||''),true);}
    finally{if(context===generation&&epoch===interactionEpoch&&$('game-start')===startButton){starting=false;startButton.disabled=false;}}
  }
  function scheduleFrame(){cancelFrame();if(!active||!engine||terminal(lastSnapshot?.status))return;raf=requestAnimationFrame(now=>{raf=null;if(now-lastFrameAt>=(mode==='race'?50:16)){lastFrameAt=now;update(engine.update(clock()));}if(lastSnapshot.status==='running')scheduleFrame();});}
  function pause(){
    if(starting)invalidatePending();
    if(!engine||lastSnapshot?.status!=='running')return;cancelFrame();clearEffects();update(engine.pause(clock()));
  }
  function togglePause(){
    if(!engine)return;
    if(lastSnapshot.status==='running')pause();else if(lastSnapshot.status==='paused'){update(engine.resume(clock()));$('game-input').focus();scheduleFrame();}
  }
  function end(){if(!engine||terminal(lastSnapshot?.status))return;update(engine.end(clock()));}
  function update(snapshot){
    const previous=lastSnapshot;lastSnapshot=snapshot;
    if(!$('game-input'))return;
    if(previous?.status!==snapshot.status){
      $('game-input').disabled=snapshot.status!=='running';text('game-pause',snapshot.status==='paused'?'继续':'暂停');
      $('game-pause').disabled=terminal(snapshot.status);$('game-end').disabled=terminal(snapshot.status);
      if(snapshot.status==='paused')message('已暂停。点击继续，回到刚才的节奏。');else if($('game-notice')&&!saveError)message('');
    }
    text('game-time',Math.max(0,Math.ceil(snapshot.timeLeft)));
    if(mode==='race')updateRace(snapshot);else updateDefense(snapshot);
    if(previous?.lives>snapshot.lives){impact($('game-defense-stage'),false);text('game-feedback',`一个词越过防线 · 剩余 ${snapshot.lives} 次生命`);}
    if(terminal(snapshot.status)&&!finished)finish(snapshot);
  }
  function updateRace(snapshot){
    for(const [name,progress]of [['you',snapshot.progress],['opponent',snapshot.opponentProgress]]){
      const ratio=Math.max(0,Math.min(1,progress));$('game-'+name+'-fill').style.transform=`scaleX(${ratio})`;
      $('game-'+name+'-racer').style.transform=`translate3d(${ratio*100}%,0,0)`;text('game-'+name+'-percent',Math.floor(ratio*100)+'%');
    }
    text('game-wpm',Math.round(snapshot.wpm));text('game-accuracy',snapshot.accuracy+'%');
    if(lastRaceValue===snapshot.value)return;lastRaceValue=snapshot.value;
    const actual=Array.from(snapshot.value),oldLength=previousRaceChars.length;
    for(let i=0;i<raceChars.length;i++){
      if(actual[i]===previousRaceChars[i]&&i!==oldLength&&i!==actual.length)continue;
      const state=i<actual.length?(charactersMatch(actual[i],raceChars[i])?'is-correct':'is-wrong'):i===actual.length?'is-caret':'';
      if(raceSpans[i].className!==state)raceSpans[i].className=state;
    }
    const overflow=actual.slice(raceChars.length).join('');if(raceOverflow.textContent!==overflow){raceOverflow.textContent=overflow;raceOverflow.className=overflow?'is-wrong':'';}
    previousRaceChars=actual;
    if(raceLayout){const target=$('game-race-text'),top=raceLayout.tops[Math.min(actual.length,raceSpans.length-1)];if(top<target.scrollTop||top+raceLayout.lineHeight>target.scrollTop+raceLayout.height)target.scrollTop=Math.max(0,top-raceLayout.height/2);}
  }
  function updateDefense(snapshot){
    text('game-score',snapshot.score);text('game-lives',snapshot.lives);text('game-combo',snapshot.combo);text('game-kills',`${snapshot.kills} / ${snapshot.target}`);
    const ids=new Set(snapshot.enemies.map(item=>item.id));for(const [id,node]of nodes){if(!ids.has(id)){node.remove();nodes.delete(id);}}
    const value=snapshot.value.toLowerCase(),matches=snapshot.enemies.filter(item=>item.word.toLowerCase().startsWith(value));
    const target=value?matches[0]:null,limited=motionLimited();
    for(const enemy of snapshot.enemies){
      let node=nodes.get(enemy.id);
      if(!node){node=el('div','game-enemy');node.dataset.enemyId=String(enemy.id);const used=new Set([...nodes.values()].map(item=>Number(item.dataset.slot)));node.dataset.slot=String(Array.from({length:8},(_,i)=>i).find(i=>!used.has(i))??0);const word=el('span','game-enemy-word');node._matched=el('b');node._rest=document.createTextNode(enemy.word);word.append(node._matched,node._rest);node._countdown=el('small','game-enemy-time');node.append(word,el('span','game-enemy-trail'),node._countdown);nodes.set(enemy.id,node);$('game-enemies').append(node);}
      const slot=Number(node.dataset.slot),left=(3+(limited?slot%4:enemy.lane)*25)+'%';if(node.style.left!==left)node.style.left=left;
      const position=limited?(.2+Math.floor(slot/4)*.45):.08+enemy.progress*.78;node.style.transform=`translate3d(0,${Math.round(stageHeight*position)}px,0)`;
      node._countdown.hidden=!limited;const remaining=Math.ceil((1-enemy.progress)*(level?.fallDuration||14000)/1000)+' 秒';if(limited&&node._countdown.textContent!==remaining)node._countdown.textContent=remaining;
      if(node.dataset.value!==value){node.dataset.value=value;const matched=value&&enemy.word.toLowerCase().startsWith(value)?value.length:0;node.classList.toggle('is-target',matched>0);node._matched.textContent=enemy.word.slice(0,matched);node._rest.data=enemy.word.slice(matched);}
    }
    $('game-input').classList.toggle('is-wrong',Boolean(value&&!target));
    if(target){const context=$('game-word-context');if(context.dataset.passage!==target.passageId){context.dataset.passage=target.passageId;context.replaceChildren(el('span','game-kicker','原句上下文'),el('p','',target.source),el('p','game-context-english',target.translation));}}
  }
  function finish(snapshot){
    finished=true;cancelFrame();
    const stars=level?levelStars(level.id,snapshot):snapshot.stars;
    pending={bookId:data.bookId,runId,mode,levelId:level?.id||null,passageId:mode==='race'?passage.id:null,stars:Math.max(0,Math.min(3,stars||0)),score:Math.round(snapshot.score||0),seconds:snapshot.seconds,accuracy:snapshot.accuracy,wpm:snapshot.wpm||0,won:snapshot.status==='won'};
    if(fullRace())pending.readingAdvance={ticket:passage.ticket,index:passage.index,typed:snapshot.value};
    const result=$('game-result');result.hidden=false;
    const title=snapshot.status==='won'?mode==='race'?'抵达终点，完成这一程。':'防线守住了。':snapshot.status==='ended'?'这一局，先到这里。':'再来一次，找回节奏。';
    const detail=snapshot.status==='won'?mode==='race'?snapshot.wonRace?'你领先陪练节奏抵达终点。':'原句已完成，下次试着追上陪练节奏。':`成功击破 ${snapshot.kills} 个词。`:mode==='race'?'继续练习同一段，可以提高速度和准确率。':`本局击破 ${snapshot.kills} 个词；达到目标才能过关。`;
    const starsNode=el('div','game-result-stars');starsNode.setAttribute('aria-label',`${pending.stars} 颗星`);
    for(let i=0;i<3;i++){const star=el('span','',i<pending.stars?'★':'☆');star.setAttribute('aria-hidden','true');starsNode.append(star);}
    result.dataset.outcome=snapshot.status;result.replaceChildren(starsNode,el('h2','',title),el('p','',detail));
    if(snapshot.status==='won'){animate(result,[{opacity:.6,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],{duration:260});Array.from(starsNode.children).slice(0,pending.stars).forEach((star,i)=>animate(star,[{transform:'scale(.6) rotate(-12deg)',opacity:.25},{transform:'scale(1) rotate(0)',opacity:1}],{duration:320,delay:i*85}));}
    const summary=el('div','game-result-summary');summary.append(el('span','',`${Math.round(snapshot.seconds)} 秒`),el('span','',`${snapshot.accuracy}% 准确率`),el('span','',mode==='race'?`${Math.round(snapshot.wpm)} WPM`:`${snapshot.score} 分`));result.append(summary);
    const status=el('p','game-save-status');status.id='game-save-status';status.setAttribute('role','status');result.append(status);
    const actions=el('div','game-actions');actions.append(button('重试保存','game-retry-save',()=>{void persist(true).catch(()=>{});}));
    actions.append(button('再来一局','game-restart',()=>navigate(()=>{engine=null;finished=false;renderArena();}),'game-button is-primary'));
    if(level&&snapshot.status==='won'&&level.id<LEVELS.length){const next=LEVELS.find(item=>item.id===level.id+1);actions.append(button('下一关 →','game-next',()=>{if(!isLevelUnlocked(next.id,data.progress.levels))return;level=next;mode=next.mode;engine=null;finished=false;selectPassage(next.id-1);renderArena();},'game-button'));}
    if(fullRace()&&snapshot.status==='won'&&selected.index<selected.total-1)actions.append(button('竞速下一段 →','game-next-paragraph',()=>void chooseParagraph(selected.index+1),'game-button'));
    result.append(actions);void persist().catch(()=>{});
    result.scrollIntoView({block:'nearest',behavior:'auto'});
  }
  async function load(bookId,nextView,index,launchMode){
    const token=++generation;++selectionRevision;clearRun();active=true;view=nextView;selected=null;prepareError=null;preparing=false;selectionBusy=false;starting=false;root.replaceChildren(el('p','game-loading','正在打开本机游戏素材…'));
    try{
      const next=await api.getGameData({bookId});if(token!==generation)return;data=next;data.progress ||= {levels:{},bestRaces:{},recent:[]};
      if(data.bookId!=='sample'&&api.getGamePassage){const paragraph=await api.getGamePassage({bookId:data.bookId,...(Number.isInteger(index)?{index}:{})});if(token!==generation)return;selected=paragraph;}
      if(launchMode){origin=nextView;mode=launchMode;selectPassage(0);renderArena();}else nextView==='map'?renderMap():renderHome();
    }catch(error){if(token!==generation)return;root.replaceChildren();header('暂时无法打开游戏','你的书库和阅读进度保持不变。');message(error.message||'本机素材读取失败。',true);root.append(button('重新打开','game-reload',()=>{void load(bookId,nextView,index,launchMode);},'game-button is-primary'));}
  }
  async function open({bookId,view:nextView='games',index,mode:launchMode}){pause();await flush();document.body.classList.add('games-open');requestedBookId=bookId;await load(bookId,nextView,index,launchMode);}
  function close(){invalidatePending();pause();active=false;generation++;selectionRevision++;cancelFrame();clearEffects();document.body.classList.remove('games-open');}
  window.addEventListener('blur',pause);
  const motionChanged=()=>{clearEffects();if(engine&&mode==='defense')updateDefense(engine.snapshot(clock()));};
  window.addEventListener('noveltype:motion-change',motionChanged);reducedMotion.addEventListener('change',motionChanged);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  const dialogs=new MutationObserver(()=>{if(document.querySelector('dialog[open]'))pause();});
  for(const dialog of document.querySelectorAll('dialog'))dialogs.observe(dialog,{attributes:true,attributeFilter:['open']});
  return {open,pause,flush,close};
}
