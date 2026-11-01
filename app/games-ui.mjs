import {buildWordPool, RaceSession, DefenseSession, LEVELS, isLevelUnlocked, levelStars} from './games.mjs';
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

/** This controller owns only game DOM and bounded game results, never reading state. */
export function createGamesUI({root, api, onRead, onViewChange}) {
  let data=null, requestedBookId=null, view='games', engine=null, mode=null, level=null, passage=null;
  let runId=null, raf=null, active=false, generation=0, finished=false, lastSnapshot=null;
  let pending=null, savePromise=null, saveError=null, origin='games', opponent='35';
  const $ = id => root.querySelector('#'+id);
  const nodes = new Map();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let lastRaceValue=null;

  function message(text, error=false) {
    let node=$('game-notice');
    if (!node) {node=el('p','game-notice');node.id='game-notice';node.setAttribute('role','status');root.prepend(node);}
    node.textContent=text;node.classList.toggle('is-error',error);node.hidden=!text;
  }
  function saveStatus() {
    const node=$('game-save-status'); if (!node) return;
    node.textContent=saveError?'成绩尚未保存：'+(saveError.message||'本机写入失败。'):savePromise?'正在保存成绩…':pending?'等待保存成绩…':'成绩已保存到本机';
    node.classList.toggle('is-error',Boolean(saveError));
    const retry=$('game-retry-save');if(retry)retry.hidden=!saveError;
    const next=$('game-next');if(next)next.disabled=Boolean(pending||savePromise||saveError);
  }
  async function persist(retry=false) {
    if(savePromise)return savePromise;
    if(!pending)return;
    if(saveError&&!retry)throw saveError;
    const payload=pending;
    saveError=null;
    savePromise=api.saveGameResult(payload).then(progress=>{
      if(data?.bookId===payload.bookId)data.progress=progress;
      if(pending===payload)pending=null;
    }).catch(error=>{saveError=error;throw error;}).finally(()=>{savePromise=null;saveStatus();});
    saveStatus();return savePromise;
  }
  async function flush(){if(savePromise)await savePromise;if(pending)await persist();}
  function cancelFrame(){if(raf!==null)cancelAnimationFrame(raf);raf=null;}
  function clearRun(){cancelFrame();engine=null;mode=null;level=null;passage=null;nodes.clear();lastRaceValue=null;finished=false;}
  async function navigate(fn) {
    pause();
    try{await flush();await fn();}catch(error){message('请先重试保存本局成绩，再离开游戏。'+(error.message||''),true);}
  }
  function header(title, detail) {
    const head=el('header','game-heading'),copy=el('div');copy.append(el('h1','',title),el('p','game-description',detail));head.append(copy);root.append(head);
  }
  function sourceStrip() {
    const strip=el('div','game-source-strip'),copy=el('div');
    copy.append(el('span','game-kicker','练习素材'),el('strong','',data.title));
    strip.append(copy,el('span','game-source-count',`${data.passages.length} 段已缓存 · 离线游戏`));
    if(data.bookId!=='sample')strip.append(button('使用原创示例', 'game-use-sample',()=>navigate(()=>load('sample',view)),'game-link'));
    else if(requestedBookId&&requestedBookId!=='sample')strip.append(button('使用当前小说','game-use-book',()=>navigate(()=>load(requestedBookId,view)),'game-link'));
    root.append(strip);
  }
  function renderEmpty(){
    const block=el('section','game-empty');block.append(svg(icons.race),el('h2','','这本书还没有可用的英文素材'),el('p','','先回到阅读页翻译一小段，或立即用原创示例开始。打开游戏不会请求翻译。'));
    const actions=el('div','game-actions');actions.append(button('用原创示例开始','game-empty-sample',()=>navigate(()=>load('sample',view)),'game-button is-primary'),button('回到阅读','game-empty-read',()=>navigate(()=>onRead?.())));block.append(actions);root.append(block);
  }
  function renderHome(){
    clearRun();view='games';onViewChange?.(view);root.replaceChildren();
    header('换一种节奏，继续练习。','让故事里的词句，成为你的下一场挑战。');sourceStrip();
    if(!data.passages.length){renderEmpty();return;}
    const feature=el('section','game-feature'),copy=el('div','game-feature-copy');
    copy.append(el('span','game-kicker','反应与拼写 · 60 秒'),el('h2','','守住每一个词'),el('p','','英文单词从远处靠近。敲完整个词，发射一道光；守住防线，累积连击。'),button('进入防御战','game-defense-open',()=>launch('defense',null),'game-button is-primary'));
    const art=el('div','game-defense-art');art.setAttribute('aria-hidden','true');
    for(const [i,word] of ['story','lighthouse','journey'].entries()){const node=el('span','art-word art-word-'+i,word);art.append(node);}
    const shield=el('div','art-shield');shield.append(svg(icons.defense));art.append(shield,el('span','art-baseline'));
    feature.append(copy,art);root.append(feature);
    const row=el('section','game-choice-row'),artRace=el('div','game-mini-race');artRace.setAttribute('aria-hidden','true');artRace.append(el('span'),el('span'));
    const raceCopy=el('div');raceCopy.append(el('h2','','小说竞速'),el('p','','沿着一段故事冲向终点。选择电脑陪练，或挑战个人最佳平均节奏。'));
    row.append(artRace,raceCopy,button('开始竞速 →','game-race-open',()=>launch('race',null),'game-link'));root.append(row);
    const mapRow=el('section','game-choice-row'),mapArt=el('div','game-mini-map');mapArt.append(svg(icons.map));const mapCopy=el('div');
    const stars=Object.values(data.progress.levels||{}).reduce((total,item)=>total+(item.stars||0),0);
    mapCopy.append(el('h2','','故事远征'),el('p','',`三片风景，十二个关卡。竞速与防御交替，已获得 ${stars} / 36 颗星。`));
    mapRow.append(mapArt,mapCopy,button('打开闯关地图 →','game-map-open',renderMap,'game-link'));root.append(mapRow);
    root.append(el('p','game-footnote','不区分大小写。游戏成绩单独保存，不改变小说阅读进度。'));
  }
  function renderMap(){
    clearRun();view='map';onViewChange?.(view);root.replaceChildren();
    header('故事远征','每过一关，故事就向前一步。重玩已完成的关卡，可以争取更多星星。');sourceStrip();
    if(!data.passages.length){renderEmpty();return;}
    const names=['晨光港湾','林间回声','星夜灯塔'],sub=['找到自己的节奏','让手指记住词句','把故事打成自己的路'];
    const map=el('div','game-worlds');
    for(let chapter=1;chapter<=3;chapter++){
      const world=el('section',`game-world game-world-${chapter}`),heading=el('div','game-world-heading');
      heading.append(el('span','game-chapter-number',`0${chapter}`));const labels=el('div');labels.append(el('h2','',names[chapter-1]),el('p','',sub[chapter-1]));heading.append(labels);world.append(heading);
      const route=el('div','game-route');route.append(svg(['M60 90 C160 15 190 160 300 90 S460 15 540 90 S700 160 780 90'],'0 0 840 180'));
      for(const item of LEVELS.filter(entry=>entry.chapter===chapter)){
        const record=data.progress.levels?.[item.id],stars=record?.stars||0,unlocked=isLevelUnlocked(item.id,data.progress.levels||{});
        const node=button('',null,()=>launch(item.mode,item),'game-map-node');node.dataset.levelId=String(item.id);node.disabled=!unlocked;
        node.setAttribute('aria-label',`第 ${item.id} 关 ${item.title}，${unlocked?`${stars} 星`:'尚未解锁'}`);
        const marker=el('span','game-node-marker');marker.append(unlocked?svg(icons[item.mode]):el('span','','锁'));node.append(marker,el('span','game-node-number',`第 ${item.id} 关 · ${item.mode==='race'?'竞速':'防御'}`),el('strong','',item.title),el('span','game-node-stars',unlocked?'★'.repeat(stars)+'☆'.repeat(3-stars):'完成上一关解锁'));
        if(stars)node.classList.add('is-cleared');route.append(node);
      }
      world.append(route);map.append(world);
    }
    root.append(map,button('← 返回游戏','game-home',renderHome,'game-link'),el('p','game-footnote','每本书分别保存关卡进度。只有成功保存的过关成绩才会解锁下一关。'));
  }
  function selectPassage(index){passage=data.passages[Math.max(0,index)%data.passages.length];}
  function launch(nextMode,nextLevel){
    void navigate(()=>{
      origin=view;clearRun();mode=nextMode;level=nextLevel;finished=false;selectPassage(nextLevel?nextLevel.id-1:0);
      renderArena();
    });
  }
  function metric(label,id,value){const node=el('div','game-metric');const number=el('strong','',value);number.id=id;node.append(number,el('span','',label));return node;}
  function renderArena(){
    cancelFrame();root.replaceChildren();nodes.clear();lastRaceValue=null;
    const top=el('div','game-arena-top');top.append(button('← 返回'+(origin==='map'?'地图':'游戏'),'game-leave',()=>navigate(()=>origin==='map'?renderMap():renderHome()),'game-link'));
    top.append(el('h1','',level?`第 ${level.id} 关 · ${level.title}`:mode==='race'?'小说竞速':'单词防御战'));root.append(top);
    const description=el('p','game-arena-description',level?level.mode==='race'?`在 ${level.timeLimit} 秒内完成原句，准确率至少 ${level.minAccuracy}%。`:`在 ${level.duration} 秒内击破 ${level.target} 个词，守住 3 次生命。`:mode==='race'?'完整输入目标句子。大小写自由，空格和标点需一致。':'60 秒内击破 12 个词。敲完整个词自动发射，漏过一个词扣除一次生命。');root.append(description);
    if(mode==='race')renderRace();else renderDefense();
    const control=el('div','game-controls');
    control.append(button('开始这一局','game-start',start,'game-button is-primary'),button('暂停','game-pause',togglePause),button('结束','game-end',end));root.append(control);
    $('game-pause').disabled=true;$('game-end').disabled=true;
    const result=el('section','game-result');result.id='game-result';result.hidden=true;result.setAttribute('aria-live','polite');root.append(result);
    root.append(el('p','game-footnote',mode==='race'?'完成挑战得 1 星；准确率达到 95% 得 2 星；达到 98% 且领先陪练节奏得 3 星。':'完成目标得 1 星；剩余至少 2 次生命且准确率达到 85% 得 2 星；满生命且准确率达到 95% 得 3 星。'));
    root.append(el('p','game-footnote','离开窗口或打开对话框会自动暂停。游戏全程使用本机缓存。'));
  }
  function renderRace(){
    const config=el('div','game-race-config');
    if(!level){
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
      const track=el('div','game-track'),fill=el('div','game-track-fill'),car=el('span','game-racer',id==='you'?'N':'•');fill.id='game-'+id+'-fill';fill.append(car);track.append(fill);const percent=el('span','game-track-percent','0%');percent.id='game-'+id+'-percent';row.append(name,track,percent);tracks.append(row);
    }
    root.append(tracks);const stats=el('div','game-metrics');stats.append(metric('WPM','game-wpm','0'),metric('准确率','game-accuracy','100%'),metric('剩余秒','game-time',String(level?.timeLimit||180)));root.append(stats);
    const card=el('section','game-race-reading'),source=el('p','game-source-context');source.id='game-race-source';const text=el('p','game-race-text');text.id='game-race-text';text.setAttribute('aria-label','竞速英文目标');card.append(source,text);
    const labelInput=el('label','sr-only','输入竞速英文');labelInput.htmlFor='game-input';const input=el('textarea','game-input');input.rows=3;input.id='game-input';input.maxLength=4000;input.placeholder='点击开始后，从第一个字符输入…';input.disabled=true;configureInput(input);card.append(labelInput,input);root.append(card);renderRacePreview();updateGhostOption();
  }
  function renderRacePreview(){if(!$('game-race-text'))return;$('game-race-source').textContent=passage.source;$('game-race-text').textContent=passage.translation;}
  function updateGhostOption(){const select=$('game-opponent'),option=select?.querySelector('[value="best"]');if(!option)return;option.disabled=!data.progress.bestRaces?.[passage.id];if(option.disabled&&select.value==='best'){select.value='35';opponent='35';}updateOpponentLabel();}
  function updateOpponentLabel(){if(!$('game-opponent-label'))return;const selected=$('game-opponent').value;$('game-opponent-label').textContent=selected==='best'?'个人最佳平均节奏':`电脑 · ${selected} WPM`;}
  function renderDefense(){
    const stats=el('div','game-metrics');stats.append(metric('分数','game-score','0'),metric('剩余秒','game-time',String(level?.duration||60)),metric('生命','game-lives','3'),metric('连击','game-combo','0'),metric('目标','game-kills',`0 / ${level?.target||12}`));root.append(stats);
    const stage=el('section','game-defense-stage');stage.id='game-defense-stage';stage.setAttribute('aria-label','单词防御区域');
    const horizon=el('div','game-horizon');horizon.append(el('span','game-stage-label','看准一个词，开始输入'));const layer=el('div','game-enemies');layer.id='game-enemies';const base=el('div','game-defense-base');base.append(svg(icons.defense),el('span','','守住防线'));stage.append(horizon,layer,base);root.append(stage);
    const label=el('label','sr-only','输入来袭的英文单词');label.htmlFor='game-input';const input=el('input','game-input');input.id='game-input';input.maxLength=80;input.placeholder='输入完整英文单词，自动发射…';input.disabled=true;configureInput(input);root.append(label,input);
    const context=el('aside','game-word-context');context.append(el('span','game-kicker','原句上下文'),el('p','', '输入后，这里会显示对应的小说原句。'));context.id='game-word-context';root.append(context);
    const feedback=el('p','game-feedback','大小写自由；Backspace 可以修改。');feedback.id='game-feedback';feedback.setAttribute('role','status');root.append(feedback);
  }
  function configureInput(input){
    input.lang='en';input.spellcheck=false;input.autocomplete='off';input.setAttribute('autocapitalize','off');input.setAttribute('autocorrect','off');
    for(const event of ['paste','drop'])input.addEventListener(event,e=>e.preventDefault());
    input.addEventListener('beforeinput',event=>{if(/insertFromPaste|insertFromDrop|insertReplacementText/.test(event.inputType||''))event.preventDefault();});
    input.addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});
    input.addEventListener('input',event=>{
      if(!engine||lastSnapshot?.status!=='running')return;
      if(event.isComposing)return;
      if(/insertFromPaste|insertFromDrop|insertReplacementText/.test(event.inputType||'')){input.value=lastSnapshot.value;return;}
      const snapshot=engine.input(input.value,clock());input.value=snapshot.value;update(snapshot);
      if(mode==='defense'&&snapshot.matchedId){const stage=$('game-defense-stage');stage.classList.remove('is-hit');void stage.offsetWidth;stage.classList.add('is-hit');$('game-feedback').textContent=`击破成功 · ${snapshot.combo} 连击`;} 
    });
  }
  function start(){
    if(engine||savePromise||pending)return;
    let options;
    if(mode==='race'){
      const selected=$('game-opponent').value,best=data.progress.bestRaces?.[passage.id];
      options={text:passage.translation,opponentWpm:selected==='best'?(best?.wpm||35):Number(selected),timeLimit:level?.timeLimit||180,minAccuracy:level?.minAccuracy||0};engine=new RaceSession(options);
    }else{
      options={words:buildWordPool(data.passages),...(level||{}),duration:level?.duration||60,target:level?.target||12};
      if(!options.words.length){message('这些译文里没有可用于防御战的英文单词。可以切换到原创示例。',true);return;}engine=new DefenseSession(options);
    }
    runId=crypto.randomUUID();finished=false;$('game-start').hidden=true;$('game-pause').disabled=false;$('game-end').disabled=false;
    for(const select of root.querySelectorAll('select'))select.disabled=true;
    update(engine.start(clock()));$('game-input').focus();scheduleFrame();
  }
  function scheduleFrame(){cancelFrame();if(!active||!engine||terminal(lastSnapshot?.status))return;raf=requestAnimationFrame(()=>{raf=null;update(engine.update(clock()));if(lastSnapshot.status==='running')scheduleFrame();});}
  function pause(){
    if(!engine||lastSnapshot?.status!=='running')return;cancelFrame();update(engine.pause(clock()));
  }
  function togglePause(){
    if(!engine)return;
    if(lastSnapshot.status==='running')pause();else if(lastSnapshot.status==='paused'){update(engine.resume(clock()));$('game-input').focus();scheduleFrame();}
  }
  function end(){if(!engine||terminal(lastSnapshot?.status))return;update(engine.end(clock()));}
  function update(snapshot){
    lastSnapshot=snapshot;
    if(!$('game-input'))return;
    $('game-input').disabled=snapshot.status!=='running';
    $('game-pause').textContent=snapshot.status==='paused'?'继续':'暂停';
    $('game-pause').disabled=terminal(snapshot.status);$('game-end').disabled=terminal(snapshot.status);
    $('game-time').textContent=String(Math.max(0,Math.ceil(snapshot.timeLeft)));
    if(mode==='race')updateRace(snapshot);else updateDefense(snapshot);
    if(snapshot.status==='paused')message('已暂停。点击继续，回到刚才的节奏。');else if($('game-notice')&&!saveError)message('');
    if(terminal(snapshot.status)&&!finished)finish(snapshot);
  }
  function updateRace(snapshot){
    for(const [name,progress]of [['you',snapshot.progress],['opponent',snapshot.opponentProgress]]){
      const pct=Math.max(0,Math.min(100,progress*100));$('game-'+name+'-fill').style.width=pct+'%';$('game-'+name+'-percent').textContent=Math.floor(pct)+'%';
    }
    $('game-wpm').textContent=String(Math.round(snapshot.wpm));$('game-accuracy').textContent=snapshot.accuracy+'%';
    if(lastRaceValue===snapshot.value)return;lastRaceValue=snapshot.value;
    const actual=Array.from(snapshot.value),fragment=document.createDocumentFragment();
    Array.from(passage.translation).forEach((char,index)=>{const span=el('span','',char);if(index<actual.length)span.className=charactersMatch(actual[index],char)?'is-correct':'is-wrong';if(index===actual.length)span.classList.add('is-caret');fragment.append(span);});
    if(actual.length>Array.from(passage.translation).length)fragment.append(el('span','is-wrong',actual.slice(Array.from(passage.translation).length).join('')));
    $('game-race-text').replaceChildren(fragment);
  }
  function updateDefense(snapshot){
    $('game-score').textContent=String(snapshot.score);$('game-lives').textContent=String(snapshot.lives);$('game-combo').textContent=String(snapshot.combo);$('game-kills').textContent=`${snapshot.kills} / ${snapshot.target}`;
    const ids=new Set(snapshot.enemies.map(item=>item.id));for(const [id,node]of nodes){if(!ids.has(id)){node.remove();nodes.delete(id);}}
    const value=snapshot.value.toLowerCase(),matches=snapshot.enemies.filter(item=>item.word.toLowerCase().startsWith(value));
    const target=value?matches[0]:null;
    for(const enemy of snapshot.enemies){
      let node=nodes.get(enemy.id);
      if(!node){node=el('div','game-enemy');node.dataset.enemyId=String(enemy.id);const used=new Set([...nodes.values()].map(item=>Number(item.dataset.slot)));node.dataset.slot=String(Array.from({length:8},(_,i)=>i).find(i=>!used.has(i))??0);const word=el('span','game-enemy-word',enemy.word);node.append(word,el('span','game-enemy-trail'),el('small','game-enemy-time'));nodes.set(enemy.id,node);$('game-enemies').append(node);}
      const slot=Number(node.dataset.slot);
      node.style.left=(8+(reducedMotion.matches?slot%4:enemy.lane)*21)+'%';node.style.top=(reducedMotion.matches?25+Math.floor(slot/4)*50:8+enemy.progress*78)+'%';
      const countdown=node.querySelector('.game-enemy-time');countdown.hidden=!reducedMotion.matches;countdown.textContent=Math.ceil((1-enemy.progress)*(level?.fallDuration||14000)/1000)+' 秒';
      node.classList.toggle('is-target',Boolean(value&&enemy.word.toLowerCase().startsWith(value)));
      const word=node.querySelector('.game-enemy-word');
      if(node.dataset.value!==value){node.dataset.value=value;const matched=value&&enemy.word.toLowerCase().startsWith(value)?value.length:0;word.replaceChildren(el('b','',enemy.word.slice(0,matched)),document.createTextNode(enemy.word.slice(matched)));}
    }
    $('game-input').classList.toggle('is-wrong',Boolean(value&&!target));
    if(target){const context=$('game-word-context');if(context.dataset.passage!==target.passageId){context.dataset.passage=target.passageId;context.replaceChildren(el('span','game-kicker','原句上下文'),el('p','',target.source),el('p','game-context-english',target.translation));}}
  }
  function finish(snapshot){
    finished=true;cancelFrame();
    const stars=level?levelStars(level.id,snapshot):snapshot.stars;
    pending={bookId:data.bookId,runId,mode,levelId:level?.id||null,passageId:mode==='race'?passage.id:null,stars:Math.max(0,Math.min(3,stars||0)),score:Math.round(snapshot.score||0),seconds:snapshot.seconds,accuracy:snapshot.accuracy,wpm:snapshot.wpm||0,won:snapshot.status==='won'};
    const result=$('game-result');result.hidden=false;
    const title=snapshot.status==='won'?mode==='race'?'抵达终点，完成这一程。':'防线守住了。':snapshot.status==='ended'?'这一局，先到这里。':'再来一次，找回节奏。';
    const detail=snapshot.status==='won'?mode==='race'?snapshot.wonRace?'你领先陪练节奏抵达终点。':'原句已完成，下次试着追上陪练节奏。':`成功击破 ${snapshot.kills} 个词。`:mode==='race'?'继续练习同一段，可以提高速度和准确率。':`本局击破 ${snapshot.kills} 个词；达到目标才能过关。`;
    result.replaceChildren(el('div','game-result-stars','★'.repeat(pending.stars)+'☆'.repeat(3-pending.stars)),el('h2','',title),el('p','',detail));
    const summary=el('div','game-result-summary');summary.append(el('span','',`${Math.round(snapshot.seconds)} 秒`),el('span','',`${snapshot.accuracy}% 准确率`),el('span','',mode==='race'?`${Math.round(snapshot.wpm)} WPM`:`${snapshot.score} 分`));result.append(summary);
    const status=el('p','game-save-status');status.id='game-save-status';status.setAttribute('role','status');result.append(status);
    const actions=el('div','game-actions');actions.append(button('重试保存','game-retry-save',()=>{void persist(true).catch(()=>{});}));
    actions.append(button('再来一局','game-restart',()=>navigate(()=>{engine=null;finished=false;renderArena();}),'game-button is-primary'));
    if(level&&snapshot.status==='won'&&level.id<LEVELS.length){const next=LEVELS.find(item=>item.id===level.id+1);actions.append(button('下一关 →','game-next',()=>{if(!isLevelUnlocked(next.id,data.progress.levels))return;level=next;mode=next.mode;engine=null;finished=false;selectPassage(next.id-1);renderArena();},'game-button'));}
    result.append(actions);void persist().catch(()=>{});
    result.scrollIntoView({block:'nearest',behavior:'auto'});
  }
  async function load(bookId,nextView){
    const token=++generation;clearRun();active=true;view=nextView;root.replaceChildren(el('p','game-loading','正在打开本机游戏素材…'));
    try{const next=await api.getGameData({bookId});if(token!==generation)return;data=next;data.progress ||= {levels:{},bestRaces:{},recent:[]};nextView==='map'?renderMap():renderHome();}
    catch(error){if(token!==generation)return;root.replaceChildren();header('暂时无法打开游戏','你的书库和阅读进度保持不变。');message(error.message||'本机素材读取失败。',true);root.append(button('重新打开','game-reload',()=>{void load(bookId,nextView);},'game-button is-primary'));}
  }
  async function open({bookId,view:nextView='games'}){pause();await flush();requestedBookId=bookId;await load(bookId,nextView);}
  function close(){pause();active=false;generation++;cancelFrame();}
  window.addEventListener('blur',pause);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  const dialogs=new MutationObserver(()=>{if(document.querySelector('dialog[open]'))pause();});
  for(const dialog of document.querySelectorAll('dialog'))dialogs.observe(dialog,{attributes:true,attributeFilter:['open']});
  return {open,pause,flush,close};
}
