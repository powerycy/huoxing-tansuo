/* ============================================================
   MISSION LOGIC
   ------------------------------------------------------------
   Radar, drill, power, thermal, samples, relays, story beats.
   ============================================================ */
import * as THREE from 'three';
import { makeRNG, clamp, sstep, lerp } from '../core/rng.js';
import { PLAYABLE_R } from '../world/terrain.js';
import { HOME } from '../world/props.js';
import { CODEX, SAMPLES, MISSIONS } from './lore.js';
import { POWER_FLOOR, POWER_KNEE, BOOST_RESERVE, BOOST_FULL_POWER } from './rover.js';
import { chargeState, chargePrompt, CHARGER_LABELS } from './charging.js';

export const STATION = { x: -236, z: 140 };
export const MASSIF = { x: 0, z: 0 };

const BAY_MAX = 6;
const SCAN_RANGE = 78;
const SCAN_COST = 2.0;
const SCAN_TIME = 2.1;
const SCAN_COOL = 1.4;
/* The LRV profile changes the time commitment of a scientific core, but the
   sealed traction pack belongs to the imported vehicle and is deliberately
   identical in both drive profiles. */
export const OPS = { drillTime: 4.2 };
const DRILL_COST = 9.0;
const RELAY_MIN_H = 10;
const RELAY_SPACING = 95;
const HOME_SERVICE_R = 10.5;
const BASE_CHARGE_RATE = 8.5;              // percentage points per second
const NOMINAL_PACK_RANGE_M = 2800;         // rough-terrain range, not odometer truth
const START_POWER = 34;
const LOW_BEAM_DRAIN = 0.004;               // 0.24 percentage points per minute
const HIGH_BEAM_DRAIN = 0.68;               // 40.8 percentage points per minute
const BOOST_DRAIN = 0.045;                 // at most 2.7 points/min, plus actual motor load
export const LIGHT_MIN_POWER = 0.2;

export class Game {
  constructor(ctx) {
    Object.assign(this, ctx);          // {terrain, rover, props, dust, sky, audio, hud, engine, rig}
    this.reset();
  }

  reset(freeRoam = false, unlockAll = freeRoam) {
    this.overcharge = false;
    this.rover.overcharge = false;
    // tear down anything a previous run left in the scene
    if (this.anoms) for (const a of this.anoms) if (a.marker) this.scene.remove(a.marker);
    if (this.props) this.props.clearDeployables();
    this.freeRoam = freeRoam;
    this.deliveryMode = false;
    this.t = 0;
    this.met = 0;
    this.power = START_POWER; this.heat = 12; this.hull = 100;
    this.bay = [];
    this.unlocked = new Set(CODEX.filter(c => c.start).map(c => c.id));
    this.missionIdx = 0;
    this.objDone = {};
    this.counts = {};
    this.relaysPlaced = 0;
    this.excavated = 0;
    this.stationVisited = false;
    this.nodeTaken = false;
    this.transmitted = false;
    this.scan = { active: false, r: 0, t: 0, cool: 0, x: 0, z: 0 };
    this.drill = { active: false, t: 0, target: null };
    this.interact = { key: null, t: 0 };
    this.msgQueue = [];
    this.autoRecover = 0;
    this.flipTimer = 0;
    this.dangerTone = 0;
    this.charging = false;
    this.coupled = false;
    this.chargingSite = null;
    if(this.rover) Object.assign(this.rover,{chargeState:null,coupled:false,charging:false,chargingSite:null,nearCharger:false});
    this.estimatedRangeM = NOMINAL_PACK_RANGE_M * this.power / 100;
    this._chargeAnnouncedSite = null;
    this._chargeFullLogged = false;
    this._criticalWarned = false;
    this._lowWarned = false;
    this._brownWarned = false;
    this._lightsDeadWarned = false;
    this.buildAnomalies();
    if (freeRoam) {
      this.missionIdx = MISSIONS.length;
      if (unlockAll) for (const c of CODEX) this.unlocked.add(c.id);
    }
  }

