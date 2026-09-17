// Portable profile contract + real Three shadow camera. No GPU claim here.
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./three-node-loader.mjs', import.meta.url);
const THREE = await import('three');
const { QUALITY, QUALITY_KEYS, selectStartupQuality, renderPixelRatio, renderFeatures } = await import('../src/core/quality.js');
const { snapShadowTarget } = await import('../src/core/shadow-framing.js');
const { Engine } = await import('../src/core/engine.js');
assert.deepEqual(QUALITY_KEYS, ['low', 'medium', 'high', 'ultra']);
assert.equal(selectStartupQuality({ platform: 'MacIntel' }), 'high');
assert.equal(selectStartupQuality({ platform: 'macOS', stored: 'medium' }), 'medium');
assert.equal(selectStartupQuality({ platform: 'MacIntel', requested: 'ultra', stored: 'low' }), 'ultra');
assert.equal(selectStartupQuality({ platform: 'Win32', requested: 'ultra' }), 'ultra');
assert.equal(selectStartupQuality({ platform: 'Win32', requested: 'invalid', cores: 12, memory: 8 }), 'high');
assert.equal(selectStartupQuality({ platform: 'iPad', cores: 8, coarse: true }), 'medium');
assert.equal(selectStartupQuality({ stored: null, cores: 2 }), 'low');
for (const key of QUALITY_KEYS) {
  const q = QUALITY[key];
  for (const [width, height, dpr] of [[1280, 720, 1], [1920, 1080, 1], [2560, 1440, 1], [1710, 1069, 2], [7680, 4320, 2]]) {
    const px = renderPixelRatio(q, width, height, dpr);
    assert.ok(px > 0 && width * height * px * px <= q.pixels + 1);
    assert.ok(px <= q.maxDpr);
  }
  assert.deepEqual(renderFeatures(q, { stableFramebuffer: true, hdrSupported: true, maxSamples: 8 }),
    { hdr: false, bloom: false, samples: 0 }, 'Apple path stays stable even when Ultra is selected');
}
assert.deepEqual(renderFeatures(QUALITY.ultra, { maxSamples: 4 }), { hdr: true, bloom: true, samples: 4 });
assert.deepEqual(renderFeatures(QUALITY.ultra, { maxSamples: 8, hdrSupported: false }), { hdr: false, bloom: false, samples: 0 });
assert.equal(renderFeatures(QUALITY.low, { maxSamples: 4 }).bloom, false);
assert.equal(renderFeatures(QUALITY.high, { maxSamples: 2 }).samples, 2);
assert.ok(QUALITY.ultra.roverShadow > QUALITY.high.roverShadow);
assert.ok(QUALITY.ultra.stationShadow > QUALITY.high.stationShadow);
assert.ok(QUALITY.ultra.terrainLightSteps > QUALITY.high.terrainLightSteps);
assert.ok(renderPixelRatio(QUALITY.ultra, 1920, 1080) > 1, 'demo gets real supersampling on a 1080p monitor');

// A LOW boot has not rendered any shadow map: switching upward still has to
// configure its orthographic projection. Also release maps on downgrade.
const engine = Object.assign(Object.create(Engine.prototype), {
  quality: QUALITY.low, caps: { maxTex: 8192 },
  renderer: { shadowMap: {} }, sun: new THREE.DirectionalLight(),
  silverFill: new THREE.DirectionalLight(), _shadowAnchor: new THREE.Vector3()
});
engine.configureKeyShadow();
assert.equal(engine.sun.castShadow, false);
engine.quality = QUALITY.ultra; engine.configureKeyShadow();
assert.equal(engine.sun.shadow.mapSize.x, 4096);
assert.equal(engine.sun.shadow.camera.left, -26);
assert.equal(engine.sun.shadow.camera.far, 180);
let disposed = 0;
engine.sun.shadow.map = { dispose() { disposed++; } };
engine.quality = QUALITY.high; engine.configureKeyShadow();
assert.equal(disposed, 1); assert.equal(engine.sun.shadow.map, null);
engine.sun.shadow.map = { dispose() { disposed++; } };
engine.quality = QUALITY.low; engine.configureKeyShadow();
assert.equal(disposed, 2); assert.equal(engine.renderer.shadowMap.enabled, false);
assert.ok(engine.sun.shadow.camera.projectionMatrix.elements.every(Number.isFinite));

