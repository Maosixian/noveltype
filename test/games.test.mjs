import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWordPool, RaceSession, DefenseSession, LEVELS, isLevelUnlocked, levelStars } from '../app/games.mjs';
import { demoData } from '../app/library.cjs';

const passages = [{id:'p1',source:'旧书店里有一封信。',translation:"The old bookshop held a letter. Don't forget the well-lit room."}, {id:'p2',source:'信在这里。',translation:'LETTER, bookshop, river.'}];
const words = buildWordPool(passages);
const makeDefense = options => new DefenseSession({words,random:()=>0,duration:30,spawnEvery:1000,fallDuration:5000,target:3,...options});

test('word pool deduplicates while retaining hyphen/apostrophe boundaries and original context',()=>{
  assert.equal(words.filter(item=>item.word.toLowerCase()==='letter').length,1);
  assert.ok(words.some(item=>item.word==="Don't"));
  assert.ok(words.some(item=>item.word==='well-lit'));
  assert.ok(!words.some(item=>item.word==='well'));
  assert.equal(words.find(item=>item.word==='letter').source,passages[0].source);
  assert.equal(words.find(item=>item.word==='letter').passageId,'p1');
  assert.equal(buildWordPool(passages,{limit:2}).length,2);
  assert.deepEqual(buildWordPool([{translation:'123 中文 !'}]),[]);
});

test('race stays ready until start and input before start cannot progress',()=>{
  const game=new RaceSession({text:'A letter.'});
  game.input('A letter.',100);
  assert.equal(game.snapshot(1000).status,'ready');
  assert.equal(game.snapshot(1000).progress,0);
  game.start(1000);assert.equal(game.snapshot(2000).seconds,1);
});

test('race preserves exact user case, punctuation and spaces',()=>{
  const game=new RaceSession({text:'Hello, World!',opponentWpm:20});game.start(0);
  assert.equal(game.input('HELLO WORLD!',1000).complete,false);
  assert.equal(game.input('hELLO, wORLD!',3000).status,'won');
  const result=game.snapshot(90000);
  assert.equal(result.value,'hELLO, wORLD!');assert.equal(result.seconds,3);
  assert.equal(result.progress,1);assert.equal(result.wonRace,true);
});

test('race accuracy remembers corrected mistakes and rejects inaccurate level completion',()=>{
  const game=new RaceSession({text:'cat',minAccuracy:90});game.start(0);
  game.input('car',1000);game.input('ca',1500);
  const result=game.input('cat',2000);
  assert.equal(result.accuracy,75);assert.equal(result.status,'lost');assert.equal(result.stars,0);
});

test('race pause excludes idle time for player and computer',()=>{
  const game=new RaceSession({text:'A letter.',opponentWpm:20});game.start(0);game.input('A',1000);
  const paused=game.pause(2000);assert.equal(paused.status,'paused');
  assert.equal(game.snapshot(100000).seconds,2);
  assert.equal(game.snapshot(100000).opponentProgress,paused.opponentProgress);
  game.input('A letter.',100000);assert.equal(game.snapshot(100000).complete,false);
  game.resume(100000);const won=game.input('A letter.',101000);
  assert.equal(won.seconds,3);assert.equal(won.status,'won');assert.equal(won.wpm,36);
});

test('race timeout freezes at limit and cannot be completed or restarted afterward',()=>{
  const game=new RaceSession({text:'Keep typing.',timeLimit:3});game.start(10);
  const result=game.update(100000);assert.equal(result.status,'lost');assert.equal(result.seconds,3);assert.equal(result.timeLeft,0);
  assert.equal(game.input('Keep typing.',100001).complete,false);
  assert.equal(game.start(100002).status,'lost');
});

test('finishing after the computer still passes a challenge, but is not presented as winning the race',()=>{
  const game=new RaceSession({text:'A long road.',opponentWpm:50});game.start(0);
  const result=game.input('A long road.',30000);
  assert.equal(result.status,'won');assert.equal(result.wonRace,false);assert.equal(result.stars,2);
});

test('ending a race freezes its elapsed time and earns no stars',()=>{
  const game=new RaceSession({text:'Walk on.'});game.start(0);game.input('W',500);game.end(1000);
  assert.equal(game.snapshot(100000).status,'ended');assert.equal(game.snapshot(100000).seconds,1);assert.equal(game.snapshot(100000).stars,0);
});

test('defense spawns an immediate target and case-insensitive completion removes exactly one enemy',()=>{
  const game=makeDefense();const first=game.start(0).enemies[0];
  assert.ok(first);const result=game.input(first.word.toUpperCase(),100);
  assert.equal(result.kills,1);assert.equal(result.matchedId,first.id);assert.equal(result.value,'');assert.equal(result.combo,1);
  assert.equal(game.snapshot(100).enemies.length,0);assert.equal(game.snapshot(100).matchedId,null);
});

test('defense input uses complete words, corrected errors remain in accuracy, punctuation is meaningful',()=>{
  const game=makeDefense({words:[{word:"don't",source:'不要。',translation:"Don't.",passageId:'p'}]});game.start(0);
  assert.equal(game.input('don',100).kills,0);
  assert.equal(game.input('dont',200).kills,0);
  game.input('don',300);game.input("don'",400);
  const result=game.input("don't",500);
  assert.equal(result.kills,1);assert.ok(result.accuracy<100);assert.ok(result.accuracy>0);
});

