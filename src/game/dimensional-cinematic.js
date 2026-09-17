/* A short, world-space observation shot before the final drive. The state
   machine owns the protected interval; this rig cannot move the chase front. */
import * as THREE from 'three';
import { lerp, sstep } from '../core/rng.js';

export const DIMENSIONAL_INTRO_SECONDS = 22;
export const DIMENSIONAL_RETURN_SECONDS = 2.8;
export const DIMENSIONAL_SHOTS = Object.freeze([
  { at: 0, title: '中继超载', detail: '供能链路已接通 · 车辆驻停' },
  { at: 3, title: '边界接触', detail: '观测后方岩层 · 银色边缘正在接近' },
  { at: 7.5, title: '厚度正在消失', detail: '岩层正在贴向地面 · 石纹与地貌仍然相连' },
  { at: 12, title: '大地正在流入画中', detail: '地面上的纹理向上延展 · 蓝与金沿着笔触蔓延' },
  { at: 18, title: '世界成为一幅画', detail: '山脊留在画的边缘 · 准备撤回母港' }
]);

export class DimensionalCinematic {
  constructor({ escape, fold, rig, terrain, rover, onRelease }) {
    Object.assign(this, { escape, fold, rig, terrain, rover, onRelease });
    this.active = false;
    this.ending = false;
    this.position = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.fov = 58;
  }

  get state() {
    if (!this.active) return null;
    const shot = [...DIMENSIONAL_SHOTS].reverse().find(s => this.escape.introElapsed >= s.at);
    return {
      title: this.ending ? '准备撤离' : shot.title,
      detail: this.ending ? '正在交还驾驶视角 · 随后按住 Shift 加速' : shot.detail,
      hint: this.ending ? '追赶尚未开始' : '空格跳过镜头 · Esc 暂停',
      progress: this.escape.introProgress,
      skippable: !this.ending,
      kind: '二维化观测'
    };
  }

  start() {
    if (this.active || !this.escape.cinematicActive) return false;
    this.hero = this.fold.getCinematicSubject();
    if (!this.hero) {
      // Asset failure must never leave a permanent input lock.
      this.escape.skipIntro(); this.escape.finishIntro(); return false;
    }
    this.axis = new THREE.Vector3(this.escape.axis.x, 0, this.escape.axis.z);
    // Observe the moon-lit flank, not the featureless backlit silhouette.
    this.side = new THREE.Vector3(this.axis.z, 0, -this.axis.x);
    // A preview/load can enter before the chase rig's first frame. Establish
    // the parked vehicle pose, never inherit the title screen's distant orbit.
    if (this.rig.first && !this.rig.cinematicLocked) {
      this.rig.update(0,this.rover,{lookX:0,lookY:0,zoom:0,looking:false},{throttle:0,steer:0});
    }
    this.position.copy(this.rig.cam.position);
    this.rig.cam.getWorldDirection(this.look).multiplyScalar(15).add(this.position);
    this.fov = this.rig.cam.fov / this.rig.fovScale;
    this.from = { position: this.position.clone(), look: this.look.clone(), fov: this.fov,
      quaternion: this.rig.cam.quaternion.clone() };
    this.orientation=this.from.quaternion.clone();
    this.active = true; this.ending = false;
    this.resumeBlend = this.escape.introElapsed > 0 ? 0 : 1;
    this.rig.lockCinematic();
    this.rover.cancelBoost?.();
    return true;
  }

  skip() {
    if (!this.active || this.ending) return false;
    // Finish the visual wave while returning the lens, keeping chase frozen.
    this.skippedAt = this.escape.introElapsed;
    this._return();
    return true;
  }

  cancel() {
    if (this.active) this.rig.releaseCinematic(true);
    this.active = this.ending = false;
    this.skippedAt = undefined;
  }

  _return() {
    this.ending = true;
    this.returnElapsed = 0;
    this.rig.releaseCinematic();
    // A slightly longer handoff than the flower macro shot: this lens has
    // travelled farther. Preserve the player's original camera mode/angles.
    if (this.rig._cinematicReturn) this.rig._cinematicReturn.duration = DIMENSIONAL_RETURN_SECONDS;
  }

  _clear(position, target = null, clearance = 1.2) {
    const localSurface=(x,y,z)=>{
      const folded=this.fold.sampleFoldPosition(new THREE.Vector3(x,y,z));
      // A source point can now feed into the upright mural far behind its old
      // ground position. It only obstructs this ray while still nearby in XZ.
      // Fade the footprint to keep a bending surface from snapping the lens.
      const nearby=1-sstep(.7,2.1,Math.hypot(folded.x-x,folded.z-z));
      return lerp(y,Math.max(y,folded.y),nearby);
    };
    let ground = this.terrain.heightAt(position.x, position.z);
    for (const [x,z] of [[.7,0],[-.7,0],[0,.7],[0,-.7]]) {
      ground = Math.max(ground, this.terrain.heightAt(position.x+x, position.z+z));
    }
    position.y = Math.max(position.y, ground + clearance);
    position.y = Math.max(position.y, localSurface(position.x,ground,position.z) + clearance);
    if (!target) return position;
    let lift = 0;
    for (let i=1;i<=14;i++) {
      const t=i/16, x=lerp(position.x,target.x,t), z=lerp(position.z,target.z,t);
      const y=this.terrain.heightAt(x,z);
      const surface=localSurface(x,y,z);
      lift=Math.max(lift,(surface+.25-lerp(position.y,target.y,t))/(1-t));
    }
    position.y += Math.max(0,lift);
    return position;
  }

