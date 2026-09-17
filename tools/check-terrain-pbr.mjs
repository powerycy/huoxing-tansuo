// Run: node tools/check-terrain-pbr.mjs
// Numerical checks execute the production scalar GLSL formulas in JavaScript.
// GPU compilation, visual shadow alignment and frame-time remain browser QA.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { QUALITY } from '../src/core/quality.js';

register('./three-node-loader.mjs', import.meta.url);
const THREE = await import('three');
const { Terrain } = await import('../src/world/terrain.js');
const terrain = Object.assign(Object.create(Terrain.prototype), {
  quality: QUALITY.high,
  trailRT: { texture: new THREE.Texture() },
  sunRT: { texture: new THREE.Texture() },
  TRAIL_EXT: 900, dentRes: 4096,
  renderer: { shadowMap: { enabled: true } },
  sunMat: { uniforms: { uSteps: { value: QUALITY.high.sunSteps } } },
  _lastSun: new THREE.Vector3()
});
terrain.buildMaterial();
const shader = terrain.material.fragmentShader;
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const mix = (a, b, t) => a + (b - a) * t;

// Scalar GLSL is a small JS-compatible subset. Extract it from the actual
// material, so a shader equation change changes the numerical test too.
function scalarGLSL(name, dependencies = {}) {
  const match = shader.match(new RegExp(`float ${name}\\(([^)]*)\\)\\{`));
  assert.ok(match, `Missing production scalar function ${name}`);
  const start = match.index + match[0].length;
  let braces = 1, end = start;
  while (braces && end < shader.length) {
    if (shader[end] === '{') braces++;
    if (shader[end] === '}') braces--;
    end++;
  }
  assert.equal(braces, 0, `Unbalanced GLSL function ${name}`);
  const body = shader.slice(start, end - 1).replace(/\bfloat\s+/g, 'let ');
  const args = match[1].split(',').map(arg => arg.trim().replace(/^float\s+/, ''));
  return new Function('clamp', 'mix', 'pow', 'max', ...Object.keys(dependencies),
    `return function(${args.join(',')}){${body}}`)(clamp, mix, Math.pow, Math.max, ...Object.values(dependencies));
}
const fresnel = scalarGLSL('terrainFresnel');
const specular = scalarGLSL('terrainSpecular', { terrainFresnel: fresnel });
const diffuse = scalarGLSL('terrainDiffuse', { terrainFresnel: fresnel });

assert.equal(fresnel(1, 0.04), 0.04);
assert.equal(fresnel(0, 0.04), 1);
assert.ok(fresnel(0.15, 0.04) > fresnel(0.8, 0.04), 'Grazing surfaces must gain Fresnel reflectance');
assert.ok(specular(1, 1, 1, 1, 0.25, 0.04) > specular(1, 1, 1, 1, 0.55, 0.04));
assert.ok(specular(1, 1, 1, 1, 0.55, 0.04) > specular(1, 1, 1, 1, 0.95, 0.04),
  'Smooth material must have a stronger specular peak than rough dust');
assert.ok(specular(0.75, 0.75, 0.75, 0.9, 0.8, 0.04) > specular(0.75, 0.75, 0.75, 0.9, 0.25, 0.04),
  'Rough material must distribute more energy away from the specular peak');

let cases = 0;
for (const roughness of [0, 0.16, 0.24, 0.4, 0.65, 0.85, 1]) {
  for (const f0 of [0.028, 0.04, 0.045]) {
    for (const NoL of [0, 0.001, 0.05, 0.3, 0.7, 1]) {
      for (const NoV of [0, 0.001, 0.05, 0.3, 0.7, 1]) {
        for (const NoH of [0, 0.5, 0.9, 0.99, 1]) {
          for (const VoH of [0, 0.1, 0.5, 0.9, 1]) {
            const s = specular(NoL, NoV, NoH, VoH, roughness, f0);
            const d = diffuse(NoL, NoV, VoH, roughness, f0);
            assert.ok(Number.isFinite(s) && s >= 0 && s <= 0.42, `Unbounded specular ${s}`);
            assert.ok(Number.isFinite(d) && d >= 0 && d <= 1.5, `Unbounded diffuse ${d}`);
            if (NoL === 0) assert.equal(s + d, 0, 'A light behind the surface cannot illuminate it');
            if (NoV === 0) assert.equal(s, 0, 'No singular grazing highlight');
            cases++;
          }
        }
      }
    }
  }
}

assert.match(shader, /dFdx\(Nr\)/);
assert.match(shader, /dFdy\(Nr\)/);
assert.match(shader, /vec2 detailN = vec2\(dot\(RA\[0\],nd\.xy\),dot\(RA\[1\],nd\.xy\)\)/);
assert.match(shader, /vec2 rockN = vec2\(dot\(RB\[0\],rockNorm\.xy\),dot\(RB\[1\],rockNorm\.xy\)\)/);
assert.match(shader, /sqrt\(surfRough\*surfRough\+normalVariance\)/);
assert.ok(shader.indexOf('float normalVariance') < shader.indexOf('if(facB*coneB*uFacilityBPower'),
  'Specular AA derivatives must be evaluated before varying light branches');
