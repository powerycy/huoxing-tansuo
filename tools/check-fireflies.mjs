// CPU checks against the exact Three build used by the game.
// Run: node tools/check-fireflies.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./three-node-loader.mjs', import.meta.url);
const THREE = await import('three');
const { GrassFireflies } = await import('../src/world/fireflies.js');
const { sstep } = await import('../src/core/rng.js');
const scene = new THREE.Scene();
let terrainCalls = 0;
const terrain = { heightAt(x, z) { terrainCalls++; return Math.sin(x * 0.045) * 1.2 + Math.cos(z * 0.035) * 0.8; } };
const station = { x: 0, z: 0 }, target = { x: 0, z: -240 }, anchor = { x: 11, z: -9 };
const fireflies = new GrassFireflies({ scene, terrain, quality: { name: 'HIGH' } });
assert.equal(fireflies.points.visible, false, 'constructor does not show lights before the event');
assert.ok(fireflies.prepare({ station, target, anchor }));
assert.equal(fireflies.geometry.drawRange.count, 320);
const roots = fireflies.geometry.getAttribute('position');
const life = fireflies.geometry.getAttribute('aLife');
const slope = fireflies.geometry.getAttribute('aSlope');
for (const attribute of [roots, life, slope]) assert.ok([...attribute.array].every(Number.isFinite));
const snapshot = [...roots.array];
assert.ok(fireflies.prepare({ station, target, anchor }));
assert.deepEqual([...roots.array], snapshot, 'same event seed restores stable world positions');
let nearAnchor = 0;
for (let i = 0; i < fireflies.geometry.drawRange.count; i++) {
  const x = roots.getX(i), z = roots.getZ(i);
  const nearestZ = Math.max(target.z, Math.min(station.z, z));
  assert.ok(Math.hypot(x, z - nearestZ) >= 8.199, 'roots plus maximum drift stay outside the bare road');
  assert.ok(Math.hypot(x, z) < 346.01, 'lights remain in the grass event area');
  assert.ok(life.getW(i) - 0.11 >= 0.4 && life.getW(i) + 0.11 <= 2, 'low terrain-relative wandering');
  assert.ok(life.getZ(i) > 0 && life.getZ(i) < 0.15, 'tiny physical halo diameters');
  if (Math.hypot(x - anchor.x, z - anchor.z) < 38) nearAnchor++;
}
assert.ok(nearAnchor > 130, 'a visible near-event population, not mostly faraway stars');
const grown = { time: 40, grassWave: 1.12, grassMaturity: 1, fade: 1 };
for (const phase of ['dormant', 'warning', 'scar', 'unknown']) {
  fireflies.update({ ...grown, phase });
  assert.equal(fireflies.points.visible, false, `${phase} suppresses lights despite stale full-growth inputs`);
  assert.equal(fireflies.material.uniforms.uFade.value, 0);
}
const bornCount = (wave, maturity) => {
  fireflies.update({ ...grown, phase: 'grass', grassWave: wave, grassMaturity: maturity });
  const U = fireflies.material.uniforms;
  let count = 0;
  for (let i = 0; i < life.count; i++) {
    const born = sstep(life.getX(i) - 0.032, life.getX(i) + 0.032, U.uWave.value);
    if (born * sstep(0.035, 0.58, U.uMaturity.value) * U.uFade.value > 0.04) count++;
  }
  return count;
};
assert.equal(bornCount(0.012, 0), 0, 'no lights before grass has risen');
const early = bornCount(0.08, 0.32), lateGrass = bornCount(0.13, 0.62), bloom = bornCount(0.65, 1);
assert.ok(early > 8, `already visible during grass, got ${early}`);
assert.ok(lateGrass > early && bloom > lateGrass, 'population expands with the same grass wave');
assert.equal(bornCount(1.12, 1), 320);
for (const phase of ['grass', 'first', 'bloom', 'full', 'navigate', 'ascend']) {
  fireflies.update({ ...grown, phase });
  assert.equal(fireflies.points.visible, true, `${phase} supports living grass lights`);
}
let previousFade = 1;
for (const fade of [1, 0.9, 0.65, 0.3, 0.05, 0.035, 0]) {
  fireflies.update({ ...grown, phase: 'ascend', fade });
  const value = fireflies.material.uniforms.uFade.value;
  assert.ok(value <= previousFade && value >= 0, 'ascension fades smoothly into residual grass');
  previousFade = value;
}
assert.equal(fireflies.points.visible, false);
const callsBeforeUpdate = terrainCalls;
const versionBeforeUpdate = roots.version;
for (let i = 0; i < 1000; i++) fireflies.update({ ...grown, phase: 'navigate', time: i / 60 });
assert.equal(terrainCalls, callsBeforeUpdate, 'animation has no per-frame terrain work');
assert.equal(roots.version, versionBeforeUpdate, 'animation has no per-frame geometry upload');
assert.equal(scene.children.length, 1);
assert.ok(fireflies.points.isPoints);
assert.equal(fireflies.material.depthTest, true);
assert.equal(fireflies.material.depthWrite, false);
assert.ok(!Object.values(fireflies.material.uniforms).some((u) => u.value?.isTexture), 'zero texture samplers');
const bytes = [roots, life, slope].reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
assert.ok(bytes < 16000, `only ${bytes} bytes of geometry`);
const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 8000);
fireflies.points.onBeforeRender({ getDrawingBufferSize(v) { v.set(1920, 1080); }, getPixelRatio() { return 2; } }, scene, camera);
assert.ok(fireflies.material.uniforms.uPointScale.value > 900);
assert.equal(fireflies.material.uniforms.uPixelRatio.value, 2);
fireflies.update({ phase: 'grass', time: NaN, grassWave: Infinity, grassMaturity: undefined, fade: NaN });
assert.ok(Object.values(fireflies.material.uniforms).every((u) => Number.isFinite(u.value)), 'bad input cannot poison shader uniforms');
let geometryDisposals = 0, materialDisposals = 0;
fireflies.geometry.addEventListener('dispose', () => geometryDisposals++);
fireflies.material.addEventListener('dispose', () => materialDisposals++);
fireflies.reset();
assert.equal(fireflies.points.visible, false);
assert.equal(fireflies.material.uniforms.uWave.value, 0);
fireflies.dispose(); fireflies.dispose();
assert.equal(scene.children.length, 0);
assert.equal(geometryDisposals, 1);
assert.equal(materialDisposals, 1);
assert.equal(fireflies.prepare({ station, target, anchor }), false);
console.log(`PASS: ${life.count} stable terrain-bound points; grass counts ${early} → ${lateGrass} → ${bloom}; road clearance; phase masks; smooth fade; one draw / ${bytes} bytes / no samplers; no per-frame uploads; cleanup`);
