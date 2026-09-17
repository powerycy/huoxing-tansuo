import { drawFlowerArchiveCue } from '../src/ui/flower-archive.js';

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
let seenCinema = false;
let frames = 0;
let dtSum = 0;
let station = null;
let chargePad = null;
let eventStartAt = 0;
let chargeStartAt = 0;
let lastStatusUpdate = 0;
let phaseStartedAt = 0;
let tapChargeT = false;

const status = text => { $('status').textContent = text; };
const fmt = n => (Math.round((Number(n) || 0) * 10) / 10).toFixed(1);

function resize() {
  const s = innerWidth / 1920;
  frame.style.transform = `scale(${s})`;
  $('view').style.height = `${1080 * s}px`;
}

function dist2d(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.hypot(dx, dz);
}

addEventListener('resize', resize);
resize();

$('prepare').onclick = async () => {
  try {
    app = frame.contentWindow.REGOLITH;
    if (!app?.startGame || !app?.rover) throw Error('游戏尚未加载完，请稍候再准备');

    app.startGame(false, false);
    await app.audio.ctx.resume();

    station = app.delivery?.station;
    // The take starts at the flower trigger pad (Ares VI). After the locked
    // flower sequence, the rover is placed directly on the relay's flower
    // playback/charging pad for the T interaction; no origin-to-event drive
    // is included in the recording.
    const triggerPad = app.props?.stationChargePoint || station;
    chargePad = app.props?.relayChargePoint || triggerPad;

    if (!station) throw Error('未读取到花海目标点');

    // 已经在花海出发点附近了，只保留“按E触发→事件播放→按T充电”。
    const yaw = Math.atan2(station.x - triggerPad.x, station.z - triggerPad.z);
    app.rover.placeAt(triggerPad.x, triggerPad.z, yaw);
    if (app.rig?.mode != null) {
      app.rig.pitch = 0.14;
      app.rig.yaw = yaw + Math.PI;
      app.rig.setMode(app.rig.mode, app.rover);
    }
    app.rig?.setYaw?.(yaw + Math.PI);

    app.input.keys.clear();
    app.input.pressed.clear();

    originalPoll = app.input.poll.bind(app.input);

    app.input.poll = () => {
      const out = originalPoll();
      out.throttle = 0;
      out.steer = 0;
      out.brake = 1;
      out.boost = false;

      if (!recording) return out;

      const speed = app.rover.vel.length();
      const dStation = dist2d(app.rover.pos.x, app.rover.pos.z, station.x, station.z);
      const dCharge = chargePad
        ? dist2d(app.rover.pos.x, app.rover.pos.z, chargePad.x, chargePad.z)
        : 1e9;
      app.input.keys.delete('KeyT');

      if (phase === 'interact') {
        out.throttle = 0;
        out.brake = 1;
        app.input.keys.add('KeyE');
        app.input.pressed.delete('KeyE');
        // 一直按住 E：恢复基地供电，随后进入 relay 并触发花海。
        app.input.keys.add('KeyE');
        if (app.delivery?.stage === 'relay' || app.delivery?.stationRecovered || app.rupture?.phase !== 'dormant') {
          app.input.keys.delete('KeyE');
          phase = 'wait-cinematic';
          seenCinema = false;
          eventStartAt = performance.now();
          phaseStartedAt = eventStartAt;
        }

        if (performance.now() - phaseStartedAt > 24000) {
          // 防止意外卡住：强制尝试进入事件
          app.input.keys.delete('KeyE');
          app.rupture?.trigger?.();
          phase = 'wait-cinematic';
          seenCinema = app.rupture?.phase !== 'dormant';
          eventStartAt = performance.now();
          phaseStartedAt = eventStartAt;
        }
      }

      if (phase === 'wait-cinematic') {
        // avoid immediate timeout if event not launched yet
        if (app.rupture?.phase !== 'dormant') seenCinema = true;
        if (app.rupture?.cinematicActive) seenCinema = true;

        if (seenCinema && !app.rupture?.cinematicActive) {
          // The requested take cuts straight to the flower playback point.
          // Put the rover on the relay induction ring instead of recording a
          // second driving segment between the event and the charge cue.
          const chargeYaw = Math.atan2(station.x - chargePad.x, station.z - chargePad.z);
          app.rover.placeAt(chargePad.x, chargePad.z, chargeYaw);
          app.rover.vel.set(0, 0, 0);
          phase = 'charge';
          phaseStartedAt = performance.now();
          chargeStartAt = performance.now();
          tapChargeT = true;
          // The cinematic lock is still applied for this frame. Defer the T
          // edge to the next poll so gameplay.update receives an enabled input.
          return out;
        }

        if (!seenCinema && performance.now() - eventStartAt > 6000) {
          const chargeYaw = Math.atan2(station.x - chargePad.x, station.z - chargePad.z);
          app.rover.placeAt(chargePad.x, chargePad.z, chargeYaw);
          app.rover.vel.set(0, 0, 0);
          phase = 'charge';
          phaseStartedAt = performance.now();
          chargeStartAt = performance.now();
          tapChargeT = true;
          return out;
        }
      }

      if (phase === 'charge') {
        out.throttle = 0;
        out.brake = 1;
        app.input.keys.add('KeyT');
        if (tapChargeT) {
          app.input.pressed.add('KeyT');
          tapChargeT = false;
        }

        if (app.power >= 99.9 || app.game?.charging) {
          if (!chargeStartAt) chargeStartAt = performance.now();
        }

        if (chargeStartAt && performance.now() - chargeStartAt > 18000 && app.power >= 99.7) {
          phase = 'done';
          endedAt = performance.now();
        }

        if (performance.now() - phaseStartedAt > 26000 && app.power > 0) {
          phase = 'done';
          endedAt = performance.now();
        }

        if (app.power >= 99.9 && app.game?.charging) {
          phase = 'done';
          endedAt = performance.now();
          out.throttle = 0;
        }
      }

      return out;
    };

    const render = app.engine.render.bind(app.engine);
    app.engine.render = dt => {
      render(dt);
      if (!recording) return;

      ctx.drawImage(app.engine.renderer.domElement, 0, 0, canvas.width, canvas.height);
      drawFlowerArchiveCue(ctx, app.flowerArchive?.current, canvas.width, canvas.height);
      frames++;
      dtSum += dt;

      if (phase === 'wait-cinematic') {
        if (app.rupture?.cinematicActive) seenCinema = true;
        if (seenCinema && !app.rupture?.cinematicActive) endedAt = performance.now();
      }

      if (phase === 'done' && performance.now() - endedAt > 3000) stop();
    };

    prepared = true;
    $('prepare').disabled = true;
    $('record').disabled = false;
    status('已配置为：已到花海触发点 → 自动按E触发花海事件 → 事件结束后直接按T充电。点击“开始录制完整花海”。');
  } catch (e) {
    status(String(e));
  }
};

