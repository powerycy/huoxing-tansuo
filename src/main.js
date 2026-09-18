/* ============================================================
   RED REGOLITH — The Silence at Utopia Planitia
   Bootstrap, loading, menus, and the frame loop.
   ============================================================ */
import * as THREE from 'three';
import { Engine, QUALITY } from './core/engine.js';
import { QUALITY_KEYS, selectStartupQuality } from './core/quality.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { Save } from './core/save.js';
import { clamp, sstep, lerp } from './core/rng.js';
import { bakeTerrain, Terrain, PLAYABLE_R } from './world/terrain.js';
import { Sky } from './world/sky.js';
import { Props, HOME } from './world/props.js';
import { Dust } from './world/dust.js';
import { makeEarthTextures, makeMoonAlbedo } from './world/textures.js';
import { Rover, DRIVE, EARTH_RTT } from './game/rover.js';
import { Porter } from './game/porter.js';
import { CameraRig, CAM } from './game/camera.js';
import { Game, STATION, MASSIF, OPS, LIGHT_MIN_POWER } from './game/gameplay.js';
import { Delivery, DELIVERY_SITE } from './game/delivery.js';
import { GlassField } from './world/glass-rocks.js';
import { ElectrostaticHaze } from './world/haze.js';
import { FlowerTide } from './world/flower-tide.js';
import { DimensionalEscape, ESCAPE } from './game/dimensional-escape.js';
import { StarfallEvent } from './world/starfall-event.js';
import { StarfallCinematic } from './game/starfall-cinematic.js';
import { STARFALL } from './world/starfall-field.js';
import { DIMENSIONAL_RETURN_SECONDS } from './game/dimensional-cinematic.js';
import { HUD } from './ui/hud.js';
import { PROFILE } from './profile.js';
import { Garage } from './ui/garage.js';
import { FlowerArchive } from './ui/flower-archive.js';

const $ = (id) => document.getElementById(id);
const ST = { BOOT: 0, MENU: 1, PLAY: 2, PAUSE: 3, CODEX: 4, HELP: 5, PROFILE: 6, END: 7, GARAGE: 8 };
const query = new URLSearchParams(location.search);
const stationPreview = query.get('station-preview');
const chargerPreview = query.get('charger-preview');
const eventPreview = query.get('event-preview');
const escapePreview = query.get('escape-preview');
const timePreview = query.get('time-preview');
// Keep the playable game rover-only. Sam stays in character-preview.html
// until the independent animation prototype is approved for integration.
const PORTER_MODE = false;
const storedSettings = Save.settings();
// Version 2 changes grain from a permanent camera filter into a contextual
// effect. Migrate old settings once so the former 0.62 default does not keep
// filling existing players' screens after the new clean baseline ships.
if (!storedSettings.contextNoiseV2) {
  storedSettings.grain = 0;
  storedSettings.contextNoiseV2 = true;
  Save.saveSettings(storedSettings);
}

const App = {
  state: ST.BOOT,
  settings: Object.assign({
    quality: guessQuality(), fov: 58, sens: 1.0, invertY: false,
    bloom: true, grain: 0, aberr: 1.0, stars: 1.0, experimentalRayTracing: false,
    volSfx: 0.8, volMusic: 0.5, music: true, tc: true, hudOn: true, autoCentre: 1,
    hudScale: 1, realistic: false, comms: false
  }, storedSettings, { quality: guessQuality() }),
  elapsed: 0, sunAz: 4.67, paused: false,
  lightDir: new THREE.Vector3(0.4, 0.08, -0.9).normalize(),
  keyIntensity: 0
};

function guessQuality() {
  return selectStartupQuality({
    requested: query.get('quality'), stored: storedSettings.quality,
    platform: navigator.userAgentData?.platform || navigator.platform || navigator.userAgent,
    memory: navigator.deviceMemory || 0, cores: navigator.hardwareConcurrency || 4,
    coarse: matchMedia('(pointer: coarse)').matches
  });
}

/* ============================================================
   LOADING
   ============================================================ */
const bar = $('loadfill'), loadtext = $('loadtext');
function progress(p, msg) {
  bar.style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%';
  if (msg) loadtext.textContent = msg;
}

/* Optional imagery. The game generates everything it needs, so the repo ships
   with no third-party assets.

   Off by default, and deliberately not auto-probing: attempting the four loads
   unconditionally cost every player four 404s in the console on every single
   load, to support a folder that is empty in every copy of this repo. Drop real
   equirectangular maps into assets/tex/ and flip this to true. */
const USE_DISK_TEX = false;
const OPTIONAL_TEX = [
  ['earthDay', 'assets/tex/earth-2k.jpg', true],
  ['earthNight', 'assets/tex/earth-night-2k.jpg', true],
  ['earthClouds', 'assets/tex/earth-clouds-2k.jpg', false],
  ['moonAlbedo', 'assets/tex/moon-2k.jpg', true]
];

// Production surface maps. These are deliberately modest 1K/2K derivatives:
// the source scans are much larger, but the WebGL runtime gains more from two
// spatial scales than from a single 8K texture that exhausts the GPU cache.
const SURFACE_TEX = [
  ['giantMoonColor', 'assets/textures/environment/moon-color-8k.jpg', true],
  ['regolithColor', 'assets/textures/environment/moon_03/diffuse.jpg', true],
  ['regolithNormal', 'assets/textures/environment/moon_03/normal_gl.jpg', false],
  ['regolithARM', 'assets/textures/environment/moon_03/arm.jpg', false],
  ['regolithDetailNormal', 'assets/textures/environment/moon_flat_macro_01/normal_gl.jpg', false],
  ['basaltColor', 'assets/textures/environment/seaside_rock/diffuse.jpg', true],
  ['basaltNormal', 'assets/textures/environment/seaside_rock/normal_gl.jpg', false],
  ['basaltARM', 'assets/textures/environment/seaside_rock/arm.jpg', false]
];

function loadTextures() {
  const L = new THREE.TextureLoader();
  const one = ([key, url, srgb]) => new Promise((resolve) => {
    L.load(url,
      (t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = Math.min(App.engine.caps.aniso, App.engine.quality.anisotropy);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        resolve([key, t]);
      },
      undefined,
      () => resolve([key, null])
    );
  });
  const requested = [...SURFACE_TEX, ...(USE_DISK_TEX ? OPTIONAL_TEX : [])];
  return Promise.all(requested.map(one)).then((pairs) => {
    const tex = {};
    for (const [k, t] of pairs) if (t) tex[k] = t;
    return tex;
  });
}