for (const direction of ['uSunDir', 'eventL', 'flA', 'flB', 'L']) {
  assert.ok(shader.includes(`terrainLight(albedo,Nr,V,${direction},filteredRough,surfaceF0)`),
    `${direction} must use the same roughness/Fresnel response`);
}
assert.doesNotMatch(shader, /mix\(70\.0,12\.0,1\.0-surfRough\)/, 'Remove the inverted Phong roughness response');
assert.doesNotMatch(shader, /albedo\s*\*=\s*mix\(0\.84,\s*1\.0,\s*surfAO\)/,
  'Ambient occlusion must not be baked into direct-light albedo');

// Count uniform identities across both stages. A shared height field must
// consume one combined texture unit, not one per use or per shader stage.
const declarations = new Set();
let source = [terrain.material.vertexShader, shader].join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
source = source.replace(/uniform\s+sampler\w+\s+([^;]+);/g, (_, list) => {
  list.split(',').forEach(name => declarations.add(name.trim()));
  return '';
});
const samplers = [...declarations].filter(name => new RegExp(`\\b${name}\\b`).test(source));
assert.equal(samplers.length, 16, 'Terrain must reuse its existing 16 combined sampler identities');
for (const name of ['uMacro', 'uFar', 'uDent']) assert.ok(samplers.includes(name));
assert.match(shader, /#ifdef MANUAL_BILINEAR[\s\S]*textureLod\(map,b\+e\.xx,0\.0\)/,
  'Height shadow sampling must retain float-linear fallback');
assert.match(shader, /receiver\.y \+= uSag\+dot\(cameraOffset,cameraOffset\)\/\(2\.0\*uCurveR\)\+0\.34/,
  'Heightfield rays must restore unsagged, uncurved world coordinates');
assert.match(shader, /if\(facB\*coneB\*uFacilityBPower > 0\.001\)\{[\s\S]*practicalTerrainVisibility\(uFacilityB\.xyz,fdB\)/);
assert.match(shader, /if\(cone > 0\.001 && dl < uLampRange\)\{[\s\S]*practicalTerrainVisibility\(uLamp,dl\)/);
assert.match(shader, /uTerrainLightSteps < 1\.0 \|\| lightDistance < 0\.6 \|\| lightDistance > 96\.0 \|\| viewDistance > 160\.0/);
assert.match(shader, /for\(int i=0; i<8; i\+\+\)/);
assert.match(shader, /if\(float\(i\) >= uTerrainLightSteps\) break/);

const stepUniform = terrain.uniforms.uTerrainLightSteps;
const ringUniforms = { ...terrain.uniforms };
for (const [key, expected] of [['low', 0], ['medium', 0], ['high', 4], ['ultra', 8]]) {
  assert.equal(QUALITY[key].terrainLightSteps, expected);
  // Keep the geometry fields constant here so the regression isolates a live
  // lighting-quality change and cannot allocate a terrain bake or lose ruts.
  terrain.setQuality({ ...QUALITY.high, name: QUALITY[key].name, terrainLightSteps: expected });
  assert.equal(terrain.uniforms.uTerrainLightSteps, stepUniform);
  assert.equal(ringUniforms.uTerrainLightSteps.value, expected);
}
terrain.setQuality({ ...QUALITY.high, terrainLightSteps: 64 });
assert.equal(stepUniform.value, 8, 'User/profile data cannot exceed the compiled ray-step budget');
terrain.setQuality({ ...QUALITY.high, terrainLightSteps: -4 });
assert.equal(stepUniform.value, 0);

// Representative height-ray contract: a level surface stays lit while a broad
// intervening slope blocks both budgets; fractional clearance fades smoothly.
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function rayVisibility(steps, heightAt, receiverHeight = 0) {
  let visibility = 1;
  for (let i = 0; i < steps; i++) {
    const t = (i + 1) / (steps + 1);
    const x = t * 40;
    const rayY = mix(receiverHeight + 0.34, 2.5, t);
    visibility = Math.min(visibility, smoothstep(-0.06, 0.24, rayY - heightAt(x)));
  }
  return visibility;
}
for (const steps of [4, 8]) {
  assert.equal(rayVisibility(steps, () => 0), 1, 'Flat ground must not shadow itself');
  assert.equal(rayVisibility(steps, x => x > 8 && x < 30 ? 4 : 0), 0, 'Broad terrain ridge blocks a practical light');
  assert.equal(rayVisibility(steps, () => -0.4, -0.4), 1, 'An excavated flat receiver retains light');
}

for (const disposable of [terrain.material, terrain._emptyShadow, terrain.trailRT.texture, terrain.sunRT.texture]) disposable.dispose();
console.log(`PASS: ${cases} production-GLSL BRDF cases: bounded response, correct roughness lobe and grazing Fresnel.`);
console.log('PASS: shared light response, derivative specular AA, 16 sampler budget, bounded cone/range ray work.');
console.log('PASS: live 0/0/4/8 quality steps, shared ring uniforms, terrain-ray coordinate and ridge contracts.');
console.log('GPU shader compilation, visual shadow quality and Mac/4070 performance still require browser checks.');
