// CPU-authoritative final act. Presentation cannot advance or rewind the front.
export const ESCAPE = Object.freeze({ warning: 8, start: -65, speed: 7.5, catchRadius: 5 });

export class DimensionalEscape {
  constructor({ rover, game, origin, home, onStart, onFail, onFinish, introDuration = 0 }) {
    Object.assign(this, { rover, game, origin: { ...origin }, home: { ...home }, onStart, onFail, onFinish });
    this.introDuration = Number.isFinite(introDuration) ? Math.max(0, Math.min(introDuration, 120)) : 0;
    const length = Math.hypot(home.x - origin.x, home.z - origin.z);
    this.axis = { x: (home.x - origin.x) / length, z: (home.z - origin.z) / length };
    this.reset();
  }
  get active() { return this.phase === 'warning' || this.phase === 'chase'; }
  get terminal() { return this.phase === 'failed' || this.phase === 'complete'; }
  get cinematicActive() { return this.active && this._cinematicActive; }
  get introActive() { return this.cinematicActive && this.introElapsed < this.introDuration; }
  get introProgress() { return this.introDuration > 0 ? Math.min(1, this.introElapsed / this.introDuration) : 1; }
  get progress() {
    return (this.rover.pos.x - this.origin.x) * this.axis.x + (this.rover.pos.z - this.origin.z) * this.axis.z;
  }
  get gap() { return this.progress - this.front - ESCAPE.catchRadius; }
  reset() {
    this.phase = 'idle'; this.elapsed = 0; this.front = ESCAPE.start;
    this.introElapsed = 0; this._cinematicActive = false;
    this.protected = false; this.reason = ''; this.restoredMotion=false; this.supply(false);
  }
  supply(on) {
    this.rover.overcharge = this.game.overcharge = on;
    if (on) {
      this.game.power = 100; this.rover.powerScale = 1; this.rover.boostAvailable = 1;
      this.rover.chargeState = null;
    }
  }
  start() {
    if (this.phase !== 'idle') return false;
    this.phase = 'warning'; this.elapsed = 0; this.front = ESCAPE.start;
    this.introElapsed = 0; this._cinematicActive = this.introDuration > 0;
    this.game.hull = 100;
    this.supply(true); this.onStart?.(); return true;
  }
  // Only the playable, unpaused render loop advances authored shots. Reaching
  // their end does not release pursuit: the camera must hand control back first.
  advanceIntro(dt) {
    if (!this.introActive || !Number.isFinite(dt)) return false;
    this.introElapsed = Math.min(this.introDuration, this.introElapsed + Math.max(0, Math.min(dt, .1)));
    if (this.introDuration - this.introElapsed < 1e-8) this.introElapsed = this.introDuration;
    return true;
  }
  skipIntro() {
    if (!this.cinematicActive) return false;
    this.introElapsed = this.introDuration; return true;
  }
  finishIntro() {
    if (!this.cinematicActive) return false;
    this.introElapsed = this.introDuration; this._cinematicActive = false;
    // elapsed has remained zero throughout the intro and return. Never reset it
    // here: a duplicate callback after loading a chase cannot rewind the front.
    this.protected = false; return true;
  }
  update(dt, { paused = false, holdingHome = false } = {}) {
    if (!this.active || paused) return;
    this.supply(true);
    if (this.cinematicActive) { this.protected = false; return; }
    const homeDistance = Math.hypot(this.rover.pos.x - this.home.x, this.rover.pos.z - this.home.z);
    // Protection is earned by the same stopped/inside/held E condition as delivery.
    // Merely reaching the home area, releasing E, or moving never freezes pursuit.
    this.protected = holdingHome && homeDistance < 10.5 && this.rover.vel.length() < 0.75;
    if (this.protected) return;
    const previousChase = Math.max(0, this.elapsed - ESCAPE.warning);
    this.elapsed += Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
    const chase = Math.max(0, this.elapsed - ESCAPE.warning);
    this.phase = this.elapsed >= ESCAPE.warning ? 'chase' : 'warning';
    this.front += (chase - previousChase) * ESCAPE.speed;
    if (this.phase === 'chase' && this.gap <= 0) this.fail('车辆已被地裂崩塌带追上');
  }
  fail(reason = '车辆无法继续撤离') {
    if (!this.active) return false;
    this.phase = 'failed'; this.reason = reason; this.protected = false; this._cinematicActive = false;
    this.supply(false); this.stop(); this.onFail?.(reason); return true;
  }
  finish() {
    if (this.phase === 'complete' || this.phase === 'failed') return false;
    this.phase = 'complete'; this.protected = false; this._cinematicActive = false;
    this.supply(false); this.stop(); this.onFinish?.(); return true;
  }
  stop() { this.rover.cancelBoost?.(); this.rover.vel.set(0, 0, 0); this.rover.omega?.set(0, 0, 0); }
  retry() {
    if (this.phase !== 'failed') return false;
    this.reset(); this.start(); return true;
  }
  save() {
    const r=this.rover;
    return {version:2,phase:this.phase,elapsed:this.elapsed,reason:this.reason,
      introElapsed:this.introElapsed,introDuration:this.introDuration,cinematicActive:this.cinematicActive,
      motion:this.active&&r.quat?{pos:r.pos.toArray(),vel:r.vel.toArray(),quat:r.quat.toArray(),
        omega:r.omega.toArray(),spin:r.wheels.map(w=>w.spinVel),
        headlights:!!r.headlights,highBeams:!!r.highBeams}:null};
  }
  load(saved, stage) {
    this.reset();
    if (stage !== 'return' && stage !== 'complete') return;
    if (stage === 'complete') { this.phase = 'complete'; return; }
    this.start();
    if (![1,2].includes(saved?.version) || !['warning', 'chase', 'failed'].includes(saved.phase) ||
        !Number.isFinite(saved.elapsed) || saved.elapsed < 0 || saved.elapsed > 3600) return;
    if (saved.version === 2 && (
        !Number.isFinite(saved.introDuration) || saved.introDuration < 0 || saved.introDuration > 120 ||
        !Number.isFinite(saved.introElapsed) || saved.introElapsed < 0 || saved.introElapsed > saved.introDuration ||
        typeof saved.cinematicActive !== 'boolean' ||
        (saved.cinematicActive && (saved.introDuration === 0 || saved.elapsed !== 0 || saved.phase !== 'warning')))) return;
    this.elapsed = saved.elapsed;
    this.front = ESCAPE.start + Math.max(0, this.elapsed - ESCAPE.warning) * ESCAPE.speed;
    this.phase = saved.phase === 'failed' ? 'failed' : this.elapsed < ESCAPE.warning ? 'warning' : 'chase';
    this.reason = saved.phase === 'failed' ? '车辆已被地裂崩塌带追上' : '';
    // Existing saves have already seen the event; do not replay an intro or
    // change chase progress. A v2 intro resumes at the same normalized shot.
    this._cinematicActive = saved.version === 2 && saved.cinematicActive && this.active && this.introDuration > 0;
    this.introElapsed = this._cinematicActive
      ? this.introDuration * (saved.introElapsed / saved.introDuration) : this.introDuration;
    this.supply(this.active);
    const m=saved.motion, r=this.rover;
    const vector=(a,n,max)=>Array.isArray(a)&&a.length===n&&a.every(v=>Number.isFinite(v)&&Math.abs(v)<=max);
    if(this.active&&r.quat&&m&&vector(m.pos,3,2000)&&vector(m.vel,3,80)&&
       vector(m.quat,4,1.001)&&Math.hypot(...m.quat)>.99&&vector(m.omega,3,12)&&vector(m.spin,6,180)) {
      r.pos.fromArray(m.pos);r.vel.fromArray(m.vel);r.quat.fromArray(m.quat).normalize();r.omega.fromArray(m.omega);
      r.wheels.forEach((w,i)=>{w.spinVel=m.spin[i];});
      r.headlights=!!m.headlights;r.highBeams=r.headlights&&!!m.highBeams;
      r.lampPower=r.headlights?1:0;r.highBeamPower=r.highBeams?1:0;
      r.sync();this.restoredMotion=true;
    }
  }
}
