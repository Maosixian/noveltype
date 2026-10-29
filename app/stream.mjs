export function initialRange(total,position){return {start:Math.max(0,position-4),end:Math.min(total,position+8)};}
export function extendRange(range,direction,total){return direction<0?{start:Math.max(0,range.start-12),end:range.end}:{start:range.start,end:Math.min(total,range.end+12)};}
export function nextPosition(position,total,complete){return complete&&position+1<total?position+1:position;}
export function translationCandidate(segments,position,enabled){
  if(!enabled||!segments[position])return null;
  if(!segments[position].translation)return position;
  return segments[position+1]&&!segments[position+1].translation?position+1:null;
}