const direction = new THREE.Vector3(0.4, 0.3, -0.9).normalize();
const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
const vertical = new THREE.Vector3().crossVectors(direction, right).normalize();
const target = new THREE.Vector3(13.2, 2.6, -17.3), anchor = new THREE.Vector3();
for (const size of [2048, 4096]) {
  snapShadowTarget(target, direction, 26, size, anchor);
  const step = 52 / size;
  assert.ok(Math.abs(anchor.dot(right) / step - Math.round(anchor.dot(right) / step)) < 1e-7);
  assert.ok(Math.abs(anchor.dot(vertical) / step - Math.round(anchor.dot(vertical) / step)) < 1e-7);
  assert.ok(anchor.distanceTo(target) < step);
  const same = snapShadowTarget(anchor.clone().addScaledVector(right, step * 0.20), direction, 26, size, new THREE.Vector3());
  assert.ok(same.distanceTo(anchor) < 1e-8, 'sub-texel camera movement does not slide the shadow footprint');
}
snapShadowTarget(target, new THREE.Vector3(0, 1, 0), 26, 4096, anchor);
assert.ok(anchor.toArray().every(Number.isFinite), 'vertical key has a stable fallback basis');
engine.quality = QUALITY.high; engine.configureKeyShadow();
engine.aimShadow(target, direction);
const actualDirection = engine.sun.position.clone().sub(engine.sun.target.position).normalize();
assert.ok(actualDirection.distanceTo(direction) < 1e-8, 'snapping never moves the apparent moon direction');

// Exercise the real composer/ShaderPass rebuild with a renderer size stub.
// GPU compilation is browser-tested separately; no fake FPS is derived here.
let ratio = 2, viewport = new THREE.Vector2(1280, 720);
const post = Object.assign(Object.create(Engine.prototype), {
  quality: QUALITY.ultra, caps: { hdr: true, maxSamples: 4, maxTex: 8192 },
  stableFramebuffer: true, renderScale: 1,
  renderer: {
    shadowMap: {},
    getPixelRatio: () => ratio,
    setPixelRatio: value => { ratio = value; },
    setSize: (w, h) => viewport.set(w, h),
    getDrawingBufferSize: out => out.copy(viewport).multiplyScalar(ratio).floor()
  },
  scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), sun: new THREE.DirectionalLight()
});
const oldWindow = globalThis.window;
globalThis.window = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2 };
try {
  post.buildComposer(); post.resize();
  const before = post.final.uniforms;
  before.uExposure.value = 1.5; before.uLetterbox.value = 0.22;
  before.uNightLift.value = 0.1; before.uTime.value = 83;
  before.uSunUV.value.set(0.2, 0.8, 0.64);
  before.tDiffuse.value = new THREE.Texture();
  const oldTarget = post.composer.renderTarget1, oldMaterial = post.final.material;
  let targetFreed = false, materialFreed = false;
  oldTarget.addEventListener('dispose', () => { targetFreed = true; });
  oldMaterial.addEventListener('dispose', () => { materialFreed = true; });
  post.setQuality('high');
  assert.ok(targetFreed && materialFreed, 'rebuild frees the old targets and pass materials');
  for (const name of ['uExposure', 'uLetterbox', 'uNightLift', 'uTime'])
    assert.equal(post.final.uniforms[name].value, before[name].value, `${name} remains stable while paused`);
  assert.ok(post.final.uniforms.uSunUV.value.equals(before.uSunUV.value));
  assert.notEqual(post.final.uniforms.uSunUV.value, before.uSunUV.value, 'new pass owns its vector');
  assert.equal(post.final.uniforms.tDiffuse.value, null, 'never retain disposed composer input');
  assert.equal(post.final.uniforms.uAA.value, QUALITY.high.fxaa);
  before.tDiffuse.value.dispose();
  for (const [w, h, dpr] of [[1280, 720, 2], [2560, 1440, 1], [1920, 1080, 2]]) {
    Object.assign(globalThis.window, { innerWidth: w, innerHeight: h, devicePixelRatio: dpr });
    post.resize();
    const expected = renderPixelRatio(QUALITY.high, w, h, dpr);
    assert.equal(post._composerPixelRatio, expected);
    assert.equal(post.composer.renderTarget1.width, w * expected);
    assert.equal(post.composer.renderTarget1.height, h * expected);
    assert.deepEqual(post.final.uniforms.uRes.value.toArray(), [Math.floor(w * expected), Math.floor(h * expected)]);
  }
} finally {
  for (const pass of post.composer.passes) pass.dispose?.();
  post.composer.dispose();
  if (oldWindow === undefined) delete globalThis.window;
  else globalThis.window = oldWindow;
}
console.log('PASS: four persistent profile choices; Mac HIGH default; explicit PC ULTRA; bounded pixels; HDR/MSAA fallback; shadow cleanup/framing; real composer DPR, disposal and paused camera continuity');