async function boot() {
  progress(0.01, '正在初始化遥测链路……');

  const engine = new Engine($('stage'), App.settings.quality);
  App.engine = engine;
  // Engine registers its resize handler first, so the status reads the new
  // drawing-buffer dimensions rather than the previous window size.
  window.addEventListener('resize', updateQualitySummary);
  await new Promise(r => setTimeout(r, 30));

  /* ---- bake the basin, yielding to the browser so the bar animates ---- */
  progress(0.02, '正在生成火星盆地');
  const gen = bakeTerrain(progress);
  const baked = await new Promise((resolve) => {
    // rAF alone would stall the whole load if the tab is backgrounded before
    // the bake finishes, so race it against a timer and take whichever fires.
    const schedule = (fn) => {
      let fired = false;
      const go = () => { if (!fired) { fired = true; fn(); } };
      requestAnimationFrame(go);
      setTimeout(go, 26);
    };
    const pump = () => {
      // Nobody is watching a hidden tab, and its timers are throttled to ~1 Hz,
      // so chunking there would stall the load indefinitely. Just finish.
      const budget = document.hidden ? 1e9 : 14;
      const t0 = performance.now();
      let res;
      do { res = gen.next(); } while (!res.done && performance.now() - t0 < budget);
      if (res.done) resolve(res.value); else schedule(pump);
    };
    schedule(pump);
  });

  progress(0.76, '正在生成环境影像');
  const tex = await loadTextures();
  App.surfaceTextures = tex;
  // fill in whatever was not supplied on disk
  if (!tex.earthDay || !tex.earthNight || !tex.earthClouds) {
    Object.assign(tex, makeEarthTextures(), tex);   // existing entries win
  }
  if (!tex.moonAlbedo) tex.moonAlbedo = makeMoonAlbedo();
  progress(0.90, '正在载入环境影像');

  progress(0.94, '正在构建运输路线');
  const terrain = new Terrain(engine.renderer, baked, engine.quality, engine.caps);
  terrain.uniforms.uAlbedoTex.value = tex.moonAlbedo;
  terrain.uniforms.uRegolithColor.value = tex.regolithColor;
  terrain.uniforms.uRegolithNormal.value = tex.regolithNormal;
  terrain.uniforms.uRegolithARM.value = tex.regolithARM;
  terrain.uniforms.uDetailNormal.value = tex.regolithDetailNormal;
  terrain.uniforms.uRockColor.value = tex.basaltColor;
  terrain.uniforms.uRockNormal.value = tex.basaltNormal;
  terrain.uniforms.uRockARM.value = tex.basaltARM;
  engine.scene.add(terrain.group);

  const sky = new Sky(engine.renderer, engine.scene, tex, engine.quality);
  const props = new Props(engine.scene, terrain, engine.quality, tex);
  progress(0.955, '正在载入扫描地质数据');
  await props.loadScannedRocks(engine.camera);
  props.buildHome();
  props.buildStation(STATION.x, STATION.z);
  progress(0.962, '正在组装火星母港与阿瑞斯六号基地');
  await Promise.all([props.homeReady, props.stationReady]);
  terrain.uniforms.uFacilityA.value.set(
    HOME.x, terrain.heightAt(HOME.x, HOME.z) + 4.8, HOME.z, 36
  );
  terrain.uniforms.uFacilityB.value.set(
    STATION.x, terrain.heightAt(STATION.x, STATION.z) + 5.2, STATION.z,
    34 * props.stationPower
  );
  // Two distant survey silhouettes are enough to orient the player without
  // turning the basin into an industrial yard.
  [[-60, 180], [-250, -110]].forEach((p, i) =>
    props.buildPylon(p[0], p[1], i));
  // One minor breach foreshadows the singular massif node; the other surface
  // props are deliberately left empty to preserve scale and isolation.
  props.buildLatticeNode(-118, -64, 1.3);
  props.buildLatticeNode(MASSIF.x + 6, MASSIF.z - 4, 2.1, true);

  const dust = new Dust(engine.scene, terrain, terrain.uniforms.uSunDir, engine.quality.dust);
  const rover = new Rover(terrain, engine.scene, engine.quality);
  progress(0.965, '正在载入火星车');
  await rover.modelReady;
  let porter = null;
  if (PORTER_MODE) {
    progress(0.972, '正在载入山姆与负载步行动画');
    porter = new Porter({ scene: engine.scene, terrain, renderer: engine.renderer });
    await porter.ready;
    rover.isPorter = true;
    rover.root.visible = false;
    document.body.classList.add('porter-mode');
  }
  const rig = new CameraRig(engine.camera, terrain);
  const audio = new Audio();
  const hud = new HUD(audio);
  hud.bakeMap(terrain);

  const input = new Input($('stage'));
  const game = new Game({
    terrain, rover, props, dust, sky, audio, hud, engine, rig, scene: engine.scene, input
  });
  game.tc = App.settings.tc;

  const glass = new GlassField(engine.scene, terrain, props, DELIVERY_SITE, tex);
  const haze = new ElectrostaticHaze(engine.scene, terrain, engine.quality);
  let rupture, escape;
  const delivery = new Delivery({
    scene: engine.scene, terrain, rover, rig, hud, audio, glass, props, game,
    station: STATION,
    onStage: (card, stage) => {
      // The final act introduces its objective after the observation shot.
      if (stage !== 'return') queueDeliveryNotice(card, 500);
      if (stage === 'relay') rupture?.trigger();
      if (stage === 'return') escape?.start();
    },
    onComplete: () => escape?.finish()
  });
  rupture = new FlowerTide({
    scene: engine.scene, sky, terrain, engine, rover, rig, hud, audio,
    props, delivery, quality: engine.quality
  });
  delivery.worldEvent = rupture;
  escape = new DimensionalEscape({ rover, game, origin: DELIVERY_SITE, home: HOME,
    introDuration: STARFALL.intro,
    onStart: () => {
      clearTimeout(deliveryNoticeTimer);
      cmdQueue.length = 0;
      App.fold?.install();
      const route = App.fold?.buildRoute(rover.pos);
      if (App.state === ST.PLAY) {
        hud.log('中继超载注入完成 · 电量 100% · 底盘已强化', 'good');
        hud.log('中塔蓝光正在升空 · 天空异变与地裂演出开始', 'warn');
        hud.log(route?.length ? '沿金色地面标记返航 · 转弯松开 Shift · 空格制动' : '沿罗盘母港方位返航 · 注意避开岩石与陡坎', 'warn');
        audio.radio();
        // load() calls onStart before restoring motion; save after a full tick.
        App._escapeSavePending = true;
      }
    },
    onFail: () => showEscapeResult(false),
    onFinish: () => showEscapeResult(true)
  });
  delivery.escapeEvent = game.escapeEvent = escape;

  Object.assign(App, {
    terrain, sky, props, dust, rover, porter, rig, audio, hud, input, game,
    glass, haze, delivery, rupture, escape, tex
  });
  engine.raySources = [
    { root: props.stationShelter },
    { root: rover.visualModel, excludeWheels: true }
  ];
  engine.onRayTracingFailure = (error) => {
    ++rayChangeVersion;
    App.settings.experimentalRayTracing = false;
    App.rayMessage = `实验光追已自动关闭：${error.message}。普通渲染与任务继续。`;
    applySettings(); persist(); buildSettingsUI();
  };
  terrain.installMeshLighting?.(engine.scene);
  // Keep App.fold as an alias for existing local QA bookmarks, not a world warp.
  App.starfall = App.fold = new StarfallEvent({ scene: engine.scene, terrain, rover, sky, props, escape, delivery, quality:engine.quality });
  progress(.97, '正在装载星空笔触');
  await App.fold.paintReady;
  App.escapeCamera = new StarfallCinematic({ escape, fold: App.fold, rig, terrain, rover,
    onRelease: () => {
      cmdQueue.length = 0;
      hud.log(`驾驶已恢复 · ${ESCAPE.warning} 秒撤离准备 · 按住 Shift 加速`, 'warn');
      App._escapeSavePending = true;
    }
  });

  applySettings();
  buildSettingsUI();
  if (App.settings.experimentalRayTracing === true) void changeExperimentalRayTracing(true);
  buildHelpUI();
  buildProfileUI();
  App.flowerArchive = new FlowerArchive();
  App.garage = new Garage(rover, Save.appearance(), value => Save.saveAppearance(value), () => {
    App.state = ST.MENU;
  });
  wireUI();

  App.tick = tick;
  App.startGame = startGame;
  window.REGOLITH = App;                 // debug handle: inspect or drive from the console
  progress(1, '链路已建立');
  await new Promise(r => setTimeout(r, 260));
  $('boot').classList.add('hidden');
  showMenu();
  requestAnimationFrame(frame);
}

/* ============================================================
   MENUS
   ============================================================ */
function showMenu() {
  App.escapeCamera?.cancel();
  $('escapeResult').classList.add('hidden');
  $('escapeStatus').hidden = true;
  App.state = ST.MENU;
  $('menu').classList.remove('hidden');
  App.hud.hideHUD();
  App.input.unlock();
  App.input.showTouch(false);
  App.engine.final.uniforms.uLetterbox.value = 0;
  const saved = Save.read();
  $('btnContinue').hidden = !saved;
}

let deliveryNoticeTimer = 0;
function queueDeliveryNotice(card, delay = 0, complete = false) {
  clearTimeout(deliveryNoticeTimer);
  deliveryNoticeTimer = setTimeout(() => {
    if (App.state !== ST.PLAY || !card) return;
    const objective = card.objectives?.[0]?.text || '';
    App.hud.flashDiscovery(complete ? '行动完成' : '新任务', card.name, objective);
    App.hud.log(`${complete ? '行动完成' : card.tag} · ${card.name}`, complete ? 'good' : null);
    App.hud.introduceMission();
  }, delay);
}

function startGame(freeRoam, loadSaved) {
  clearTimeout(deliveryNoticeTimer);
  App.escapeCamera?.cancel();
  $('escapeResult').classList.add('hidden');
  cmdQueue.length = 0;
  App.audio.init(); App.audio.resume();
  App.audio.setVolumes(App.settings.volSfx, App.settings.volMusic);
  App.audio.setMusic(App.settings.music);

  $('menu').classList.add('hidden');
  App.hud.show();
  // The delivery slice keeps the original simulation running in free-survey
  // mode, then supplies one focused rover-only objective and its own save state.
  App.game.reset(true, false);
  App.delivery.reset();
  App.rupture.reset();
  App.flowerArchive.reset();
  App.escape.reset();
  App._escapeSavePending = false;
  App.rover.headlights = false;
  App.rover.highBeams = false;
  App.rover.lampPower = 0;
  App.rover.highBeamPower = 0;
  App.terrain.clearDent();
  App.terrain.clearTrails();
  App.dust.clear();
  App.props.levelPad();
  App._nightCue = false;

  // Begin on the front-right apron, already aimed toward Ares VI. The Sled is
  // offset across the frame so the rover and cargo silhouette read immediately.
  const spawn = { x: HOME.x + 7.2, z: HOME.z - 5.2 };
  const departureYaw = Math.atan2(STATION.x - spawn.x, STATION.z - spawn.z);
  App.rover.placeAt(spawn.x, spawn.z, departureYaw);
  App.rig.setMode(CAM.CHASE, App.rover);

  let resumed = false;
  if (loadSaved) {
    const saved = Save.read();
    resumed = App.game.load(saved);
    App.delivery.load(saved?.delivery);
    App.rupture.load(saved?.rupture);
    App.escape.load(saved?.escape, App.delivery.stage);
    if (App.escape.active) {
      const yaw = App.escape.restoredMotion
        ? Math.atan2(App.rover.forward.x,App.rover.forward.z)
        : Math.atan2(HOME.x-App.rover.pos.x,HOME.z-App.rover.pos.z);
      if(!App.escape.restoredMotion)App.rover.quat.setFromAxisAngle(new THREE.Vector3(0,1,0), yaw);
      App.rover.sync();
      App.rig.yaw=yaw+Math.PI; App.rig.setMode(CAM.CHASE,App.rover);
    }
  }

  if (!resumed) {
    App.rig.yaw = departureYaw + Math.PI + 0.16;
    App.rig.pitch = 0.12;
    App.rig.dist = PORTER_MODE ? 5.4 : 12.2;
    App.rig.lookIdle = 0;
    App.rig.setMode(CAM.CHASE, App.rover);
  }

  // Development-only lighting checkpoints for visual regression inspection.
  if (timePreview === 'mid') App.game.met = 15;
  if (timePreview === 'night') App.game.met = TWILIGHT_SECONDS;

  // Non-production inspection spawns for the two charge pads and the station
  // composition. Normal play never enters these branches.
  if (chargerPreview === 'sled') {
    App.rover.placeAt(spawn.x, spawn.z, departureYaw);
    App.game.power = 42;
    App.rig.yaw = departureYaw + Math.PI + 0.16;
    App.rig.pitch = 0.12;
    App.rig.dist = 12.2;
    App.rig.lookIdle = 0;
    App.rig.setMode(CAM.CHASE, App.rover);
  } else if (chargerPreview === 'relay' && App.props.relayChargePoint) {
    const pad = App.props.relayChargePoint;
    App.rover.placeAt(pad.x, pad.z, 0);
    App.game.power = 42;
    App.rig.yaw = Math.PI - 0.4; App.rig.pitch = 0.18; App.rig.dist = 12;
    App.rig.setMode(CAM.CHASE, App.rover);
  } else if (chargerPreview && App.props.stationChargePoint) {
    const pad = App.props.stationChargePoint;
    const stationYaw = 1.05;
    App.rover.placeAt(pad.x, pad.z, stationYaw);
    App.game.power = 42;
    App.rig.yaw = stationYaw + Math.PI - 0.30;
    App.rig.pitch = 0.14;
    App.rig.dist = 9.4;
    App.rig.setMode(CAM.CHASE, App.rover);
  } else if (stationPreview || eventPreview) {
    const stationYaw = 1.05;
    // Approach from the front-right rather than parking square to the facade.
    // The longer diagonal reveals the pod's real length, keeps the utility
    // shelter behind it, and leaves a driveable strip through the frame.
    const previewOffset = new THREE.Vector3(16, 0, -36)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), stationYaw);
    const roverYaw = stationYaw - 0.42;
    App.rover.placeAt(STATION.x + previewOffset.x, STATION.z + previewOffset.z, roverYaw);
    // A slight camera-side offset puts the rover into the lower-right third
    // while the station carries the left half of the composition.
    App.rig.yaw = roverYaw + Math.PI - 0.34;
    App.rig.pitch = 0.11;
    App.rig.dist = 10.8;
    App.rig.setMode(CAM.CHASE, App.rover);
    if (stationPreview === 'powered') {
      App.delivery.stationRecovered = true;
      App.props.setStationPowerProgress(1);
    }
  }

  if (App.porter) {
    App.porter.placeAt(App.rover);
    App.rig.dist = Math.min(App.rig.dist, 6.2);
    App.rig.pitch = Math.min(App.rig.pitch, 0.16);
    App.rig.setMode(CAM.CHASE, App.rover);
  }

  App.state = ST.PLAY;
  panelReturn = ST.PLAY;
  App.input.lock();
  App.input.showTouch(true);
  if (resumed) {
    App.hud.log('任务状态已恢复 · 导航链路正常', 'good');
  } else {
    App.audio.radio();
    App.hud.log(PORTER_MODE
      ? '布里吉斯搬运员 · 山姆·波特，货物连接正常'
      : '火星地表控制 · MR-7「仙后座」，运输系统正常', 'good');
    App.hud.log(PORTER_MODE
      ? '黄昏沙尘正在降低能见度 · 请沿导航方位步行'
      : '黄昏沙尘正在降低能见度 · 按 L 开启近光灯', 'warn');
    App.hud.log('导航目标已接入 · 阿瑞斯六号 · 346 米');
    App.hud.log('货物 01 · 中继通信单元 · 42.8 千克');
    App.hud.introduceMission();
  }
  if (stationPreview === 'boot') {
    setTimeout(() => {
      if (App.state === ST.PLAY) App.delivery._recoverStation();
    }, 900);
  }
  if (eventPreview && !escapePreview) {
    setTimeout(() => {
      if (App.state !== ST.PLAY) return;
      // Inspection URLs skip the drive from the Sled but otherwise use the
      // exact production systems and objective route.
      App.game.met = Math.max(App.game.met, TWILIGHT_SECONDS);
      App.delivery.stationRecovered = true;
      App.delivery.stationBooting = false;
      App.props.setStationPowerProgress(1);
      App.delivery.stage = 'relay';
      App.delivery._layoutStageRoute();
      App.delivery._syncGameState();
      App.rupture.trigger();
      if (eventPreview !== '1') App.rupture.debugPhase(eventPreview);
    }, 900);
  }
  if (escapePreview && !resumed) prepareEscapePreview();
  if (App.escape.terminal) showEscapeResult(App.escape.phase === 'complete');
  void freeRoam;
}

