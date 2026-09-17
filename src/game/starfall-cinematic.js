import * as THREE from 'three';
import { DimensionalCinematic } from './dimensional-cinematic.js';
import { lerp,sstep } from '../core/rng.js';
export const STARFALL_SHOTS=Object.freeze([
  {at:0,title:'中继唤醒',detail:'蓝色光束正在汇聚 · 车辆超载充能'},
  {at:4.8,title:'仰望信号',detail:'光束穿入高空 · 天幕开始变化'},
  {at:10,title:'星空苏醒',detail:'蓝白笔触与金色星团正在天空中展开'},
  {at:17,title:'山脊正在下沉',detail:'远处岩层错动 · 震源正在接近'},
  {at:21,title:'断层逼近中塔',detail:'落石与尘墙正在吞没来路'},
  {at:24,title:'立即撤回母港',detail:'后方地表失稳 · 镜头归位后沿金色标记撤离'}
]);
// Reuse only the tested lock, skip, pause, saved-shot and handoff machinery.
// No flattened-world camera coordinates or former mural framing survive here.
export class StarfallCinematic extends DimensionalCinematic {
  get state(){
    if(!this.active)return null;
    const shot=[...STARFALL_SHOTS].reverse().find(s=>this.escape.introElapsed>=s.at);
    return {title:this.ending?'驾驶即将恢复':shot.title,
      detail:this.ending?'按住 Shift 超载加速 · 返回母港停车并按住 E':shot.detail,
      hint:this.ending?'追赶尚未开始':'空格跳过镜头 · Esc 暂停',
      progress:this.escape.introProgress,skippable:!this.ending,kind:'星空异变 · 地裂撤离'};
  }
  _pose(t){
    const anchor=this.fold.anchor,axis=this.axis,side=this.side;
    const ground=(a,s,h)=>{const p=anchor.clone().addScaledVector(axis,a).addScaledVector(side,s);p.y=this.terrain.heightAt(p.x,p.z)+h;return p;};
    // Keep every observation point on the same safe flank of the relay.
    // The previous sky-to-quake move crossed the station and placed the lens
    // behind its large imported meshes. Observe failure from the intact edge.
    const beamPos=ground(26,30,5),beamLook=anchor.clone().add(new THREE.Vector3(0,3,0));
    const skyPos=ground(26,32,7),skyLook=anchor.clone().addScaledVector(axis,-720).addScaledVector(side,-130);skyLook.y+=960;
    const quakePos=ground(12,72,6),quakeLook=ground(-88,90,3);
    this._clear(quakePos,quakeLook);
    const ridgePos=ground(20,64,9),ridgeLook=ground(-185,90,4);
    this._clear(ridgePos,ridgeLook);
    const nodes=[{at:0,position:this.from.position,look:this.from.look,fov:this.from.fov},
      {at:3.8,position:beamPos,look:beamLook,fov:49},
      {at:11,position:skyPos,look:skyLook,fov:73},
      {at:15.5,position:skyPos,look:skyLook,fov:77},
      {at:19.5,position:ridgePos,look:ridgeLook,fov:60},
      {at:24.1,position:quakePos,look:quakeLook,fov:62},
      {at:26,position:quakePos,look:quakeLook,fov:65}];
    let i=0;while(i<nodes.length-2&&t>nodes[i+1].at)i++;
    const a=nodes[i],b=nodes[i+1],k=sstep(a.at,b.at,t),position=a.position.clone().lerp(b.position,k);
    this._clear(position);
    const orientation=n=>new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(n.position,n.look,new THREE.Vector3(0,1,0)));
    const quaternion=orientation(a).slerp(orientation(b),k),distance=lerp(a.position.distanceTo(a.look),b.position.distanceTo(b.look),k);
    const look=new THREE.Vector3(0,0,-1).applyQuaternion(quaternion).multiplyScalar(distance).add(position);
    return {position,look,quaternion,distance,fov:lerp(a.fov,b.fov,k)};
  }
}
