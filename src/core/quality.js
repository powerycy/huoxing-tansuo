// Explicit, portable quality profiles. Hardware names describe intended use,
// not measured frame-rate guarantees or automatic GPU detection.
export const QUALITY_KEYS = Object.freeze(['low', 'medium', 'high', 'ultra']);
export const QUALITY = Object.freeze({
  low: Object.freeze({
    name: 'LOW', label: '低', maxDpr: 1.5, minDpr: 1, pixels: 0.85e6,
    clipM: 88, clipLevels: 7, clipCell: 0.28,
    stars: 2500, boulders: 420, trailRes: 1024, sunRes: 512, sunSteps: 36, dentRes: 2048,
    shadow: 0, roverShadow: 0, stationShadow: 0, terrainLightSteps: 0,
    anisotropy: 4, bloom: false, msaa: 0, fxaa: 0.72, dust: 500
  }),
  medium: Object.freeze({
    name: 'MEDIUM', label: '中', maxDpr: 1.75, minDpr: 1, pixels: 1.6e6,
    clipM: 128, clipLevels: 8, clipCell: 0.20,
    stars: 6000, boulders: 1000, trailRes: 2048, sunRes: 768, sunSteps: 52, dentRes: 2048,
    shadow: 1024, roverShadow: 512, stationShadow: 0, terrainLightSteps: 0,
    anisotropy: 4, bloom: true, msaa: 0, fxaa: 0.86, dust: 1200
  }),
  high: Object.freeze({
    name: 'HIGH', label: '高 · Mac', maxDpr: 2, minDpr: 1, pixels: 2.4e6,
    clipM: 160, clipLevels: 9, clipCell: 0.16,
    stars: 11000, boulders: 1500, trailRes: 4096, sunRes: 1024, sunSteps: 76, dentRes: 4096,
    shadow: 2048, roverShadow: 1024, stationShadow: 1536, terrainLightSteps: 4,
    anisotropy: 8, bloom: true, msaa: 4, fxaa: 0.94, dust: 2200
  }),
  ultra: Object.freeze({
    name: 'ULTRA', label: '极致 · 4070S', maxDpr: 2, minDpr: 1.15, pixels: 4.2e6,
    clipM: 192, clipLevels: 9, clipCell: 0.13,
    stars: 16000, boulders: 2200, trailRes: 4096, sunRes: 1536, sunSteps: 96, dentRes: 4096,
    shadow: 4096, roverShadow: 2048, stationShadow: 2048, terrainLightSteps: 8,
    anisotropy: 16, bloom: true, msaa: 4, fxaa: 1, dust: 3200
  })
});

export function isApplePlatform(platform = '') {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function selectStartupQuality({ requested, stored, platform = '', cores = 4, memory = 0, coarse = false } = {}) {
  if (QUALITY_KEYS.includes(requested)) return requested;
  if (QUALITY_KEYS.includes(stored)) return stored;
  if (/Mac/i.test(platform) && !coarse) return 'high';
  let tier = cores >= 8 && (!memory || memory >= 8) ? 2 : cores >= 6 || memory >= 4 ? 1 : 0;
  if (coarse) tier = Math.max(0, tier - 1);
  return QUALITY_KEYS[tier];
}

export function renderPixelRatio(q, width, height, deviceDpr = 1, scale = 1) {
  const w = Math.max(1, width), h = Math.max(1, height);
  const desired = Math.min(q.maxDpr, Math.max(q.minDpr || 1, deviceDpr));
  // Never violate the pixel budget even on an extremely large desktop.
  return Math.min(desired, Math.sqrt(q.pixels / (w * h))) * Math.min(1, Math.max(0.1, scale));
}

export function renderFeatures(q, { stableFramebuffer = false, hdrSupported = true, maxSamples = 0 } = {}) {
  const hdr = hdrSupported && !stableFramebuffer;
  return { hdr, bloom: hdr && q.bloom, samples: hdr ? Math.min(q.msaa || 0, maxSamples) : 0 };
}
