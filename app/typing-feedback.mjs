/** Bounded, compositor-only reading feedback; never schedules or changes input. */
export function createTypingFeedback({panel}) {
  const badge=document.createElement('span');badge.className='typing-feedback';badge.setAttribute('aria-hidden','true');badge.hidden=true;
  const accent=document.createElement('span');accent.className='typing-feedback-accent';accent.setAttribute('aria-hidden','true');
  panel.querySelector('.typing-bottom').append(badge);panel.append(accent);
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  const animations=new Map();let words=0,lastWordEnd=0,finished=false;
  function mode(){return document.documentElement.dataset.motion==='off'?'off':media.matches||document.documentElement.dataset.motion==='reduced'?'reduced':'full';}
  function cancel(){for(const animation of animations.values())animation.cancel();animations.clear();}
  function animate(slot,element,keyframes,duration){
    if(mode()!=='full'||!element?.animate)return;
    animations.get(slot)?.cancel();
    const animation=element.animate(keyframes,{duration,easing:'cubic-bezier(.22,1,.36,1)'});animations.set(slot,animation);
    animation.finished.then(()=>{if(animations.get(slot)===animation)animations.delete(slot);}).catch(()=>{});
  }
  function preferenceChanged(){cancel();if(mode()==='off')badge.hidden=true;}
  document.addEventListener('noveltype:motion-change',preferenceChanged);window.addEventListener('noveltype:motion-change',preferenceChanged);media.addEventListener('change',preferenceChanged);
  return {
    reset(){cancel();words=0;lastWordEnd=0;finished=false;badge.hidden=true;},
    input({before,value,target,complete,error,nodes}){
      if(mode()==='off'){badge.hidden=true;return;}
      if(finished&&before===''){lastWordEnd=0;finished=false;}
      // Replacement/deletion never awards a word. No shake or flashing for errors.
      if(error){words=0;badge.hidden=true;return;}
      if(value.length<=before.length||!value.startsWith(before))return;
      const position=Array.from(value).length-1;
      animate('key',nodes?.[position],[{opacity:.45},{opacity:1}],110);
      const boundary=/[\s.,!?;:]$/u.test(value)&&/[\p{L}\p{N}][\s.,!?;:]$/u.test(value);
      if(boundary&&value.length>lastWordEnd&&value.toLowerCase()===target.slice(0,value.length).toLowerCase()){words++;lastWordEnd=value.length;badge.textContent=words>1?`${words} 词连击`:'节奏很好';badge.hidden=false;animate('word',badge,[{transform:'translateY(3px)',opacity:.4},{transform:'translateY(0)',opacity:1}],180);}
      if(complete){finished=true;badge.textContent='本段完成 ✓';badge.hidden=false;animate('word',badge,[{transform:'translateY(4px)',opacity:.3},{transform:'translateY(0)',opacity:1}],220);animate('complete',accent,[{transform:'scaleX(0)',opacity:1},{transform:'scaleX(1)',opacity:1,offset:.45},{transform:'scaleX(1)',opacity:0}],500);}
    }
  };
}
