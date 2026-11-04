/** Native text editing with a compact input proxy beside the visible target caret.
 * Layout reads are batched once per frame, outside the input handler. Scrolling
 * itself never changes the selection, progress or translation scheduling.
 */
export function createInlineTyping({input,getCaret,getToolbar}) {
  let surface=null,target=null,frame=0,follow=false;
  const observer=new ResizeObserver(()=>schedule());
  function layout(){
    frame=0;const reveal=follow;follow=false;
    if(!surface?.isConnected||surface.getClientRects().length===0)return;
    const caret=getCaret()||target;if(!caret)return;
    const box=caret.getBoundingClientRect(),host=surface.getBoundingClientRect();
    // The native textarea scrolls only its own hidden text, never a duplicate
    // paragraph below the visible target. Keep its focus rectangle at the caret.
    input.style.left=`${Math.max(0,Math.min(host.width-3,box.left-host.left))}px`;
    input.style.top=`${Math.max(0,box.top-host.top)}px`;
    input.style.height=`${Math.max(20,box.height)}px`;
    if(reveal){
      const toolbar=getToolbar()?.getBoundingClientRect();
      const top=Math.max(24,Math.min(innerHeight-80,(toolbar?.bottom||0)+16));
      const bottom=innerHeight-32;
      const delta=box.top<top?box.top-top:box.bottom>bottom?box.bottom-bottom:0;
      if(delta)window.scrollBy({top:delta,behavior:'instant'});
    }
  }
  function schedule(reveal=false){follow=follow||reveal;if(!frame)frame=requestAnimationFrame(layout);}
  function attach(next,nextTarget){
    if(surface!==next){observer.disconnect();surface=next;target=nextTarget;input.style.left='0px';input.style.top='0px';if(target)observer.observe(target);}
    schedule();
  }
  function focus(reveal=false){if(!input.disabled){input.focus({preventScroll:true});schedule(reveal);}}
  function navigate(event,cache){
    if(!cache||event.ctrlKey||event.altKey||event.metaKey||event.isComposing||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return false;
    const value=Array.from(input.value),nodes=[...cache.nodes,...(cache.extra?.children||[]),cache.end];
    const positions=nodes.slice(0,value.length+1).map((node,index)=>({index,rect:node.getBoundingClientRect()}));
    const focusOffset=input.selectionDirection==='backward'?input.selectionStart:input.selectionEnd;
    const index=Math.min(Array.from(input.value.slice(0,focusOffset)).length,positions.length-1),current=positions[index];
    if(!current)return false;
    const line=positions.filter(p=>Math.abs(p.rect.top-current.rect.top)<3);let destination=index;
    if(event.key==='Home')destination=line[0].index;
    else if(event.key==='End'){
      const last=line.at(-1).index;
      // A hard line break belongs to the preceding visual line, but End must
      // stop before it so the next character is not silently skipped.
      destination=Math.min(value.length,last+(cache.characters[last]==='\n'?0:1));
    }
    else{
      const direction=event.key==='ArrowUp'?-1:1,candidates=positions.filter(p=>(p.rect.top-current.rect.top)*direction>3);
      if(candidates.length){
        const rowTop=candidates.reduce((best,p)=>Math.abs(p.rect.top-current.rect.top)<Math.abs(best-current.rect.top)?p.rect.top:best,candidates[0].rect.top);
        destination=candidates.filter(p=>Math.abs(p.rect.top-rowTop)<3).reduce((best,p)=>Math.abs(p.rect.left-current.rect.left)<Math.abs(best.rect.left-current.rect.left)?p:best).index;
      }
    }
    event.preventDefault();const offset=value.slice(0,destination).join('').length;
    if(event.shiftKey){const anchor=input.selectionDirection==='backward'?input.selectionEnd:input.selectionStart;input.setSelectionRange(Math.min(anchor,offset),Math.max(anchor,offset),offset<anchor?'backward':'forward');}
    else input.setSelectionRange(offset,offset);
    schedule(true);return true;
  }
  input.addEventListener('mousedown',event=>{if(event.button===0){event.preventDefault();focus();}});
  input.addEventListener('focus',()=>{surface?.classList.add('has-typing-focus');schedule();});
  input.addEventListener('blur',()=>surface?.classList.remove('has-typing-focus'));
  window.addEventListener('resize',()=>schedule());
  return {attach,schedule,focus,navigate};
}