function saveState() {
  if (!App.game) return null;
  return {
    ...App.game.save(),
    delivery: App.delivery?.save(),
    rupture: App.rupture?.save(),
    escape: App.escape?.save()
  };
}

function placeEscapeCheckpoint() {
  const pad = App.props.relayChargePoint || {x:DELIVERY_SITE.x+12,z:DELIVERY_SITE.z-10};
  const yaw=Math.atan2(HOME.x-pad.x,HOME.z-pad.z);
  App.rover.placeAt(pad.x,pad.z,yaw);
  App.rig.yaw=yaw+Math.PI;App.rig.pitch=0.18;App.rig.dist=12.2;
  App.rig.setMode(CAM.CHASE,App.rover);
  App.rover.headlights=true;App.rover.highBeams=false;
}

function prepareEscapePreview() {
  App.game.met=TWILIGHT_SECONDS;
  App.delivery.load({ version:4,stage:'return',delivered:true,transmitted:false,
    cargoState:'delivered',integrity:100,stationRecovered:true,firstScan:true });
  App.rupture.debugPhase('scar');
  placeEscapeCheckpoint();
  App.escape.start();
  if (escapePreview === 'home') {
    App.escape.skipIntro(); App.escape.finishIntro();
    const a=App.escape.axis;
    App.rover.placeAt(HOME.x-a.x*9,HOME.z-a.z*9,Math.atan2(a.x,a.z));
    App.rig.setMode(CAM.CHASE,App.rover);
  } else if (escapePreview === 'chase') {
    App.escape.skipIntro(); App.escape.finishIntro();
    App.escape.elapsed=10;App.escape.front=ESCAPE.start+2*ESCAPE.speed;App.escape.phase='chase';
    App.rig.yaw=Math.atan2(App.escape.axis.x,App.escape.axis.z);
    App.rig.pitch=0.14;App.rig.lookIdle=-15;
  }
}

function showEscapeResult(success) {
  clearTimeout(deliveryNoticeTimer);cmdQueue.length=0;
  App.escapeCamera?.cancel();
  App.engine.final.uniforms.uLetterbox.value = 0;
  App.state=ST.END;panelReturn=ST.PLAY;
  App.escape.stop();App.delivery.interact=0;App.delivery.holdingHome=false;
  App.input.unlock();App.input.showTouch(false);App.hud.hideHUD();
  $('escapeStatus').hidden=true;
  $('escapeResultTag').textContent=success?'乌托邦行动 · 终章':'撤离中断 · 检查点已保留';
  $('escapeResultTitle').textContent=success?'记录已送出':'未能逃离地裂';
  $('escapeResultCopy').textContent=success
    ?'车辆已抵达母港。灯塔-9 的记录已送达轨道器，进入地球上行队列。中塔光束正在熄灭，异常星空退去，地震与地裂追击结束。'
    :'从孤立中继塔重新出发，车辆将恢复满电与完整底盘。已完成的基地记录和花海进度不会丢失。';
  $('btnEscapeRetry').hidden=success;
  $('escapeResult').classList.remove('hidden');
  $('btnEscape'+(success?'Menu':'Retry')).focus();
  App.audio.update(0.1,{wheelSpin:0,motorLoad:0,speed:0,slip:0,rough:0,drilling:false,contacts:0,alarm:0,maxSpeed:8.4,spinRef:1});
  Save.write(saveState());
}

function syncEscapeUI() {
  const e=App.escape, visible=App.state===ST.PLAY&&e.active&&!e.cinematicActive;
  $('escapeStatus').hidden=!visible;
  if(!visible)return;
  $('escapeStatusTitle').textContent=App.rig.mode===CAM.PHOTO?'摄影模式 · 追击已暂停 · 按 P 返回'
    :e.protected?'母港链路已接管 · 正在传输'
    :e.phase==='warning'?`超载充能完成 · ${Math.max(0,Math.ceil(ESCAPE.warning-e.elapsed))} 秒后开始追击`
    :`后方地裂逼近 · 安全间距 ${Math.max(0,Math.round(e.gap))} 米`;
  const homeDist=Math.hypot(App.rover.pos.x-HOME.x,App.rover.pos.z-HOME.z);
  $('escapeStatusHint').textContent=homeDist<100
    ?'松开 Shift，按空格刹停 · 进入母港圆环后按住 E'
    :'满电持续供能 · Shift 超载加速 · 空格制动 · 沿金色标记返航';
  $('escapeGap').value=clamp(e.gap/160,0,1);
}

/* Where a closing panel should hand control back to. openPanel overwrites
   App.state, so the `state !== ST.MENU` test the close paths used could never
   see MENU: opening CONTROLS or SYSTEMS from the main menu dropped you into
   ST.PLAY and grabbed the pointer, before the game had even started. */
let panelReturn = ST.MENU;

function openPanel(id, state) {
  cmdQueue.length = 0;
  if (App.state === ST.MENU || App.state === ST.PLAY) panelReturn = App.state;
  App.state = state;
  $(id).classList.remove('hidden');
  App.input.unlock();
  App.input.showTouch(false);
  App.rover?.cancelBoost?.();
  App.audio.ui('tick');
}
function closePanels() {
  for (const id of ['pause', 'codex', 'help', 'profile']) $(id).classList.add('hidden');
  if (panelReturn === ST.MENU) showMenu();
  else { App.state = ST.PLAY; App.input.lock(); App.input.showTouch(true); }
}

function openPersonalArchive() {
  if (App.state === ST.PLAY && (App.rupture.cinematicActive || App.escape.cinematicActive)) return;
  App.flowerArchive.dismiss();
  openPanel('profile', ST.PROFILE);
}

