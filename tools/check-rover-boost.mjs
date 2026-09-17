// Run: node tools/check-rover-boost.mjs
// CPU-only regression: the real six-wheel solver on ideal, static surfaces.
// This does not promise escape from every rock collision, vertical hole or
// deforming rut in the playable terrain, and is not a visual/gameplay test.
import assert from 'node:assert/strict';
import { register } from 'node:module';

const project = new URL('../', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(s, c, next) {
    if (s === 'three') return { url: new URL('vendor/three/three.module.js', '${project}').href, shortCircuit: true };
    if (s.startsWith('three/addons/')) return { url: new URL('vendor/three/examples/jsm/' + s.slice(13), '${project}').href, shortCircuit: true };
    return next(s, c);
  }
`), import.meta.url);

const THREE = await import('three');
const { Rover, DRIVE, POWER_FLOOR, POWER_KNEE } = await import('../src/game/rover.js');
const { Game } = await import('../src/game/gameplay.js');
const { Input } = await import('../src/core/input.js');

// Skip only material/model creation; constructor physics state and step are
// unchanged. Test overrides never affect the game running in the browser.
Rover.prototype.build = function () {};
Rover.prototype.loadMoonRoverExterior = function () { return Promise.resolve(); };
const idle = { throttle: 0, steer: 0, brake: 1, tc: true, boost: false };
const drive = { throttle: 1, steer: 0, brake: 0, tc: true, boost: true };

function terrain(fn) {
  return {
    heightAt: fn,
    normalAt(x, z, e, out) {
      return out.set(-(fn(x + e, z) - fn(x - e, z)) / (2 * e), 1,
        -(fn(x, z + e) - fn(x, z - e)) / (2 * e)).normalize();
    }
  };
}
function create(fn = () => 0, power = 34) {
  const t = terrain(fn), r = new Rover(t, new THREE.Scene());
  r.placeAt(0, 0);
  // A uniform-grade test starts facing along its surface; dropping the level
  // chassis into a 55° plane instead creates an unrelated spawn collision.
  const normal = t.normalAt(0, 0, 0.3, new THREE.Vector3());
  r.quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  r.powerScale = POWER_FLOOR + (1 - POWER_FLOOR) * Math.min(1, power / POWER_KNEE);
  for (let i = 0; i < 240; i++) r.step(1 / 120, idle, t);
  // Remove any rollback left by the finite grip of the parking brake so each
  // measured run proves a start from rest, without approach momentum.
  r.vel.set(0, 0, 0); r.omega.set(0, 0, 0);
  for (const w of r.wheels) w.spinVel = 0;
  return { r, t };
}
function simulate(fn, boost, seconds = 12, power = 34, hz = 120, throttle = 1) {
  const { r, t } = create(fn, power);
  const startZ = r.pos.z, startY = r.pos.y;
  let maxSlip = 0, minAlignment = 1;
  const normal = new THREE.Vector3();
  for (let i = 0; i < seconds * hz; i++) {
    r.step(1 / hz, { ...drive, boost, throttle }, t);
    maxSlip = Math.max(maxSlip, ...r.wheels.map(w => w.slipLong));
    t.normalAt(r.pos.x, r.pos.z, 0.3, normal);
    minAlignment = Math.min(minAlignment, r.up.dot(normal));
    assert.ok(r.pos.toArray().every(Number.isFinite));
    assert.ok(r.quat.toArray().every(Number.isFinite));
    assert.ok(Math.abs(r.quat.length() - 1) < 1e-6);
  }
  return {
    distance: +((r.pos.z - startZ) * Math.sign(throttle)).toFixed(2), height: +(r.pos.y - startY).toFixed(2),
    speed: +r.speed.toFixed(2), upright: +r.up.y.toFixed(3),
    alignment: +minAlignment.toFixed(3), maxSlip: +maxSlip.toFixed(3), boost: r.boostBlend
  };
}

const results = [];
for (const slope of [0, 15, 25, 30, 35, 45, 50, 55]) {
  const fn = (x, z) => Math.tan(slope * Math.PI / 180) * z;
  const row = { surface: `${slope} degree uniform slope`, base: simulate(fn, false), boost: simulate(fn, true) };
  assert.ok(row.boost.distance > row.base.distance + 5, `${slope} degree grade must benefit`);
  assert.ok(row.boost.alignment > 0.90, `${slope} degree grade must stay aligned to the surface`);
  results.push(row);
}
const hollow = (x, z) => -8 * Math.cos(Math.min(1, Math.abs(z) / 20) * Math.PI / 2);
const bowl = { surface: '8m deep / 20m half-width smooth hollow', base: simulate(hollow, false, 16), boost: simulate(hollow, true, 16) };
assert.ok(bowl.boost.distance > 20 && bowl.boost.distance > bowl.base.distance);
assert.ok(bowl.boost.maxSlip < bowl.base.maxSlip);
results.push(bowl);
const reserve = { surface: '5% reserve / flat', base: simulate(() => 0, false, 6, 5), boost: simulate(() => 0, true, 6, 5) };
assert.deepEqual(reserve.base, reserve.boost, 'reserve must retain precisely the base drive');
results.push(reserve);
const reserveSlope = (x, z) => Math.tan(35 * Math.PI / 180) * z;
assert.deepEqual(simulate(reserveSlope, false, 6, 5), simulate(reserveSlope, true, 6, 5));
const noBattery = simulate(() => 0, true, 6, 0);
assert.equal(noBattery.boost, 0);
assert.ok(noBattery.distance > 0, 'empty pack must retain base crawl');
const chargeSlope = (x, z) => Math.tan(45 * Math.PI / 180) * z;
const reduced = simulate(chargeSlope, true, 12, 8), full = simulate(chargeSlope, true, 12, 12);
assert.ok(reduced.boost > 0 && reduced.boost < 1, 'boost must fade between 5% and 12%');
assert.equal(full.boost, 1, '12% pack enables full boost');
assert.ok(full.distance > 20 && full.distance > reduced.distance);

const frameRates = [];
for (const hz of [30, 60]) {
  const flatBase = simulate(() => 0, false, 20, 34, hz);
  const flatBoost = simulate(() => 0, true, 20, 34, hz);
  assert.ok(flatBoost.speed > flatBase.speed * 1.35, 'Shift must give a strong cruise-speed gain');
  assert.ok(flatBoost.speed <= DRIVE.maxSpeed * 1.38, 'flat boost must respect its speed envelope');
  assert.ok(flatBoost.alignment > 0.99 && flatBoost.maxSlip < 0.10);
  frameRates.push({ hz, degrees: 0, baseSpeed: flatBase.speed, boostSpeed: flatBoost.speed });
  for (const degrees of [35, 45, 55]) {
    const slope = (x, z) => Math.tan(degrees * Math.PI / 180) * z;
    const baseline = simulate(slope, false, 12, 34, hz);
    const boosted = simulate(slope, true, 12, 34, hz);
    const reference = results.find(row => row.surface.startsWith(`${degrees} degree`)).boost;
    assert.ok(boosted.distance > 20 && boosted.distance > baseline.distance + 15);
    assert.ok(boosted.alignment > 0.95);
    assert.ok(Math.abs(boosted.distance - reference.distance) < reference.distance * 0.10,
      `${degrees}° climbing distance must be consistent at ${hz}Hz`);
    frameRates.push({ hz, degrees, distance: boosted.distance, speed: boosted.speed });
  }
}

// Reverse uses the commanded travel direction, including when pulling out of
// a hollow backwards. The default +Z heading now points down the test grade.
for (const hz of [30, 60, 120]) {
  const reverseSlope = (x, z) => -Math.tan(55 * Math.PI / 180) * z;
  const reverse = simulate(reverseSlope, true, 12, 34, hz, -1);
  assert.ok(reverse.distance > 20 && reverse.height > 28 && reverse.speed < -3);
  assert.ok(reverse.alignment > 0.95);
  frameRates.push({ hz, degrees: -55, distance: reverse.distance, speed: reverse.speed });
}

// Drive in from level ground through a rounded slope transition. This checks
// entering a steep hill without the aligned initial pose of a uniform plane.
const steepRamp = (x, z) => {
  const u = Math.max(0, z - 6), run = 18, rise = Math.tan(55 * Math.PI / 180);
  return rise * (u < run ? u * u / (2 * run) : u - run / 2);
};
const ramp = { surface: 'flat approach / rounded transition / 55 degree hill', base: simulate(steepRamp, false, 18), boost: simulate(steepRamp, true, 18) };
assert.ok(ramp.boost.distance > 45 && ramp.boost.height > 40);
assert.ok(ramp.boost.distance > ramp.base.distance + 20 && ramp.boost.alignment > 0.90);
results.push(ramp);

// No wheel support means no extra boost propulsion: actual trajectories must
// match ordinary gravity at both frame rates even with Shift already held.
for (const hz of [30, 60]) {
  const baseAir = create(), boostAir = create();
  for (const { r: rover } of [baseAir, boostAir]) {
    rover.pos.set(0, 100, 0); rover.vel.set(0.7, 2, 1.2);
    rover.quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.5);
  }
  for (let i = 0; i < hz * 2; i++) {
    baseAir.r.step(1 / hz, { ...drive, boost: false }, baseAir.t);
    boostAir.r.step(1 / hz, drive, boostAir.t);
    assert.equal(boostAir.r.airborne, true);
    assert.deepEqual(boostAir.r.vel.toArray(), baseAir.r.vel.toArray());
    assert.deepEqual(boostAir.r.pos.toArray(), baseAir.r.pos.toArray());
  }
}

const { r, t } = create();
const engage = () => { for (let i = 0; i < 60; i++) r.step(1 / 120, drive, t); assert.equal(r.boostActive, true); };
engage(); r.step(1 / 120, { ...drive, brake: 1 }, t); assert.equal(r.boostBlend, 0);
engage(); r.step(1 / 120, { ...drive, boost: false }, t); assert.equal(r.boostBlend, 0);
engage(); r.step(1 / 120, { ...drive, throttle: 0 }, t); assert.equal(r.boostBlend, 0);
engage(); r.cancelBoost(); // Same external freeze used by photo, pause and cinema.
assert.equal(r.boostBlend, 0); assert.equal(r.boostRequested, false); assert.equal(r.boostActive, false);

// Exercise the real Input constructor and blur handler without a DOM renderer.
const listeners = new Map();
globalThis.addEventListener = (type, handler) => listeners.set(type, handler);
globalThis.document = { addEventListener() {} };
globalThis.window = {};
globalThis.matchMedia = () => ({ matches: false });
const input = new Input({ addEventListener() {} });
input.keys = new Set(['ShiftLeft', 'KeyW']); assert.equal(input.poll().boost, true);
listeners.get('blur')(); assert.equal(input.poll().boost, false); assert.equal(input.keys.size, 0);
input.keys = new Set(['ShiftRight', 'KeyS']); assert.equal(input.poll().boost, true);
input.keys.add('Space'); assert.equal(input.poll().boost, false);
input.keys = new Set(['ShiftLeft']); assert.equal(input.poll().boost, false);
input.keys.add('KeyW'); input.enabled = false; assert.equal(input.poll().boost, false);

// Exercise Game.update's actual energy code with non-rendering surroundings.
function batteryCase(power, blend, cinematicHold = false) {
  const { r: rover, t: surface } = create();
  rover.pos.set(150, 0.58, 50); // Outside either induction charger.
  rover.boostBlend = blend; rover.boostActive = blend > 0;
  rover.motorLoad = 1; rover.lampPower = 1; rover.highBeamPower = 1;
  rover.headlights = true; rover.highBeams = true;
  const game = Object.assign(Object.create(Game.prototype), {
    rover, terrain: surface, props: {}, sky: { anomalyMoonDir: { y: 0.5 }, anomalyMoonKey: 0.46, sunDir: { y: -1 } },
    scan: { active: false, cool: 0 }, drill: { active: false },
    t: 0, met: 0, power, heat: 12, hull: 100, deliveryMode: true,
    missionIdx: 999, bay: [], anoms: [], interact: { t: 0 },
    hud: { setPrompt() {} }, audio: { ui() {} }, log() {}
  });
  game.update(1 / 60, { ...drive, cinematicHold }, { down: () => false, hit: () => false });
  return { game, rover };
}
const threshold = batteryCase(5.001, 1);
assert.ok(threshold.game.power < 5);
assert.equal(threshold.rover.boostBlend, 0);
assert.equal(threshold.rover.boostActive, false);
assert.equal(threshold.rover.boostAvailable, 0);
assert.ok(threshold.rover.powerScale >= POWER_FLOOR);
const baseBattery = batteryCase(34, 0), boostBattery = batteryCase(34, 1);
assert.ok(Math.abs((baseBattery.game.power - boostBattery.game.power) * 60 - 0.045) < 1e-8);
assert.ok(34 - boostBattery.game.power < 0.02, 'high beam plus boost must not drain abruptly');
const criticalCinematic = batteryCase(0.201, 0, true);
assert.equal(criticalCinematic.game.power, 0.201);
assert.equal(criticalCinematic.rover.headlights, true, 'cinema must not turn off near-empty lamps then refund');
assert.equal(criticalCinematic.rover.highBeams, true);
const { HOME } = await import('../src/world/props.js');
criticalCinematic.rover.pos.set(HOME.x, 0.58, HOME.z);
criticalCinematic.rover.vel.set(0, 0, 0);
criticalCinematic.game.update(1 / 60, { ...idle, cinematicHold: true }, { down: () => false, hit: () => false });
assert.equal(criticalCinematic.game.power, 0.201, 'cinema must neither debit energy nor auto-charge without T');

console.log(JSON.stringify({
  scope: 'CPU ideal uniform slopes/static smooth hollow; not all playable terrain',
  results, frameRates,
  checks: 'PASS: 0–55° slopes; steep hill entry; reverse; 30/60/120Hz; airborne gravity parity; quaternion stability; release/brake/idle/freeze; Shift/blur/disabled; 5–12% boost fade; empty-pack crawl; reserve crossing; capped extra drain; cinema near-empty lamps and charging'
}, null, 2));
