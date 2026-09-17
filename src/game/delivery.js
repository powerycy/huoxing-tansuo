/* ============================================================
   ROVER DELIVERY LOOP — cargo, scan and isolated relay
   ============================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAM } from './camera.js';
import { clamp, sstep } from '../core/rng.js';
import { HOME } from '../world/props.js';

export const DELIVERY_SITE = Object.freeze({ x: -140, z: -104 });
const SCAN_RANGE = 96;
const SCAN_TIME = 2.15;
const SCAN_COST = 2.0;
const INTERACT_TIME = 1.6;
const STATION_BOOT_POWER_TIME = 3.8;
const STATION_BOOT_SETTLE_TIME = 1.2;

const CARDS = Object.freeze({
  station: {
    tag: '任务 01', name: '寂静基地',
    brief: `灯塔-9 在二百一十四天前停止传输。驾驶火星车运送通信货物前往阿瑞斯六号居住舱，在接触中继链之前恢复基地的本地记录。`,
    objectives: [{ text: '抵达阿瑞斯六号并恢复基地日志' }]
  },
  relay: {
    tag: '任务 02', name: '孤寂中站',
    brief: `花海异常在阿瑞斯六号外形成了唯一通道。MR-7 后舱已锁定一块高密度电池包；将它送至环形山边缘的孤寂中站，恢复中塔的供能与发射能力。`,
    objectives: [{ text: '将高密度电池包运送至孤寂中站' }]
  },
  return: {
    tag: '最终撤离', name: '逃离地裂',
    brief: `中塔已向车辆注入超载能量。蓝光唤醒异常星空，地裂正从后方逼近；沿返航标记撤回火星母港，停车并按住 E 将记录发往地球，结束灾变。`,
    objectives: [{ text: '按住 Shift 超载加速 · 赶在崩塌带之前抵达母港' }]
  },
  complete: {
    tag: '乌托邦行动', name: '传输',
    brief: `中继链运行正常。轨道器已接收记录缓存，距离下一个地球上行窗口还有十三分钟。\n\n理事会将最先收到这份记录，但记录仍然会被送出去。MR-7「仙后座」，乌托邦平原，太阳日 228。开始传输。`,
    objectives: [{ text: '证据已写入地球上行队列' }]
  }
});

export class Delivery {
  constructor({ scene, terrain, rover, rig, hud, audio, glass, props, game,
    station, onStage, onComplete }) {
    Object.assign(this, {
      scene, terrain, rover, rig, hud, audio, glass, props, game,
      station, onStage, onComplete
    });
    this.mode = 'ROVER';
    this.stage = 'station';
    this.cargoState = 'rover';
    this.integrity = 100;
    this.delivered = false;
    this.transmitted = false;
    this.firstScan = false;
    this.movedOnce = false;
    this.moveHintT = 0;
    this.interact = 0;
    this.stationBooting = false;
    this.stationRecovered = false;
    this.stationBootT = 0;
    this.stationBootCue = 0;
    this.scan = { active: false, t: 0, r: -1, cool: 0, reveal: 0, x: 0, z: 0 };
    this.facility = this._buildFacility();
    this.props.buildRelayCharger(DELIVERY_SITE.x + 12, DELIVERY_SITE.z - 10);
    this.cargo = this._buildCargo();
    this.roverCargoMount = new THREE.Group();
    this.roverCargoMount.name = 'RoverBatteryCargoMount';
    this.roverCargoMount.position.set(0, 0.38, -0.82);
    this.roverCargoMount.visible = false;
    this.rover.root.add(this.roverCargoMount);
    this.relayAssetReady = this._loadRelayAssets();
    this.markers = this._buildRouteMarkers();
    this.reset();
  }

  _buildFacility() {
    const root = new THREE.Group();
    root.name = 'LoneRelayFacility';
    const y = this.terrain.heightAt(DELIVERY_SITE.x, DELIVERY_SITE.z);
    root.position.set(DELIVERY_SITE.x, y, DELIVERY_SITE.z);

    // Near-black, dust-roughened hardware reads as one isolated silhouette
    // against the giant moon. Bright white boxes made the relay look like a
    // clean kit-bashed placeholder and destroyed the scene's scale.
    const black = new THREE.MeshStandardMaterial({ color: 0x07090b, roughness: 0.74, metalness: 0.48 });
    const grey = new THREE.MeshStandardMaterial({ color: 0x252a2d, roughness: 0.80, metalness: 0.34 });
    const shell = new THREE.MeshStandardMaterial({ color: 0x626766, roughness: 0.88, metalness: 0.18 });
    this.facilityLampMat = new THREE.MeshStandardMaterial({
      color: 0xffe6bd, emissive: 0xff9a3d, emissiveIntensity: 0.12,
      roughness: 0.3, metalness: 0.1
    });
    this.terminalMat = new THREE.MeshStandardMaterial({
      color: 0x071015, emissive: 0x00b7d7, emissiveIntensity: 0.18,
      roughness: 0.24, metalness: 0.5
    });

    const pad = new THREE.Mesh(new THREE.CylinderGeometry(7.0, 7.6, 0.58, 8), black);
    pad.position.y = 0.12; pad.receiveShadow = true; root.add(pad);
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.45, 0.32, 12), grey);
    deck.position.y = 0.48; deck.receiveShadow = true; root.add(deck);
    const module = new THREE.Mesh(new THREE.BoxGeometry(5.8, 2.25, 3.4), shell);
    module.position.set(0.6, 1.72, 0.4); module.castShadow = true; root.add(module);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(6.18, 0.18, 3.72), black);
    roof.position.set(0.6, 2.92, 0.4); roof.castShadow = true; root.add(roof);
    // External pressure-frame ribs break the perfect box and produce readable
    // contact shadows at human scale without adding another large building.
    for (const x of [-1.85, 0.58, 3.02]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.13, 2.48, 3.58), black);
      rib.position.set(x, 1.76, 0.4); rib.castShadow = true; root.add(rib);
    }
    const darkFace = new THREE.Mesh(new THREE.BoxGeometry(5.88, 1.5, 0.09), black);
    darkFace.position.set(0.6, 1.72, -1.34); root.add(darkFace);
    for (const x of [-0.9, 0.1, 1.1, 2.1]) {
      const service = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.82, 0.16), grey);
      service.position.set(x, 1.70, -1.46); service.castShadow = true; root.add(service);
    }
    const sidePlant = new THREE.Mesh(new THREE.BoxGeometry(1.45, 1.25, 2.55), grey);
    sidePlant.position.set(-3.15, 1.18, 0.58); sidePlant.castShadow = true; root.add(sidePlant);

    // A thin, asymmetric mast makes the tiny structure readable from hundreds
    // of metres away without turning it into a city skyline.
    this.relayFallbackMast = new THREE.Group();
    this.relayFallbackMast.name = 'FallbackRelayMast';
    root.add(this.relayFallbackMast);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, 10.8, 8), black);
    mast.position.set(-1.9, 7.1, 0.2); mast.castShadow = true; this.relayFallbackMast.add(mast);
    this.signalTip = new THREE.Object3D();
    this.signalTip.name = 'RelaySignalTip';
    this.signalTip.position.set(-1.9, 12.5, 0.2); root.add(this.signalTip);
    for (const h of [5.0, 8.5, 11.9]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.12, 0.12), black);
      arm.position.set(-1.9, h, 0.2); this.relayFallbackMast.add(arm);
    }
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.25, 0.32, 18), shell);
    dish.position.set(-1.9, 10.2, 0.2); dish.rotation.z = Math.PI * 0.5; dish.castShadow = true; this.relayFallbackMast.add(dish);

    const tray = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.22, 1.45), black);
    tray.position.set(0, 0.86, -3.15); root.add(tray);
    this.deliveryTray = tray;
    this.relayFallbackTerminal = new THREE.Group();
    this.relayFallbackTerminal.name = 'FallbackRelayTerminal';
    root.add(this.relayFallbackTerminal);
    const terminal = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.35, 0.55), black);
    terminal.position.set(2.1, 1.05, -2.5); terminal.rotation.y = -0.35; this.relayFallbackTerminal.add(terminal);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.42), this.terminalMat);
    screen.position.set(2.0, 1.29, -2.79); screen.rotation.y = -0.35; this.relayFallbackTerminal.add(screen);

    this.facilityBulbs = [];
    for (const [x, yy, z] of [[-3.9, 1.1, -3.7], [4.0, 1.1, -3.4], [-1.9, 12.0, 0.2], [2.8, 3.3, -1.34]]) {
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), this.facilityLampMat);
      bulb.position.set(x, yy, z); root.add(bulb); this.facilityBulbs.push(bulb);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: 0xffb45a, transparent: true, opacity: 0.13,
        depthWrite: false, blending: THREE.AdditiveBlending
      }));
      glow.position.copy(bulb.position); glow.scale.setScalar(yy > 10 ? 9 : 5); root.add(glow);
      bulb.userData.glow = glow;
    }
    const point = new THREE.PointLight(0xffa04a, 0.0, 24, 2);
    point.position.set(0, 3.2, -1.0); root.add(point); this.facilityPoint = point;

    root.traverse((o) => { if (o.isMesh) { o.castShadow ||= false; o.receiveShadow ||= false; } });
    this.scene.add(root);
    // The landing pad stays traversable, but the pressure module and side
    // plant are solid. The old visual-only facility could be walked or driven
    // through, which immediately exposed it as scenery rather than a place.
    this.props.colliders.push(
      { x: DELIVERY_SITE.x + 0.6, z: DELIVERY_SITE.z + 0.4, r: 2.18, kind: 'delivery-facility' },
      { x: DELIVERY_SITE.x - 3.15, z: DELIVERY_SITE.z + 0.58, r: 0.82, kind: 'delivery-facility' }
    );
    return root;
  }

  _buildCargo() {
    const root = new THREE.Group();
    root.name = 'DeliveryCargo';
    // Only display the case at the relay after delivery. While onboard it is
    // stowed inside the vehicle, leaving the original rover silhouette clear.
    root.visible = false;
    root.scale.setScalar(0.76);
    const shell = new THREE.MeshStandardMaterial({ color: 0xe4e1d6, roughness: 0.55, metalness: 0.18 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xdf641f, roughness: 0.46, metalness: 0.26 });
    const cyan = new THREE.MeshStandardMaterial({ color: 0x071419, emissive: 0x00d9ff, emissiveIntensity: 1.25 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.94, 0.45), shell);
    box.castShadow = true; root.add(box);
    for (const x of [-0.25, 0.25]) {
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.98, 0.48), orange);
      strap.position.x = x; root.add(strap);
    }
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.16, 0.035), cyan);
    panel.position.set(0, 0.16, -0.244); root.add(panel);
    const rack = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.10, 0.57), orange);
    rack.position.y = -0.51; root.add(rack);
    this.cargoFallbacks = root.children.slice();
    this.scene.add(root);
    return root;
  }

  _prepareImportedRelayAsset(source, {
    name, height, position, rotateX = 0, palette, accentStride = 0
  }) {
    const asset = source.clone(true);
    asset.name = name;
    asset.rotation.x = rotateX;
    asset.updateMatrixWorld(true);

    const firstBox = new THREE.Box3().setFromObject(asset);
    const firstSize = firstBox.getSize(new THREE.Vector3());
    asset.scale.setScalar(height / Math.max(firstSize.y, 0.001));
    asset.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(asset);
    const center = box.getCenter(new THREE.Vector3());
    asset.position.x -= center.x;
    asset.position.y -= box.min.y;
    asset.position.z -= center.z;
    asset.position.add(position);

    let meshIndex = 0;
    asset.traverse((object) => {
      if (!object.isMesh) return;
      const glowing = accentStride > 0 && meshIndex % accentStride === accentStride - 1;
      object.material = new THREE.MeshStandardMaterial({
        color: palette[meshIndex % palette.length],
        metalness: glowing ? 0.22 : 0.58,
        roughness: glowing ? 0.26 : 0.66,
        emissive: glowing ? 0x00b9d7 : 0x000000,
        emissiveIntensity: glowing ? 1.7 : 0
      });
      object.castShadow = true;
      object.receiveShadow = true;
      meshIndex++;
    });
    return asset;
  }

  async _loadRelayAssets() {
    const loader = new GLTFLoader();
    const base = 'assets/models/lonely-relay';
    const [tower, generator, terminal, battery] = await Promise.allSettled([
      loader.loadAsync(`${base}/ds-watchtower.glb`),
      loader.loadAsync(`${base}/ds-generator.glb`),
      loader.loadAsync(`${base}/ds-terminal.glb`),
      loader.loadAsync(`${base}/ds-battery-pack.glb`)
    ]);

    if (tower.status === 'fulfilled') {
      const asset = this._prepareImportedRelayAsset(tower.value.scene, {
        name: 'DSWatchingTower', height: 16.4,
        position: new THREE.Vector3(-2.45, 0, 1.05), rotateX: -Math.PI * 0.5,
        palette: [0x090c0e, 0x171d20, 0x30383b], accentStride: 0
      });
      this.facility.add(asset);
      this.relayFallbackMast.visible = false;
      this.signalTip.position.set(-2.45, 16.45, 1.05);
      const signalBulb = this.facilityBulbs[2];
      if (signalBulb) {
        signalBulb.position.copy(this.signalTip.position);
        signalBulb.userData.glow.position.copy(this.signalTip.position);
      }
    }

    if (generator.status === 'fulfilled') {
      const asset = this._prepareImportedRelayAsset(generator.value.scene, {
        name: 'DSGeneratorCore', height: 3.35,
        position: new THREE.Vector3(-3.9, 0, 1.9), rotateX: -Math.PI * 0.5,
        palette: [0x111719, 0x283034, 0x485256], accentStride: 11
      });
      this.facility.add(asset);
    }

    if (terminal.status === 'fulfilled') {
      const asset = this._prepareImportedRelayAsset(terminal.value.scene, {
        name: 'DSRelayTerminal', height: 1.56,
        position: new THREE.Vector3(2.2, 0, -2.55), rotateX: -Math.PI * 0.5,
        palette: [0x0a1013, 0x1d282c, 0x38464a], accentStride: 5
      });
      this.facility.add(asset);
      this.relayFallbackTerminal.visible = false;
    }

    if (battery.status === 'fulfilled') {
      const relayPack = this._prepareImportedRelayAsset(battery.value.scene, {
        name: 'DSBatteryPackDelivered', height: 1.18,
        position: new THREE.Vector3(0, 0, 0),
        palette: [0xd6d2c7, 0x232b2d, 0xc75b26], accentStride: 4
      });
      this.cargo.add(relayPack);
      for (const fallback of this.cargoFallbacks) fallback.visible = false;

      const roverPack = this._prepareImportedRelayAsset(battery.value.scene, {
        name: 'DSBatteryPackOnRover', height: 0.78,
        position: new THREE.Vector3(0, 0, 0),
        palette: [0xd6d2c7, 0x20282a, 0xc75b26], accentStride: 4
      });
      this.roverCargoMount.add(roverPack);
      this.batteryRoverAsset = roverPack;
    }

    if (tower.status !== 'fulfilled' || generator.status !== 'fulfilled') {
      console.warn('[REGOLITH] 部分孤寂中站资源载入失败，保留程序化备用结构');
    } else {
      console.info('[REGOLITH] 孤寂中站已载入 Death Stranding 信号塔、发电机、终端与电池包');
    }
  }

  _buildRouteMarkers() {
    const markers = [];
    const ringGeo = new THREE.TorusGeometry(1.35, 0.035, 5, 32);
    for (let i = 1; i <= 28; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x36e5ff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const m = new THREE.Mesh(ringGeo, mat);
      m.rotation.x = Math.PI * 0.5;
      m.visible = false;
      m.userData.phase = i * 0.31;
      m.userData.routeT = i / 29;
      this.scene.add(m); markers.push(m);
    }
    return markers;
  }

  _layoutRouteMarkers(from, to) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.max(1, Math.hypot(dx, dz));
    const rx = dz / len, rz = -dx / len;
    for (const m of this.markers) {
      const t = m.userData.routeT;
      const curve = Math.sin(t * Math.PI * 2.2) * 8.0;
      const x = from.x + dx * t + rx * curve;
      const z = from.z + dz * t + rz * curve;
      m.position.set(x, this.terrain.heightAt(x, z) + 0.08, z);
    }
  }

  _layoutStageRoute() {
    if (this.stage === 'station') this._layoutRouteMarkers(HOME, this.station);
    else if (this.stage === 'relay') this._layoutRouteMarkers(this.station, DELIVERY_SITE);
    else if (this.stage === 'return') this._layoutRouteMarkers(DELIVERY_SITE, HOME);
    else for (const m of this.markers) m.visible = false;
  }

  reset() {
    this.mode = 'ROVER';
    this.stage = 'station';
    this.cargoState = 'rover';
    this.integrity = 100;
    this.delivered = false;
    this.transmitted = false;
    this.firstScan = false;
    this.movedOnce = false;
    this.moveHintT = 0;
    this.interact = 0;
    this.stationBooting = false;
    this.stationRecovered = false;
    this.stationBootT = 0;
    this.stationBootCue = 0;
    this.scan.active = false; this.scan.t = 0; this.scan.r = -1; this.scan.cool = 0; this.scan.reveal = 0;
    this.terrain.uniforms.uScanR.value = -1;
    this.props.setStationPowerProgress?.(0);
    this._setFacilityPower(0);
    this._layoutStageRoute();
    this._syncCargo();
    this._syncGameState();
  }

  save() {
    return {
      version: 4, mode: 'ROVER', stage: this.stage, cargoState: this.cargoState,
      integrity: this.integrity, delivered: this.delivered,
      transmitted: this.transmitted, firstScan: this.firstScan,
      stationBooting: this.stationBooting, stationRecovered: this.stationRecovered,
      stationBootT: this.stationBootT
    };
  }

  load(s) {
    if (!s || ![1, 2, 3, 4].includes(s.version)) return false;
    this.cargoState = s.cargoState === 'delivered' ? 'delivered' : 'rover';
    const integrity = Number(s.integrity);
    this.integrity = clamp(Number.isFinite(integrity) ? integrity : 100, 0, 100);
    this.delivered = !!s.delivered || this.cargoState === 'delivered';
    this.transmitted = !!s.transmitted;
    this.stage = s.version >= 3 && ['station', 'relay', 'return', 'complete'].includes(s.stage)
      ? s.stage
      : this.delivered ? 'return' : 'station';
    if (this.transmitted) this.stage = 'complete';
    this.firstScan = !!s.firstScan;
    this.movedOnce = true;
    this.moveHintT = 0;
    this.interact = 0;
    this.stationBooting = s.version >= 4 && this.stage === 'station' && !!s.stationBooting;
    this.stationRecovered = this.stage !== 'station' ||
      (s.version >= 4 && (!!s.stationRecovered || this.stationBooting));
    this.stationBootT = this.stationBooting
      ? clamp(Number(s.stationBootT) || 0, 0, STATION_BOOT_POWER_TIME + STATION_BOOT_SETTLE_TIME)
      : 0;
    this.stationBootCue = this.stationBootT >= STATION_BOOT_POWER_TIME ? 4
      : this.stationBootT >= 2.75 ? 3
      : this.stationBootT >= 1.55 ? 2
      : this.stationBootT >= 0.50 ? 1 : 0;
    this.mode = 'ROVER';
    this.rig.dist = 8.2;
    this.rig.setMode(CAM.CHASE, this.rover);
    const stationPower = this.stage !== 'station' || this.stationRecovered && !this.stationBooting
      ? 1
      : this.stationBooting ? clamp(this.stationBootT / STATION_BOOT_POWER_TIME, 0, 1) : 0;
    this.props.setStationPowerProgress?.(stationPower);
    this._setFacilityPower(this.delivered ? 1 : 0);
    this._layoutStageRoute();
    this._syncCargo();
    this._syncGameState();
    return true;
  }

  _syncGameState() {
    this.game.enterDeliveryMode();
    this.game.stationVisited = this.stationRecovered || this.stage !== 'station';
    this.game.transmitted = this.transmitted;
    this.game.deliveryScanActive = this.scan.active;
    this.game.deliveryScan = this.scan;
    this.game.deliveryCargoIntegrity = this.integrity;
    this.game.deliveryCargoOnboard = this.cargoState === 'rover';
    this.game.navTarget = this._target();
  }

  _target() {
    if (this.stage === 'station') return { ...this.station, label: '阿瑞斯六号', color: '#ffb454' };
    if (this.stage === 'relay') return { ...DELIVERY_SITE, label: '孤寂中站', color: '#ffb454' };
    if (this.stage === 'return') return { ...HOME, label: '火星母港', color: '#6fe3f5' };
    return null;
  }

  _advance(stage) {
    this.stage = stage;
    this.interact = 0;
    this.scan.reveal = 0;
    this._layoutStageRoute();
    this._syncGameState();
    if (stage === 'complete') this.onComplete?.(CARDS.complete, stage);
    else this.onStage?.(CARDS[stage], stage);
  }

  doScan() {
    if (this.scan.active || this.scan.cool > 0) {
      this.audio.ui('bad');
      this.hud.log(`奥卓德克正在充能 · ${Math.ceil(this.scan.cool)} 秒`, 'warn');
      return;
    }
    if (this.game.power < SCAN_COST) {
      this.audio.ui('bad');
      this.hud.log('电量不足，无法进行奥卓德克扫描', 'warn');
      return;
    }
    this.game.power = Math.max(0, this.game.power - SCAN_COST);
    const p = this.rover.pos;
    this.scan.active = true; this.scan.t = 0; this.scan.r = 0; this.scan.reveal = 6.5;
    this.scan.x = p.x; this.scan.z = p.z;
    this.moveHintT = 0;
    this.glass.reveal(6.5);
    this.props.revealHomeGuidance(6.5);
    this.audio.ui('ok');
    this.hud.log('奥卓德克扫描完成 · 已解析可通行路线', 'good');
    if (!this.firstScan) {
      this.firstScan = true;
      this.game.unlock('first-return');
    }
  }

  update(dt, raw, input) {
    this.holdingHome = false;
    const p = this.rover.pos;
    const slow = this.rover.vel.length() < 0.75;
    let holding = false;

    if (!this.movedOnce && Math.abs(raw.throttle) > 0.15) {
      this.movedOnce = true;
      this.moveHintT = 5.5;
      this.hud.log('奥卓德克就绪 · 按 G 扫描前方地形');
      this.audio.ui('tick');
    }
    this.moveHintT = Math.max(0, this.moveHintT - dt);

    if (this.stage === 'station') {
      if (this.stationBooting) {
        this._updateStationBoot(dt);
      } else {
        const d = Math.hypot(p.x - this.station.x, p.z - this.station.z);
        holding = d < 12 && slow && input.down('KeyE');
        if (holding) {
          this.interact += dt;
          if (this.interact >= INTERACT_TIME) this._recoverStation();
        }
      }
    } else if (this.stage === 'relay' && input.hit('KeyE')) {
      this._dockCargo();
    } else if (this.stage === 'return') {
      const d = Math.hypot(p.x - HOME.x, p.z - HOME.z);
      holding = d < 10.5 && slow && input.down('KeyE');
      this.holdingHome = holding;
      if (holding) {
        this.interact += dt;
        if (this.interact >= INTERACT_TIME) this._transmitToEarth();
      }
    }
    if (!holding) this.interact = 0;

    this._updateScan(dt);
    this._syncCargo();
    const d = Math.hypot(p.x - DELIVERY_SITE.x, p.z - DELIVERY_SITE.z);
    const approach = 1 - sstep(70, 310, d);
    const power = this.delivered ? 1 : 0.10 + approach * 0.16;
    this._setFacilityPower(power, dt);
    this._syncGameState();
    this.hud.interactProgress = this.stationBooting
      ? clamp(this.stationBootT / STATION_BOOT_POWER_TIME, 0, 1)
      : this.interact / INTERACT_TIME;
    void raw;
  }

  _recoverStation() {
    if (this.stage !== 'station' || this.stationBooting || this.stationRecovered) return;
    this.stationBooting = true;
    this.stationRecovered = true;
    this.stationBootT = 0;
    this.stationBootCue = 0;
    this.interact = 0;
    this.props.setStationPowerProgress?.(0);
    this.game.stationVisited = true;
    this.game.unlock('roster');
    for (const id of ['lattice', 'log6', 'log11', 'lasthour']) this.game.unlock(id, false);
    this.hud.flashDiscovery('本地记录已恢复', '阿瑞斯六号辅助电源启动', '主配电序列已建立');
    this.hud.log('记录校验完成 · 正在恢复阿瑞斯六号供电', 'good');
    this.audio.ui('ok');
  }

  _updateStationBoot(dt) {
    if (!this.stationBooting) return;
    this.stationBootT += dt;
    const progress = clamp(this.stationBootT / STATION_BOOT_POWER_TIME, 0, 1);
    this.props.setStationPowerProgress?.(progress);

    const cueTimes = [0.50, 1.55, 2.75, STATION_BOOT_POWER_TIME];
    const cueLogs = [
      '本地终端在线',
      '居住舱内部照明已恢复',
      '外部泛光灯与引导灯已恢复',
      '阿瑞斯六号感应充电平台已上线'
    ];
    while (this.stationBootCue < cueTimes.length && this.stationBootT >= cueTimes[this.stationBootCue]) {
      this.hud.log(cueLogs[this.stationBootCue], this.stationBootCue === 3 ? 'good' : null);
      this.audio.ui(this.stationBootCue === 3 ? 'ok' : 'tick');
      this.stationBootCue++;
    }

    if (this.stationBootT < STATION_BOOT_POWER_TIME + STATION_BOOT_SETTLE_TIME) return;
    this.stationBooting = false;
    this.props.setStationPowerProgress?.(1);
    this.hud.log('阿瑞斯六号供电稳定 · 中继路线已授权', 'good');
    this.audio.radio();
    this._advance('relay');
  }

  _dockCargo() {
    if (this.stage !== 'relay' || this.delivered || this.rig.mode === CAM.PHOTO) return;
    const d = Math.hypot(this.rover.pos.x - DELIVERY_SITE.x, this.rover.pos.z - DELIVERY_SITE.z);
    if (d >= 8.5) return;
    if (this.rover.vel.length() > 0.75) {
      this.hud.log('降至 3 千米/小时以下才能对接', 'warn'); this.audio.ui('bad'); return;
    }
    this.cargoState = 'delivered';
    this.delivered = true;
    this._setFacilityPower(1);
    this.game.unlock('memo');
    this.hud.flashDiscovery('电池对接完成', '孤寂中站已上线', `电池完整度 ${Math.round(this.integrity)}%`);
    this.hud.log('高密度电池包已接入中塔 · 发射链路与母港上行已恢复', 'good');
    this.audio.ui('ok');
    this._advance('return');
  }

  _transmitToEarth() {
    if (this.stage !== 'return') return;
    this.transmitted = true;
    this.game.transmitted = true;
    this.game.unlock('transmission');
    this.hud.flashDiscovery('上行传输完成', '轨道器已接收', '地球单程延迟 · 13 分 42 秒');
    this.hud.log('灯塔-9 记录已写入地球上行队列', 'good');
    this.audio.radio();
    this._advance('complete');
  }

  damageCargo(amount, reason = '撞击') {
    if (this.cargoState !== 'rover' || this.stage === 'complete') return;
    const loss = clamp(amount, 0, 12);
    if (loss < 0.35) return;
    this.integrity = clamp(this.integrity - loss, 0, 100);
    if (loss >= 1.2) {
      this.hud.log(`电池包受冲击 · -${loss.toFixed(1)}% · ${reason}`, loss >= 4 ? 'bad' : 'warn');
      this.audio.ui(loss >= 4 ? 'bad' : 'warn');
    }
  }

  _updateScan(dt) {
    if (this.scan.active) {
      this.scan.t += dt;
      this.scan.r = this.scan.t / SCAN_TIME * SCAN_RANGE;
      const fade = 1 - sstep(0.72, 1, this.scan.t / SCAN_TIME);
      this.terrain.uniforms.uScanC.value.set(this.scan.x, fade, this.scan.z);
      this.terrain.uniforms.uScanR.value = this.scan.r;
      if (this.scan.t >= SCAN_TIME) {
        this.scan.active = false; this.scan.cool = 4.0; this.terrain.uniforms.uScanR.value = -1;
      }
    } else {
      this.scan.cool = Math.max(0, this.scan.cool - dt);
      this.terrain.uniforms.uScanR.value = -1;
    }
    this.scan.reveal = Math.max(0, this.scan.reveal - dt);
    const escaping = this.escapeEvent?.active;
    const show = !escaping && this.scan.reveal > 0;
    const opacity = clamp(Math.min(this.scan.reveal / 1.2, 1) * (this.scan.active ? 0.95 : 0.58), 0, 1);
    for (const m of this.markers) {
      const nearPulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.003 + m.userData.phase);
      m.visible = show; m.material.opacity = opacity * nearPulse;
    }
  }

  _syncCargo() {
    if (this.roverCargoMount) {
      this.roverCargoMount.visible = this.cargoState === 'rover' && !!this.batteryRoverAsset;
    }
    if (this.cargoState === 'delivered') {
      this.cargo.visible = true;
      this.cargo.position.set(DELIVERY_SITE.x, this.terrain.heightAt(DELIVERY_SITE.x, DELIVERY_SITE.z) + 1.55, DELIVERY_SITE.z - 3.15);
      this.cargo.rotation.set(0, 0, 0);
    } else {
      // Before transfer, the low-profile battery pack is secured to the rover
      // rear deck. The relay display model only appears after docking.
      this.cargo.visible = false;
    }
  }

  _setFacilityPower(power, dt = 1) {
    this.facilityPower ??= power;
    this.facilityPower += (power - this.facilityPower) * Math.min(1, dt * 2.8);
    const pulse = 0.92 + Math.sin(performance.now() * 0.0024) * 0.08;
    const p = this.facilityPower * pulse;
    this.facilityLampMat.emissiveIntensity = 0.08 + p * 4.5;
    this.terminalMat.emissiveIntensity = 0.16 + p * 2.7;
    this.facilityPoint.intensity = p * 34;
    for (const b of this.facilityBulbs) b.userData.glow.material.opacity = 0.07 + p * 0.66;
  }

  syncHud() {
    const p = this.rover.pos;
    const homeDist = Math.hypot(p.x - HOME.x, p.z - HOME.z);
    const target = this._target();
    const dist = target ? Math.hypot(p.x - target.x, p.z - target.z) : 0;
    const bearing = target
      ? (Math.atan2(target.x - p.x, -(target.z - p.z)) * 180 / Math.PI + 360) % 360
      : 0;
    let objective;
    let rangeLabel;
    const escaping = this.escapeEvent?.active;
    const anomaly = this.stage === 'relay' ? this.worldEvent?.hudState?.() : null;
    if (anomaly) {
      this.hud.el.tag.textContent = anomaly.tag;
      this.hud.el.name.textContent = anomaly.name;
      rangeLabel = '距离 · 孤寂中站';
      objective = `<div><i>!</i><span>${anomaly.objective}<small>${Math.round(dist)} 米 · 方位 ${String(Math.round(bearing)).padStart(3, '0')}° · ${anomaly.status || '环境异常'}</small></span></div>`;
    } else if (this.stage === 'station') {
      this.hud.el.tag.textContent = '任务 01';
      this.hud.el.name.textContent = '寂静基地';
      rangeLabel = '距离 · 阿瑞斯六号';
      objective = this.stationBooting
        ? `<div><i>▸</i><span>恢复阿瑞斯六号供电<small>配电序列 ${Math.round(clamp(this.stationBootT / STATION_BOOT_POWER_TIME, 0, 1) * 100)}% · 请等待系统稳定</small></span></div>`
        : dist < 12
        ? `<div><i>▸</i><span>恢复灯塔-9 本地记录<small>停在阿瑞斯六号旁并按住 E</small></span></div>`
        : `<div><i>▸</i><span>前往阿瑞斯六号<small>${Math.round(dist)} 米 · 方位 ${String(Math.round(bearing)).padStart(3, '0')}° · 按 G 扫描</small></span></div>`;
    } else if (this.stage === 'relay') {
      this.hud.el.tag.textContent = '任务 02';
      this.hud.el.name.textContent = '孤寂中站';
      rangeLabel = '距离 · 孤寂中站';
      objective = dist < 14
        ? `<div><i>▸</i><span>对准中继站装卸平台<small>停在对接区内并按 E</small></span></div>`
        : `<div><i>▸</i><span>运送高密度电池包<small>${Math.round(dist)} 米 · 方位 ${String(Math.round(bearing)).padStart(3, '0')}° · 电池完整度 ${Math.round(this.integrity)}%</small></span></div>`;
    } else if (this.stage === 'return') {
      this.hud.el.tag.textContent = escaping ? '最终撤离 · 超载供能' : '任务 03';
      this.hud.el.name.textContent = escaping ? '逃离地裂' : '返程链路';
      rangeLabel = '距离 · 火星母港';
      objective = dist < 11
        ? `<div><i>▸</i><span>传输灯塔-9 记录<small>停在火星母港圆环内并按住 E</small></span></div>`
        : `<div><i>▸</i><span>返回火星母港<small>${Math.round(dist)} 米 · 方位 ${String(Math.round(bearing)).padStart(3, '0')}° · ${escaping ? 'Shift 超载加速 · 空格刹车' : '中继已上线'}</small></span></div>`;
    } else {
      this.hud.el.tag.textContent = '行动完成';
      this.hud.el.name.textContent = '已发送';
      rangeLabel = '地球链路';
      objective = `<div class="done"><i>✓</i><span>地球已收到灯塔-9 记录<small>电池完整度 ${Math.round(this.integrity)}%</small></span></div>`;
    }
    this.hud.el.obj.innerHTML = objective;
    this.hud.el.rangeHome.previousElementSibling.textContent = rangeLabel;
    this.hud.el.rangeHome.textContent = this.stage === 'complete' ? '已接收' : `${Math.round(dist)} 米`;
    this.hud.el.gprState.textContent = this.scan.active ? '扫描中' : this.scan.cool > 0 ? `充能 ${Math.ceil(this.scan.cool)} 秒` : '奥卓德克就绪';
    document.body.classList.toggle('hud-scan', this.scan.active || this.scan.reveal > 0);
    document.body.classList.toggle('hud-cargo', this.cargoState === 'rover');
    this.hud.el.bayCount.textContent = this.cargoState === 'rover'
      ? `${Math.round(this.integrity)}%`
      : this.transmitted ? '已上传' : '已转移';
    const slot = this.hud.el.bay.children[0];
    if (slot) {
      slot.className = 'slot' + (this.delivered ? '' : ' full rare');
      slot.title = this.delivered
        ? '高密度电池包已接入孤寂中站'
      : `高密度电池包 · ${Math.round(this.integrity)}%`;
    }

    let prompt = '';
    if (anomaly) {
      prompt = this.worldEvent.phase === 'navigate' || this.worldEvent.phase === 'ascend'
        ? '花海导航 · 沿两侧流动银光驶向终点花环'
        : '生命异常 · 保持车辆扫描系统在线';
    } else if (this.stationBooting) prompt = `阿瑞斯六号启动中 · 配电 ${Math.round(clamp(this.stationBootT / STATION_BOOT_POWER_TIME, 0, 1) * 100)}%`;
    else if (this.stage === 'station' && dist < 12) prompt = this.rover.vel.length() < 0.75
      ? '<kbd>E</kbd> 按住 · 恢复本地记录'
      : '停车后才能访问阿瑞斯六号';
    else if (this.stage === 'relay' && dist < 8.5) prompt = this.rover.vel.length() < 0.75
      ? '<kbd>E</kbd> 对接电池包'
      : '减速后才能对接';
    else if (this.stage === 'return' && dist < 10.5) prompt = this.rover.vel.length() < 0.75
      ? '<kbd>E</kbd> 按住 · 向地球传输'
      : '请停在火星母港上行圆环内';
    else if (this.moveHintT > 0 && !this.firstScan) prompt = '<kbd>G</kbd> · 扫描前方地形';
    else if (homeDist < 18 && this.rover.vel.length() < 0.75 && this.stage !== 'return') {
      prompt = '<kbd>I</kbd> · 打开母港个人档案终端';
    }
    // Charging status lives beside the battery, not in E's mission prompt.
    this.hud.setPrompt(prompt);
  }
}

let _glowTex;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.11, 'rgba(255,185,92,.95)');
  r.addColorStop(0.38, 'rgba(255,126,36,.28)');
  r.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c); _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}