function wireUI() {
  // Losing focus cannot turn an unattended preview into an unfair death.
  const pauseEscape=()=>{if(App.state===ST.PLAY&&App.escape.active)openPanel('pause',ST.PAUSE);};
  addEventListener('blur',pauseEscape);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseEscape();});
  $('btnEscapeRetry').onclick=()=>{
    if(App.escape.phase!=='failed')return;
    App.delivery.interact=0;App.delivery.holdingHome=false;
    cmdQueue.length=0;App.dust.clear();
    App.input.keys.clear();App.input.pressed.clear();
    App.escapeCamera.cancel();
    placeEscapeCheckpoint();
    App.state=ST.PLAY;App.escape.retry();
    $('escapeResult').classList.add('hidden');
    App.hud.show();App.input.lock();App.input.showTouch(true);
    Save.write(saveState());
  };
  $('btnEscapeMenu').onclick=showMenu;
  $('skipEventCamera').onclick = () => App.escapeCamera?.active
    ? App.escapeCamera.skip() : App.rupture?.skipCinematic();
  $('btnPlay').onclick = () => { Save.clear(); startGame(false, false); };
  $('btnContinue').onclick = () => startGame(false, true);
  $('btnGarage').onclick = () => { App.state = ST.GARAGE; App.garage.open(); };
  $('btnControls').onclick = () => openPanel('help', ST.HELP);
  $('btnSettings').onclick = () => openPanel('pause', ST.PAUSE);
  $('btnProfile').onclick = openPersonalArchive;
  $('openFlowerArchive').onclick = openPersonalArchive;
  $('dismissFlowerArchive').onclick = () => App.flowerArchive.dismiss();
  $('btnResume').onclick = closePanels;
  $('btnHelp').onclick = () => { $('pause').classList.add('hidden'); openPanel('help', ST.HELP); };
  $('btnCodexFromPause').onclick = () => { $('pause').classList.add('hidden'); openPanel('codex', ST.CODEX); };
  $('btnProfileFromPause').onclick = () => { $('pause').classList.add('hidden'); openPersonalArchive(); };
  $('btnAbort').onclick = () => {
    Save.write(saveState());
    for (const id of ['pause', 'codex', 'help', 'profile']) $(id).classList.add('hidden');
    showMenu();
  };
  // one close path, so the ESC button and the Escape key cannot diverge
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = closePanels);
  addEventListener('beforeunload', () => { if (App.game && App.state >= ST.PLAY && App.state !== ST.GARAGE) Save.write(saveState()); });
}

function buildProfileUI() {
  const initials = PROFILE.romanizedName.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('');
  const avatar = $('profileAvatar');
  avatar.textContent = initials || 'ID';
  if (PROFILE.avatar) {
    avatar.style.backgroundImage = `linear-gradient(rgba(4,5,10,.06),rgba(4,5,10,.34)),url("${encodeURI(PROFILE.avatar)}")`;
    avatar.classList.add('has-image');
  }
  $('profileName').textContent = PROFILE.displayName;
  $('profileRoman').textContent = PROFILE.romanizedName;
  $('profileRole').textContent = PROFILE.role;
  $('profileLocation').textContent = PROFILE.location;
  $('profileAvailability').textContent = PROFILE.availability;
  $('profileIntro').textContent = PROFILE.intro;
  $('openFlowerArchive').querySelector('b').textContent = `${PROFILE.displayName} · 创作档案`;
  $('profileFocus').replaceChildren(...PROFILE.focus.map(value => {
    const item = document.createElement('span');
    item.textContent = value;
    return item;
  }));

  const projectRoot = $('profileProjects');
  projectRoot.replaceChildren(...PROFILE.projects.map((project) => {
    const article = document.createElement('article');
    article.className = 'profile-project';
    const code = document.createElement('small');
    code.textContent = project.code;
    const title = document.createElement('h4');
    title.textContent = project.title;
    const summary = document.createElement('p');
    summary.textContent = project.summary;
    const tags = document.createElement('div');
    tags.className = 'profile-tags';
    for (const value of project.stack || []) {
      const tag = document.createElement('span');
      tag.textContent = value;
      tags.appendChild(tag);
    }
    article.append(code, title, summary, tags);
    return article;
  }));

  let searchableAccounts = 0;
  const channelRoot = $('profileChannels');
  channelRoot.replaceChildren(...PROFILE.channels.map((channel, index) => {
    const validURL = /^(https?:|mailto:)/i.test(channel.url || '');
    const hasHandle = !!channel.handle && channel.handle !== '待接入';
    if (hasHandle && !validURL) searchableAccounts++;
    const item = document.createElement(validURL ? 'a' : 'div');
    item.className = `profile-channel${validURL || hasHandle ? '' : ' pending'}`;
    if (validURL) {
      item.href = channel.url;
      item.target = channel.url.startsWith('mailto:') ? '_self' : '_blank';
      item.rel = 'noopener noreferrer';
    }
    const number = document.createElement('span');
    number.className = 'profile-channel-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'profile-channel-copy';
    const title = document.createElement('b');
    title.textContent = channel.label;
    const detail = document.createElement('small');
    detail.textContent = channel.detail;
    copy.append(title, detail);
    const handle = document.createElement('span');
    handle.className = 'profile-channel-handle';
    handle.textContent = hasHandle ? channel.handle : validURL ? '打开频道' : '待接入';
    item.append(number, copy, handle);
    return item;
  }));
  $('profileConfigNote').hidden = searchableAccounts === 0;
  $('profileConfigNote').textContent = '可复制上方账号，通过平台搜索与我联系。';
}

/* ---------------- settings ---------------- */
function buildSettingsUI() {
  const body = $('settingsBody');
  const S = App.settings;
  const rows = [];
  const seg = (label, note, opts, get, set) => rows.push(
    { type: 'seg', label, note, opts, get, set });
  const rng = (label, note, min, max, step, get, set) => rows.push(
    { type: 'rng', label, note, min, max, step, get, set });

  seg('渲染质量', 'Mac 推荐高画质；4070 Super 演示选极致。档位可保存，切换不重置任务。',
    QUALITY_KEYS.map((key) => QUALITY[key].label),
    () => QUALITY_KEYS.indexOf(S.quality),
    // setQuality rebuilds the composer, so the final-pass uniforms are new
    // objects — re-apply the user's settings or grain/aberration silently reset.
    (i) => {
      S.quality = QUALITY_KEYS[i];
      // A launch URL can request a demo preset. A later manual choice wins on
      // refresh too, instead of being silently overridden by that old query.
      if (new URLSearchParams(location.search).has('quality')) {
        const url = new URL(location.href);
        url.searchParams.delete('quality');
        history.replaceState(null, '', url);
      }
      App.engine.setQuality(S.quality);
      applyWorldQuality();
      applySettings();
      persist();
      updateQualitySummary();
    });
  seg('实验光追 · 接触遮蔽',
    '默认关闭。基地与车身的真实三角形光线求交；非 RTX、无光追反射。开启使用 FXAA，Mac 仅建议短时对比。',
    ['关闭', '开启'], () => S.experimentalRayTracing === true ? 1 : 0,
    (i) => { void changeExperimentalRayTracing(i === 1); });
  seg('辉光', App.engine.stableFramebuffer
    ? 'Mac 稳定模式不启用后期辉光；此偏好保留，灯具自身光晕仍可见'
    : '明亮光源周围的克制光晕；需要支持 HDR 的设备与中档以上画质', ['关闭', '开启'],
    () => S.bloom ? 1 : 0, (i) => { S.bloom = !!i; applySettings(); persist(); });
  seg('传感器噪点', '默认保持清晰，仅在扫描、信号干扰和受损时增强', ['仅事件', '低', '完整'],
    () => S.grain === 0 ? 0 : S.grain < 0.7 ? 1 : 2,
    (i) => { S.grain = [0, 0.5, 1][i]; applySettings(); persist(); });
  seg('色差', '画面边缘的镜头色彩分离效果', ['关闭', '开启'],
    () => S.aberr ? 1 : 0, (i) => { S.aberr = i ? 1 : 0; applySettings(); persist(); });
  seg('星空亮度', '电影模式会让阳光下的星星依然可见', ['写实', '电影化'],
    () => S.stars > 0.5 ? 1 : 0, (i) => { S.stars = i ? 1 : 0.22; applySettings(); persist(); });
  seg('驾驶性能', '写实火星车：最高 13 千米/小时，钻探一次需要 45 秒',
    ['娱乐', '写实火星车'],
    () => S.realistic ? 1 : 0,
    (i) => { S.realistic = !!i; applySettings(); persist();
      App.hud.log(i ? '驾驶模式 — 写实火星车 · 3.6 米/秒 · 钻探 45 秒' : '驾驶模式 — 娱乐'); });
  seg('信号延迟', '指令经过本地轨道中继后，火星车才会执行',
    ['关闭', '轨道中继 2.6 秒'],
    () => S.comms ? 1 : 0,
    (i) => { S.comms = !!i; applySettings(); persist();
      App.hud.log(i ? '上行链路 — 单程 1.28 秒，往返 2.56 秒' : '上行链路 — 本地控制'); });
  seg('界面大小', '统一缩放所有仪表面板', ['小', '标准', '大'],
    () => S.hudScale < 0.92 ? 0 : S.hudScale > 1.08 ? 2 : 1,
    (i) => { S.hudScale = [0.82, 1, 1.18][i]; applySettings(); persist(); });
  seg('镜头自动回正', '追踪视角会逐渐回到火星车后方', ['关闭', '慢', '快'],
    () => S.autoCentre, (i) => { S.autoCentre = i; App.rig.autoCentre = i; persist(); });
  seg('反转视角', '', ['关闭', '开启'],
    () => S.invertY ? 1 : 0, (i) => { S.invertY = !!i; applySettings(); persist(); });
  seg('牵引力控制', '在车轮刨入火星表土前限制轮毂扭矩', ['关闭', '开启'],
    () => S.tc ? 1 : 0, (i) => { S.tc = !!i; App.game.tc = !!i; persist(); });
  seg('配乐', '生成式 D 小调氛围配乐', ['关闭', '开启'],
    () => S.music ? 1 : 0, (i) => { S.music = !!i; App.audio.setMusic(!!i); persist(); });
  rng('视野范围', '角度', 42, 82, 1, () => S.fov, (v) => { S.fov = v; App.rig.fovScale = v / 58; persist(); });
  rng('视角灵敏度', '', 0.25, 3, 0.05, () => S.sens, (v) => { S.sens = v; applySettings(); persist(); });
  rng('音效音量', '', 0, 1, 0.05, () => S.volSfx, (v) => { S.volSfx = v; App.audio.setVolumes(v, S.volMusic); persist(); });
  rng('音乐音量', '', 0, 1, 0.05, () => S.volMusic, (v) => { S.volMusic = v; App.audio.setVolumes(S.volSfx, v); persist(); });

  body.innerHTML = '';
  const qualitySummary = document.createElement('p');
  qualitySummary.id = 'qualitySummary';
  qualitySummary.setAttribute('role', 'status');
  qualitySummary.className = 'quality-summary';
  body.appendChild(qualitySummary);
  const raySummary = document.createElement('p');
  raySummary.id = 'rayTracingSummary'; raySummary.className = 'quality-summary';
  raySummary.setAttribute('role', 'status'); body.appendChild(raySummary);
  updateQualitySummary();
  updateRayTracingSummary();
  for (const r of rows) {
    const d = document.createElement('div');
    d.className = 'set-row' + (r.label === '渲染质量' || r.label === '实验光追 · 接触遮蔽' ? ' quality-row' : '');
    const l = document.createElement('label');
    l.innerHTML = `${r.label}${r.note ? `<small>${r.note}</small>` : ''}`;
    d.appendChild(l);
    if (r.type === 'seg') {
      const s = document.createElement('div'); s.className = 'seg';
      r.opts.forEach((o, i) => {
        const b = document.createElement('button'); b.textContent = o;
        if (r.label === '实验光追 · 接触遮蔽') b.dataset.rayChoice = String(i);
        b.onclick = () => { r.set(i); [...s.children].forEach((c, j) => {
          c.classList.toggle('on', j === i); c.setAttribute('aria-pressed', String(j === i));
        }); App.audio.ui('tick'); };
        s.appendChild(b);
      });
      [...s.children].forEach((c, j) => {
        c.classList.toggle('on', j === r.get()); c.setAttribute('aria-pressed', String(j === r.get()));
      });
      d.appendChild(s);
    } else {
      const wrap = document.createElement('div');
      const i = document.createElement('input');
      i.type = 'range'; i.min = r.min; i.max = r.max; i.step = r.step; i.value = r.get();
      const v = document.createElement('span');
      v.style.cssText = 'margin-left:10px;font-size:10px;color:#6fe3f5;min-width:34px;display:inline-block';
      v.textContent = (+r.get()).toFixed(r.step < 1 ? 2 : 0);
      i.oninput = () => { r.set(+i.value); v.textContent = (+i.value).toFixed(r.step < 1 ? 2 : 0); };
      wrap.appendChild(i); wrap.appendChild(v);
      d.appendChild(wrap);
    }
    body.appendChild(d);
  }
}
let rayChangeVersion = 0;
async function changeExperimentalRayTracing(enabled) {
  const version = ++rayChangeVersion;
  App.settings.experimentalRayTracing = enabled;
  App.rayMessage = enabled ? '正在准备基地与车身的光线求交数据……' : '';
  updateRayTracingSummary();
  // Give the UI one task to show progress. A quick OFF cancels pending ON.
  if (enabled) await new Promise(resolve => setTimeout(resolve, 40));
  if (version !== rayChangeVersion) return;
  try {
    App.engine.setRayTracing(enabled);
    App.rayMessage = '';
  } catch (error) {
    App.engine.setRayTracing(false);
    App.settings.experimentalRayTracing = false;
    App.rayMessage = `未启用：${error.message}。已保留普通渲染。`;
    console.warn('[REGOLITH] Experimental contact rays unavailable:', error);
  }
  applySettings(); persist(); updateQualitySummary(); updateRayTracingSummary();
  document.querySelectorAll('[data-ray-choice]').forEach(button => {
    const selected = Number(button.dataset.rayChoice) === (App.settings.experimentalRayTracing ? 1 : 0);
    button.classList.toggle('on', selected); button.setAttribute('aria-pressed', String(selected));
  });
}
function updateRayTracingSummary() {
  const node = $('rayTracingSummary'); if (!node) return;
  const pass = App.engine.rayPass;
  node.textContent = App.rayMessage || (pass
    ? `实验光追已开启 · 近景接触遮蔽 · ${pass.models.reduce((n,m)=>n+m.triangles,0).toLocaleString('zh-CN')} 个真实三角形 · 4 条光线/采样点。草花、车轮、远景和反射仍用原渲染；4070S 帧率需实测。`
    : '实验光追已关闭 · 不创建光追纹理或执行额外光线求交。');
}
function updateQualitySummary() {
  const node = $('qualitySummary');
  if (!node) return;
  const engine = App.engine, q = engine.quality;
  const buffer = new THREE.Vector2();
  engine.renderer.getDrawingBufferSize(buffer);
  const features = engine.features;
  node.textContent = `${q.label} · 实际渲染 ${buffer.x} × ${buffer.y} · `
    + `${features.hdr ? 'HDR' : '稳定 LDR'} · ${features.samples ? `${features.samples}× MSAA + ` : ''}FXAA · `
    + `主光阴影 ${q.shadow ? q.shadow : '关闭'}`
    + (engine.stableFramebuffer ? '。Mac 保留防闪烁路径，极致档也不强开 HDR/MSAA。'
      : '。4070S 演示建议 2560 × 1440；实际帧率请在目标机器验证。');
}
function persist() { Save.saveSettings(App.settings); }