test('defense does not create duplicate concurrent targets from a tiny pool',()=>{
  const game=makeDefense({words:[{word:'river',source:'河',translation:'river'}],fallDuration:10000});
  game.start(0);game.update(4000);assert.equal(game.snapshot(4000).enemies.length,1);
  assert.equal(game.input('RIVER',4100).kills,1);
  assert.equal(game.update(5000).enemies.length,1);
});

test('defense missed enemies remove lives once and bound large time jumps',()=>{
  const game=makeDefense({fallDuration:2000,lives:3});game.start(0);
  const result=game.update(1e9);
  assert.equal(result.status,'lost');assert.equal(result.lives,0);assert.equal(result.seconds,4);
  const again=game.update(1e9+10000);assert.equal(again.seconds,4);assert.equal(again.lives,0);
});

test('defense pause/resume freezes enemies and time, and ended games cannot score',()=>{
  const game=makeDefense();game.start(0);const paused=game.pause(700);
  assert.equal(game.snapshot(90000).enemies[0].progress,paused.enemies[0].progress);
  assert.equal(game.snapshot(90000).seconds,0.7);
  assert.equal(game.input(paused.enemies[0].word,90000).kills,0);
  game.resume(90000);assert.equal(game.update(90300).seconds,1);
  game.end(90500);assert.equal(game.input('The',91000).status,'ended');assert.equal(game.snapshot(99999).seconds,1.2);
});

test('defense target victory freezes time and earns stars, timeout below target loses',()=>{
  const game=makeDefense({target:2});const a=game.start(0).enemies[0];game.input(a.word,100);
  const b=game.update(1000).enemies[0];const result=game.input(b.word,1100);
  assert.equal(result.status,'won');assert.equal(result.stars,3);assert.equal(result.kills,2);assert.equal(game.snapshot(99999).seconds,1.1);
  const timeout=makeDefense({duration:1,fallDuration:5000});timeout.start(0);
  assert.equal(timeout.update(99999).status,'lost');assert.equal(timeout.snapshot(99999).seconds,1);
});

test('defense enemy snapshots are isolated from callers and active enemy count stays bounded',()=>{
  const game=makeDefense({spawnEvery:250,fallDuration:30000});const result=game.start(0);
  result.enemies[0].word='changed';assert.notEqual(game.snapshot(0).enemies[0].word,'changed');
  assert.ok(game.update(10000).enemies.length<=8);
});

test('level map has three chapters, twelve sequential unlocks and alternating game modes',()=>{
  assert.equal(LEVELS.length,12);assert.deepEqual([...new Set(LEVELS.map(x=>x.chapter))],[1,2,3]);
  assert.equal(isLevelUnlocked(1,{}),true);assert.equal(isLevelUnlocked(2,{}),false);
  assert.equal(isLevelUnlocked(2,{1:{stars:1}}),true);assert.equal(isLevelUnlocked(3,{1:{stars:3}}),false);
  assert.equal(isLevelUnlocked(0,{1:{stars:3}}),false);assert.equal(isLevelUnlocked(13,{12:{stars:3}}),false);
  LEVELS.forEach((level,index)=>{assert.equal(level.id,index+1);assert.equal(level.mode,index%2?'defense':'race');assert.ok(level.title);});
});

test('level awards cannot come from unfinished games, another mode, or invalid IDs',()=>{
  assert.equal(levelStars(1,{status:'running',stars:3}),0);
  assert.equal(levelStars(1,{status:'won',mode:'defense',stars:3}),0);
  assert.equal(levelStars(13,{status:'won',mode:'race',stars:3}),0);
  assert.equal(levelStars(1,{status:'won',mode:'race',stars:3,accuracy:100}),3);
});

test('invalid or empty game content fails safely and clocks cannot move backward',()=>{
  assert.throws(()=>new RaceSession({text:''}));assert.throws(()=>new DefenseSession({words:[]}));
  assert.throws(()=>new DefenseSession({words:[{word:'bad word'}]}));
  const game=new RaceSession({text:'Hello.'});assert.throws(()=>game.start(NaN));game.start(1000);game.update(2000);
  assert.equal(game.update(1500).seconds,1);assert.throws(()=>game.update(Infinity));
});

test('the shipped demo can clear all twelve levels at a steady 35 WPM without errors',()=>{
  const passages=demoData().books[0].segments.map((passage,index)=>({...passage,id:String(index)}));
  const pool=buildWordPool(passages),progress={};
  assert.ok(pool.length>=50);
  for(const level of LEVELS){
    assert.equal(isLevelUnlocked(level.id,progress),true);
    let now=0,seed=42;
    const game=level.mode==='race'
      ?new RaceSession({...level,text:passages[(level.id-1)%passages.length].translation})
      :new DefenseSession({...level,words:pool,random:()=>((seed=(seed*1664525+1013904223)>>>0)/2**32)});
    let snapshot=game.start(now);
    if(level.mode==='race'){
      let value='';
      for(const char of game.text){value+=char;now+=60000/(35*5);snapshot=game.input(value,now);}
    }else{
      while(snapshot.status==='running'&&now<180000){
        const enemy=snapshot.enemies[0];
        if(!enemy){now+=100;snapshot=game.update(now);continue;}
        let value='';
        for(const char of enemy.word){value+=char;now+=60000/(35*5);snapshot=game.input(value,now);if(snapshot.status!=='running')break;}
        if(snapshot.value)snapshot=game.input('',now);
      }
    }
    assert.equal(snapshot.status,'won',`demo level ${level.id} should be playable`);
    const stars=levelStars(level.id,snapshot);assert.ok(stars>=1);progress[level.id]={stars};
  }
});
