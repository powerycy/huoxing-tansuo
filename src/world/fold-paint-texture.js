import * as THREE from 'three';

const PLACEHOLDER_RGBA = [23, 45, 89, 255];

/** Pack two RGBA8 layers without changing either source's row order.
 * Painting pixels follow Canvas ImageData: the first row is the image's TOP.
 * With flipY=false, painting UV y=0 therefore addresses its top edge. The
 * shader should choose its canvas orientation explicitly, not flip geology.
 */
export function packFoldPaintPixels(geologyPixels, width, height, paintingPixels = null) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError('Fold painting requires positive integer texture dimensions.');
  }
  const layerBytes = width * height * 4;
  const isRGBA8 = pixels => (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)
    && pixels.length === layerBytes;
  if (!isRGBA8(geologyPixels) || (paintingPixels !== null && !isRGBA8(paintingPixels))) {
    throw new TypeError('Fold painting layers must contain width × height RGBA8 pixels.');
  }
  const data = new Uint8Array(layerBytes * 2);
  data.set(geologyPixels);
  if (paintingPixels !== null) data.set(paintingPixels, layerBytes);
  else for (let offset = layerBytes; offset < data.length; offset += 4) data.set(PLACEHOLDER_RGBA, offset);
  return data;
}

/** One sampler holds unchanged geology (layer 0) and oil paint (layer 1).
 * The returned texture is immediately uploadable. ready resolves false on
 * load failure, missing browser APIs, or cancellation; the placeholder stays
 * valid. This helper never replaces or disposes terrain.texGeology: its caller
 * owns that swap and must retain the existing shared uniform wrapper.
 */
export function createFoldPaintTexture(terrain, {
  url = 'assets/textures/events/dimensional-starry-oil.png'
} = {}) {
  const source = terrain.texGeology;
  const { data: geologyPixels, width, height } = source.image;
  const data = packFoldPaintPixels(geologyPixels, width, height);
  const layerBytes = width * height * 4;
  const texture = new THREE.DataArrayTexture(data, width, height, 2);
  texture.name = 'DimensionalOilPaintingAndGeology';
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = source.wrapS;
  texture.wrapT = source.wrapT;
  texture.magFilter = source.magFilter;
  texture.minFilter = source.minFilter;
  texture.generateMipmaps = source.generateMipmaps;
  texture.anisotropy = source.anisotropy;
  // Geology is linear control data. Painting bytes remain sRGB and need a
  // separate decode in the paint shader; array-wide sRGB would corrupt layer 0.
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;

  let image = null, settled = false, disposed = false, resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const finish = success => {
    if (settled) return;
    settled = true;
    if (image) { image.onload = null; image.onerror = null; image = null; }
    resolveReady(success);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    finish(false);
    texture.dispose();
  };

  if (typeof Image === 'undefined' || typeof document === 'undefined') finish(false);
  else {
    try {
      image = new Image();
      image.decoding = 'async';
      image.onload = () => {
        if (disposed) { finish(false); return; }
        try {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) { finish(false); return; }
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          context.drawImage(image, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height).data;
          // Only the painting layer changes; all rings keep the same texture
          // and data allocation, and the upload regenerates independent mips.
          data.set(pixels, layerBytes);
          texture.needsUpdate = true;
          finish(true);
        } catch { finish(false); }
      };
      image.onerror = () => finish(false);
      image.src = url;
    } catch { finish(false); }
  }
  return { texture, ready, dispose };
}
