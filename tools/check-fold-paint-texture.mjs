// Run: node tools/check-fold-paint-texture.mjs
// Packing, loading, and ownership checks; actual GPU sampling needs browser QA.
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./three-node-loader.mjs', import.meta.url);
const THREE = await import('three');
const { createFoldPaintTexture, packFoldPaintPixels } = await import('../src/world/fold-paint-texture.js');

const geology = new Uint8Array([0, 1, 2, 3, 10, 11, 12, 13, 100, 101, 102, 103, 250, 251, 252, 255]);
// Distinct top and bottom rows detect a hidden image or geology inversion.
const painting = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
const originalGeology = geology.slice();
const packed = packFoldPaintPixels(geology, 2, 2, painting);
assert.deepEqual(packed.slice(0, 16), geology);
assert.deepEqual(packed.slice(16), new Uint8Array(painting));
assert.notEqual(packed.buffer, geology.buffer, 'array allocation never aliases CPU geology');
packed[0] = 99;
assert.deepEqual(geology, originalGeology);
assert.throws(() => packFoldPaintPixels(geology, 0, 2), RangeError);
assert.throws(() => packFoldPaintPixels(geology, 2, 2, new Uint8Array(4)), TypeError);

const source = new THREE.DataTexture(geology, 2, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
source.wrapS = source.wrapT = THREE.ClampToEdgeWrapping;
source.magFilter = THREE.LinearFilter;
source.minFilter = THREE.LinearMipmapLinearFilter;
source.generateMipmaps = true;
source.anisotropy = 1;
source.colorSpace = THREE.NoColorSpace;
source.needsUpdate = true;
const sourceVersion = source.version;
const terrain = { texGeology: source };
let sourceDisposals = 0;
source.addEventListener('dispose', () => sourceDisposals++);
const savedImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const defineGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
const restoreGlobal = (name, descriptor) => {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
};

try {
  defineGlobal('Image', undefined);
  defineGlobal('document', undefined);
  const offline = createFoldPaintTexture(terrain);
  assert.equal(await offline.ready, false, 'Node use is safe without browser APIs');
  assert.ok(offline.texture.isDataArrayTexture);
  assert.deepEqual([offline.texture.image.width, offline.texture.image.height, offline.texture.image.depth], [2, 2, 2]);
  assert.equal(offline.texture.image.data.byteLength, 32);
  assert.deepEqual(offline.texture.image.data.slice(0, 16), geology);
  for (let offset = 16; offset < 32; offset += 4) {
    assert.deepEqual([...offline.texture.image.data.slice(offset, offset + 4)], [23, 45, 89, 255]);
  }
  for (const property of ['wrapS', 'wrapT', 'magFilter', 'minFilter', 'generateMipmaps', 'anisotropy']) {
    assert.equal(offline.texture[property], source[property], `preserve ${property}`);
  }
  assert.equal(offline.texture.format, THREE.RGBAFormat);
  assert.equal(offline.texture.type, THREE.UnsignedByteType);
  assert.equal(offline.texture.colorSpace, THREE.NoColorSpace);
  assert.equal(offline.texture.flipY, false);
  assert.equal(offline.texture.unpackAlignment, 1);
  let offlineDisposals = 0;
  offline.texture.addEventListener('dispose', () => offlineDisposals++);
  offline.dispose(); offline.dispose();
  assert.equal(offlineDisposals, 1, 'helper disposal is idempotent');

  const images = [];
  class FakeImage {
    constructor() { images.push(this); }
    set src(value) { this.url = value; }
  }
  let drawn = null;
  const context = {
    drawImage(...args) { drawn = args; },
    getImageData(x, y, width, height) {
      assert.deepEqual([x, y, width, height], [0, 0, 2, 2]);
      return { data: painting };
    }
  };
  const canvas = { getContext(kind) { assert.equal(kind, '2d'); return context; } };
  defineGlobal('Image', FakeImage);
  defineGlobal('document', { createElement(tag) { assert.equal(tag, 'canvas'); return canvas; } });

  const loaded = createFoldPaintTexture(terrain, { url: 'fixture-paint.png' });
  const loadedData = loaded.texture.image.data;
  const beforeVersion = loaded.texture.version;
  const successImage = images.at(-1);
  assert.equal(successImage.url, 'fixture-paint.png');
  successImage.onload();
  assert.equal(await loaded.ready, true);
  assert.equal(loaded.texture.image.data, loadedData, 'loading retains the original array allocation');
  assert.deepEqual(loadedData.slice(0, 16), geology, 'loading cannot alter geology');
  assert.deepEqual(loadedData.slice(16), new Uint8Array(painting), 'canvas top row remains painting UV y=0');
  assert.equal(loaded.texture.version, beforeVersion + 1, 'successful loading requests a fresh upload');
  assert.deepEqual(drawn, [successImage, 0, 0, 2, 2], 'image fills the layer dimensions');
  assert.equal(canvas.width, 2); assert.equal(canvas.height, 2);
  assert.equal(successImage.onload, null); assert.equal(successImage.onerror, null);
  loaded.dispose();

  const failed = createFoldPaintTexture(terrain);
  assert.equal(images.at(-1).url, 'assets/textures/events/dimensional-starry-oil.png');
  const failedData = failed.texture.image.data.slice();
  images.at(-1).onerror();
  assert.equal(await failed.ready, false);
  assert.deepEqual(failed.texture.image.data, failedData, 'failed image leaves valid placeholder data');
  failed.dispose();

  const cancelled = createFoldPaintTexture(terrain);
  const cancelledImage = images.at(-1), lateLoad = cancelledImage.onload;
  const cancelledVersion = cancelled.texture.version;
  cancelled.dispose();
  assert.equal(await cancelled.ready, false, 'disposing a pending load settles its promise');
  lateLoad();
  assert.equal(cancelled.texture.version, cancelledVersion, 'late loading cannot re-upload a disposed texture');
  assert.equal(cancelledImage.onload, null); assert.equal(cancelledImage.onerror, null);

  const unreadable = createFoldPaintTexture(terrain);
  context.getImageData = () => { throw new Error('Canvas readback failed'); };
  images.at(-1).onload();
  assert.equal(await unreadable.ready, false, 'canvas errors preserve game fallback');
  unreadable.dispose();

  assert.equal(terrain.texGeology, source, 'caller alone owns texture replacement');
  assert.equal(source.version, sourceVersion, 'source upload state remains unchanged');
  assert.equal(sourceDisposals, 0, 'helper never disposes the terrain source');
  assert.deepEqual(geology, originalGeology);
} finally {
  restoreGlobal('Image', savedImage);
  restoreGlobal('document', savedDocument);
  source.dispose();
}

console.log('PASS: exact geology bytes; two RGBA8 layers; top-down paint rows; preserved filtering/mips; one load allocation; fallback and cancellation; caller-owned source disposal.');