$('record').onclick = async () => {
  try {
    if (!prepared) return;
    await app.audio.ctx.resume();

    const dest = app.audio.ctx.createMediaStreamDestination();
    const comp = app.audio.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 5;
    comp.attack.value = .004;
    comp.release.value = .22;

    app.audio.master.connect(comp);
    comp.connect(dest);

    const stream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));

    const mime = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(x => MediaRecorder.isTypeSupported(x));

    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16000000, audioBitsPerSecond: 192000 });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      status('录制完成，正在保存原片…');
      try {
        const response = await fetch('/__recording', { method: 'POST', body: new Blob(chunks, { type: mime }) });
        if (!response.ok) throw Error('保存失败');
        const result = await response.json();
        status(`已保存：${result.file}\n时长 ${((performance.now() - began) / 1000).toFixed(1)} 秒，${frames} 个实际画面，游戏时长 ${dtSum.toFixed(1)} 秒`);
        app.audio.master.disconnect(comp);
        comp.disconnect();
        stream.getTracks().forEach(t => t.stop());
      } catch (e) {
        status(String(e));
      }
    };

    frames = 0;
    dtSum = 0;
    seenCinema = false;
    endedAt = 0;
    began = performance.now();
    phase = 'interact';
    phaseStartedAt = began;
    chargeStartAt = 0;
    tapChargeT = false;
    recording = true;
    app.input.keys.delete('KeyE');
    app.input.keys.delete('KeyT');
    recorder.start(1000);
    $('record').disabled = true;
    $('stop').disabled = false;
  } catch (e) {
    status(String(e));
  }
};

function stop() {
  if (!recording) return;
  recording = false;
  app.input.keys.delete('KeyE');
  app.input.keys.delete('KeyT');
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
    status(`录制中 ${(now - began) / 1000 | 0} 秒 · ${phase} · ${app?.rupture?.phase || 'dormant'} ${fmt(app?.rupture?.phaseT)}\n` +
      `距离站点 ${fmt(dist2d(app.rover.pos.x, app.rover.pos.z, station.x, station.z))} 米 · 距离充电口 ${fmt(dist2d(app.rover.pos.x, app.rover.pos.z, chargePad.x, chargePad.z))} 米 · 速度 ${fmt(app.rover.vel.length())} · ${frames} 帧`);
  }
  if (now - began > 240000) stop();
}, 1000);
