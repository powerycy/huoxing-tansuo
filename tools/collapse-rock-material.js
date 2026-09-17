import * as THREE from 'three';
import {mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';

// Only the study imports this module. Coordinates are captured before animation:
// every fragment shares the same material scale, with no world-space swimming.
const vertexPars = `
attribute vec3 rockRestPosition;
attribute vec3 rockRestNormal;
varying vec3 vRockPosition;
varying vec3 vRockProjectionNormal;
`;
const fragmentPars = `
uniform sampler2D rockColor;
uniform sampler2D rockNormal;
uniform sampler2D rockArm;
varying vec3 vRockPosition;
varying vec3 vRockProjectionNormal;
float rockNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  vec3 k = vec3(17.1, 43.7, 113.5);
  float n = dot(i, k);
  return mix(mix(mix(fract(sin(n) * 43758.5453), fract(sin(n + k.x) * 43758.5453), f.x),
                 mix(fract(sin(n + k.y) * 43758.5453), fract(sin(n + k.x + k.y) * 43758.5453), f.x), f.y),
             mix(mix(fract(sin(n + k.z) * 43758.5453), fract(sin(n + k.x + k.z) * 43758.5453), f.x),
                 mix(fract(sin(n + k.y + k.z) * 43758.5453), fract(sin(n + k.x + k.y + k.z) * 43758.5453), f.x), f.y), f.z);
}
float rockStrata(vec3 p) {
  float warp = rockNoise(p * vec3(.75, .32, .75));
  float strata = sin(p.y * 13.0 + warp * 7.0 + sin(p.x * .5) * .7);
  return smoothstep(.66, .94, strata) * smoothstep(.25, .7, rockNoise(p * 1.3 + 5.0));
}
vec3 rockBump(vec3 base, float height) {
  vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, base), r2 = cross(base, sx);
  float det = dot(sx, r1);
  if (abs(det) < 0.0000000001) return base;
  return normalize(abs(det) * base - sign(det) * (dFdx(height) * r1 + dFdy(height) * r2));
}
vec3 rockWeights() {
  vec3 w = pow(abs(normalize(vRockProjectionNormal)), vec3(4.0));
  return w / max(dot(w, vec3(1.0)), 0.0001);
}
vec4 rockSample(sampler2D tex, vec3 p, vec3 w) {
  return texture2D(tex, p.zy) * w.x + texture2D(tex, p.xz) * w.y + texture2D(tex, p.xy) * w.z;
}
vec3 rockPerturb(vec3 base, vec3 p, vec3 w, float strength) {
  vec3 x = texture2D(rockNormal, p.zy).xyz * 2.0 - 1.0;
  vec3 y = texture2D(rockNormal, p.xz).xyz * 2.0 - 1.0;
  vec3 z = texture2D(rockNormal, p.xy).xyz * 2.0 - 1.0;
  x.xy *= strength; y.xy *= strength; z.xy *= strength;
  vec3 nx = getTangentFrame(-vViewPosition, base, p.zy) * normalize(x);
  vec3 ny = getTangentFrame(-vViewPosition, base, p.xz) * normalize(y);
  vec3 nz = getTangentFrame(-vViewPosition, base, p.xy) * normalize(z);
  return normalize(nx * w.x + ny * w.y + nz * w.z);
}
`;

function makeMaterial(original, textures, interior) {
  const mat = original.clone();
  mat.name = interior ? '断面 · 干燥冷灰岩石' : '外表 · 扫描岩皮与细节';
  mat.metalness = 0;
  mat.roughness = 1;
  mat.roughnessMap = null; mat.metalnessMap = null;
  // Keep the original scan normal on the exterior. Interior has no scan UVs.
  if (interior) { mat.map = null; mat.normalMap = textures.normal; mat.aoMap = null; }
  mat.normalScale.set(.65, .65);
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      rockColor: {value: textures.color}, rockNormal: {value: textures.normal}, rockArm: {value: textures.arm},
    });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + vertexPars)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRockPosition = rockRestPosition;\nvRockProjectionNormal = rockRestNormal;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <normalmap_pars_fragment>', '#include <normalmap_pars_fragment>\n' + fragmentPars)
      .replace('#include <map_fragment>', `
        ${interior ? '' : '#include <map_fragment>'}
        vec3 rw = rockWeights();
        vec3 rp = vRockPosition * 0.30;
        vec3 rockTexel = rockSample(rockColor, rp, rw).rgb;
        float grain = dot(rockTexel, vec3(0.2126, 0.7152, 0.0722));
        float fineGrain = dot(rockSample(rockColor, rp * 4.7 + vec3(0.37), rw).rgb, vec3(0.2126, 0.7152, 0.0722));
        ${interior
          ? 'diffuseColor.rgb = vec3(0.20, 0.212, 0.22) * clamp(0.62 + grain * 3.1, 0.66, 1.38);'
          : 'float scanLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(scanLuma), 0.87) * vec3(0.78, 0.82, 0.85) * clamp(0.76 + grain * 1.9, 0.8, 1.24);'}
        diffuseColor.rgb *= clamp(0.9 + fineGrain * 0.7, 0.92, 1.07);
        diffuseColor.rgb *= 1.0 - rockStrata(vRockPosition) * ${interior ? '0.16' : '0.09'};
      `)
      .replace('#include <roughnessmap_fragment>', `
        vec3 surfaceArm = rockSample(rockArm, vRockPosition * 0.30, rockWeights()).rgb;
        float roughnessFactor = clamp(0.72 + surfaceArm.g * 0.25, 0.76, 0.97);
        diffuseColor.rgb *= mix(0.87, 1.0, surfaceArm.r);
      `)
      .replace('#include <normal_fragment_maps>', `
        ${interior ? '' : '#include <normal_fragment_maps>'}
        normal = rockPerturb(normal, vRockPosition * 0.30, rockWeights(), ${interior ? '0.95' : '0.55'});
        normal = rockPerturb(normal, vRockPosition * 1.41 + vec3(0.37), rockWeights(), 0.19);
        normal = rockBump(normal, -rockStrata(vRockPosition) * ${interior ? '0.019' : '0.008'});
      `);
  };
  mat.customProgramCacheKey = () => `collapse-rock-v1-${interior}`;
  return mat;
}