/* Save the frame that was just drawn. Photo mode hides the HUD already, so what
   lands on disk is what you framed. */
function saveFrame() {
  try {
    const url = App.engine.renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    const t = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `死亡搁浅-赤壤-${t}.png`;
    a.href = url;
    a.click();
    App.hud.log('画面已保存', 'good');
    App.audio.ui('ok');
  } catch (e) {
    App.hud.log('画面保存失败', 'bad');
  }
}

/* Push a tier change through to everything that sized itself from it at boot.
   Engine.setQuality only re-fits the framebuffer, the shadow map and the
   composer; the clipmap, the excavation grid, the trail buffer, the sun mask,
   the boulder density and the dust budget all live out here and used to be
   frozen at whatever guessQuality picked on the first run. On a tablet that
   meant RENDER QUALITY moved almost nothing.

   Cheap because bakeTerrain takes no quality argument: the height field is
   tier-independent, so none of this re-bakes the basin. */
function applyWorldQuality() {
  const q = App.engine.quality;
  App.terrain?.setQuality(q);
  App.props?.setQuality(q);
  App.sky?.setQuality(q);
  App.rover?.setQuality(q);
  App.dust?.setMax(q.dust);
  App.rupture?.setQuality(q);
  App.starfall?.setQuality(q);
  const anisotropy = Math.min(App.engine.caps.aniso, q.anisotropy);
  const seen = new Set();
  const tune = (texture) => {
    if (!texture?.isTexture || texture.isRenderTargetTexture || seen.has(texture)) return;
    seen.add(texture);
    if (texture.anisotropy !== anisotropy) { texture.anisotropy = anisotropy; texture.needsUpdate = true; }
  };
  for (const tex of Object.values(App.surfaceTextures || {})) tune(tex);
  App.engine.scene.traverse((object) => {
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) tune(material[key]);
    }
  });
}

function applySettings() {
  const S = App.settings, e = App.engine;
  e.final.uniforms.uGrain.value = S.grain;
  e.final.uniforms.uAberr.value = S.aberr;
  e.bloom.enabled = S.bloom && e.features.bloom;
  App.rig.invertY = S.invertY;
  App.rig.sens = S.sens;
  App.rig.autoCentre = S.autoCentre;
  App.rig.fovScale = S.fov / 58;
  App.sky.starIntensity = S.stars;
  // The field rover cruises at ~13 km/h; the arcade default is 30. Every speed
  // threshold in the rover, camera and audio is a fraction of this, so the one
  // assignment retunes all of them.
  DRIVE.maxSpeed = App.porter ? 1.55 : (S.realistic ? 3.6 : 8.4);
  DRIVE.commsDelay = S.comms ? EARTH_RTT : 0;
  OPS.drillTime = S.realistic ? 45 : 4.2;
  // one knob for every instrument dimension; the stylesheet does the rest
  document.documentElement.style.setProperty('--hud-k', S.hudScale);
  if (App.audio.ready) App.audio.setVolumes(S.volSfx, S.volMusic);
}

function buildHelpUI() {
  $('keysBody').innerHTML = `
    <div class="keygroup"><h4>${PORTER_MODE ? '步行' : '驾驶'}</h4>
      ${row(PORTER_MODE ? '前进 / 后退' : '前进 / 倒车', 'W', 'S')}${row('转向', 'A', 'D')}
      ${PORTER_MODE ? '' : row('制动', '空格键')}
      ${PORTER_MODE ? '' : row('按住增力 / 冲刺 · 辅助爬坡', 'Shift', 'W / S')}
      ${row('互动 / 交付 / 传输', 'E')}
    </div>
    <div class="keygroup"><h4>火星车系统</h4>
      ${row('奥卓德克地形扫描 · 消耗 2% 电量', 'G')}${row('车灯：关闭 / 近光 / 远光', 'L')}
      ${row('切换镜头', 'C')}${row('摄影模式', 'P')}
    </div>
    <div class="keygroup"><h4>系统</h4>
      ${row('档案库', '制表键')}
      ${row('个人档案 / 收录的花海来信', 'I')}
      ${row('暂停 / 系统设置', '退出键')}${row('显示或隐藏界面', 'H')}
    </div>
    <div class="keygroup"><h4>视角</h4>
      ${row('观察', '鼠标')}${row('缩放', '滚轮')}
      ${row('摄影模式：自由移动', 'W', 'A', 'S', 'D')}
      ${row('摄影模式：上升 / 下降', 'Q', 'Z')}${row('摄影模式：加速', '上档键')}
      ${row('将当前画面保存为图片', 'K')}
      ${row('花海演出：提前交还镜头，生长继续', '空格键')}
      ${row('星空地裂演出：提前交还镜头，归位后开始撤离', '空格键')}
    </div>
    <div class="keygroup"><h4>操作手册提示</h4>
      <div class="keyrow"><span>黑色玻璃岩摩擦力很低，也难以辨认，穿越前先进行扫描。</span></div>
      <div class="keyrow"><span>${PORTER_MODE ? '山姆将通信货物固定在背部货架上，步行完成运输。' : '整个运输过程中，操作员始终留在火星车内。'}</span></div>
      <div class="keyrow"><kbd>T</kbd><span>停车后按一下开始充电，再按停止；驶离自动断开。母港、阿瑞斯六号与孤立中继站均可补电；基地须先恢复供电。</span></div>
      <div class="keyrow"><span>恢复阿瑞斯六号、安装中继货物，然后返回火星母港进行传输。</span></div>
      <div class="keyrow"><span>猛烈撞击会降低货物完整度，越过坡顶和碎石区前请减速。</span></div>
      <div class="keyrow"><span>青色扫描脉冲会短暂显示建议行驶路线。</span></div>
      <div class="keyrow"><span>地平线上唯一的暖色灯光就是你的目的地。</span></div>
    </div>`;
  function row(label, ...keys) {
    return `<div class="keyrow"><span>${label}</span><b>${keys.map(k => `<kbd>${k}</kbd>`).join(' ')}</b></div>`;
  }
}