  /* ============================================================
     buried things
     ============================================================ */
  buildAnomalies() {
    const rng = makeRNG(0x5EED17);
    this.anoms = [];
    const push = (x, z, type, depth, special) => {
      this.anoms.push({
        x, z, type, depth, special: special || null,
        found: false, taken: false, marker: null
      });
    };

    // the lattice: tubes radiating from the massif in a hex arrangement
    for (let ring = 1; ring <= 5; ring++) {
      const n = 4 + ring * 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 0.31;
        const r = 58 + ring * 62 + (rng() - 0.5) * 26;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (Math.hypot(x, z) > PLAYABLE_R - 26) continue;
        if (this.terrain.slopeAt(x, z) > 26) continue;
        push(x, z, 'tube', 3.4 + rng() * 1.4);
      }
    }
    // ordinary science, scattered
    const kinds = ['regolith', 'breccia', 'ilmenite', 'agglutinate', 'pyroclast', 'meteoritic'];
    for (let i = 0; i < 46; i++) {
      const a = rng() * Math.PI * 2, r = 40 + rng() * (PLAYABLE_R - 70);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (this.terrain.slopeAt(x, z) > 28) continue;
      const t = kinds[Math.floor(Math.pow(rng(), 1.6) * kinds.length)];
      push(x, z, t, 1.2 + rng() * 2.2);
    }
    // the deep core under the massif — only reachable in mission 5
    push(MASSIF.x + 6, MASSIF.z - 4, 'core', 11.0, 'node');
    // the film sample, at the station's own dig site
    push(STATION.x + 14, STATION.z + 9, 'film', 4.1, 'film');
  }

  /* ============================================================
     helpers
     ============================================================ */
  get mission() { return MISSIONS[this.missionIdx] || null; }
  get bayFull() { return this.bay.length >= BAY_MAX; }
  distTo(x, z) { return Math.hypot(this.rover.pos.x - x, this.rover.pos.z - z); }
  get atHome() { return this.distTo(HOME.x, HOME.z) < HOME_SERVICE_R; }

  enterDeliveryMode() {
    if (this.deliveryMode && this.missionIdx === MISSIONS.length) return;
    this.deliveryMode = true;
    this.freeRoam = true;
    this.missionIdx = MISSIONS.length;
    this.hud.missionDirty = true;
  }

  log(text, kind) { this.hud.log(text, kind); }

  unlock(id, announce = true) {
    if (this.unlocked.has(id)) return;
    const e = CODEX.find(c => c.id === id);
    if (!e) return;
    this.unlocked.add(id);
    this.hud.codexDirty = true;
    if (!announce) return;
    this.log(`档案 · ${e.title}`, 'good');
    this.audio.discovery();
    this.hud.flashDiscovery('档案已更新', e.title, e.meta);
  }

  complete(objId) {
    if (this.objDone[objId]) return;
    this.objDone[objId] = true;
    this.audio.ui('ok');
    this.hud.missionDirty = true;
    const m = this.mission;
    if (m && m.objectives.every(o => this.objDone[o.id])) {
      setTimeout(() => this.advance(), 1400);
    }
  }
  bump(objId, n = 1) {
    this.counts[objId] = (this.counts[objId] || 0) + n;
    this.hud.missionDirty = true;
    const m = this.mission;
    const o = m && m.objectives.find(x => x.id === objId);
    if (o && o.count && this.counts[objId] >= o.count) this.complete(objId);
  }

  advance() {
    const done = this.mission;
    if (!done) return;
    this.missionIdx++;
    this.log(`${done.tag} 已完成 — ${done.name}`, 'good');
    this.audio.discovery();
    if (this.mission) {
      this.hud.flashDiscovery('新任务', this.mission.name, this.mission.objectives[0]?.text || '');
      this.hud.missionDirty = true;
    } else {
      this.hud.flashDiscovery('行动完成', '传输完成', '自由勘察已解锁——整座盆地向你开放');
      this.freeRoam = true;
    }
    this.save();
  }

  /* ============================================================
     actions
     ============================================================ */
  doScan() {
    if (this.scan.active || this.scan.cool > 0) return;
    if (this.power < SCAN_COST) { this.log('电量不足，无法进行雷达扫描', 'warn'); this.audio.ui('bad'); return; }
    this.power -= SCAN_COST;
    this.scan.active = true; this.scan.t = 0; this.scan.r = 0;
    this.scan.x = this.rover.pos.x; this.scan.z = this.rover.pos.z;
    this.audio.chirp();
    this.log('探地雷达扫描 · 400 兆赫 · 孔径 78 米');
    this.complete('scan');
  }

  _finishScan() {
    let hits = 0, deep = 0;
    for (const a of this.anoms) {
      if (a.found || a.taken) continue;
      if (a.special === 'node' && this.missionIdx < 4) continue;
      const d = Math.hypot(a.x - this.scan.x, a.z - this.scan.z);
      if (d > SCAN_RANGE) continue;
      a.found = true; hits++;
      if (a.type === 'tube' || a.special) deep++;
      this.addMarker(a);
    }
    if (hits) {
      this.audio.echo();
      this.log(`发现 ${hits} 个地下回波${deep ? ` · ${deep} 个连贯结构` : ''}`, deep ? 'good' : null);
      if (deep && !this.unlocked.has('first-return')) this.unlock('first-return');
    } else {
      this.log('无回波 · 地下 12 米内为均质火星表土');
    }
    this.hud.mapDirty = true;
  }

  addMarker(a) {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.05, 26),
      new THREE.MeshBasicMaterial({ color: a.special || a.type === 'tube' ? 0xffb454 : 0x2ad2ff,
        transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 2.2, 6),
      new THREE.MeshBasicMaterial({ color: 0x2ad2ff, transparent: true, opacity: 0.35, depthWrite: false }));
    post.position.y = 1.1; g.add(post);
    const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.16),
      new THREE.MeshBasicMaterial({ color: a.special || a.type === 'tube' ? 0xffb454 : 0x2ad2ff }));
    cap.position.y = 2.3; g.add(cap);
    g.position.set(a.x, this.terrain.heightAt(a.x, a.z) + 0.04, a.z);
    g.userData.cap = cap;
    this.scene.add(g);
    a.marker = g;
  }

  /** Nearest un-taken return to the DRILL BIT, not to the chassis — the whole
      point of an aimable arm is that where you point it is what you sample. */
  nearestAnom(maxD = 2.6) {
    const p = this.rover.armOut ? this.rover.armTarget : null;
    let best = null, bd = maxD;
    for (const a of this.anoms) {
      if (!a.found || a.taken) continue;
      const d = p ? Math.hypot(p.x - a.x, p.z - a.z) : this.distTo(a.x, a.z);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  /** Stow / deploy the sampling arm. Deployed, the drive keys aim it. */
  toggleArm() {
    if (this.drill.active) return;
    this.rover.armOut = !this.rover.armOut;
    this.audio.ui('tick');
    this.log(this.rover.armOut
      ? '采样臂已展开 · W/S 伸缩 · A/D 摆动 · 鼠标左键钻探'
      : '采样臂已收起');
  }

  startDrill() {
    if (this.drill.active) return;
    if (!this.rover.armOut) { this.toggleArm(); return; }
    if (this.bayFull) { this.log('样本舱已满 · 请返回火星母港', 'warn'); this.audio.ui('bad'); return; }
    if (this.power < DRILL_COST) { this.log('电量不足，无法启动钻探', 'warn'); this.audio.ui('bad'); return; }
    if (this.rover.vel.length() > 1.1) { this.log('请停车后再钻探', 'warn'); return; }
    const a = this.nearestAnom();
    if (a && a.special === 'node' && this.missionIdx < 4) {
      this.log('钻杆长度不足 · 目标位于地下 11 米', 'warn'); this.audio.ui('bad'); return;
    }
    this.drill.active = true; this.drill.t = 0; this.drill.target = a;
    this.rover.drilling = true;
    this.log(a ? `正在钻探 · 目标深度 ${a.depth.toFixed(1)} 米` : '正在钻探 · 盲钻岩芯');
  }

  _finishDrill() {
    const a = this.drill.target;
    const type = a ? a.type : 'regolith';
    const def = SAMPLES[type];
    this.bay.push({ type, name: def.name, rare: def.rare });
    this.hud.bayDirty = true;
    if (a) {
      a.taken = true;
      if (a.marker) { this.scene.remove(a.marker); a.marker = null; }
      this.excavated++;
      this.bump('find3');
      if (a.special === 'node') { this.nodeTaken = true; this.complete('deep'); }
      if (a.special === 'film') this.unlock('charge');
      this.hud.mapDirty = true;
    }
    if (def.unlock) this.unlock(def.unlock);
    this.audio.discovery();
    this.hud.flashDiscovery('样本已收集', def.name, def.desc);
    this.log(`样本 ${String(this.bay.length).padStart(2, '0')} · ${def.name}`, def.rare ? 'good' : null);
    // the excavation stays in the ground, right where the bit went in
    this.terrain.excavate(this.rover.armTarget.x, this.rover.armTarget.z, 1.4, 0.85);
  }

  deployRelay() {
    const p = this.rover.pos;
    const h = this.terrain.heightAt(p.x, p.z);
    if (h < RELAY_MIN_H) {
      this.log(`位置过低 · 当前 ${h.toFixed(0)} 米，需要至少 ${RELAY_MIN_H} 米以建立视线`, 'warn');
      this.audio.ui('bad'); return;
    }
    if (this.props.relays) {
      for (const r of this.props.relays) {
        if (Math.hypot(r.position.x - p.x, r.position.z - p.z) < RELAY_SPACING) {
          this.log('中继器间距过近 · 请移动 95 米', 'warn'); this.audio.ui('bad'); return;
        }
      }
    }
    if (this.relaysPlaced >= 3) { this.log('没有剩余中继器', 'warn'); return; }
    const bx = p.x - this.rover.forward.x * 2.6, bz = p.z - this.rover.forward.z * 2.6;
    this.props.buildRelay(bx, bz);
    this.relaysPlaced++;
    this.dust.spawn(60, bx, this.terrain.heightAt(bx, bz), bz, 1.4, 0.6);
    this.audio.ui('ok'); this.audio.radio();
    this.log(`中继器 ${this.relaysPlaced}/3 已部署 · 海拔 ${h.toFixed(0)} 米`, 'good');
    this.bump('relays');
    if (this.relaysPlaced >= 3) this.unlock('memo');
    this.hud.mapDirty = true;
  }

  /* ============================================================
     per-frame
     ============================================================ */
  update(dt, ctl, input) {
    this.t += dt; this.met += dt;

    /* ---- radar ---- */
    if (this.scan.active) {
      this.scan.t += dt;
      this.scan.r = (this.scan.t / SCAN_TIME) * SCAN_RANGE;
      const fade = 1 - sstep(0.7, 1.0, this.scan.t / SCAN_TIME);
      this.terrain.uniforms.uScanC.value.set(this.scan.x, fade, this.scan.z);
      this.terrain.uniforms.uScanR.value = this.scan.r;
      this.rover.gprGlow.material.opacity = 0.55 * fade;
      if (this.scan.t >= SCAN_TIME) {
        this.scan.active = false; this.scan.cool = SCAN_COOL;
        this.terrain.uniforms.uScanR.value = -1;
        this.rover.gprGlow.material.opacity = 0;
        this._finishScan();
      }
    } else if (this.scan.cool > 0) this.scan.cool -= dt;

    /* ---- drill ---- */
    if (this.drill.active) {
      this.drill.t += dt;
      this.power -= DRILL_COST / OPS.drillTime * dt;
      const fx = this.rover.armTarget.x, fz = this.rover.armTarget.z;
      const fy = this.terrain.heightAt(fx, fz);
      if (Math.random() < dt * 55) {
        this.dust.spawn(3, fx, fy, fz, 0.9 + Math.random() * 0.7, 0.35,
          0, 0, this.drill.target && (this.drill.target.type === 'tube' || this.drill.target.special) ? 0.85 : 0);
      }
      this.rig.addShake(dt * 0.6);
      this.terrain.excavate(fx, fz, 0.9, dt * 0.55);
      if (this.rover.vel.length() > 1.2) {
        this.drill.active = false; this.rover.drilling = false;
        this.log('钻探已中止 · 底盘发生移动', 'warn'); this.audio.ui('bad');
      } else if (this.drill.t >= OPS.drillTime) {
        this.drill.active = false; this.rover.drilling = false;
        this._finishDrill();
      }
    }
    /* ---- sealed battery + base induction charging ----------------------
       The film-inspired rover has no deployable solar wing.  It carries one
       long-life traction pack. Tap T to toggle coupling while parked;
       driving away or entering a locked camera disconnects immediately. */
    const moonUp = this.sky.anomalyMoonDir.y;
    const moonEnergy = clamp(this.sky.anomalyMoonKey / 0.46, 0, 1);
    const eveningSun = clamp((this.sky.sunDir.y + 0.03) * 7.0, 0, 0.55);
    const lit = this.rover.sunVis * Math.max(eveningSun,
      clamp(moonUp * 6, 0, 1) * moonEnergy);
    const state = chargeState(this.rover, this.props, HOME,
      input.enabled !== false && input.hit('KeyT'), !!ctl.cinematicHold || !!ctl.interactionLocked || input.enabled === false,
      Math.abs(ctl.throttle || 0) > 0.05);
    if(this.power >= 99.9) state.coupled = false;
    const site = state.site;
    this.rover.chargeState = state;
    this.coupled = state.coupled;
    this.charging = this.coupled && this.power < 99.9;
    this.chargingSite = site;
    this.rover.nearCharger = state.inside;
    this.rover.coupled = this.coupled;
    this.rover.charging = this.charging;
    this.rover.chargingSite = site;
    this.props.chargingSite = this.coupled ? site : null;

    let drain = 0.008;                                  // sealed avionics floor
    drain += this.rover.motorLoad * 0.075;
    // The low beam is sustainable for a long night crossing, but is not free.
    // High beam is intentionally a short-burst search tool, not a permanent sun.
    drain += this.rover.lampPower * LOW_BEAM_DRAIN;
    drain += this.rover.highBeamPower * HIGH_BEAM_DRAIN;
    drain += (this.rover.boostBlend || 0) * BOOST_DRAIN;
    if (this.heat < -30) drain += 0.018;                 // survival heaters
    // A locked event camera must not spend limited lighting energy while the
    // player has no driving agency. Suppress the debit BEFORE low-pack side
    // effects, not by refunding afterward (which would still switch lamps off).
    if (ctl.cinematicHold) drain = 0;
    const charge = this.coupled ? BASE_CHARGE_RATE : 0;
    this.power = this.overcharge ? 100 : clamp(this.power + (charge - drain) * dt, 0, 100);
    this.estimatedRangeM = NOMINAL_PACK_RANGE_M * this.power / 100;

    if (this.power <= LIGHT_MIN_POWER &&
        (this.rover.headlights || this.rover.highBeams || this.rover.lampPower > 0.02)) {
      this.rover.headlights = false;
      this.rover.highBeams = false;
      if (!this._lightsDeadWarned) {
        this._lightsDeadWarned = true;
        this.log('电量耗尽 · 近光与远光已自动熄灭', 'bad');
        this.audio.ui('warn');
      }
    }
    if (this.power > 1) this._lightsDeadWarned = false;

    if (!this.coupled) this._chargeAnnouncedSite = null;
    if (this.coupled && site !== this._chargeAnnouncedSite) {
      const siteLabel = CHARGER_LABELS[site];
      this.log(`充电已连接 · ${siteLabel} · 按 T 停止，驶离自动断开`, 'good');
      this.audio.ui('ok');
      this._chargeFullLogged = false;
      this._chargeAnnouncedSite = site;
    }
    if (this.charging && this.power >= 99.9 && !this._chargeFullLogged) {
      this.log('牵引电池已充满 · 充电完成', 'good');
      this.audio.ui('ok');
      this._chargeFullLogged = true;
    }
    // A flat pack now costs you the drive, not just the instruments.
    this.rover.powerScale = POWER_FLOOR + (1 - POWER_FLOOR) * clamp(this.power / POWER_KNEE, 0, 1);
    this.rover.boostAvailable = sstep(BOOST_RESERVE, BOOST_FULL_POWER, this.power);
    if (this.power <= BOOST_RESERVE) this.rover.cancelBoost?.();
    if (this.rover.powerScale < 0.99 && !this._brownWarned) {
      this._brownWarned = true;
      this.log('电池电量偏低 · 轮毂扭矩已降低', 'warn'); this.audio.ui('warn');
    }
    if (this.power > POWER_KNEE + 4) this._brownWarned = false;

    const targetHeat = lerp(-68, -12, lit) + this.rover.motorLoad * 14 + (this.drill.active ? 10 : 0);
    this.heat += (targetHeat - this.heat) * Math.min(1, dt * 0.055);

    if (this.power < 25 && !this._lowWarned) {
      this._lowWarned = true; this.log('电池电量低 · 可前往母港、基地或孤立中继站，停车按 T 充电', 'warn'); this.audio.ui('warn');
    }
    if (this.power > 30) this._lowWarned = false;
    if (this.power < 10 && !this._criticalWarned) {
      this._criticalWarned = true; this.log('电池电量危急 · 紧急行驶储备已启用', 'bad'); this.audio.ui('warn');
    }
    if (this.power > 14) this._criticalWarned = false;
    this.dangerTone = clamp((1 - this.power / 25) * 0.6 + (1 - this.hull / 100) * 0.6, 0, 1);

    /* ---- home services ---- */
    if (this.atHome) {
      if (this.bay.length) {
        const n = this.bay.length;
        const rare = this.bay.filter(b => b.rare).length;
        this.bay.length = 0; this.hud.bayDirty = true;
        this.log(`${n} 个样本已卸载${rare ? ` · ${rare} 个稀有样本已标记` : ''}`, 'good');
        this.audio.ui('ok');
        this.complete('home1');
        if (this.missionIdx === 4 && this.nodeTaken) {
          this.transmitted = true;
          this.unlock('node'); this.unlock('lasthour'); this.unlock('transmission');
          this.complete('transmit');
        }
      }
      if (this.hull < 100) this.hull = Math.min(100, this.hull + 9 * dt);
    }

    /* ---- objectives that watch the world ---- */
    if (this.mission) {
      if (!this.objDone.drive && this.distTo(HOME.x, HOME.z) > 120) this.complete('drive');
      if (!this.objDone.reach && this.distTo(STATION.x, STATION.z) < 26) {
        this.complete('reach');
        this.unlock('roster');
        this.log('已进入灯塔-9 周界 · 未检测到电力信号', 'warn');
      }
      if (!this.objDone.massif && this.distTo(MASSIF.x, MASSIF.z) < 46 &&
          this.terrain.heightAt(this.rover.pos.x, this.rover.pos.z) > 12) {
        this.complete('massif');
        this.log('中央山体 · 晶格汇聚点');
      }
    }

    /* ---- context prompt ---- */
    let prompt = null, key = null;
    const dStation = this.distTo(STATION.x, STATION.z);
    if (!this.deliveryMode && dStation < 12 && !this.stationVisited && this.missionIdx >= 3) {
      prompt = '按住 <kbd>E</kbd> · 读取本地存储'; key = 'station';
    } else {
      const a = this.nearestAnom();
      if (this.drill.active) {
        prompt = '正在钻探…';
      } else if (this.rover.armOut) {
        prompt = a
          ? `<kbd>鼠标左键</kbd> 钻探 · ${SAMPLES[a.type].name} · 深度 ${a.depth.toFixed(1)} 米 &nbsp; <kbd>R</kbd> 收起`
          : '采样臂已展开 · <kbd>W</kbd><kbd>S</kbd> 伸缩 · <kbd>A</kbd><kbd>D</kbd> 摆动 · <kbd>鼠标左键</kbd> 钻探 · <kbd>R</kbd> 收起';
      } else if (this.nearestAnom(6.0)) {
        prompt = '<kbd>R</kbd> · 展开采样臂';
      } else if (this.atHome) {
        prompt = chargePrompt(this.rover, this.power) || '火星母港 · 样本已卸载';
      }
    }
    this.hud.setPrompt(prompt);

    if (key && input.down('KeyE')) {
      this.interact.t += dt;
      if (this.interact.t > 1.6) {
        this.interact.t = 0;
        this.stationVisited = true;
        this.complete('recover');
        this.unlock('log6'); this.unlock('log11');
        this.log('本地存储已恢复 · 3 段日志', 'good');
        this.audio.radio();
      }
    } else this.interact.t = 0;
    this.hud.interactProgress = key ? this.interact.t / 1.6 : 0;

    /* ---- rollover rescue ---- */
    if (this.rover.flipped && this.rover.vel.length() < 1.2) {
      this.flipTimer += dt;
      if (this.flipTimer > 2.4) {
        this.hud.setPrompt('<kbd>X</kbd> · 翻正底盘');
        if (input.hit('KeyX')) {
          this.rover.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0),
            Math.atan2(this.rover.forward.x, this.rover.forward.z));
          this.rover.pos.y = this.terrain.heightAt(this.rover.pos.x, this.rover.pos.z) + 1.4;
          this.rover.vel.set(0, 0, 0); this.rover.omega.set(0, 0, 0);
          this.hull = Math.max(5, this.hull - 4);
          this.flipTimer = 0;
          this.dust.spawn(90, this.rover.pos.x, this.rover.pos.y - 1, this.rover.pos.z, 2.2, 1.6);
          this.audio.thud(1.4);
          this.log('底盘已翻正 · 完整度损失 4%', 'warn');
        }
      }
    } else this.flipTimer = 0;

    /* ---- markers ---- */
    for (const a of this.anoms) {
      if (a.marker) {
        a.marker.userData.cap.rotation.y += dt * 1.6;
        a.marker.userData.cap.position.y = 2.3 + Math.sin(this.t * 2 + a.x) * 0.09;
      }
    }

    /* ---- fence warning ---- */
    const r = Math.hypot(this.rover.pos.x, this.rover.pos.z);
    if (r > PLAYABLE_R + 40 && !this._fenceWarn) {
      this._fenceWarn = true;
      this.log('正在接近环形山壁 · 坡度超过 30°', 'warn');
    }
    if (r < PLAYABLE_R) this._fenceWarn = false;

    void ctl;
  }

  damage(amount, reason) {
    if(this.escapeEvent?.terminal)return;
    // The relay supplies reinforced suspension as well as power. Impacts still
    // matter, but a fast landing must not invoke the old teleport-home rescue.
    if (this.overcharge) amount *= 0.22;
    if (amount < 0.4) return;
    this.hull = clamp(this.hull - amount, 0, 100);
    this.hud.hit(clamp(amount / 12, 0.15, 1));
    this.audio.thud(clamp(amount / 6, 0.4, 2));
    if (amount > 4) this.log(`受到冲击 · 完整度损失 ${amount.toFixed(0)}%${reason ? ' · ' + reason : ''}`, 'bad');
    if (this.hull <= 0) this.strand();
  }

  strand() {
    if (this.overcharge && this.escapeEvent?.active) {
      this.escapeEvent.fail('底盘失去行动能力 · 撤离失败');
      return;
    }
    this.hull = 22;
    this.log('严重损坏 · 火星母港绞盘正在回收车辆', 'bad');
    this.rover.placeAt(HOME.x - 9, HOME.z - 9, 2.2);
    this.power = Math.max(this.power, 35);
    this.audio.ui('bad');
  }

  /* ============================================================
     persistence
     ============================================================ */
  save() {
    return {
      missionIdx: this.missionIdx,
      objDone: this.objDone, counts: this.counts,
      unlocked: [...this.unlocked],
      anoms: this.anoms.map(a => (a.taken ? 1 : a.found ? 2 : 0)),
      relays: this.props.relays ? this.props.relays.map(r => [r.position.x, r.position.z]) : [],
      relaysPlaced: this.relaysPlaced,
      power: this.power, hull: this.hull, met: this.met,
      pos: [this.rover.pos.x, this.rover.pos.z],
      stationVisited: this.stationVisited, nodeTaken: this.nodeTaken,
      odo: this.rover.odo
    };
  }

  load(d) {
    if (!d) return false;
    this.missionIdx = d.missionIdx || 0;
    this.objDone = d.objDone || {};
    this.counts = d.counts || {};
    this.unlocked = new Set(d.unlocked || []);
    this.relaysPlaced = d.relaysPlaced || 0;
    this.power = d.power ?? START_POWER; this.hull = d.hull ?? 100; this.met = d.met || 0;
    this.stationVisited = !!d.stationVisited; this.nodeTaken = !!d.nodeTaken;
    if (d.anoms) d.anoms.forEach((v, i) => {
      const a = this.anoms[i]; if (!a) return;
      if (v === 1) a.taken = true;
      else if (v === 2) { a.found = true; this.addMarker(a); }
    });
    if (d.relays) for (const [x, z] of d.relays) this.props.buildRelay(x, z);
    if (d.pos) this.rover.placeAt(d.pos[0], d.pos[1], 0);
    this.rover.odo = d.odo || 0;
    this.hud.mapDirty = this.hud.bayDirty = this.hud.missionDirty = this.hud.codexDirty = true;
    return true;
  }
}