// Shallow, inward-only relief: do not alter the baked collision hull or move
// fracture rims. Shared coordinates avoid cracks between subdivided triangles.
export function roughenCutSurface(source) {
  const src = source.index ? source.toNonIndexed() : source.clone();
  const pos = src.getAttribute('position');
  const edges = new Map(), triangles = [];
  const key = p => p.toArray().map(v => Math.round(v * 10000)).join(',');
  for (let i = 0; i < pos.count; i += 3) {
    const v = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, i + k));
    const n = new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0])).normalize();
    triangles.push({v, n});
    for (let j = 0; j < 3; j++) {
      const a = v[j], b = v[(j + 1) % 3], id = [key(a), key(b)].sort().join('|');
      const e = edges.get(id);
      if (e) { e.count++; if (e.normal.dot(n) < .995) e.corner = true; }
      else edges.set(id, {a, b, normal: n, count: 1, corner: false});
    }
  }
  const rims = [...edges.values()].filter(e => e.count === 1 || e.corner).map(e => new THREE.Line3(e.a, e.b));
  const positions = [], normals = [], scratch = new THREE.Vector3();
  function emit(v, n) {
    let distance = Infinity;
    for (const rim of rims) distance = Math.min(distance, rim.closestPointToPoint(v, true, scratch).distanceTo(v));
    const fade = THREE.MathUtils.smoothstep(distance, 0, .22);
    const f = Math.sin(v.x * 4.1 + Math.sin(v.z * 3.7)) * Math.sin(v.y * 5.3 + v.z * 2.9);
    const detail = Math.sin(v.x * 13.7 + v.y * 11.3 + v.z * 15.1);
    const depth = fade * (.021 + f * .012 + detail * .005);
    positions.push(v.x - n.x * depth, v.y - n.y * depth, v.z - n.z * depth);
    normals.push(n.x, n.y, n.z);
  }
  function subdivide(a, b, c, n, depth) {
    if (!depth) { emit(a, n); emit(b, n); emit(c, n); return; }
    const ab = a.clone().add(b).multiplyScalar(.5), bc = b.clone().add(c).multiplyScalar(.5), ca = c.clone().add(a).multiplyScalar(.5);
    subdivide(a, ab, ca, n, depth - 1); subdivide(ab, b, bc, n, depth - 1);
    subdivide(ca, bc, c, n, depth - 1); subdivide(ab, bc, ca, n, depth - 1);
  }
  for (const {v, n} of triangles) subdivide(...v, n, 2);
  const raw = new THREE.BufferGeometry();
  raw.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  raw.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  // Preserve separate vertices across hard cap corners when welding.
  const geo = mergeVertices(raw, .00001); geo.computeVertexNormals();
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  geo.computeBoundingBox(); geo.computeBoundingSphere(); raw.dispose(); src.dispose();
  return geo;
}

export async function enhanceStudyRocks(model, renderer) {
  const loader = new THREE.TextureLoader();
  const [color, normal, arm] = await Promise.all([
    loader.loadAsync('../assets/textures/collapse-rock/diffuse-4k.jpg'),
    loader.loadAsync('../assets/textures/collapse-rock/normal-gl-4k.jpg'),
    loader.loadAsync('../assets/textures/environment/seaside_rock/arm.jpg'),
  ]);
  color.colorSpace = THREE.SRGBColorSpace;
  for (const tex of [color, normal, arm]) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }
  model.updateMatrixWorld(true);
  let caps = 0, exteriors = 0;
  model.traverse(mesh => {
    if (!mesh.isMesh || mesh.name === '接触地面') return;
    mesh.userData.studyOriginal = {geometry: mesh.geometry, material: mesh.material};
    const interior = mesh.material.name === '新鲜断面';
    if (interior) { mesh.geometry = roughenCutSurface(mesh.geometry); caps++; } else exteriors++;
    const geometry = mesh.geometry, positions = geometry.attributes.position, normals = geometry.attributes.normal;
    const restP = [], restN = [], normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < positions.count; i++) {
      restP.push(...new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).toArray());
      restN.push(...new THREE.Vector3().fromBufferAttribute(normals, i).applyNormalMatrix(normalMatrix).toArray());
    }
    geometry.setAttribute('rockRestPosition', new THREE.Float32BufferAttribute(restP, 3));
    geometry.setAttribute('rockRestNormal', new THREE.Float32BufferAttribute(restN, 3));
    mesh.material = makeMaterial(mesh.material, {color, normal, arm}, interior);
    mesh.userData.studyEnhanced = {geometry: mesh.geometry, material: mesh.material};
  });
  return {caps, exteriors};
}