/* ============================================================
   FRAME
   ============================================================ */
let last = performance.now(), acc = 0, fpsT = 0, fpsN = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1;
  tick(dt);
}

/** One simulated + rendered frame. Exposed on the debug handle so a headless
    driver can advance the game without relying on rAF. */
function tick(dt) {
  const input = App.input;
  const raw = input.poll();

  /* ---------------- global keys ---------------- */
  if (input.hit('Escape')) {
    if (App.state === ST.GARAGE) App.garage.close(false);
    else if (App.state === ST.PLAY) openPanel('pause', ST.PAUSE);
    else if (App.state === ST.PAUSE || App.state === ST.CODEX || App.state === ST.HELP || App.state === ST.PROFILE) closePanels();
  }
  if (App.state === ST.GARAGE) { App.garage.render(); input.endFrame(); return; }
  if (input.hit('Tab')) {
    if (App.state === ST.PLAY && !App.rupture.cinematicActive && !App.escape.cinematicActive) { App.hud.refreshCodex(App.game); openPanel('codex', ST.CODEX); }
    else if (App.state === ST.CODEX) closePanels();
  }
  if (input.hit('KeyH') && App.state >= ST.PLAY) {
    App.settings.hudOn = !App.settings.hudOn;
    App.hud.el.hud.style.opacity = App.settings.hudOn ? '' : '0';
  }
  if (input.hit('KeyI')) {
    if ((App.state === ST.PLAY && !App.rupture.cinematicActive && !App.escape.cinematicActive) || App.state === ST.MENU) openPersonalArchive();
    else if (App.state === ST.PROFILE) closePanels();
  }

  // Pause must freeze the world and the event camera, not run the title orbit.
  // Evaluate state after Escape so the pause key never advances one extra tick.
  if (App.state === ST.PLAY) stepWorld(dt, raw, input);
  else if (App.state !== ST.END && (App.state === ST.MENU || panelReturn === ST.MENU)) idleWorld(dt);
  if(App.state!==ST.PLAY&&App.escape.active&&App.audio.ready)
    App.audio.rGain.gain.setTargetAtTime(0,App.audio.now(),.10);
  if(App.state!==ST.PLAY||!App.escape.active)App.audio.stopSeismicImpacts();
  syncCinematicUI();
  App.flowerArchive.update(dt, {
    event: App.rupture, playing: App.state === ST.PLAY,
    blocked: App.escape.active, hudOn: App.settings.hudOn
  });
  syncEscapeUI();
  App.fold.update(App.state!==ST.MENU&&App.state!==ST.BOOT&&panelReturn!==ST.MENU,
    App.state===ST.PLAY||App.state===ST.END?dt:0,App.engine.camera);
  // Seismic effects do not remap or fade the original facility transforms.
  App.terrain.syncPracticalLights?.(App.rover.headlightSources?.[0], App.props.stationGroundLight);

  /* ---------------- sun bearing on screen, for the flare ---------------- */
  const sp = _v.copy(App.sky.anomalyMoonDir).multiplyScalar(4000).add(App.engine.camera.position)
    .project(App.engine.camera);
  const front = App.sky.anomalyMoonDir.dot(App.engine.camera.getWorldDirection(_v2)) > 0;
  const vis = front && App.sky.anomalyMoonDir.y > -0.02
    ? clamp(1 - Math.max(Math.abs(sp.x), Math.abs(sp.y)) * 0.42, 0, 1) *
      clamp(App.sky.anomalyMoonDir.y * 14, 0, 1) * App.sky.anomalyMoonPresence
    : 0;
  // The false moon supplies the bright disc and a restrained halo only while
  // the flower-tide anomaly is present.
  // Keep only a trace of optical glare so its surrounding sky remains black.
  App.engine.final.uniforms.uSunUV.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5, vis * 0.18);

  App.engine.rayVisible = App.state !== ST.MENU && App.state !== ST.BOOT && App.fold.uniforms.uFoldOn.value===0
    && App.starfall.uniforms.uQuakeOn.value===0;
  App.engine.render(dt);
  // Must run in the same task as the draw: the drawing buffer is cleared before
  // the next event loop turn unless preserveDrawingBuffer is on, which costs
  // performance on every frame to serve a key almost nobody presses.
  if (App.wantShot) { App.wantShot = false; saveFrame(); }
  input.endFrame();

  fpsT += dt; fpsN++;
  if (fpsT > 1) { App.fps = fpsN / fpsT; fpsT = 0; fpsN = 0; }
  void acc;
}

function syncCinematicUI() {
  const state = App.escapeCamera?.state || App.rupture?.cinematicState;
  const active = App.state === ST.PLAY && !!state;
  document.body.classList.toggle('event-cinematic', active);
  document.body.classList.toggle('flower-story-active', active && !App.escapeCamera?.state);
  $('eventCinematic').hidden = !active;
  if (!active) return;
  $('eventCameraTitle').textContent = state?.title || '寂静花潮';
  $('eventCameraKind').textContent = state.kind || '地表异常记录';
  $('eventCameraDetail').textContent = state.detail || '正在记录地表异常 · 车辆驻停';
  $('eventCameraHint').textContent = state.hint || '空格跳过镜头 · Esc 暂停';
  $('skipEventCamera').disabled = !state.skippable;
  $('skipEventCamera').textContent = state.skippable ? '空格 · 交还镜头' : '镜头归位中';
}

/* ---------------- the world when nobody is driving ---------------- */
function idleWorld(dt) {
  App.elapsed += dt;
  App.sunAz += dt * 0.00032;
  // The title screen always holds the opening composition. Waiting in the
  // menu must not consume the player's two-and-a-half-minute dusk.
  App.sky.setSun(App.sunAz, sunAltitude(0));
  syncSun();
  // a slow orbit over the basin behind the menus
  const t = App.elapsed * 0.045;
  const cx = Math.cos(t) * 150, cz = Math.sin(t) * 150;
  const cy = App.terrain.heightAt(cx, cz) + 46 + Math.sin(t * 1.7) * 10;
  App.engine.camera.position.set(cx, cy, cz);
  App.engine.camera.lookAt(0, App.terrain.heightAt(0, 0) + 14, 0);
  App.terrain.update(dt, App.engine.camera, App.lightDir);
  App.sky.update(dt, App.engine.camera, App.elapsed);
  App.props.update(dt, App.elapsed, App.engine.camera);
  App.glass?.update(dt);
  App.engine.aimShadow(_v.set(cx, cy - 40, cz), App.lightDir);
}

/* Commands in flight to the rover.

   Only the DRIVE axes go through here, not arm aiming and not the camera. That
   is a design call, not a modelling shortcut, and it is worth being explicit
   about: latency is interesting where it forces anticipation — you brake before
   you think you need to, and a boulder you can already see is one you may
   already have hit. Aiming a drill is point-and-hold; the same 2.6 s there is
   friction with no decision in it. The chase camera is not a real camera on a
   real rover at all, so delaying it would buy nothing. */
const cmdQueue = [];

function pumpCommands(now, live) {
  const d = App.escape?.active ? 0 : DRIVE.commsDelay;
  if (d <= 0) { cmdQueue.length = 0; return live; }
  cmdQueue.push({ t: now, ...live });
  // Everything stamped before now-d has arrived; the last of those is what the
  // rover is acting on. Nothing yet => the first commands are still crossing.
  let arrived = null;
  while (cmdQueue.length && cmdQueue[0].t <= now - d) arrived = cmdQueue.shift();
  return arrived || { throttle: 0, steer: 0, brake: 0 };
}

