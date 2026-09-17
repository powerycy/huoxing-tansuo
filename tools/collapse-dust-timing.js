// Deterministic event-time sampling: scrubbing, pausing, and replay do not
// accumulate particles or use random wall-clock state.
const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
export function dustEmitters(contacts){
  return contacts.flatMap((c,i)=>[0,1,...(i%3===0?[2]:[])].map(layer=>({
    start:c.time+layer*.13,life:layer===2?8.2:layer===1?6.8:5.8,
    position:c.position,size:c.size,layer,seed:i*2.39996+layer*1.3,
  })));
}
export function dustPose(e,time){
  const age=time-e.start,t=age/e.life;
  if(age<=0||t>=1)return null;
  const drift=1-Math.exp(-age*.5),ground=e.layer===1;
  const width=e.size*(ground?4.5:4.2)*(.52+.48*drift);
  const height=width*(ground?.33:e.layer===2?1.15:.92);
  return {frame:Math.min(23.999,t*24),width,height,
    x:e.position[0]+Math.sin(e.seed)*drift*(ground?3:1.4),
    y:.35+height*(ground?.29:.44)+Math.max(0,age-.5)*(ground?.06:.40),
    z:e.position[2]+Math.cos(e.seed)*drift*(ground?3:1.4),
    opacity:smooth(0,.25,age)*(1-smooth(.55,1,t))*(ground?.58:e.layer===2?.42:.9),
    mirror:Math.sin(e.seed)>0?1:0,
  };
}
