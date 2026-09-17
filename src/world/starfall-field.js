// Fixed world-space faults. The visible front never leads the CPU catch line:
// the rover loses before its wheels could encounter a render-only cavity.
import { sstep, lerp } from '../core/rng.js';

export const STARFALL = Object.freeze({ intro: 26, beam: 1.2, sky: 6, quake: 17,
  settle: 4, spacing: 26, halfWidth: 2.6, depth: 8 });
export function starfallState(escape) {
  const visible = escape.phase !== 'idle';
  const time = escape.cinematicActive ? escape.introElapsed : escape.introDuration + escape.elapsed;
  return { time, beam: visible ? sstep(1.2, 4.8, time) : 0,
    sky: visible ? sstep(6, 15.5, time) : 0,
    quake: visible ? sstep(17, 22.5, time) : 0,
    // The observed rupture starts far away, then reaches the parked rover's
    // rear. It can never pass the authoritative danger line during the film.
    front: Math.min(escape.front,lerp(-320,-65,sstep(17,25.6,time)))
      + (time>=26 ? Math.max(0,escape.front+65) : 0), visible };
}
// Integrated angular travel: no reset, sudden speed switch, or wall-clock input.
export function skyTurnAt(t){const a=Math.max(0,t-7),b=Math.max(0,t-17);return a*.065+b*.045-(1-Math.exp(-b*.3))*.15;}
export function quakeImpactAt(t){return [[18.2,.62,.32],[21.5,.82,.38],[24.3,1,.30]]
  .reduce((sum,[at,gain,width])=>sum+gain*Math.exp(-(((t-at)/width)**2)),0);}
// Small integer polynomial: the same intermediate integers remain exactly
// representable by GLSL highp floats. Avoid fract(sin(...)) CPU/GPU drift.
const quakeMod = (n,d) => n-Math.floor(n/d)*d;
function quakeCell(x,y){const n=quakeMod(x*17+y*131,251);return quakeMod(n*n*13+n*19+23,251)/250;}
function quakeBlock(s,d){
  const x=s/54,z=d/38,ix=Math.floor(x),iz=Math.floor(z);
  const u=sstep(.18,.82,x-ix),v=sstep(.18,.82,z-iz);
  return lerp(lerp(quakeCell(ix,iz),quakeCell(ix+1,iz),u),lerp(quakeCell(ix,iz+1),quakeCell(ix+1,iz+1),u),v);
}
function faultSegment(s,row){
  const q=s/38+row*.013,i=Math.floor(q);
  return lerp(quakeCell(i,row/26),quakeCell(i+1,row/26),sstep(.18,.82,q-i));
}
export function seismicDrop(x,z,origin,axis,front,on){
  const s=(x-origin.x)*axis.z-(z-origin.z)*axis.x,d=(x-origin.x)*axis.x+(z-origin.z)*axis.z;
  // Broad slabs stay level through most of each cell, then join smoothly.
  // Their different release delays prevent a synchronous rolling sine wave.
  const block=quakeBlock(s,d),delay=2+5*(1-block),travel=16+8*block;
  return sstep(delay,delay+travel,front-d)*on*(4+10*block);
}
export const SKY_FLOW_GLSL=/* glsl */`
  uniform float uSkyTurn,uBearing;
  vec2 spinEddy(vec2 p,vec2 center,float radius,float angle){
    vec2 q=p-center;float k=exp(-dot(q,q)/(radius*radius));
    float a=angle*k,c=cos(a),s=sin(a);
    return center+mat2(c,s,-s,c)*q;
  }
  vec2 skyFlow(vec2 p,float turn){
    p=spinEddy(p,vec2(-.43,.85),.46,turn);
    p=spinEddy(p,vec2(.83,.51),.34,-turn*.70);
    return p;
  }
`;
export const faultBend = s => 7*Math.sin(s*.028)+2.2*Math.sin(s*.113)+.8*Math.sin(s*.37);
export function faultWidth(s, row, front, on) {
  const center=row+faultBend(s),segment=faultSegment(s,row),delay=2+6*(1-segment);
  // Interrupted, uneven crack segments, all opening behind the catch line.
  return 2.6*(.62+.38*segment)*sstep(.19,.45,segment)*on*sstep(delay,delay+10+5*segment,front-center);
}
export function faultContains(x,z,origin,axis,front,on) {
  const side=(x-origin.x)*axis.z-(z-origin.z)*axis.x;
  const d=(x-origin.x)*axis.x+(z-origin.z)*axis.z;
  const row=Math.floor((d-faultBend(side))/26+.5)*26;
  return Math.abs(side)<590 && row>=-364 && row<=624 && Math.abs(d-row-faultBend(side)) < faultWidth(side,row,front,on);
}
export const FAULT_GLSL = /* glsl */`
  uniform vec2 uQuakeOrigin,uQuakeAxis;
  uniform float uQuakeFront,uQuakeOn;
  float quakeCell(float x,float y){
    float n=mod(x*17.0+y*131.0,251.0);return mod(n*n*13.0+n*19.0+23.0,251.0)/250.0;
  }
  float quakeBlock(float s,float d){
    vec2 q=vec2(s/54.0,d/38.0),i=floor(q),f=smoothstep(vec2(.18),vec2(.82),q-i);
    return mix(mix(quakeCell(i.x,i.y),quakeCell(i.x+1.0,i.y),f.x),
      mix(quakeCell(i.x,i.y+1.0),quakeCell(i.x+1.0,i.y+1.0),f.x),f.y);
  }
  float faultSegment(float s,float row){
    float q=s/38.0+row*.013,i=floor(q);
    return mix(quakeCell(i,row/26.0),quakeCell(i+1.0,row/26.0),smoothstep(.18,.82,q-i));
  }
  vec3 seismicWorld(vec3 p){
    vec2 local=p.xz-uQuakeOrigin;
    float s=dot(local,vec2(uQuakeAxis.y,-uQuakeAxis.x)),d=dot(local,uQuakeAxis);
    float block=quakeBlock(s,d),delay=2.0+5.0*(1.0-block),travel=16.0+8.0*block;
    p.y-=smoothstep(delay,delay+travel,uQuakeFront-d)*uQuakeOn*(4.0+10.0*block);return p;
  }
  float faultBend(float s){return 7.0*sin(s*.028)+2.2*sin(s*.113)+.8*sin(s*.37);}
  float faultWidth(float s,float row){
    float center=row+faultBend(s),segment=faultSegment(s,row),delay=2.0+6.0*(1.0-segment);
    return 2.6*(.62+.38*segment)*smoothstep(.19,.45,segment)*uQuakeOn*smoothstep(delay,delay+10.0+5.0*segment,uQuakeFront-center);
  }
  bool faultContains(vec3 p){
    vec2 local=p.xz-uQuakeOrigin;
    float s=dot(local,vec2(uQuakeAxis.y,-uQuakeAxis.x)),d=dot(local,uQuakeAxis);
    float row=floor((d-faultBend(s))/26.0+.5)*26.0;
    return abs(s)<590.0 && row>=-364.0 && row<=624.0 && abs(d-row-faultBend(s))<faultWidth(s,row);
  }
`;
