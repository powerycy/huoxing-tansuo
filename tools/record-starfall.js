const $ = id => document.getElementById(id);
const frame = $('game');
const canvas = $('capture');
const ctx = canvas.getContext('2d', { alpha: false });

let app;
let prepared = false;
let recording = false;
let originalPoll;
let recorder;
let phase = 'idle';
let began = 0;
let endedAt = 0;
let frames = 0;
let dtSum = 0;
let routeIndex = 1;
let tappedDock = false;
let lastStatusUpdate = 0;
let stream;
let audioNodes;
let steeringError = 0;
let targetDistance = 0;

const status = text => { $('status').textContent = text; };
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function resize() {
  const s = innerWidth / 1920;
  frame.style.transform = `scale(${s})`;
  $('view').style.height = `${1080 * s}px`;
}

function resetKeys() {
  for (const key of ['KeyE', 'KeyW', 'KeyA', 'KeyD', 'Space', 'ShiftLeft']) app.input.keys.delete(key);
}

function configureSecondEvent() {
  app.escape.reset();
  app.rupture.debugPhase('scar');
  app.delivery.load({
    version: 4, stage: 'relay', delivered: false, transmitted: false,
    cargoState: 'rover', integrity: 100, stationRecovered: true, firstScan: true
  });
  const relay = app.delivery._target();
  const home = app.escape.home;
  const length = Math.max(0.001, distance(relay, home));
  const axis = { x: (home.x - relay.x) / length, z: (home.z - relay.z) / length };
  // Start on the relay-facing edge of the docking zone. This is close enough
  // for the production E interaction without putting the chassis inside the mast.
  const start = { x: relay.x + axis.x * 5.2, z: relay.z + axis.z * 5.2 };
  const yaw = Math.atan2(axis.x, axis.z);
  app.rover.placeAt(start.x, start.z, yaw);
  app.rover.headlights = true;
  app.rover.highBeams = false;
  app.rover.lampPower = 1;
  app.rig.yaw = yaw + Math.PI;
  app.rig.pitch = 0.14;
  app.rig.dist = 12.2;
  app.rig.lookIdle = 0;
  app.rig.setMode(0, app.rover);
  app.game.power = 100;
  resetKeys();
  app.input.pressed.clear();
}

function steerAlongRoute(out) {
  const rover = app.rover;
  const home = app.escape.home;
  const route = app.fold.route || [];
  const homeDistance = distance(rover.pos, home);
  const speed = rover.vel.length();

  if (homeDistance < 10.0) {
    out.throttle = 0;
    out.steer = 0;
    out.boost = false;
    out.brake = 1;
    if (speed < 0.58) app.input.keys.add('KeyE');
    return;
  }

  app.input.keys.delete('KeyE');
  while (routeIndex < route.length - 1 && distance(rover.pos, route[routeIndex]) < Math.max(11, speed * 0.62)) routeIndex++;
  const lookAhead = clamp(Math.floor(speed / 7), 0, 3);
  const target = route.length ? route[Math.min(route.length - 1, routeIndex + lookAhead)] : home;
  const desired = Math.atan2(target.x - rover.pos.x, target.z - rover.pos.z);
  const heading = Math.atan2(rover.forward.x, rover.forward.z);
  const error = wrapAngle(desired - heading);
  steeringError = error;
  targetDistance = distance(rover.pos, target);

  // The rover's positive input steers its physical front hubs toward local -X,
  // therefore its yaw response has the opposite sign to the world yaw error.
  out.steer = clamp(-error * 1.65, -1, 1);
  out.brake = 0;
  out.throttle = Math.abs(error) > 1.12 ? 0.22 : Math.abs(error) > 0.62 ? 0.58 : 1;
  out.boost = Math.abs(error) < 0.72 && homeDistance > 28;

  // Arrive on camera instead of crossing the mother-port ring at 40 m/s.
  if (homeDistance < 34) {
    out.boost = false;
    out.throttle = speed > 8 ? 0 : 0.42;
    out.brake = speed > 9 ? 0.55 : 0;
  }
  if (homeDistance < 17) {
    // Do not ask the hill-hold brake and the motors to fight each other: the
    // mother-port goal is deliberately nine metres from its solid centre, so
    // the last few metres need a clean, slow creep before the final stop.
    out.throttle = speed < 2.4 ? 0.34 : 0;
    out.brake = speed > 2.4 ? 0.9 : 0;
  }
}

addEventListener('resize', resize);
resize();

