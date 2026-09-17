// CPU geometry/state and production shader-hook regressions. GPU compilation
// and the visible paint treatment are checked separately in the preview.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { QUALITY } from '../src/core/quality.js';
register('./three-node-loader.mjs', import.meta.url);
const THREE = await import('three');
const { DimensionalFold, FOLD, FOLD_GLSL, FOLD_PAINT_GLSL } = await import('../src/world/dimensional-fold.js');
const { FalseEarthGrass, FalseEarthRoseField } = await import('../src/world/false-earth-vegetation.js');
const { Terrain } = await import('../src/world/terrain.js');
const close = (actual, expected, message, tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} vs ${expected}`);
const sample = point => fold.sampleFoldPosition(point, new THREE.Vector3(), false);
const withoutComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const samplerInfo = (...stages) => {
  const declarations = [];
  const source = withoutComments(stages.join('\n')).replace(/uniform\s+(sampler\w+)\s+([^;]+);/g,
    (_, type, list) => {
      for (const name of list.split(',')) declarations.push({ name: name.trim(), type });
      return '';
    });
  const active = [...new Set(declarations.map(({ name }) => name))]
    .filter(name => new RegExp(`\\b${name}\\b`).test(source)).sort();
  return { declarations, active };
};

const scene = new THREE.Scene(), rockMaterial = new THREE.MeshStandardMaterial({ color: 0x454747 });
let originalHookCalls = 0;
rockMaterial.onBeforeCompile = shader => {
  originalHookCalls++;
  shader.vertexShader = '// retained scan hook\n' + shader.vertexShader;
};
const terrain = { heightAt: () => 2, material: new THREE.ShaderMaterial({
  uniforms: { uSag: { value: 0 } },
  vertexShader: 'uniform float uSag;varying vec3 vW;void main(){vec4 wp=modelMatrix*vec4(position,1.);wp.y-=uSag;vW=wp.xyz;gl_Position = projectionMatrix * viewMatrix * wp;}',
  fragmentShader: 'varying vec3 vW;void main(){vec3 col=vec3(.3);gl_FragColor = vec4(col, 1.0);}'
}) };
terrain.uniforms = terrain.material.uniforms;
for (const name of ['uMacro', 'uFar', 'uDetail', 'uDent', 'uTrail', 'uConst', 'uConst2', 'uCamXZ', 'uLod', 'uTexRes'])
  terrain.uniforms[name] = { value: new THREE.Vector4() };
terrain.levels = [0, 1].map(() => ({ mesh: new THREE.Mesh(new THREE.PlaneGeometry(), terrain.material.clone()) }));
for (const level of terrain.levels) scene.add(level.mesh);
const scanGeometry = new THREE.IcosahedronGeometry(.5, 2), sourceUv = scanGeometry.getAttribute('uv');
const props = { group: new THREE.Group(), colliders: [],
  scanVariants: [{ geometries: [scanGeometry], material: rockMaterial }], revealHomeGuidance() {} };
scene.add(props.group);
const lamp = new THREE.PointLight(0xffffff, 30);
const fixture = new THREE.Mesh(new THREE.IcosahedronGeometry(.5), new THREE.MeshBasicMaterial());
lamp.position.set(10, 8, -90);
props.group.add(lamp, fixture);
const rover = { root: new THREE.Group(), pos: new THREE.Vector3(0, 2, 0) }, sky = { group: new THREE.Group() };
const excludedMaterial = new THREE.MeshStandardMaterial(), excludedHook = excludedMaterial.onBeforeCompile;
rover.root.add(new THREE.Mesh(scanGeometry, excludedMaterial));
scene.add(rover.root, sky.group);

// Use the real shader builders. Only rose asset transport is omitted; _addLOD
// constructs the same material and instanced mesh used after a real VAT load.
const grass = new FalseEarthGrass({ scene, terrain, rover, engine: {},
  station: { x: 0, z: -90 }, target: { x: 0, z: 300 }, quality: { name: 'LOW' } });
const roses = Object.assign(Object.create(FalseEarthRoseField.prototype), { group: new THREE.Group(), meshes: [] });
scene.add(roses.group);
roses._addLOD({ geometry: new THREE.PlaneGeometry(), position: new THREE.Texture(), normal: new THREE.Texture(),
  meta: { frameCount: 2, textureWidth: 4 } },
{ petal: new THREE.Texture(), outline: new THREE.Texture(), petalNormal: new THREE.Texture() },
{ count: 1, attributes: new Float32Array([0, .72, .18, 1]), matrices: [new THREE.Matrix4()] }, 0, 5);
const originalGrassSource = grass.meshes[0].material.vertexShader;
const originalRoseSource = roses.meshes[0].material.vertexShader;
assert.ok(originalGrassSource.includes('vec4(world, 1.0);'), 'fixture uses the live vec3 grass path');
assert.ok(originalRoseSource.includes('viewMatrix * world;'), 'fixture uses the live vec4 rose path');

const e = { origin: { x: 0, z: 0 }, axis: { x: 0, z: 1 }, home: { x: 0, z: 400 },
  front: -65, elapsed: 0, phase: 'idle', introActive: false, introProgress: 0, cinematicActive: false, active: false };
const fold = new DimensionalFold({ scene, terrain, props, rover, sky, escape: e }), U = fold.uniforms;
assert.equal(await fold.paintReady, false, 'Node fixtures retain a valid array without browser image loading');
assert.equal(U.uFoldPaintReady.value, 0, 'failed loading keeps the original color path');
assert.ok(terrain.texGeology.isDataArrayTexture);
assert.equal(terrain.texGeology.image.depth, 2);
assert.equal(U.uGeology.value, terrain.texGeology);
const hero = fold.getCinematicSubject();
assert.equal(fold.outcrop.children.length, 6);
for (const rock of fold.outcrop.children) {
  assert.equal(rock.geometry, scanGeometry, 'witness retains source scanned geometry');
  assert.equal(rock.material, rockMaterial, 'witness retains source scanned material');
  assert.equal(rock.geometry.getAttribute('uv'), sourceUv, 'source UVs are not replaced');
}
assert.equal(fold.sheet, undefined, 'no independent mural plane');
assert.deepEqual(fold.root.children, [fold.edge, fold.guide], 'only seam and route geometry are added');
assert.equal(fold.edge.geometry.attributes.position.count, 386);
assert.equal(excludedMaterial.onBeforeCompile, excludedHook, 'rover material stays unchanged');
for (const level of terrain.levels) {
  assert.ok(level.mesh.material.vertexShader.includes('wp.xyz=foldWorld(wp.xyz)'));
  assert.equal(level.mesh.material.uniforms.uFoldOn, U.uFoldOn);
  assert.equal(level.mesh.material.uniforms.uGeology, U.uGeology);
  assert.equal(level.mesh.material.uniforms.uFoldPaintReady, U.uFoldPaintReady);
}
const rebuiltRing = new THREE.ShaderMaterial({ uniforms: { ...terrain.uniforms },
  vertexShader: terrain.material.vertexShader, fragmentShader: terrain.material.fragmentShader });
assert.equal(rebuiltRing.uniforms.uFoldFeed, U.uFoldFeed, 'quality rebuild inherits live feed');
assert.equal(rebuiltRing.uniforms.uGeology, U.uGeology, 'quality rebuild inherits the shared array wrapper');
assert.equal(rebuiltRing.uniforms.uFoldPaintReady, U.uFoldPaintReady, 'quality rebuild inherits painting readiness');
assert.equal(rebuiltRing.fragmentShader, terrain.material.fragmentShader);

fold.update(true);
assert.equal(U.uFoldOn.value, 0);
const untouched = new THREE.Vector3(4, 9, -90);
assert.deepEqual(sample(untouched).toArray(), untouched.toArray(), 'idle source positions stay unchanged');
Object.assign(e, { phase: 'intro', active: true, introActive: true, cinematicActive: true });
let previousFront = FOLD.introStart, previousFeed = 0;
for (let i = 0; i <= 100; i++) {
  e.introProgress = i / 100;
  fold.update(true);
  assert.ok(U.uFoldFront.value >= previousFront - 1e-8, 'consumption front advances continuously');
  assert.ok(U.uFoldFeed.value >= previousFeed - 1e-8, 'source feed never reverses during intro');
  previousFront = U.uFoldFront.value; previousFeed = U.uFoldFeed.value;
  assert.ok(fold.edgePositions.every(Number.isFinite));
  assert.ok(sample(hero.crown).toArray().every(Number.isFinite));
}
assert.equal(previousFront, e.front);
assert.equal(previousFeed, FOLD.feed);

// First compress the witness onto the floor, retaining an oblique image of its
// facade. Only afterward does that same source image travel around the bend.
e.introProgress = .5;
const flatCrown = fold.sampleFoldPosition(hero.crown), flatRoot = sample(hero.root);
const sourceHeight = hero.crown.y - hero.root.y;
assert.equal(U.uFoldFront.value, e.front, 'compression completes before feed begins');
assert.equal(U.uFoldFeed.value, 0);
assert.equal(U.uFoldLift.value, 0);
close(flatCrown.y - flatRoot.y, sourceHeight * FOLD.thickness, 'floor image loses 98.8% height');
close(flatRoot.z - flatCrown.z, sourceHeight * FOLD.printShear, 'floor image retains facade detail');
e.introProgress = 1;
const raisedCrown = fold.sampleFoldPosition(hero.crown), raisedRoot = sample(hero.root);
assert.ok(raisedRoot.y > flatRoot.y + 35, 'same consumed witness reaches the upright region');
close(raisedCrown.y - raisedRoot.y, sourceHeight * FOLD.printShear, 'facade image becomes vertical');
close(raisedCrown.z - raisedRoot.z, sourceHeight * FOLD.thickness, 'upright image retains only hairline depth');
const safe = new THREE.Vector3(0, 6, 0);
assert.deepEqual(sample(safe).toArray(), safe.toArray(), 'ahead geometry remains unchanged at full feed');
const frozen = sample(hero.crown);
e.elapsed += 500;
fold.update(true);
assert.deepEqual(sample(hero.crown).toArray(), frozen.toArray(), 'elapsed time alone cannot animate mapping');

// Isolate the fixed support path from event timing. At each join both position
// and tangent must agree; a rotating wall or a hard right-angle bend fails.
U.uFoldOrigin.value.set(0, 0); U.uFoldAxis.value.set(0, 1);
U.uFoldFront.value = 0; U.uFoldBaseY.value = 0; U.uFoldOn.value = 1; U.uFoldFeed.value = 0;
const atTravel = q => sample(new THREE.Vector3(0, 0, -q)), epsilon = 1e-4;
for (const [join, direction] of [[FOLD.apron, new THREE.Vector3(0, 0, -1)],
  [FOLD.apron + FOLD.radius * Math.PI / 2, new THREE.Vector3(0, 1, 0)]]) {
  const before = atTravel(join - epsilon), center = atTravel(join), after = atTravel(join + epsilon);
  assert.ok(before.distanceTo(after) < epsilon * 2.001, 'bend has no positional gap');
  const incoming = center.clone().sub(before).divideScalar(epsilon);
  const outgoing = after.clone().sub(center).divideScalar(epsilon);
  assert.ok(incoming.distanceTo(outgoing) < .0001, 'bend tangent is continuous');
  assert.ok(incoming.distanceTo(direction) < .0001 && outgoing.distanceTo(direction) < .0001,
    'support runs horizontally into bend and vertically out');
}
const fedSource = new THREE.Vector3(0, 0, -60);
U.uFoldFeed.value = FOLD.feed - 8;
const earlier = sample(fedSource);
U.uFoldFeed.value = FOLD.feed;
const later = sample(fedSource);
close(later.z, -FOLD.apron - FOLD.radius, 'upright support remains at fixed depth');
close(later.z, earlier.z, 'feeding never pivots or translates the support');
close(later.y - earlier.y, 8, 'additional consumed distance moves only upward');
const raisedFacade = sample(fedSource.clone().add(new THREE.Vector3(0, 5, 0)));
close(raisedFacade.z - later.z, 5 * FOLD.thickness, 'upright source height creates only residual depth');
close(raisedFacade.y - later.y, 5 * FOLD.printShear, 'upright print preserves original facade height');
const aliasInput = fedSource.clone(), aliasExpected = sample(aliasInput);
fold.sampleFoldPosition(aliasInput, aliasInput, false);
assert.deepEqual(aliasInput.toArray(), aliasExpected.toArray(), 'light-target in-place sampling is supported');

// Live state restores all transforms and culling after a menu/reset, including
// re-installation while the fold is active and meshes added with shared shaders.
fold.update(true);
const beforeWarning = sample(hero.crown);
Object.assign(e, { phase: 'warning', introActive: false, cinematicActive: false });
fold.update(true);
assert.ok(sample(hero.crown).distanceTo(beforeWarning) < 1e-7, 'intro-to-warning has no geometry snap');
assert.equal(lamp.intensity, 0);
assert.equal(fixture.frustumCulled, false);
const lateGrass = new THREE.Mesh(grass.meshes[0].geometry, grass.meshes[0].material);
lateGrass.frustumCulled = true;
props.group.add(lateGrass);
const beforeHook = rockMaterial.onBeforeCompile;
const shaderMaterials = [terrain.material, ...terrain.levels.map(level => level.mesh.material),
  ...grass.meshes.map(mesh => mesh.material), ...roses.meshes.map(mesh => mesh.material)];
const shaderSources = shaderMaterials.map(material => [material.vertexShader, material.fragmentShader]);
fold.install(); fold.update(true); fold.install();
assert.equal(lateGrass.frustumCulled, false, 'late shared plant mesh is not culled using intact bounds');
assert.equal(rockMaterial.onBeforeCompile, beforeHook, 'mesh hooks are idempotent');
assert.deepEqual(shaderMaterials.map(material => [material.vertexShader, material.fragmentShader]), shaderSources,
  're-install does not duplicate shader functions');
Object.assign(e, { phase: 'intro', introActive: true, cinematicActive: true });
fold.update(false);
assert.equal(U.uFoldOn.value, 0, 'menu visibility overrides saved intro activity');
assert.equal(fold.root.visible, false);
assert.equal(lamp.intensity, 30);
assert.deepEqual(lamp.position.toArray(), [10, 8, -90]);
assert.equal(fixture.frustumCulled, true);
assert.equal(lateGrass.frustumCulled, true, 're-install preserves original culling state');
assert.equal(grass.meshes[0].frustumCulled, false, 'naturally uncullable grass retains that setting');
Object.assign(e, { phase: 'complete', introActive: false, cinematicActive: false });
fold.update(true);
assert.equal(U.uFoldOn.value, 1, 'ending keeps the final source-world image visible');
Object.assign(e, { phase: 'idle', active: false });
fold.update(true);
assert.equal(U.uFoldOn.value, 0);
assert.equal(lamp.intensity, 30);
assert.deepEqual(lamp.position.toArray(), [10, 8, -90]);

// Inspect the assembled production shaders, including real Three depth chunks.
// These assertions verify hook coverage and matching helpers, not compilation.
const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
  fragmentShader: THREE.ShaderLib.standard.fragmentShader };
rockMaterial.onBeforeCompile(shader, {});
assert.equal(originalHookCalls, 1);
assert.ok(shader.vertexShader.includes('// retained scan hook'));
assert.ok(shader.vertexShader.includes('worldPosition.xyz=foldWorld(worldPosition.xyz)'));
assert.ok(shader.fragmentShader.includes('foldPigment(outgoingLight,vFoldWorld)'));
const depthShader = { uniforms: {}, vertexShader: THREE.ShaderLib.depth.vertexShader,
  fragmentShader: THREE.ShaderLib.depth.fragmentShader };
fold.outcrop.children[0].customDepthMaterial.onBeforeCompile(depthShader);
for (const assembled of [shader, depthShader]) {
  assert.ok(assembled.vertexShader.includes(FOLD_GLSL), 'color and shadow share mapping');
  assert.ok(assembled.fragmentShader.includes(FOLD_GLSL + FOLD_PAINT_GLSL), 'color and shadow share crest clipping');
  assert.ok(assembled.vertexShader.includes('foldWorld(foldPosition.xyz)'));
  assert.equal((assembled.fragmentShader.match(/foldClip\(vFoldWorld\)/g) || []).length, 1,
    'clipping is called once in the color/depth main function');
  assert.equal((assembled.vertexShader.match(/uniform vec2 uFoldOrigin/g) || []).length, 1);
  assert.ok(!/\b(?:fwidth|dFdx|dFdy)\s*\(/.test(assembled.vertexShader), 'derivatives stay out of vertex shaders');
  for (const [name, uniform] of Object.entries(U)) assert.equal(assembled.uniforms[name], uniform);
}
for (const mesh of [...grass.meshes, ...roses.meshes]) {
  const material = mesh.material, vertex = material.vertexShader;
  assert.ok(vertex.includes('foldWorld(world'), 'every real grass/rose vertex path is deformed');
  assert.ok(vertex.indexOf('vWorld = world') < vertex.indexOf('=foldWorld(world'), 'paint uses original plant position');
  assert.ok(material.fragmentShader.includes('foldClip(vWorld);col=foldPigment(col,vWorld);'));
  assert.equal(material.uniforms.uFoldFeed, U.uFoldFeed);
  assert.equal(material.uniforms.uGeology, U.uGeology, 'plants share the same painting array');
  assert.equal(material.uniforms.uFoldPaintReady, U.uFoldPaintReady);
  assert.ok(!/\b(?:fwidth|dFdx|dFdy)\s*\(/.test(vertex));
}
assert.doesNotMatch(withoutComments(FOLD_GLSL), /\b(?:sampler\w*|texture\w*)\b/,
  'geometry mapping remains independent of texture sampling');
assert.doesNotMatch(withoutComments(FOLD_GLSL + FOLD_PAINT_GLSL), /\b(?:u\w*Time|uTime|gl_FragCoord)\b/,
  'mapping and pigment have no time or screen-position noise');
assert.deepEqual(samplerInfo(FOLD_PAINT_GLSL), {
  declarations: [{ name: 'uGeology', type: 'sampler2DArray' }], active: ['uGeology']
}, 'painting adds only the existing shared geology sampler identity');
assert.doesNotMatch(withoutComments(FOLD_PAINT_GLSL), /\b(?:sin|cos|tan|atan)\s*\(/,
  'painting imagery is not reconstructed from procedural stripes or curls');
const pigmentBody = withoutComments(FOLD_PAINT_GLSL).split('vec3 foldPigment')[1];
assert.ok(pigmentBody.includes('foldCanvas(p)'), 'painting UVs use the source world canvas');
const firstPaintBranch = pigmentBody.search(/\bif\s*\(/);
for (const derivative of ['dFdx(q)', 'dFdy(q)']) {
  const at = pigmentBody.indexOf(derivative);
  assert.ok(at >= 0 && at < firstPaintBranch, `${derivative} precedes the varying fold branch`);
}
assert.match(pigmentBody, /textureGrad\(uGeology,\s*vec3\(uv,\s*1\.0\),\s*dx,\s*dy\)/,
  'painting layer 1 uses explicit derivatives instead of implicit branch-dependent LOD');
assert.match(pigmentBody, /foldDecodePaint\(textureGrad/,
  'sRGB painting pixels are decoded separately from linear geology controls');

// Exercise production terrain shaders and actual clipmap rebuilds. Keep ring
// geometry small so this verifies integration without baking a 2048² basin or
// allocating production dent/trail render targets in a Node-only check.
const geologyBytes = new Uint8Array([0, 8, 16, 24, 32, 64, 96, 128, 2, 4, 6, 8, 250, 251, 252, 255]);
const originalGeologyTexture = new THREE.DataTexture(geologyBytes, 2, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
originalGeologyTexture.magFilter = THREE.LinearFilter;
originalGeologyTexture.minFilter = THREE.LinearMipmapLinearFilter;
originalGeologyTexture.generateMipmaps = true;
originalGeologyTexture.colorSpace = THREE.NoColorSpace;
let geologyDisposals = 0;
originalGeologyTexture.addEventListener('dispose', () => geologyDisposals++);
const productionQuality = { ...QUALITY.high, clipM: 8, clipLevels: 2 };
const productionTerrain = Object.assign(Object.create(Terrain.prototype), {
  quality: productionQuality,
  texGeology: originalGeologyTexture,
  trailRT: { texture: new THREE.Texture() }, sunRT: { texture: new THREE.Texture() },
  TRAIL_EXT: 900, dentRes: productionQuality.dentRes,
  renderer: { shadowMap: { enabled: true } },
  sunMat: { uniforms: { uSteps: { value: productionQuality.sunSteps } } },
  _lastSun: new THREE.Vector3(), heightAt: () => 2
});
productionTerrain.buildMaterial(); productionTerrain.buildClipmap();
const baselineSamplers = samplerInfo(productionTerrain.material.vertexShader, productionTerrain.material.fragmentShader).active;
assert.equal(baselineSamplers.length, 16, 'production terrain fixture begins with its full sampler budget');
const originalGeologyUniform = productionTerrain.uniforms.uGeology;
const productionScene = new THREE.Scene();
productionScene.add(productionTerrain.group);
const productionFold = new DimensionalFold({
  scene: productionScene, terrain: productionTerrain,
  props: { group: new THREE.Group(), colliders: [], scanVariants: [], revealHomeGuidance() {} },
  rover: { root: new THREE.Group(), pos: new THREE.Vector3() }, sky: { group: new THREE.Group() },
  escape: { ...e }
});
assert.equal(await productionFold.paintReady, false);
assert.equal(geologyDisposals, 1, 'fold installation releases the replaced source texture once');
assert.equal(productionTerrain.uniforms.uGeology, originalGeologyUniform, 'installation mutates the existing wrapper');
assert.equal(productionFold.uniforms.uGeology, originalGeologyUniform);
const sharedPaintArray = originalGeologyUniform.value;
assert.ok(sharedPaintArray.isDataArrayTexture);
assert.deepEqual(sharedPaintArray.image.data.slice(0, geologyBytes.length), geologyBytes,
  'installed layer 0 preserves production geology bytes');

const checkProductionMaterial = material => {
  const info = samplerInfo(material.vertexShader, material.fragmentShader);
  assert.deepEqual(info.active, baselineSamplers,
    'installed fold reuses exactly the original 16 combined sampler identities');
  assert.deepEqual(info.declarations.filter(({ name }) => name === 'uGeology'),
    [{ name: 'uGeology', type: 'sampler2DArray' }], 'one array declaration replaces the original 2D sampler');
  assert.match(material.fragmentShader, /texture\(uGeology,\s*vec3\(guv,\s*0\.0\)\)/,
    'unfolded geology still reads its unchanged UVs from layer 0');
  assert.match(material.fragmentShader, /textureGrad\(uGeology,\s*vec3\(uv,\s*1\.0\),\s*dx,\s*dy\)/);
  assert.equal(material.uniforms.uGeology, originalGeologyUniform);
  assert.equal(material.uniforms.uGeology.value, sharedPaintArray);
  assert.equal(material.uniforms.uFoldPaintReady, productionFold.uniforms.uFoldPaintReady);
  assert.equal(material.uniforms.uFoldFeed, productionFold.uniforms.uFoldFeed);
};
checkProductionMaterial(productionTerrain.material);
for (const level of productionTerrain.levels) checkProductionMaterial(level.mesh.material);
const originalTerrainGroup = productionTerrain.group;
for (const change of [{ clipM: 12, clipLevels: 3 }, { clipM: 8, clipLevels: 2, clipCell: .6 }]) {
  const oldMeshes = productionTerrain.levels.map(level => level.mesh);
  productionTerrain.setQuality({ ...productionTerrain.quality, ...change });
  assert.equal(productionTerrain.group, originalTerrainGroup, 'real quality rebuild retains the scene group');
  assert.ok(oldMeshes.every(mesh => mesh.parent === null), 'old rings leave the scene during rebuild');
  for (const level of productionTerrain.levels) checkProductionMaterial(level.mesh.material);
  productionFold.install();
  for (const level of productionTerrain.levels) checkProductionMaterial(level.mesh.material);
  assert.equal(geologyDisposals, 1, 'quality changes do not replace or reallocate the shared painting texture');
}
productionFold.paintAsset.dispose();
for (const level of productionTerrain.levels) { level.mesh.geometry.dispose(); level.mesh.material.dispose(); }
for (const resource of [productionTerrain.material, productionTerrain._emptyShadow,
  productionTerrain.trailRT.texture, productionTerrain.sunRT.texture]) resource.dispose();
fold.paintAsset.dispose(); rebuiltRing.dispose();
console.log(JSON.stringify({ status: 'PASS', checks: [
  'original scanned geometry and UVs', 'compression before source feed', 'flat witness then upright facade',
  'fixed support depth and upward-only feed', 'continuous bend position and tangent', 'ahead geometry unchanged',
  'time-independent mapping', 'current-frame camera sampling', 'warning and menu continuity',
  'light and culling restoration', 'real grass vec3 and VAT rose vec4 integration',
  'matching color/depth deformation and crest clipping', 'source-anchored oil image with explicit gradients',
  'one shared geology/paint array', '16 installed production terrain samplers',
  'real quality rebuilds preserve shared texture/uniforms', 'idempotent installation'
] }, null, 2));
