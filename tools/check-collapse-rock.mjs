import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root = new URL('../', import.meta.url);
const threeURL = new URL('vendor/three/three.module.js', root).href;
const THREE = await import(threeURL);
const dataURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const utilities = readFileSync(new URL('vendor/three/examples/jsm/utils/BufferGeometryUtils.js', root), 'utf8')
  .replace(/from 'three'/g, `from '${threeURL}'`);
const source = readFileSync(new URL('tools/collapse-rock-material.js', root), 'utf8');
const moduleSource = source.replace(/from 'three'/g, `from '${threeURL}'`)
  .replace(/from 'three\/addons\/utils\/BufferGeometryUtils.js'/g, `from '${dataURL(utilities)}'`);
const {roughenCutSurface} = await import(dataURL(moduleSource));
const plane = new THREE.PlaneGeometry(2, 2);
const rough = roughenCutSurface(plane), again = roughenCutSurface(plane);
assert.equal(rough.index.count, plane.index.count * 16);
assert.deepEqual(rough.attributes.position.array, again.attributes.position.array);
let relief = false;
for (let i = 0; i < rough.attributes.position.count; i++) {
  const p = new THREE.Vector3().fromBufferAttribute(rough.attributes.position, i);
  const n = new THREE.Vector3().fromBufferAttribute(rough.attributes.normal, i);
  assert([...p, ...n].every(Number.isFinite));
  assert(Math.abs(n.length() - 1) < .0001);
  assert(p.z <= .000001 && p.z >= -.039, 'Inward-only relief below 4 cm');
  if (Math.abs(p.x) > .9999 || Math.abs(p.y) > .9999) assert(Math.abs(p.z) < .000001, 'Rims remain welded to the scan');
  if (p.z < -.001) relief = true;
}
assert(relief);
const textures = [
  ['diffuse-4k.jpg', 'c4b60a33201c3d4dfd9b94527691e476'],
  ['normal-gl-4k.jpg', 'ed4096ba697a01bc29ccdc4752325f0a'],
];
for (const [name, md5] of textures) {
  const file = readFileSync(new URL('assets/textures/collapse-rock/' + name, root));
  assert.equal(createHash('md5').update(file).digest('hex'), md5);
}
assert(source.includes('rockRestPosition'));
assert(!/localStorage|indexedDB|src\/main|startGame/.test(source));
const html = readFileSync(new URL('tools/collapse-study.html', root), 'utf8');
assert(/id="originalRock"/.test(html));
assert(!/id="originalRock"[^>]*checked/.test(html), 'Enhanced appearance is the default');
console.log('PASS: authentic 4K texture hashes; deterministic inward relief; intact rims; finite normals; comparison default; study isolation.');