/* ---------------- driving ---------------- */
function stepWorld(dt, raw, input) {
  const { rover, terrain, sky, props, dust, game, rig, engine, audio, hud,
    delivery, glass, haze, rupture, escape, escapeCamera } = App;
  App.starfall.prepareFrame(engine.camera);
  // Match the solver's 50 ms cap: slow frames must not let pursuit outrun physics.
  if (escape.active) dt=Math.min(dt,0.05);
  App.elapsed += dt;

  /* ---- low Martian evening sun ---- */
  App.sunAz += dt * 0.00032;
  sky.setSun(App.sunAz, sunAltitude(game.met));
  syncSun();
  if (!App._nightCue && sky.sunAlt < -0.055) {
    App._nightCue = true;
    hud.log('太阳已沉入尘幕 · 地表照度正在快速下降', 'warn');
  }
  // Keep the prefiltered environment stable during play. Rebuilding PMREM in
  // the middle of a frame caused visible exposure steps on some WebGL drivers;
  // the moving sun and false moon are already represented by direct lights.

  /* ---- controls ---- */
  if (escape.cinematicActive && !escapeCamera.active) escapeCamera.start();
  if (rupture.cinematicActive && input.hit('Space')) rupture.skipCinematic();
  // A held docking brake must not skip the establishing shot on its first tick.
  if (escapeCamera.active && escape.introElapsed > 0.8 && input.hit('Space')) escapeCamera.skip();
  const cinematic = !!rupture.cinematicActive || escape.cinematicActive;
  let photo = rig.mode === CAM.PHOTO;
  let controlsLocked = photo || cinematic;
  if (controlsLocked) cmdQueue.length = 0;
  const sent = pumpCommands(App.elapsed, {
    throttle: controlsLocked ? 0 : raw.throttle,
    steer: controlsLocked ? 0 : raw.steer,
    brake: controlsLocked ? 1 : raw.brake,
  });
  const ctl = { throttle: sent.throttle, steer: sent.steer, brake: sent.brake,
    tc: game.tc, boost: !controlsLocked && !!raw.boost, cinematicHold: cinematic };
  if (controlsLocked) {
    ctl.throttle = 0; ctl.steer = 0; ctl.brake = 1; ctl.boost = false;
    rover.cancelBoost?.();
  }
  App.cmdInFlight = cmdQueue.length;

  if (input.hit('KeyL')) {
    if (game.power <= LIGHT_MIN_POWER) {
      rover.headlights = false;
      rover.highBeams = false;
      hud.log('电量耗尽 · 车灯无法开启', 'bad');
      audio.ui('warn');
    } else if (!rover.headlights) {
      rover.headlights = true;
      rover.highBeams = false;
      hud.log('近光灯已开启 · 低耗电 · 再按 L 切换远光');
      audio.ui('tick');
    } else if (!rover.highBeams) {
      rover.highBeams = true;
      hud.log('远光灯已开启 · 高耗电 · 建议短时使用', 'warn');
      audio.ui('tick');
    } else {
      rover.headlights = false;
      rover.highBeams = false;
      hud.log('车灯已关闭');
      audio.ui('tick');
    }
  }
  if (!cinematic && input.hit('KeyG')) delivery.doScan();

  /* ---- arm: R deploys it, then the drive keys aim it ----
     Reusing WASD costs no new bindings and is unambiguous, because you have to
     be stopped to drill anyway. The hill hold keeps the chassis where you left
     it while you line the bit up. */
  if (!game.deliveryMode && input.hit('KeyR')) game.toggleArm();
  if (!game.deliveryMode && rover.armOut) {
    const spd = dt * 1.5;
    rover.armYaw = clamp(rover.armYaw - raw.steer * spd, -0.95, 0.95);
    rover.armReach = clamp(rover.armReach + raw.throttle * spd * 0.8, 0.55, 1.62);
    ctl.throttle = 0; ctl.steer = 0; ctl.brake = 1;      // chassis is parked while aiming
    // `clicked` as well as `down`: a phone tap can begin and end between two
    // frames, and checking only `down` silently drops it.
    if ((input.mouse.down || input.mouse.clicked) && !game.drill.active) game.startDrill();
  }
  if (!game.deliveryMode && input.hit('KeyB')) game.deployRelay();
  if (!cinematic && input.hit('KeyC')) {
    rig.cycle(rover);
    audio.ui('tick');
  }
  if (input.hit('KeyK')) App.wantShot = true;
  if (!cinematic && input.hit('KeyP')) {
    rig.setMode(rig.mode === CAM.PHOTO ? CAM.CHASE : CAM.PHOTO, rover);
    if (rig.mode === CAM.PHOTO) rig.enterPhoto(rover);
    rover.cancelBoost?.();
    photo = rig.mode === CAM.PHOTO;
    controlsLocked = photo || cinematic;
    ctl.boost = false;
    if (controlsLocked) {
      ctl.throttle = ctl.steer = 0;
      ctl.brake = 1;
      cmdQueue.length = 0;
    }
    audio.ui('tick');
  }
  engine.final.uniforms.uLetterbox.value +=
    ((cinematic ? 0.12 : rig.mode === CAM.PHOTO ? 0.22 : 0) - engine.final.uniforms.uLetterbox.value) * Math.min(1, dt * 3);

  rover.lampPower += ((rover.headlights ? 1 : 0) - rover.lampPower) * Math.min(1, dt * 5);
  rover.highBeamPower += ((rover.headlights && rover.highBeams ? 1 : 0) - rover.highBeamPower) * Math.min(1, dt * 4);

  /* ---- physics ---- */
  if (cinematic) {
    // Hold the actual vehicle in place; the cutscene must not roll it off a
    // slope, damage cargo, or spend a limited high-beam battery without agency.
    rover.vel.set(0, 0, 0);
    rover.omega.set(0, 0, 0);
    rover.hardHit = 0;
    rover.motorLoad = 0;
    for (const w of rover.wheels) {
      w.spinVel = w.slipLong = w.slipLat = w.compVel = 0;
      w.lastGround.copy(w.worldPos);
    }
    rover.sync();
  } else if (!photo) {
    rover.hardHit = 0;
    if (App.porter) App.porter.step(dt, ctl, rover);
    else rover.step(dt, ctl, terrain);
    const impact = props.resolve(rover);
    if (App.porter) App.porter.sync(rover);
    if (!App.porter && impact > 1.6) {
      game.damage(impact * 1.8, '巨石撞击');
      delivery.damageCargo((impact - 1.6) * 0.95, '巨石撞击');
      rig.addShake(clamp(impact * 0.16, 0, 1));
    }
    if (!App.porter && rover.hardHit > 3.2) {
      game.damage((rover.hardHit - 3.2) * 2.4, '重着陆');
      delivery.damageCargo((rover.hardHit - 3.2) * 1.25, '重着陆');
      rig.addShake(clamp(rover.hardHit * 0.11, 0, 1));
      audio.thud(clamp(rover.hardHit * 0.25, 0.3, 2));
      const p = rover.pos;
      dust.spawn(Math.min(70, 12 + rover.hardHit * 8), p.x, terrain.heightAt(p.x, p.z), p.z,
        clamp(rover.hardHit * 0.30, 0.5, 2.4), 1.3);
    }
    if (!App.porter) rover.sync();
  }
  if (escape.terminal) return;
  if (!App.porter) rover.updateVisuals(dt, ctl);

  /* ---- tracks + dust from the wheels ---- */
  let slipSum = 0, spinMax = 0, roughSum = 0, contacts = 0;
  for (const w of App.porter || controlsLocked ? [] : rover.wheels) {
    spinMax = Math.max(spinMax, Math.abs(w.spinVel));
    if (!w.contact) { w.lastGround.copy(w.worldPos); continue; }
    contacts++;
    slipSum += w.slipLong + w.slipLat;
    roughSum += Math.min(Math.abs(w.compVel) * 0.30, 1);
    // A suspension stop taking a hit is a discrete event, not part of a bed —
    // give it its own transient, panned to the side the wheel is on.
    if (w.compVel > 1.9 && (w._clunk || 0) <= 0) {
      audio.clunk((w.compVel - 1.9) * 0.30, w.side * 0.45);
      w._clunk = 0.22;
    }
    w._clunk = Math.max(0, (w._clunk || 0) - dt);
    const gx = w.worldPos.x, gz = w.worldPos.z;
    const dx = gx - w.lastGround.x, dz = gz - w.lastGround.z;
    const moved = Math.hypot(dx, dz);
    if (moved > 0.10) {
      // One pass must already read as a track; repeats deepen it toward black.
      const strength = clamp(0.52 + w.load / 900 * 0.26 + w.slipLong * 0.30, 0, 0.95);
      terrain.addTrack(w.lastGround.x, w.lastGround.z, gx, gz, 0.44, strength);
      // The rut is real geometry, not a decal: sinkage sets the depth, and the
      // regolith the wheel pushes down comes back up as berms on both flanks.
      const depth = Math.min(0.115, 0.045 + w.sink * 2.0 + w.slipLong * 0.06);
      const steps = Math.min(6, Math.ceil(moved / 0.12));
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        terrain.rut(w.lastGround.x + dx * f, w.lastGround.z + dz * f, 0.26, depth, 0);
      }
      w.lastGround.set(gx, w.worldPos.y, gz);
    }
    // Wheelspin excavates. Keep the throttle down in soft ground and you will
    // dig a hole and drop into it, exactly as you would on the real thing.
    if (w.slipLong > 0.22 && Math.abs(rover.speed) < 2.4) {
      terrain.rut(gx, gz, 0.27, 0.06, (w.slipLong - 0.18) * dt * 0.42);
    }
    /* Rooster tails. The grousers fling regolith whether or not the wheel is
       slipping, and at 1/6 g it arcs for twenty metres before it lands — the
       single most recognisable thing about driving on the Moon. */
    const surf = Math.abs(w.spinVel) * 0.335;
    const slip = w.slipLong;
    if (surf > 0.8 && contacts > 0) {
      const rate = (surf * 3.4 + slip * 55) * dt;
      let n = Math.floor(rate);
      if (Math.random() < rate - n) n++;
      if (n > 0) {
        const f = rover.forward;
        const sgn = Math.sign(w.spinVel) || 1;
        dust.spawn(Math.min(n, 4), gx, w.worldPos.y - 0.26, gz,
          0.30 + surf * 0.16 + slip * 1.7, 0.20, -f.x * sgn, -f.z * sgn);
      }
    }
  }
  const speed = rover.vel.length();

  /* ---- lighting the rover: is it in a crater shadow? ---- */
  if (!App._sunVisT || App.elapsed - App._sunVisT > 0.18) {
    App._sunVisT = App.elapsed;
    App._sunVisTarget = terrain.sunVis(rover.pos.x, rover.pos.z, App.lightDir);
    props.padLight = 1 - terrain.sunVis(HOME.x, HOME.z, App.lightDir);
  }
  rover.sunVis = lerp(rover.sunVis, App._sunVisTarget ?? 1, Math.min(1, dt * 3));
  // Macro terrain occlusion is applied locally by each model's material. A
  // rover entering a crater must not dim the lights on every distant building.
  engine.sun.intensity = App.keyIntensity;

  /* ---- hand three's directional shadow map to the terrain shader ----
     The terrain is a custom material, so it is invisible to the built-in
     shadow plumbing; without this the rover and every boulder float. */
  const sh = engine.sun.shadow;
  if (engine.sun.castShadow && sh.map) {
    terrain.uniforms.uRShadow.value = sh.map.texture;
    // Three updates this matrix in place before the current shadow pass.
    // Keep the live reference so terrain never samples it one frame behind.
    terrain.uniforms.uRShadowMat.value = sh.matrix;
    terrain.uniforms.uRShadowTexel.value = 1 / sh.mapSize.x;
    terrain.uniforms.uRShadowOn.value = 1;
  } else terrain.uniforms.uRShadowOn.value = 0;

  /* ---- headlight cone into the terrain shader ---- */
  const lampPos = _v.copy(rover.pos).addScaledVector(rover.forward, 1.1).addScaledVector(rover.up, 0.62);
  terrain.uniforms.uLamp.value.copy(lampPos);
  terrain.uniforms.uLampDir.value.copy(rover.forward).addScaledVector(rover.up, -0.30).normalize();
  terrain.uniforms.uLampPow.value = rover.lampPower;
  terrain.uniforms.uLampHigh.value = rover.highBeamPower;

  /* ---- world systems ---- */
  dust.update(dt);
  ctl.interactionLocked = controlsLocked;
  game.update(dt, ctl, controlsLocked ? NO_INTERACTION : input);
  delivery.update(dt, controlsLocked ? { throttle: 0 } : raw, controlsLocked ? NO_INTERACTION : input);
  if (escape.terminal) return;
  escape.update(dt,{paused:controlsLocked,holdingHome:delivery.holdingHome});
  if (escape.terminal) return;
  glass.update(dt);
  // Delivery can start the event in this tick, after controls were read.
  if (escape.cinematicActive && !escapeCamera.active) escapeCamera.start();
  rig.update(dt, rover, {
    lookX: raw.lookX, lookY: raw.lookY, zoom: raw.zoom, looking: raw.looking,
    boost: input.down('ShiftLeft', 'ShiftRight'),
    up: input.down('KeyQ'), down: input.down('KeyZ')
  }, photo ? { throttle: raw.throttle, steer: raw.steer } : { throttle: 0, steer: 0 });
  rupture.update(dt);
  escapeCamera.update(dt);
  rupture.updateCinematic?.(dt);
  // Camera-centred terrain/LOD and the sky must follow the final cinematic
  // camera in the same frame, not the chase camera from the previous frame.
  syncSun();
  terrain.update(dt, engine.camera, App.lightDir);
  sky.update(dt, engine.camera, App.elapsed);
  haze.update(dt, engine.camera, App.elapsed);
  props.update(dt, App.elapsed, engine.camera);
  App.starfall.shakeCamera(engine.camera);
  const shadowFocus=escapeCamera.active
    ? _v.copy(escapeCamera.look).lerp(rover.pos,escapeCamera.ending
      ? sstep(0,DIMENSIONAL_RETURN_SECONDS,escapeCamera.returnElapsed) : 0) : rover.pos;
  engine.aimShadow(shadowFocus, App.lightDir);
  terrain.syncPracticalLights?.(rover.headlightSources?.[0], props.stationGroundLight);

  /* ---- audio mix ---- */
  audio.update(dt, {
    wheelSpin: spinMax, motorLoad: rover.motorLoad, speed,
    slip: clamp(slipSum / 6, 0, 1), rough: clamp(roughSum / 6, 0, 1),
    drilling: game.drill.active, contacts, alarm: Math.max(game.dangerTone, rupture.tension),
    quake: App.starfall.audioState(audio),
    maxSpeed: rover.driveMaxSpeed, spinRef: rover.spinRef
  });
  audio.musicTick(App.elapsed, Math.max(game.dangerTone, rupture.tension));

  /* ---- post ---- */
  engine.final.uniforms.uGlitch.value = Math.max(0,
    engine.final.uniforms.uGlitch.value - dt * 2.2);
  engine.final.uniforms.uGlitch.value = Math.max(
    engine.final.uniforms.uGlitch.value, rupture.interference * (0.35 + Math.random() * 0.65)
  );
  if (game.hull < 40) engine.final.uniforms.uGlitch.value =
    Math.max(engine.final.uniforms.uGlitch.value, (1 - game.hull / 40) * 0.10 * Math.random());
  // Normal exploration stays clean. Noise now communicates a real event:
  // an active terrain sweep, delayed command traffic, or a failing chassis.
  const scanNoise = delivery.scan.active ? 0.24 : 0;
  const signalNoise = App.settings.comms && App.cmdInFlight > 0 ? 0.07 : 0;
  const damageNoise = game.hull < 55 ? (1 - game.hull / 55) * 0.34 : 0;
  // The flower tide is intentionally absent here: its motion lives in the
  // world geometry and must not modulate the whole camera image. Sensor noise
  // is reserved for scan, delayed communications and real chassis damage.
  const eventNoise = Math.max(scanNoise, signalNoise, damageNoise);
  const grainTarget = clamp(App.settings.grain + eventNoise, 0, 1);
  engine.final.uniforms.uGrain.value = lerp(engine.final.uniforms.uGrain.value,
    grainTarget, Math.min(1, dt * (eventNoise > 0 ? 10 : 4.5)));
  const solarDaylight = sstep(-0.07, 0.10, sky.sunDir.y);
  const nightState = (1 - solarDaylight) * (1 - rupture.moonPresence);
  const nightCameraLift = nightState * 0.14;
  engine.final.uniforms.uNightLift.value = lerp(
    engine.final.uniforms.uNightLift.value, nightState, Math.min(1, dt * 1.5));
  engine.final.uniforms.uExposure.value = lerp(engine.final.uniforms.uExposure.value,
    1.36 + nightCameraLift + (1 - rover.sunVis) * 0.10 + rupture.exposureOffset,
    Math.min(1, dt * 0.75));
  engine.final.uniforms.uFlash.value = lerp(
    engine.final.uniforms.uFlash.value, rupture.flash, Math.min(1, dt * 12)
  );

  hud.update(dt, game, rover, sky, rig);
  if(escape.active) {
    engine.final.uniforms.uGlitch.value=0;
    engine.final.uniforms.uFlash.value=0;
    engine.final.uniforms.uGrain.value=0;
  }
  delivery.syncHud();

  /* ---- autosave ---- */
  if (App._escapeSavePending || !App._saveT || App.elapsed - App._saveT > 20) {
    App._saveT = App.elapsed; App._escapeSavePending = false; Save.write(saveState());
  }
}