$('prepare').onclick = async () => {
  try {
    app = frame.contentWindow.REGOLITH;
    if (!app?.startGame || !app?.rover || !app?.delivery || !app?.escape) throw Error('游戏尚未加载完，请稍候再准备');
    app.startGame(false, false);
    await app.audio.ctx.resume();
    configureSecondEvent();

    originalPoll = app.input.poll.bind(app.input);
    app.input.poll = () => {
      const out = originalPoll();
      out.throttle = 0;
      out.steer = 0;
      out.brake = 1;
      out.boost = false;
      out.lookX = out.lookY = out.zoom = 0;
      out.looking = false;
      if (!recording) return out;

      if (phase === 'dock') {
        if (!tappedDock) {
          app.input.keys.add('KeyE');
          app.input.pressed.add('KeyE');
          tappedDock = true;
        }
        if (app.delivery.stage === 'return' && app.escape.active) {
          app.input.keys.delete('KeyE');
          phase = 'cinematic';
        }
      } else if (phase === 'cinematic') {
        if (!app.escape.cinematicActive && !app.escapeCamera?.active) {
          phase = 'escape';
          routeIndex = 1;
        }
      } else if (phase === 'escape') {
        steerAlongRoute(out);
        if (app.delivery.stage === 'complete' || app.escape.phase === 'complete') {
          resetKeys();
          phase = 'done';
          endedAt = performance.now();
        } else if (app.escape.phase === 'failed') {
          resetKeys();
          phase = 'failed';
          endedAt = performance.now();
        }
      }
      return out;
    };

    const render = app.engine.render.bind(app.engine);
    app.engine.render = dt => {
      render(dt);
      if (!recording) return;
      ctx.drawImage(app.engine.renderer.domElement, 0, 0, canvas.width, canvas.height);
      frames++;
      dtSum += dt;
      if ((phase === 'done' || phase === 'failed') && performance.now() - endedAt > 4500) stop();
    };

    prepared = true;
    $('prepare').disabled = true;
    $('record').disabled = false;
    status('已准备：孤寂中站对接 → 蓝光与异常星空 → 地裂追击 → 母港上传。\n点击“开始录制第二大事件”。');
  } catch (error) {
    status(String(error));
  }
};

$('record').onclick = async () => {
  try {
    if (!prepared) return;
    configureSecondEvent();
    await app.audio.ctx.resume();
    const dest = app.audio.ctx.createMediaStreamDestination();
    const comp = app.audio.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    app.audio.master.connect(comp);
    comp.connect(dest);
    audioNodes = { dest, comp };

    stream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    const mime = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 18000000, audioBitsPerSecond: 192000 });
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      status('录制完成，正在保存原片…');
      try {
        const response = await fetch('/__starfall-recording', { method: 'POST', body: new Blob(chunks, { type: mime }) });
        if (!response.ok) throw Error('保存失败');
        const result = await response.json();
        status(`已保存：${result.file}\n时长 ${((performance.now() - began) / 1000).toFixed(1)} 秒，${frames} 个实际画面，游戏时长 ${dtSum.toFixed(1)} 秒`);
      } catch (error) {
        status(String(error));
      } finally {
        app.audio.master.disconnect(audioNodes.comp);
        audioNodes.comp.disconnect();
        stream.getTracks().forEach(track => track.stop());
      }
    };

    frames = 0;
    dtSum = 0;
    endedAt = 0;
    began = performance.now();
    phase = 'dock';
    routeIndex = 1;
    tappedDock = false;
    recording = true;
    recorder.start(1000);
    $('record').disabled = true;
    $('stop').disabled = false;
  } catch (error) {
    status(String(error));
  }
};

function stop() {
  if (!recording) return;
  recording = false;
  resetKeys();
  app.input.pressed.clear();
  if (originalPoll && app?.input) app.input.poll = originalPoll;
  recorder.stop();
  $('stop').disabled = true;
}

$('stop').onclick = stop;

setInterval(() => {
  if (!recording) return;
  const now = performance.now();
  if (now - lastStatusUpdate > 500) {
    lastStatusUpdate = now;
    const home = app.escape.home;
    const route = app.fold.route || [];
    status(`录制中 ${Math.floor((now - began) / 1000)} 秒 · ${phase}\n` +
      `事件 ${app.escape.phase} · 镜头 ${app.escape.introElapsed.toFixed(1)} / ${app.escape.introDuration.toFixed(1)} 秒 · ` +
      `母港 ${distance(app.rover.pos, home).toFixed(1)} 米 · 安全间距 ${app.escape.gap.toFixed(1)} 米 · ` +
      `路点 ${routeIndex}/${Math.max(0, route.length - 1)} · 速度 ${app.rover.vel.length().toFixed(1)} · ` +
      `转向误差 ${(steeringError * 180 / Math.PI).toFixed(0)}° · 目标 ${targetDistance.toFixed(1)} 米 · ${frames} 帧`);
  }
  if (now - began > 180000) stop();
}, 1000);