  _pose(t) {
    const root=this.hero.root;
    const foldedRoot=this.fold.sampleFoldPosition(root);
    const foldedCrown=this.fold.sampleFoldPosition(this.hero.crown);
    const target=foldedRoot.clone().lerp(foldedCrown,.64);
    // Hold the same source rock through compression. Only after the flattened
    // image starts travelling up the standing plane do we reveal its skyline.
    const widen=sstep(12,20,t);
    const far=root.clone().addScaledVector(this.axis,-40);
    far.y=this.terrain.heightAt(far.x,far.z);
    const mural=this.fold.getMuralFocus?.() || this.fold.sampleFoldPosition(far);
    target.lerp(mural,widen);
    const pullback=90/Math.min(1,this.rig.fovScale);
    const close=root.clone().addScaledVector(this.axis,lerp(14,pullback,widen))
      .addScaledVector(this.side,lerp(18,30,widen));
    // The source image rises; its observer stays over the original ground.
    // Following the transported root would turn this into an aerial shot and
    // point the final lens down into the painting instead of up at its height.
    close.y=root.y+lerp(6.5,18,widen);
    this._clear(close,target);

    // First settle on the real lit relay, then arc into the rock observation.
    const relay=new THREE.Vector3(this.escape.origin.x,0,this.escape.origin.z);
    relay.y=this.terrain.heightAt(relay.x,relay.z)+4.3;
    const overview=this.from.position.clone().addScaledVector(this.side,3.5);
    overview.y+=3.2;
    this._clear(overview,relay);
    const establish=sstep(0,2.8,t), approach=sstep(2.6,6.5,t);
    const position=this.from.position.clone().lerp(overview,establish).lerp(close,approach);
    // Interpolating two look-at POINTS can pass the target through the lens
    // during a near-180° turn. Interpolate orientations on the unit sphere.
    const orientationAt=(position,look)=>new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(position,look,new THREE.Vector3(0,1,0)));
    const quaternion=this.from.quaternion.clone().slerp(orientationAt(overview,relay),establish)
      .slerp(orientationAt(close,target),approach);
    const distance=lerp(lerp(15,overview.distanceTo(relay),establish),close.distanceTo(target),approach);
    const look=new THREE.Vector3(0,0,-1).applyQuaternion(quaternion).multiplyScalar(distance).add(position);
    this._clear(position);
    return {position,look,quaternion,distance,fov:lerp(lerp(this.from.fov,49,establish),lerp(38,62,widen),approach)};
  }

  update(dt) {
    if (!this.active) {
      if (this.escape.cinematicActive) this.start();
      if (!this.active) return;
    }
    if (!this.escape.active) { this.cancel(); return; }
    if (this.ending) {
      this.returnElapsed+=dt;
      if (this.skippedAt !== undefined) {
        // A skipped view still leaves the final landscape coherent; do not
        // teleport the whole wave in the frame the user presses Space.
        const remaining=(1-sstep(0,DIMENSIONAL_RETURN_SECONDS-.2,this.returnElapsed));
        const target=this.escape.introDuration-(this.escape.introDuration-this.skippedAt)*remaining;
        let remainingTime=Math.max(0,target-this.escape.introElapsed);
        while(remainingTime>1e-7) {
          const step=Math.min(.1,remainingTime);
          this.escape.advanceIntro(step); remainingTime-=step;
        }
      }
      if (!this.rig.cinematicReturning) {
        this.escape.skipIntro(); this.escape.finishIntro();
        this.active=this.ending=false;
        this.skippedAt=undefined;
        this.onRelease?.();
      }
      return;
    }
    this.escape.advanceIntro(dt);
    const pose=this._pose(this.escape.introElapsed);
    this.resumeBlend=Math.min(1,this.resumeBlend+dt/1.4);
    const blend=sstep(0,1,this.resumeBlend);
    this.position.lerpVectors(this.from.position,pose.position,blend);
    // Follow a moving target incrementally. Repeatedly slerping from a fixed
    // saved orientation can flip its shortest arc as a load crosses 180°.
    const angle=this.orientation.angleTo(pose.quaternion);
    this.orientation.rotateTowards(pose.quaternion,Math.min(dt*1.5,angle*(1-Math.exp(-dt*6))));
    const orientation=this.orientation;
    this.look.set(0,0,-1).applyQuaternion(orientation).multiplyScalar(pose.distance).add(this.position);
    this.fov=lerp(this.from.fov,pose.fov,blend);
    // Only the authored overview/subject rays require a clear sightline.
    // During a turn this look point is a direction at an interpolated range,
    // not a physical subject: clearing hills along it can hoist a resumed
    // ground-level shot hundreds of metres while the lens is still rotating.
    this._clear(this.position);
    this.rig.applyCinematicPose(this.position,this.look,this.fov,orientation);
    if (!this.escape.introActive) this._return();
  }
}