/** Hold a readable 3.2° opening, then cross sunset into true Martian night.
    Game mission time is used instead of wall-clock time, so menus and pauses
    cannot spend the player's remaining daylight. */
const TWILIGHT_SECONDS = 30;
function sunAltitude(missionSeconds) {
  const descent = sstep(0, TWILIGHT_SECONDS,
    clamp(missionSeconds, 0, TWILIGHT_SECONDS));
  return THREE.MathUtils.degToRad(lerp(3.2, -8.5, descent));
}

function syncSun() {
  const { sky, terrain, engine } = App;
  const moonLo = clamp(sstep(-0.02, 0.10, sky.anomalyMoonDir.y), 0, 1);
  const moonPresence = App.rupture?.moonPresence ?? 0;
  const eventBlend = sstep(0.05, 0.78, moonPresence) * moonLo;
  App.lightDir.copy(sky.sunDir).lerp(sky.anomalyMoonDir, eventBlend).normalize();
  terrain.uniforms.uSunDir.value.copy(App.lightDir);
  terrain.uniforms.uEarthDir.value.copy(sky.earthDir);
  const daylight = sstep(-0.07, 0.10, sky.sunDir.y);
  // Only the gain changes; the broad reflection environment is pre-baked once.
  if (terrain.uniforms.uMeshEnvGain) {
    terrain.uniforms.uMeshEnvGain.value = 0.55 + daylight * 0.45 + moonPresence * 0.30;
  }
  const sunEnergy = 0.72 * daylight * (1 - eventBlend * 0.78);
  const moonKey = App.rupture?.moonKeyStrength ?? 0;
  const moonEnergy = moonKey * moonLo;
  terrain.uniforms.uSunCol.value.set(
    1.75 * sunEnergy + 2.40 * moonEnergy,
    1.16 * sunEnergy + 2.46 * moonEnergy,
    0.78 * sunEnergy + 2.52 * moonEnergy
  );
  engine.sun.color.setRGB(
    lerp(1.0, 0.80, eventBlend),
    lerp(0.64, 0.88, eventBlend),
    lerp(0.42, 0.92, eventBlend)
  );
  engine.sun.position.copy(App.lightDir).multiplyScalar(100);
  App.keyIntensity = 1.30 * sunEnergy + 2.60 * moonEnergy;
  engine.sun.intensity = App.keyIntensity;
  // Unlike the headlights and facility lamps, natural fill dies with the sun.
  // A trace remains for eye adaptation; the anomalous moon restores a cold fill.
  engine.fill.intensity = lerp(0.095, 0.54, daylight) + moonPresence * 0.06;
  engine.silverFill.intensity = 0.035 + moonPresence * 0.265;
  terrain.uniforms.uAmbient.value.set(
    lerp(0.014, 0.088, daylight) + moonPresence * 0.018,
    lerp(0.014, 0.052, daylight) + moonPresence * 0.026,
    lerp(0.021, 0.045, daylight) + moonPresence * 0.034
  );
  terrain.uniforms.uEarthCol.value.set(
    lerp(0.012, 0.138, daylight),
    lerp(0.009, 0.071, daylight),
    lerp(0.014, 0.055, daylight)
  );
  if (App.props) App.props.globalKeyStrength = clamp((sunEnergy + moonEnergy) / 0.72, 0, 1);
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const NO_INTERACTION = Object.freeze({ down: () => false, hit: () => false });

/* ============================================================ */
addEventListener('error', (e) => {
  const t = $('loadtext');
  if (t && !$('boot').classList.contains('hidden')) {
    t.textContent = '链路故障 · 请刷新页面后重试';
    t.style.color = '#ff5f56';
  }
  console.error(e.error || e.message);
});

boot().catch((err) => {
  console.error(err);
  const t = $('loadtext');
  if (t) { t.textContent = '链路故障 · 请刷新页面后重试'; t.style.color = '#ff5f56'; }
});

void PLAYABLE_R; void QUALITY; void Props;
