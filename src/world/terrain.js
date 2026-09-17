/* ============================================================
   UTOPIA PLANITIA — terrain
   ------------------------------------------------------------
   • Height is BAKED on the CPU into Float textures; the GPU only ever
     samples them.  Physics and pixels therefore agree exactly.
   • Rendered as a 9-level geometry clipmap centred on the camera:
     0.16 m cells under the wheels, 41 m cells at the 5 km horizon,
     ~370 k triangles total, zero per-frame CPU geometry work.
   • A baked sun-occlusion mask gives kilometre-long crater shadows.
   • A GPU "trail" buffer records the compacted surface and grouser marks.
   • A CPU-authoritative dent field carries the real geometry: wheel ruts
     with displaced berms, drill pits, and wheelspin holes — the ones
     that were churned slump at the angle of repose, the compacted ones
     stay exactly where you put them.
   ============================================================ */
import * as THREE from 'three';
import { fbm, ridged, vnoise, hash2i, clamp, sstep, lerp } from '../core/rng.js';

/* ---------------- world constants (metres) ---------------- */
export const MARS_G = 3.71;

export const MACRO_EXT = 1200, MACRO_RES = 2048;      // 0.586 m / texel
export const FAR_EXT = 7200, FAR_RES = 512;           // horizon scenery
export const DET_TILE = 16, DET_RES = 256;            // 0.0625 m / texel, tiling
export const DENT_EXT = 1024;                         // excavation field extent
export const SUNMASK_EXT = 1500, SUNMASK_RES = 1024;

export const RIM_R = 470, RIM_W = 74;                 // crater rim wall
export const PLAYABLE_R = 432;                        // soft mission fence

// Geometry carries only the relief that can change a wheel contact.  The old
// amplitudes made every square metre undulate, so the basin read as procedural
// noise instead of compacted regolith.  Centimetre grain stays in the normal
// maps where it belongs.
const DET_AMP = 0.22, DET_AMP2 = 0.052, DET_SCALE2 = 4.33;
const BERM_OUT = 1.72;      // berm reaches this multiple of the rut half-width
const BERM_GAIN = 0.85;     // how much of the displaced volume shows up as lip
const DIG_CAP = 0.48;       // buried to the axle; past this you are not driving out
const SLUMP_TTL = 2.4;                                // seconds an excavation keeps settling
const CURVE_R = 620000;                               // horizon-curvature radius

/* ============================================================
   1.  THE SHAPE OF THE BASIN  (smooth, low-frequency)
   ============================================================ */
const RILLE_CUT = 2.6;
const rilleProfile = (t) => 1 / (1 + Math.pow(t, 6));
const RILLE_EDGE = rilleProfile(RILLE_CUT);

function rilleH(x, z) {
  // A sinuous graben running roughly N–S through the western floor.
  if (z < -470 || z > 470) return 0;
  const xc = -168 + 118 * Math.sin(z * 0.0061) + 46 * Math.sin(z * 0.0172 + 1.3)
                  + 17 * Math.sin(z * 0.041 - 0.4);
  const w = 27 + 9 * Math.sin(z * 0.0102 + 2.1);
  const d = Math.abs(x - xc);
  const t = d / w;
  if (t > RILLE_CUT) return 0;
  // collapsed section around z≈95 forms the only natural crossing
  const bridge = Math.exp(-Math.pow((z - 95) / 46, 2)) * 0.97;
  const taper = sstep(470, 380, Math.abs(z));
  // A single C-infinity profile — flat floor, steep shoulders, exactly zero at
  // the cut-off. The obvious two-branch version leaves a five-metre step at the
  // wall, and the Catmull-Rom upsample rings across that step into a row of
  // shark fins running the whole length of the graben.
  const prof = -(rilleProfile(t) - RILLE_EDGE) / (1 - RILLE_EDGE);
  return prof * 17.5 * (1 - bridge) * taper;
}

/** Smooth basin form. Shared by the near AND far bakes so they blend seamlessly. */
export function baseHeight(x, z) {
  const r = Math.hypot(x, z);
  // Broad, anisotropic undulation first.  A quieter second octave breaks the
  // silhouette without carpeting the whole floor in equal-sized bumps.
  let h = (fbm(x * 0.00118, z * 0.00152, 3, 2.03, 0.47, 11) - 0.5) * 25;
  h += (fbm(x * 0.0032 + 19, z * 0.0025 - 7, 2, 2.10, 0.42, 29) - 0.5) * 5.5;

  // broad bowl: the floor sinks toward the middle
  h -= 36 * sstep(RIM_R - 40, 55, r);

  // rim wall — ridged crests, with azimuthal breaches that let ejecta out
  const ang = Math.atan2(z, x);
  const breach = fbm(Math.cos(ang) * 1.55 + 5, Math.sin(ang) * 1.55 + 9, 3, 2.0, 0.5, 77);
  let rimAmp = 112 * (0.30 + 1.05 * breach);
  // A wide southern saddle turns the circular crater wall into an asymmetric
  // layered horizon from the delivery start.  It preserves the side masses,
  // but opens a broad low route beneath the giant primary instead of closing
  // the view with one uniformly tall procedural ring.
  const southSaddle = Math.exp(-Math.pow((x + 35) / 225, 2))
                    * Math.exp(-Math.pow((z + RIM_R) / 165, 2));
  rimAmp *= 1 - southSaddle * 0.76;
  const prof = Math.exp(-Math.pow((r - RIM_R) / RIM_W, 2));
  h += rimAmp * prof * (0.5 + 0.95 * ridged(x * 0.0062, z * 0.0062, 4, 2.1, 0.5, 31));

  // terraced apron on the inner face of the wall
  const terr = sstep(RIM_R - 150, RIM_R - 20, r) * (1 - sstep(RIM_R, RIM_R + 60, r));
  h += terr * 6.5 * Math.sin(r * 0.092 + fbm(x * 0.004, z * 0.004, 2, 2, .5, 3) * 4.2);

  // outside the wall: fall away, then distant ridge country
  const outT = sstep(RIM_R + RIM_W * 0.55, RIM_R + 430, r);
  h -= 62 * outT;
  h += sstep(RIM_R + 130, RIM_R + 900, r) *
       (ridged(x * 0.00185, z * 0.00220, 5, 2.1, 0.55, 5) - 0.32) * 158;

  // Central massif — crustal rebound after the impact. Wide rather than tall:
  // a narrow peak of the same height would exceed 35° and simply could not be
  // driven, and the whole last mission happens on top of it.
  const cm = Math.exp(-Math.pow(r / 145, 2));
  h += cm * (42 + 18 * ridged(x * 0.0175, z * 0.0175, 4, 2.1, 0.5, 61));

  h += rilleH(x, z);
  return h;
}

/* ============================================================
   2.  CRATERS  (splatted, not evaluated per-texel)
   ============================================================ */
const TIERS = [
  //  cell, rMin, rMax, prob, depth, seed
  [148, 31, 68, 0.38, 0.145, 3],
  [ 54, 10, 25, 0.43, 0.168, 17],
  [ 19,  2.8, 8.0, 0.48, 0.185, 41]
];

// A few named impacts establish readable, kilometre-scale geology.  The
// statistical field below supplies the smaller population around them.
const LANDMARK_CRATERS = [
  [ 286,   52, 92, 0.58, 0.128],
  [-286,  176, 74, 0.34, 0.148],
  [ 192, -272, 108, 0.72, 0.118]
];

/** classic bowl + raised rim + ejecta skirt, normalised to unit radius */
function craterProfile(t, age) {
  // t = d / r ;  age 0 = fresh & deep, 1 = ancient & filled
  if (t >= 1.92) return 0;
  const depth = lerp(1.0, 0.22, age);
  if (t < 1.0) {
    const c = Math.cos(t * Math.PI) * 0.5 + 0.5;          // 1 at centre -> 0 at rim
    const flat = lerp(1.35, 2.2, age);                     // older craters flatten out
    return -Math.pow(c, flat) * depth;
  }
  const u = (t - 1.0) / 0.92;
  return Math.sin(u * Math.PI) * (1 - u) * 0.55 * depth * lerp(1.0, 0.35, age);
}

function forEachCrater(ext, cb) {
  const half = ext * 0.5;
  for (let i = 0; i < LANDMARK_CRATERS.length; i++) {
    const [cx, cz, r, age, depth] = LANDMARK_CRATERS[i];
    if (Math.abs(cx) <= half + r * 2 && Math.abs(cz) <= half + r * 2) {
      cb(cx, cz, r, age, depth, -1);
    }
  }
  for (let ti = 0; ti < TIERS.length; ti++) {
    const [cell, rMin, rMax, prob, depth, seed] = TIERS[ti];
    const n = Math.ceil(ext / cell) + 2;
    const o = -half - cell;
    for (let gz = 0; gz < n; gz++) for (let gx = 0; gx < n; gx++) {
      if (hash2i(gx, gz, seed) > prob) continue;
      const cx = o + (gx + hash2i(gx, gz, seed + 1)) * cell;
      const cz = o + (gz + hash2i(gx, gz, seed + 2)) * cell;
      const rr = hash2i(gx, gz, seed + 3);
      const r = rMin + (rMax - rMin) * rr * rr;            // many small, few large
      const age = hash2i(gx, gz, seed + 4);
      // keep the central massif clean — the node is up there
      const dc = Math.hypot(cx, cz);
      if (dc < 82) continue;
      cb(cx, cz, r, age, depth, ti);
    }
  }
}

/* ============================================================
   3.  BAKING
   ============================================================ */
function bilinear(arr, res, ext, x, z) {
  // matches GL LinearFilter + ClampToEdge exactly
  let u = (x / ext + 0.5) * res - 0.5;
  let v = (z / ext + 0.5) * res - 0.5;
  const x0 = Math.floor(u), z0 = Math.floor(v);
  const fx = u - x0, fz = v - z0;
  const c = (a, b) => (a < 0 ? 0 : a > b ? b : a);
  const xa = c(x0, res - 1), xb = c(x0 + 1, res - 1);
  const za = c(z0, res - 1), zb = c(z0 + 1, res - 1);
  const h00 = arr[za * res + xa], h10 = arr[za * res + xb];
  const h01 = arr[zb * res + xa], h11 = arr[zb * res + xb];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}
function bilinearWrap(arr, res, x, z) {
  let u = x * res - 0.5, v = z * res - 0.5;
  const x0 = Math.floor(u), z0 = Math.floor(v);
  const fx = u - x0, fz = v - z0;
  const w = (a) => ((a % res) + res) % res;
  const xa = w(x0), xb = w(x0 + 1), za = w(z0), zb = w(z0 + 1);
  const h00 = arr[za * res + xa], h10 = arr[za * res + xb];
  const h01 = arr[zb * res + xa], h11 = arr[zb * res + xb];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}

/* periodic value noise, for the seamless detail tile */
function pvn(x, y, per, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = (a) => ((a % per) + per) % per;
  const a = hash2i(w(ix), w(iy), seed), b = hash2i(w(ix + 1), w(iy), seed);
  const c = hash2i(w(ix), w(iy + 1), seed), d = hash2i(w(ix + 1), w(iy + 1), seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Box-filtered mip chain. A clipmap ring with 19 m cells cannot represent a
    20 m crater bowl; without a filtered height field it interpolates straight
    across and leaves a row of tents on the horizon. */
function buildMips(base, res) {
  const mips = [{ data: base, width: res, height: res }];
  let src = base, w = res;
  while (w > 4) {
    const nw = w >> 1;
    const dst = new Float32Array(nw * nw);
    for (let y = 0; y < nw; y++) {
      const r0 = (y * 2) * w, r1 = r0 + w, o = y * nw;
      for (let x = 0; x < nw; x++) {
        const i = x * 2;
        dst[o + x] = (src[r0 + i] + src[r0 + i + 1] + src[r1 + i] + src[r1 + i + 1]) * 0.25;
      }
    }
    mips.push({ data: dst, width: nw, height: nw });
    src = dst; w = nw;
  }
  return mips;
}

/** Bake everything. Returns a generator: step it until done, reading .progress. */
export function* bakeTerrain(report) {
  /* --- 3a. macro base (coarse, then smoothly upsampled) --- */
  const CO = 640;                                    // coarse resolution of the smooth form
  const coarse = new Float32Array(CO * CO);
  for (let z = 0; z < CO; z++) {
    for (let x = 0; x < CO; x++) {
      const wx = (x / (CO - 1) - 0.5) * MACRO_EXT;
      const wz = (z / (CO - 1) - 0.5) * MACRO_EXT;
      coarse[z * CO + x] = baseHeight(wx, wz);
    }
    if ((z & 15) === 0) { report(0.02 + 0.20 * (z / CO), '正在塑造盆地'); yield; }
  }

  /* Catmull–Rom upsample, done SEPARABLY: rows first into a strip, then
     columns. The naive 2D form costs 21 M spline evaluations at this size and
     blocks the main thread for seconds; separating it costs 5.5 M. */
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  // precompute the x sample indices + parameter once; every row reuses them
  const xi = new Int32Array(MACRO_RES), xt = new Float32Array(MACRO_RES);
  for (let x = 0; x < MACRO_RES; x++) {
    const fx = (x / (MACRO_RES - 1)) * (CO - 1);
    xi[x] = Math.floor(fx); xt[x] = fx - xi[x];
  }
  const cx = (v) => (v < 0 ? 0 : v > CO - 1 ? CO - 1 : v);
  const strip = new Float32Array(CO * MACRO_RES);       // CO rows × full width
  for (let z = 0; z < CO; z++) {
    const row = z * CO, out = z * MACRO_RES;
    for (let x = 0; x < MACRO_RES; x++) {
      const i = xi[x];
      strip[out + x] = cr(coarse[row + cx(i - 1)], coarse[row + cx(i)],
                          coarse[row + cx(i + 1)], coarse[row + cx(i + 2)], xt[x]);
    }
    if ((z & 63) === 0) { report(0.22 + 0.05 * (z / CO), '正在解析地形起伏'); yield; }
  }

  const macro = new Float32Array(MACRO_RES * MACRO_RES);
  for (let z = 0; z < MACRO_RES; z++) {
    const fz = (z / (MACRO_RES - 1)) * (CO - 1), iz = Math.floor(fz), tz = fz - iz;
    const r0 = cx(iz - 1) * MACRO_RES, r1 = cx(iz) * MACRO_RES;
    const r2 = cx(iz + 1) * MACRO_RES, r3 = cx(iz + 2) * MACRO_RES;
    const out = z * MACRO_RES;
    for (let x = 0; x < MACRO_RES; x++) {
      macro[out + x] = cr(strip[r0 + x], strip[r1 + x], strip[r2 + x], strip[r3 + x], tz);
    }
    if ((z & 63) === 0) { report(0.27 + 0.09 * (z / MACRO_RES), '正在解析地形起伏'); yield; }
  }

  /* --- 3b. splat craters into the macro field --- */
  // RGBA geology control map, generated from the same impacts as the height
  // field so the material can never drift away from the actual landform:
  // R bowl deposits, G rim/ejecta, B exposed substrate, A dust maturity.
  const geology = new Uint8Array(MACRO_RES * MACRO_RES * 4);
  const px = MACRO_EXT / MACRO_RES;                  // metres per texel
  const half = MACRO_RES * 0.5;
  let done = 0, total = 0;
  forEachCrater(MACRO_EXT + 240, () => total++);
  const jobs = [];
  forEachCrater(MACRO_EXT + 240, (cx, cz, r, age, depth) => jobs.push([cx, cz, r, age, depth]));
  for (let ji = 0; ji < jobs.length; ji++) {
    const [cx, cz, r, age, depth] = jobs[ji];
    const R = r * 1.92, amp = r * depth;
    const gx0 = Math.max(0, Math.floor((cx - R) / px + half));
    const gx1 = Math.min(MACRO_RES - 1, Math.ceil((cx + R) / px + half));
    const gz0 = Math.max(0, Math.floor((cz - R) / px + half));
    const gz1 = Math.min(MACRO_RES - 1, Math.ceil((cz + R) / px + half));
    for (let gz = gz0; gz <= gz1; gz++) {
      const wz = (gz - half + 0.5) * px;
      for (let gx = gx0; gx <= gx1; gx++) {
        const wx = (gx - half + 0.5) * px;
        const d = Math.hypot(wx - cx, wz - cz) / r;
        if (d >= 1.92) continue;
        // radial noise on the lip so no crater is a perfect circle
        const wob = 1 + 0.13 * (vnoise(Math.atan2(wz - cz, wx - cx) * 2.4 + cx, cz * 0.1, 909) - 0.5) * 2;
        const dw = d * wob;
        macro[gz * MACRO_RES + gx] += craterProfile(dw, age) * amp;

        const gi = (gz * MACRO_RES + gx) * 4;
        // Filled, mature bowls retain fine dark dust. Fresh rims and ejecta
        // expose brighter angular fragments in a broken annulus.
        const bowl = dw < 1.02
          ? sstep(1.02, 0.18, dw) * (0.46 + age * 0.46) : 0;
        const rim = Math.exp(-Math.pow((dw - 1.02) / 0.17, 2)) * (0.54 + (1 - age) * 0.42);
        const ejecta = dw > 1.02
          ? sstep(1.92, 1.03, dw) * (0.34 + 0.66 * (1 - age)) : 0;
        geology[gi] = Math.max(geology[gi], Math.round(clamp(bowl, 0, 1) * 255));
        geology[gi + 1] = Math.max(geology[gi + 1], Math.round(clamp(Math.max(rim, ejecta * 0.52), 0, 1) * 255));
      }
    }
    done++;
    if ((ji & 127) === 0) { report(0.36 + 0.20 * (done / total), `正在生成撞击记录 · ${done}/${total}`); yield; }
  }

  /* --- 3c. classify exposed slopes and long-lived dust provinces --- */
  for (let z = 0; z < MACRO_RES; z++) {
    const zm = Math.max(0, z - 1), zp = Math.min(MACRO_RES - 1, z + 1);
    for (let x = 0; x < MACRO_RES; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(MACRO_RES - 1, x + 1);
      const dhx = (macro[z * MACRO_RES + xp] - macro[z * MACRO_RES + xm]) / (2 * px);
      const dhz = (macro[zp * MACRO_RES + x] - macro[zm * MACRO_RES + x]) / (2 * px);
      const slope = Math.hypot(dhx, dhz);
      const wx = (x - half + 0.5) * px, wz = (z - half + 0.5) * px;
      const gi = (z * MACRO_RES + x) * 4;
      const ejecta = geology[gi + 1] / 255;
      const exposure = sstep(0.16, 0.72, slope) * (0.72 + ejecta * 0.28);
      const province = fbm(wx * 0.0027 + 31, wz * 0.0022 - 17, 3, 2.03, 0.48, 93);
      geology[gi + 2] = Math.round(clamp(exposure, 0, 1) * 255);
      geology[gi + 3] = Math.round(clamp(0.18 + province * 0.74, 0, 1) * 255);
    }
    if ((z & 63) === 0) { report(0.56 + 0.06 * (z / MACRO_RES), '正在读取火星地质'); yield; }
  }

  /* --- 3d. far horizon field --- */
  const far = new Float32Array(FAR_RES * FAR_RES);
  for (let z = 0; z < FAR_RES; z++) {
    for (let x = 0; x < FAR_RES; x++) {
      const wx = (x / (FAR_RES - 1) - 0.5) * FAR_EXT;
      const wz = (z / (FAR_RES - 1) - 0.5) * FAR_EXT;
      far[z * FAR_RES + x] = baseHeight(wx, wz);
    }
    if ((z & 31) === 0) { report(0.62 + 0.08 * (z / FAR_RES), '正在绘制地平线'); yield; }
  }

  /* --- 3e. seamless detail tile: grain, clods, sub-metre pitting --- */
  const det = new Float32Array(DET_RES * DET_RES);
  const P = 16;                                       // noise lattice period inside the tile
  for (let z = 0; z < DET_RES; z++) {
    for (let x = 0; x < DET_RES; x++) {
      const u = x / DET_RES * P, v = z / DET_RES * P;
      let d = pvn(u, v, P, 5) * 0.5 + pvn(u * 2, v * 2, P * 2, 6) * 0.29
            + pvn(u * 4, v * 4, P * 4, 7) * 0.14 + pvn(u * 8, v * 8, P * 8, 8) * 0.07;
      det[z * DET_RES + x] = d - 0.5;
    }
    if ((z & 63) === 0) { report(0.70 + 0.04 * (z / DET_RES), '正在生成火星表土颗粒'); yield; }
  }
  // micro-craters, wrapped
  {
    const mpx = DET_TILE / DET_RES;
    const N = 26;
    for (let k = 0; k < 130; k++) {
      const cx = hash2i(k, 1, 313) * DET_TILE, cz = hash2i(k, 2, 313) * DET_TILE;
      const r = 0.16 + Math.pow(hash2i(k, 3, 313), 2.4) * 1.15;
      const age = hash2i(k, 4, 313);
      const R = r * 1.92;
      const g0x = Math.floor((cx - R) / mpx), g1x = Math.ceil((cx + R) / mpx);
      const g0z = Math.floor((cz - R) / mpx), g1z = Math.ceil((cz + R) / mpx);
      for (let gz = g0z; gz <= g1z; gz++) for (let gx = g0x; gx <= g1x; gx++) {
        const wx = gx * mpx, wz = gz * mpx;
        const d = Math.hypot(wx - cx, wz - cz) / r;
        if (d >= 1.92) continue;
        const ix = ((gx % DET_RES) + DET_RES) % DET_RES;
        const iz = ((gz % DET_RES) + DET_RES) % DET_RES;
        det[iz * DET_RES + ix] += craterProfile(d, age) * r * 0.30 / DET_AMP;
      }
    }
    // normalise to ±0.5 so DET_AMP is meaningful
    let mn = 1e9, mx = -1e9;
    for (let i = 0; i < det.length; i++) { if (det[i] < mn) mn = det[i]; if (det[i] > mx) mx = det[i]; }
    const s = 1 / Math.max(mx - mn, 1e-6);
    for (let i = 0; i < det.length; i++) det[i] = (det[i] - mn) * s - 0.5;
  }
  report(0.75, '火星表土地形已生成'); yield;
  const macroMips = buildMips(macro, MACRO_RES);
  const farMips = buildMips(far, FAR_RES);
  report(0.76, '正在生成远景层级'); yield;

  return { macro, far, det, geology, macroMips, farMips };
}

/* ============================================================
   4.  GLSL — one height function, shared by every terrain shader
   ============================================================ */
export const TERRAIN_GLSL = /* glsl */`
uniform sampler2D uMacro, uFar, uDetail, uDent, uTrail;
uniform vec4 uConst;      // MACRO_EXT, FAR_EXT, DET_TILE, DENT_EXT
uniform vec4 uConst2;     // DET_AMP, DET_AMP2, DET_SCALE2, TRAIL_EXT
uniform vec3 uCamXZ;      // camera x, z, detail-fade distance
uniform vec2 uLod;        // mip level this clipmap ring should read
uniform vec4 uTexRes;     // macro, far, detail, dent texel counts

#ifdef MANUAL_BILINEAR
/* Four taps and a lerp — what the sampler would have done for us. */
float texBil(sampler2D t, vec2 uv, float res){
  vec2 p = uv * res - 0.5;
  vec2 i = floor(p), f = fract(p);
  vec2 b = (i + 0.5) / res, e = vec2(1.0 / res, 0.0);
  float h00 = textureLod(t, b, 0.0).r;
  float h10 = textureLod(t, b + e.xy, 0.0).r;
  float h01 = textureLod(t, b + e.yx, 0.0).r;
  float h11 = textureLod(t, b + e.xx, 0.0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
  #define SAMPLE_H(t, uv, res, lod) texBil(t, uv, res)
#else
  #define SAMPLE_H(t, uv, res, lod) textureLod(t, uv, lod).r
#endif

float hMacro(vec2 p){
  vec2 uv = p / uConst.x + 0.5;
  float m = SAMPLE_H(uMacro, clamp(uv, 0.0005, 0.9995), uTexRes.x, uLod.x);
  float f = SAMPLE_H(uFar, p / uConst.y + 0.5, uTexRes.y, uLod.y);
  float r = length(p);
  return mix(m, f, smoothstep(520.0, 596.0, r));
}
float hDetail(vec2 p, float fade){
  // No fract() here: the texture is RepeatWrapping, and folding the coordinate
  // by hand would put a hard seam at every tile boundary in BOTH paths.
  float d  = SAMPLE_H(uDetail, p / uConst.z, uTexRes.z, 0.0) * uConst2.x;
  d += SAMPLE_H(uDetail, p / uConst2.z + vec2(0.37, 0.71), uTexRes.z, 0.0) * uConst2.y;
  return d * fade;
}
float hDent(vec2 p){
  vec2 uv = p / uConst.w + 0.5;
  if (any(lessThan(uv, vec2(0.001))) || any(greaterThan(uv, vec2(0.999)))) return 0.0;
  return SAMPLE_H(uDent, uv, uTexRes.w, 0.0);
}
float terrainH(vec2 p){
  float fade = 1.0 - smoothstep(95.0, 300.0, distance(p, uCamXZ.xy));
  return hMacro(p) + hDetail(p, fade) - hDent(p);
}
`;

/* ============================================================
   5.  TERRAIN OBJECT
   ============================================================ */
export class Terrain {
  constructor(renderer, baked, quality, caps = {}) {
    this.renderer = renderer;
    /* Height fields are R32F. Sampling them with LinearFilter needs
       OES_texture_float_linear, which three silently downgrades to NEAREST when
       absent — 0.6 m stair-steps across the whole basin. Where the extension is
       missing we filter in the shader instead. */
    this.manualBilinear = caps.floatLinear === false;
    this.macro = baked.macro; this.far = baked.far; this.det = baked.det;
    this.geology = baked.geology;
    this.quality = quality;

    /* ---- data textures ----
       R32F, not half: heights reach 160 m and half-float's 10-bit mantissa
       would quantise that to 12 cm steps — visibly terraced ground. The
       Float32Array IS the texture, so there is no conversion cost either. */
    const mk = (arr, res, wrap, mips) => {
      const t = new THREE.DataTexture(arr, res, res, THREE.RedFormat, THREE.FloatType);
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      if (this.manualBilinear) { t.magFilter = t.minFilter = THREE.NearestFilter; }
      else if (mips) { t.mipmaps = mips; t.minFilter = THREE.LinearMipmapLinearFilter; }
      else t.minFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    };
    this.texMacro = mk(this.macro, MACRO_RES, false, baked.macroMips);
    this.texFar = mk(this.far, FAR_RES, false, baked.farMips);
    this.texDetail = mk(this.det, DET_RES, true, null);
    this.texGeology = new THREE.DataTexture(
      this.geology, MACRO_RES, MACRO_RES, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this.texGeology.wrapS = this.texGeology.wrapT = THREE.ClampToEdgeWrapping;
    this.texGeology.magFilter = THREE.LinearFilter;
    this.texGeology.minFilter = THREE.LinearMipmapLinearFilter;
    this.texGeology.generateMipmaps = true;
    this.texGeology.colorSpace = THREE.NoColorSpace;
    this.texGeology.needsUpdate = true;

    /* ---- excavation field (CPU authoritative, uploaded as dirty rects) ----
       0.25 m per texel at HIGH, which is what it takes for a 0.30 m wheel to
       cut a rut you can actually see. Half-float on the GPU: the field only
       ever holds +-4 m, where a half carries sub-millimetre precision. */
    const DR = this.dentRes = quality.dentRes;
    this.dent = new Float32Array(DR * DR);
    this.dentHalf = new Uint16Array(DR * DR);
    this.texDent = new THREE.DataTexture(this.dentHalf, DR, DR, THREE.RedFormat, THREE.HalfFloatType);
    this.texDent.magFilter = this.texDent.minFilter =
      this.manualBilinear ? THREE.NearestFilter : THREE.LinearFilter;
    this.texDent.generateMipmaps = false;
    this.texDent.needsUpdate = true;
    // A rut touches ~4 texels; a drill pit touches ~200. Uploading a fixed
    // 128-square block for both wastes two orders of magnitude of bandwidth.
    this.scratches = [16, 64, 256].map((n) => {
      const t = new THREE.DataTexture(new Uint16Array(n * n), n, n, THREE.RedFormat, THREE.HalfFloatType);
      t.generateMipmaps = false; t.needsUpdate = true;
      return { n, tex: t };
    });
    this._marks = [];      // rects awaiting GPU upload
    this._slumps = [];     // excavations still settling: [x0,z0,x1,z1,ttl]

    /* ---- trail buffer (wheel tracks) ---- */
    const TR = quality.trailRes;
    this.TRAIL_EXT = 900;
    this.trailRT = new THREE.WebGLRenderTarget(TR, TR, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false
    });
    this.trailCam = new THREE.OrthographicCamera(-this.TRAIL_EXT / 2, this.TRAIL_EXT / 2,
      this.TRAIL_EXT / 2, -this.TRAIL_EXT / 2, -1, 1);
    this.trailCam.position.set(0, 0, 0);
    this.trailScene = new THREE.Scene();
    this._trailPool = []; this._trailUsed = 0;
    this._trailTex = makeTrackStamp();
    this._trailGeo = new THREE.PlaneGeometry(1, 1);
    // Additive accumulation: a track deepens where wheels pass twice, and
    // saturates at 1. Nothing ever erases it — lunar tracks outlive us.
    this._trailProto = new THREE.MeshBasicMaterial({
      map: this._trailTex, color: 0xffffff, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, toneMapped: false
    });
    this._footPool = []; this._footUsed = 0;
    this._footTex = makeFootprintStamp();
    this._footProto = this._trailProto.clone();
    this._footProto.map = this._footTex;
    renderer.setRenderTarget(this.trailRT);
    renderer.setClearColor(0x000000, 1); renderer.clear(true, false, false);
    renderer.setRenderTarget(null);

    /* ---- sun occlusion mask ---- */
    this.sunRT = new THREE.WebGLRenderTarget(quality.sunRes, quality.sunRes, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false
    });
    this.sunMat = new THREE.ShaderMaterial({
      uniforms: {
        uMacro: { value: this.texMacro }, uFar: { value: this.texFar },
        uSun: { value: new THREE.Vector3(1, 0.3, 0) }, uExt: { value: SUNMASK_EXT },
        uSteps: { value: quality.sunSteps }
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy*2.0,0.0,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv;
        uniform sampler2D uMacro, uFar; uniform vec3 uSun; uniform float uExt, uSteps;
        float hM(vec2 p){
          float m = texture2D(uMacro, clamp(p/${MACRO_EXT.toFixed(1)}+0.5, 0.0005, 0.9995)).r;
          float f = texture2D(uFar, p/${FAR_EXT.toFixed(1)}+0.5).r;
          return mix(m, f, smoothstep(520.0, 596.0, length(p)));
        }
        void main(){
          vec2 p = (vUv - 0.5) * uExt;
          float h0 = hM(p) + 0.15;                       // bias off the surface: no acne
          vec2 dir = normalize(uSun.xz + vec2(1e-5));
          float tanA = max(uSun.y, 0.02) / max(length(uSun.xz), 1e-4);
          float sh = 1.0, d = 0.7, step = 0.7;
          for (int i = 0; i < 96; i++){
            if (float(i) >= uSteps) break;
            float hr = h0 + d * tanA;
            float ht = hM(p + dir * d);
            // Penumbra width is the sun's angular diameter times the distance
            // to the occluder — 0.53°, which is why lunar shadows have edges
            // you could cut yourself on.
            sh = min(sh, clamp((hr - ht) / (0.0093 * d + 0.06), 0.0, 1.0));
            if (sh <= 0.002) break;
            d += step; step *= 1.05;
          }
          gl_FragColor = vec4(sh, 0.0, 0.0, 1.0);
        }`
    });
    this._sunQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.sunMat);
    this._sunScene = new THREE.Scene(); this._sunScene.add(this._sunQuad);
    this._sunCam = new THREE.Camera();
    this._lastSun = new THREE.Vector3(9, 9, 9);

    this.buildMaterial();
    this.buildClipmap();
  }

  /* ---------- CPU height, byte-for-byte what the vertex shader computes ---------- */
  heightAt(x, z) {
    const m = bilinear(this.macro, MACRO_RES, MACRO_EXT, x, z);
    const f = bilinear(this.far, FAR_RES, FAR_EXT, x, z);
    const r = Math.hypot(x, z);
    let h = lerp(m, f, sstep(520, 596, r));
    h += bilinearWrap(this.det, DET_RES, x / DET_TILE, z / DET_TILE) * DET_AMP;
    h += bilinearWrap(this.det, DET_RES, x / DET_SCALE2 + 0.37, z / DET_SCALE2 + 0.71) * DET_AMP2;
    h -= this.dentAt(x, z);
    return h;
  }
  /** Material classification at a world point. Shared with prop placement so
      the rocks visible on a rim are generated by the same impact that shaded
      that rim. Values are normalised: bowl, ejecta, exposed, dust. */
  geologyAt(x, z, out = { bowl: 0, ejecta: 0, exposed: 0, dust: 0.5 }) {
    let u = (x / MACRO_EXT + 0.5) * MACRO_RES - 0.5;
    let v = (z / MACRO_EXT + 0.5) * MACRO_RES - 0.5;
    const x0 = Math.floor(u), z0 = Math.floor(v);
    const fx = u - x0, fz = v - z0;
    const c = (a) => a < 0 ? 0 : a >= MACRO_RES ? MACRO_RES - 1 : a;
    const xa = c(x0), xb = c(x0 + 1), za = c(z0), zb = c(z0 + 1);
    const A = this.geology;
    const sample = (ch) => {
      const a = A[(za * MACRO_RES + xa) * 4 + ch];
      const b = A[(za * MACRO_RES + xb) * 4 + ch];
      const d = A[(zb * MACRO_RES + xa) * 4 + ch];
      const e = A[(zb * MACRO_RES + xb) * 4 + ch];
      return ((a + (b - a) * fx) * (1 - fz) + (d + (e - d) * fx) * fz) / 255;
    };
    out.bowl = sample(0); out.ejecta = sample(1);
    out.exposed = sample(2); out.dust = sample(3);
    return out;
  }
  dentAt(x, z) {
    const u = (x / DENT_EXT + 0.5), v = (z / DENT_EXT + 0.5);
    if (u < 0.001 || u > 0.999 || v < 0.001 || v > 0.999) return 0;
    return bilinear(this.dent, this.dentRes, DENT_EXT, x, z);
  }
  normalAt(x, z, e = 0.35, out = new THREE.Vector3()) {
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }
  /** slope in degrees */
  slopeAt(x, z) { const n = this.normalAt(x, z, 0.9, _v3a); return Math.acos(clamp(n.y, -1, 1)) * 57.29578; }

  /** CPU sun visibility (0 shadow .. 1 lit) — used to light the rover.
      Marches the macro field only, exactly like the baked GPU mask does. */
  sunVis(x, z, sun) {
    const h0 = bilinear(this.macro, MACRO_RES, MACRO_EXT, x, z);
    const l = Math.hypot(sun.x, sun.z) || 1e-4;
    const dx = sun.x / l, dz = sun.z / l;
    const tanA = Math.max(sun.y, 0.02) / l;
    let sh = 1, d = 0.9, step = 0.9;
    for (let i = 0; i < 56; i++) {
      const hr = h0 + 0.15 + d * tanA;
      const ht = bilinear(this.macro, MACRO_RES, MACRO_EXT, x + dx * d, z + dz * d);
      sh = Math.min(sh, clamp((hr - ht) / (0.0093 * d + 0.06), 0, 1));
      if (sh <= 0.004) break;
      d += step; step *= 1.08;
    }
    return sh;
  }

  /** Apply the existing kilometre-scale terrain mask locally to imported
   * objects. Never reduce the world's key just because the rover is in a pit.
   * This is a surface-mask approximation; real nearby geometry still uses the
   * standard directional shadow map. It intentionally leaves fill and lamps alone. */
  installMeshLighting(root) {
    this._litMaterials ||= new WeakSet();
    root.traverse((object) => {
      if (!object.isMesh) return;
      for (const material of [object.material].flat()) {
        if (!material?.isMeshStandardMaterial || this._litMaterials.has(material)) continue;
        this._litMaterials.add(material);
        const previous = material.onBeforeCompile;
        const previousKey = material.customProgramCacheKey.bind(material);
        const key = previousKey();
        material.onBeforeCompile = (shader, renderer) => {
          previous.call(material, shader, renderer);
          shader.uniforms.uLocalTerrainMask = this.uniforms.uSunMask;
          shader.uniforms.uLocalTerrainExt = this.uniforms.uSunMaskExt;
          shader.uniforms.uLocalTerrainKey = this.uniforms.uSunDir;
          shader.uniforms.uLocalEnvironmentGain = this.uniforms.uMeshEnvGain;
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vLocalTerrainWorld;')
            .replace('#include <project_vertex>', `#include <project_vertex>
              vec4 localTerrainWorld = vec4(transformed,1.0);
              #ifdef USE_BATCHING
                localTerrainWorld = batchingMatrix * localTerrainWorld;
              #endif
              #ifdef USE_INSTANCING
                localTerrainWorld = instanceMatrix * localTerrainWorld;
              #endif
              vLocalTerrainWorld = (modelMatrix * localTerrainWorld).xyz;`);
          const localLights = THREE.ShaderChunk.lights_fragment_begin.replace(
            'getDirectionalLightInfo( directionalLight, directLight );',
            `getDirectionalLightInfo( directionalLight, directLight );
             if(dot(directLight.direction,normalize(mat3(viewMatrix)*uLocalTerrainKey)) > 0.995){
               vec2 terrainUV = vLocalTerrainWorld.xz/uLocalTerrainExt + 0.5;
               if(all(greaterThan(terrainUV,vec2(0.001))) && all(lessThan(terrainUV,vec2(0.999)))){
                 directLight.color *= texture2D(uLocalTerrainMask,terrainUV).r;
               }
             }`
          );
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
              varying vec3 vLocalTerrainWorld;
              uniform sampler2D uLocalTerrainMask;
              uniform float uLocalTerrainExt;
              uniform float uLocalEnvironmentGain;
              uniform vec3 uLocalTerrainKey;`)
            .replace('#include <lights_fragment_begin>', localLights)
            .replace('#include <envmap_physical_pars_fragment>',
              THREE.ShaderChunk.envmap_physical_pars_fragment.replaceAll('* envMapIntensity','* envMapIntensity * uLocalEnvironmentGain'));
        };
        material.customProgramCacheKey = () => `${key}|local-terrain-key-v1`;
        material.needsUpdate = true;
      }
    });
  }

  /** Call after object transforms/power have updated, before engine.render.
   * Both terrain cones and shadow receivers share the actual physical lamps. */
  syncPracticalLights(roverLight, stationLight) {
    const U = this.uniforms;
    this._practicalPosition ||= new THREE.Vector3();
    this._practicalTarget ||= new THREE.Vector3();
    const sync = (light, prefix, position, direction, cone) => {
      U[`${prefix}On`].value = 0;
      if (!light) return;
      light.updateWorldMatrix(true, false);
      light.target.updateWorldMatrix(true, false);
      light.getWorldPosition(this._practicalPosition);
      light.target.getWorldPosition(this._practicalTarget);
      position.set(this._practicalPosition.x,this._practicalPosition.y,this._practicalPosition.z);
      direction.copy(this._practicalTarget).sub(this._practicalPosition).normalize();
      cone.set(Math.cos(light.angle),Math.cos(light.angle*(1-light.penumbra)));
      const shadow = light.shadow;
      if (light.castShadow && shadow?.map && this.renderer.shadowMap.enabled) {
        U[prefix].value = shadow.map.texture;
        U[`${prefix}Mat`].value = shadow.matrix;
        U[`${prefix}Texel`].value = 1/shadow.mapSize.x;
        U[`${prefix}On`].value = 1;
      }
    };
    sync(roverLight, 'uLampShadow', U.uLamp.value, U.uLampDir.value, U.uLampCone.value);
    U.uLampRange.value = roverLight?.distance || 78;
    // Vector4.set requires w, so use the shared Vector3 then assign explicitly.
    const stationPosition = this._stationLightPosition ||= new THREE.Vector3();
    sync(stationLight, 'uFacilityShadow', stationPosition, U.uFacilityBDir.value, U.uFacilityBCone.value);
    if (stationLight) {
      U.uFacilityB.value.set(stationPosition.x,stationPosition.y,stationPosition.z,stationLight.distance || 46);
      U.uFacilityBPower.value = stationLight.visible ? stationLight.intensity/210 : 0;
    } else U.uFacilityBPower.value = 0;
  }

  /* ============================================================
     material
     ============================================================ */
  buildMaterial() {
    this._emptyShadow ||= new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);
    this._emptyShadow.needsUpdate = true;
    const U = this.uniforms = {
      uMacro: { value: this.texMacro }, uFar: { value: this.texFar },
      uDetail: { value: this.texDetail }, uDent: { value: this.texDent },
      uTrail: { value: this.trailRT.texture },
      uSunMask: { value: this.sunRT.texture },
      uMeshEnvGain: { value: 0.70 },
      uAlbedoTex: { value: null },
      uGeology: { value: this.texGeology },
      uRegolithColor: { value: null }, uRegolithNormal: { value: null }, uRegolithARM: { value: null },
      uDetailNormal: { value: null },
      uRockColor: { value: null }, uRockNormal: { value: null }, uRockARM: { value: null },
      uConst: { value: new THREE.Vector4(MACRO_EXT, FAR_EXT, DET_TILE, DENT_EXT) },
      uConst2: { value: new THREE.Vector4(DET_AMP, DET_AMP2, DET_SCALE2, this.TRAIL_EXT) },
      uCamXZ: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0.6, 0.22, 0.3).normalize() },
      uSunCol: { value: new THREE.Vector3(2.40, 2.46, 2.52) },
      // Thin-atmosphere twilight fill: warmer near the ground than the cold
      // anomaly light, but still dark enough for the rover lamps to matter.
      uAmbient: { value: new THREE.Vector3(0.088, 0.052, 0.045) },
      uEarthDir: { value: new THREE.Vector3(0.2, 0.7, -0.6).normalize() },
      // Reused as low-frequency atmospheric bounce in the custom terrain BRDF.
      uEarthCol: { value: new THREE.Vector3(0.138, 0.071, 0.055) },
      // Static pools from the two inhabited/serviced sites. xyz is the light
      // position, w is its reach over the custom-shaded terrain.
      uFacilityA: { value: new THREE.Vector4(0, 0, 0, 0) },
      uFacilityB: { value: new THREE.Vector4(0, 0, 0, 0) },
      uFacilityBDir: { value: new THREE.Vector3(0, -1, 0) },
      uFacilityBCone: { value: new THREE.Vector2(0.75, 0.94) },
      uFacilityBPower: { value: 0 },
      uSunMaskExt: { value: SUNMASK_EXT },
      uCurveR: { value: CURVE_R },
      uCell: { value: 0.3 },
      uSag: { value: 0.0 },
      uLod: { value: new THREE.Vector2(0, 0) },
      uTexRes: { value: new THREE.Vector4(MACRO_RES, FAR_RES, DET_RES, this.dentRes) },
      uLamp: { value: new THREE.Vector3(0, 0, 0) },      // headlight position
      uLampDir: { value: new THREE.Vector3(0, 0, -1) },
      uLampPow: { value: 0.0 },
      uLampHigh: { value: 0.0 },
      uLampRange: { value: 78 },
      uLampCone: { value: new THREE.Vector2(0.861, 0.985) },
      uTerrainLightSteps: { value: clamp(Math.round(this.quality?.terrainLightSteps || 0), 0, 8) },
      uScanC: { value: new THREE.Vector3(0, 0, 0) },     // GPR pulse origin
      uScanR: { value: -1 },                              // pulse radius (<0 = off)
      uTime: { value: 0 },
      uFogK: { value: 0.72 },
      // World-event controls. They stay neutral during the delivery loop.
      uEventCenter: { value: new THREE.Vector3(0, 0, 0) },
      uEventPulse: { value: -1 },
      uEventWet: { value: 0 },
      uEventLight: { value: 0 },
      uEventDir: { value: new THREE.Vector3(0.3, 0.7, -0.6).normalize() },
      // Real instanced flowers cover the playable area; these uniforms extend
      // the silver bloom over distant mountains at sub-pixel density.
      uFlowerCenter: { value: new THREE.Vector3(0, 0, 0) },
      uFlowerTarget: { value: new THREE.Vector3(0, 0, 0) },
      uFlowerRadius: { value: 0 },
      uFlowerFade: { value: 0 },
      uFlowerLight: { value: 0 },
      // the rover's own shadow, from three's directional shadow map
      uRShadow: { value: this._emptyShadow },
      uRShadowMat: { value: new THREE.Matrix4() },
      uRShadowOn: { value: 0 },
      uRShadowTexel: { value: 1 / 2048 },
      uLampShadow: { value: this._emptyShadow }, uLampShadowMat: { value: new THREE.Matrix4() },
      uLampShadowOn: { value: 0 }, uLampShadowTexel: { value: 1 / 1024 },
      uFacilityShadow: { value: this._emptyShadow }, uFacilityShadowMat: { value: new THREE.Matrix4() },
      uFacilityShadowOn: { value: 0 }, uFacilityShadowTexel: { value: 1 / 1024 }
    };

    const vert = /* glsl */`
      ${TERRAIN_GLSL}
      uniform float uCurveR, uCell, uSag;
      varying vec3 vW; varying vec3 vN; varying float vDent;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec2 p = wp.xz;
        float h = terrainH(p);
        float e = max(uCell, 0.25);
        float hx = terrainH(p + vec2(e, 0.0));
        float hz = terrainH(p + vec2(0.0, e));
        vN = normalize(vec3(h - hx, e, h - hz));
        vDent = hDent(p);
        wp.y = h - uSag;
        wp.y -= dot(p - uCamXZ.xy, p - uCamXZ.xy) / (2.0 * uCurveR);   // horizon curvature
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`;

    const frag = /* glsl */`
      precision highp float;
      #include <packing>
      varying vec3 vW; varying vec3 vN; varying float vDent;
      uniform sampler2D uSunMask, uTrail, uGeology;
      uniform sampler2D uRegolithColor, uRegolithNormal, uRegolithARM;
      uniform sampler2D uRockColor, uRockNormal, uRockARM;
      uniform sampler2D uRShadow; uniform mat4 uRShadowMat;
      uniform float uRShadowOn, uRShadowTexel;
      uniform sampler2D uLampShadow, uFacilityShadow;
      // Reuse height textures already bound by the vertex stage: the combined
      // program remains within the 16-unit Apple texture budget.
      uniform sampler2D uMacro, uFar, uDent;
      uniform mat4 uLampShadowMat, uFacilityShadowMat;
      uniform float uLampShadowOn, uLampShadowTexel, uFacilityShadowOn, uFacilityShadowTexel;
      uniform vec2 uLampCone, uFacilityBCone;
      uniform vec3 uFacilityBDir;
      uniform float uFacilityBPower;
      uniform vec3 uSunDir, uSunCol, uAmbient, uEarthDir, uEarthCol;
      uniform vec4 uFacilityA, uFacilityB;
      uniform vec3 uLamp, uLampDir, uScanC, uEventCenter, uEventDir;
      uniform vec3 uFlowerCenter, uFlowerTarget;
      uniform float uSunMaskExt, uLampPow, uLampHigh, uScanR, uTime, uMarks, uFogK;
      uniform float uTerrainLightSteps, uLampRange, uCurveR, uSag;
      uniform vec3 uCamXZ;
      uniform vec4 uConst, uTexRes;
      uniform float uEventPulse, uEventWet, uEventLight;
      uniform float uFlowerRadius, uFlowerFade, uFlowerLight;
      uniform vec4 uConst2;

      float h1(vec2 p){ p = fract(p*vec2(0.1031,0.1030)); p += dot(p,p.yx+33.33); return fract((p.x+p.y)*p.x); }
      float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(h1(i),h1(i+vec2(1,0)),f.x), mix(h1(i+vec2(0,1)),h1(i+vec2(1,1)),f.x), f.y); }
      const mat2 RA = mat2(0.8090,-0.5878,0.5878,0.8090);
      const mat2 RB = mat2(0.3090,0.9511,-0.9511,0.3090);
      float fb(vec2 p){ return n2(p)*0.55 + n2(RA*p*2.17+7.7)*0.30 + n2(RB*p*4.01+19.3)*0.15; }

      // One dielectric response for the sun, anomaly and practical lamps.
      // Values are pi-scaled to match the existing authored light energies.
      // The broad dust lobe stays diffuse; smooth rock receives a narrower GGX
      // reflection instead of the former inverted roughness/Phong exponent.
      float terrainFresnel(float VoH, float f0){
        return f0 + (1.0-f0)*pow(1.0-clamp(VoH,0.0,1.0),5.0);
      }
      float terrainSpecular(float NoL, float NoV, float NoH, float VoH, float roughness, float f0){
        if(NoL <= 0.0 || NoV <= 0.0) return 0.0;
        float r = clamp(roughness,0.24,1.0);
        float alpha = r*r;
        float a2 = alpha*alpha;
        float denom = NoH*NoH*(a2-1.0)+1.0;
        float distribution = a2/max(denom*denom,0.000001);
        float k = (r+1.0)*(r+1.0)*0.125;
        float maskL = NoL/(NoL*(1.0-k)+k);
        float maskV = NoV/(NoV*(1.0-k)+k);
        float spec = distribution*terrainFresnel(VoH,f0)*maskL*maskV/max(4.0*NoV,0.004);
        // A smooth shoulder bounds small grazing highlights on the stable LDR
        // path as well as HDR. No frame noise or temporal history is involved.
        return spec/(1.0+spec/0.42);
      }
      float terrainDiffuse(float NoL, float NoV, float VoH, float roughness, float f0){
        float fd90 = 0.5+2.0*roughness*VoH*VoH;
        float lightScatter = 1.0+(fd90-1.0)*pow(1.0-NoL,5.0);
        float viewScatter = 1.0+(fd90-1.0)*pow(1.0-NoV,5.0);
        return NoL*(1.0-terrainFresnel(VoH,f0))*mix(1.0,lightScatter*viewScatter,0.45)
          /(1.0+0.15*roughness);
      }
      vec3 terrainLight(vec3 albedo, vec3 N, vec3 V, vec3 L, float roughness, float f0){
        float NoL = max(dot(N,L),0.0);
        float NoV = max(dot(N,V),0.0);
        vec3 halfVector = L+V;
        vec3 H = halfVector*inversesqrt(max(dot(halfVector,halfVector),0.000001));
        float NoH = max(dot(N,H),0.0);
        float VoH = clamp(dot(V,H),0.0,1.0);
        float diffuse = terrainDiffuse(NoL,NoV,VoH,roughness,f0);
        float specular = terrainSpecular(NoL,NoV,NoH,VoH,roughness,f0);
        return albedo*diffuse + vec3(specular*0.62);
      }

      float practicalHeightSample(sampler2D map, vec2 uv, float resolution){
        #ifdef MANUAL_BILINEAR
          vec2 p = uv*resolution-0.5;
          vec2 f = fract(p), b = (floor(p)+0.5)/resolution;
          vec2 e = vec2(1.0/resolution,0.0);
          float h00 = textureLod(map,b,0.0).r;
          float h10 = textureLod(map,b+e.xy,0.0).r;
          float h01 = textureLod(map,b+e.yx,0.0).r;
          float h11 = textureLod(map,b+e.xx,0.0).r;
          return mix(mix(h00,h10,f.x),mix(h01,h11,f.x),f.y);
        #else
          return textureLod(map,uv,0.0).r;
        #endif
      }
      float practicalTerrainHeight(vec2 p){
        float radial = length(p);
        float h = 0.0;
        if(radial < 596.0){
          h = practicalHeightSample(uMacro,clamp(p/uConst.x+0.5,0.0005,0.9995),uTexRes.x);
        }
        if(radial > 520.0){
          float farH = practicalHeightSample(uFar,p/uConst.y+0.5,uTexRes.y);
          h = mix(h,farH,smoothstep(520.0,596.0,radial));
        }
        vec2 dentUV = p/uConst.w+0.5;
        if(all(greaterThan(dentUV,vec2(0.001))) && all(lessThan(dentUV,vec2(0.999)))){
          h -= practicalHeightSample(uDent,dentUV,uTexRes.w);
        }
        return h;
      }
      float practicalTerrainVisibility(vec3 lightPosition, float lightDistance){
        float viewDistance = distance(vW.xz,cameraPosition.xz);
        if(uTerrainLightSteps < 1.0 || lightDistance < 0.6 || lightDistance > 96.0 || viewDistance > 160.0) return 1.0;
        vec3 receiver = vW;
        vec2 cameraOffset = vW.xz-uCamXZ.xy;
        // Shadow rays live in physics/world height, before the visual sag and
        // horizon curvature. Allow for omitted centimetre detail in the bias.
        receiver.y += uSag+dot(cameraOffset,cameraOffset)/(2.0*uCurveR)+0.34;
        float visibility = 1.0;
        for(int i=0; i<8; i++){
          if(float(i) >= uTerrainLightSteps) break;
          float t = (float(i)+1.0)/(uTerrainLightSteps+1.0);
          vec3 ray = mix(receiver,lightPosition,t);
          float clearance = ray.y-practicalTerrainHeight(ray.xz);
          visibility = min(visibility,smoothstep(-0.06,0.24,clearance));
        }
        return mix(visibility,1.0,smoothstep(100.0,160.0,viewDistance));
      }

      // The same packed depth textures that shadow GLTFs now occlude the
      // procedural ground. References to each live matrix are bound before
      // rendering, so Three can update the shadow camera without a one-frame lag.
      float practicalShadow(sampler2D map, mat4 matrix, float enabled, float texel){
        if(enabled < 0.5) return 1.0;
        vec4 q = matrix * vec4(vW + normalize(vN)*0.035, 1.0);
        if(q.w <= 0.0) return 1.0;
        vec3 p = q.xyz/q.w;
        if(p.x <= 0.002 || p.x >= 0.998 || p.y <= 0.002 || p.y >= 0.998 || p.z <= 0.0 || p.z >= 1.0) return 1.0;
        float d = p.z - 0.00045;
        float s = step(d, unpackRGBAToDepth(texture2D(map,p.xy)));
        s += step(d, unpackRGBAToDepth(texture2D(map,p.xy+vec2(texel,texel))));
        s += step(d, unpackRGBAToDepth(texture2D(map,p.xy+vec2(-texel,texel))));
        s += step(d, unpackRGBAToDepth(texture2D(map,p.xy+vec2(texel,-texel))));
        s += step(d, unpackRGBAToDepth(texture2D(map,p.xy-vec2(texel,texel))));
        return s*0.2;
      }

      void main(){
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        float dist = distance(vW.xz, cameraPosition.xz);
        float near = 1.0 - smoothstep(26.0, 190.0, dist);

        /* ---- scanned PBR surface at two physical scales ----
           Moon 03 carries the 3.2 m geology; Moon Flat Macro carries the
           sub-metre grains. Rotating the detail layer keeps the two scans from
           lining up into a visible repeating grid. */
        vec2 uvBase = vW.xz / 5.8 + vec2(0.173, 0.317);
        vec2 uvDetail = RA * (vW.xz / 0.68) + vec2(0.431, 0.127);
        vec3 scanAlb = texture2D(uRegolithColor, uvBase).rgb;
        vec3 arm = texture2D(uRegolithARM, uvBase).rgb;

        /* ---- geology authored by the impact bake ----
           One control texture ties the shading to real height features.  It
           fades before the macro field ends, so the far landscape never
           inherits a clamped stripe from the texture border. */
        vec2 guv = clamp(vW.xz / ${MACRO_EXT.toFixed(1)} + 0.5, 0.001, 0.999);
        vec4 geology = texture2D(uGeology, guv);
        geology *= 1.0 - smoothstep(500.0, 590.0, length(vW.xz));

        /* ---- micro relief: the grain must CATCH the grazing sun, not be painted on.
           Kept high-frequency on purpose — at a half-metre wavelength it reads as
           swirling dunes, which the Moon does not have. ---- */
        #define GRIT(P) (n2((P)*7.3)*0.58 + n2((P)*23.0)*0.42)
        float g0 = GRIT(vW.xz);
        vec3 Nr = N;
        if (near > 0.002){
          float e = 0.045;
          float gx = GRIT(vW.xz + vec2(e, 0.0));
          float gz = GRIT(vW.xz + vec2(0.0, e));
          Nr = normalize(N + vec3(-(gx-g0), 0.0, -(gz-g0)) * 0.34 * near);
        }

        // OpenGL tangent normals: texture X/Y map onto world X/Z because the
        // height field is sampled in world XZ. Geometry normals still carry
        // the large slope, the scans only add centimetre-scale relief.
        vec3 nb = texture2D(uRegolithNormal, uvBase).xyz * 2.0 - 1.0;
        // Reuse the scan at a rotated sub-metre scale: the combined shader
        // budget is 16 texture units on Apple GPUs. Three height samplers are
        // now shared across stages; no extra detail sampler is introduced.
        vec3 nd = texture2D(uRegolithNormal, uvDetail).xyz * 2.0 - 1.0;
        // Rotating UVs also rotates the tangent basis. Transform the scan's
        // relief back to world XZ so the visible grooves catch the right light.
        vec2 detailN = vec2(dot(RA[0],nd.xy),dot(RA[1],nd.xy));
        vec2 scanN = nb.xy * 0.34 + detailN * (0.12 + 0.14*near);
        Nr = normalize(Nr + vec3(scanN.x, 0.0, scanN.y) * (0.48 + 0.18*near));

        /* ---- albedo: real regolith scan + orbital-scale basin variation ---- */
        float macroVariation = clamp(geology.r*0.42+geology.g*0.18+fb(vW.xz*0.007)*0.40,0.0,1.0);
        float mott = mix(0.84,1.13,macroVariation);
        float varN = fb(vW.xz*0.34);
        float speck = n2(vW.xz*11.9);
        float scanL = dot(scanAlb, vec3(0.299,0.587,0.114));
        float detailL = 0.46 + n2(uvDetail*13.0+7.1) * 0.18;
        // Iron-rich dust supplies the Mars identity while the measured scan
        // still carries the real grains, cracks and roughness underneath.
        vec3 scanned = scanL * vec3(0.365, 0.178, 0.108);
        float detailMod = 0.89 + detailL * 0.28;
        vec3 albedo = scanned * mott * detailMod * (0.94 + 0.08*varN + 0.035*g0) * (0.97 + 0.06*speck);
        float surfAO = clamp(arm.r * (0.94 + detailL*0.10), 0.0, 1.0);
        float surfRough = clamp(arm.g * (0.94 + detailL*0.10), 0.48, 1.0);

        /* Conductive black rain does not replace the measured surface.  It
           darkens it in broad, broken sheets and lowers its micro-roughness,
           retaining all of the scan normals beneath the wet response. */
        float wetBreakup = 0.68 + 0.32*fb(vW.xz*0.055 + vec2(7.1,13.7));
        float eventWet = clamp(uEventWet*wetBreakup,0.0,1.0);
        albedo *= mix(1.0,0.57,eventWet);
        surfRough = mix(surfRough,0.16,eventWet);

        // Crater deposits are fine and dark; the fractured rim/ejecta catches
        // more light. Dust provinces drift only a few percent so they read as
        // geology at distance, not another noise octave.
        float bowlMask = geology.r * (1.0 - geology.b * 0.55);
        float ejectaMask = geology.g;
        float dustProvince = geology.a - 0.5;
        albedo *= mix(1.0, 0.77, bowlMask);
        albedo *= mix(1.0, 1.13, ejectaMask * (1.0 - bowlMask));
        albedo *= 1.0 + dustProvince * 0.075;

        // Dark basalt breaks through the oxidised dust on slopes and fresh
        // crater walls, providing the near-black structure of the scene.
        float slopeMask = smoothstep(0.075, 0.30, 1.0 - N.y);
        float rockMask = clamp(max(geology.b, slopeMask) * (0.62 + ejectaMask * 0.38), 0.0, 0.88);
        vec2 uvRock = RB * (vW.xz / 4.7) + vec2(0.219, 0.683);
        vec3 rockTex = texture2D(uRockColor, uvRock).rgb;
        vec3 rockArm = texture2D(uRockARM, uvRock).rgb;
        vec3 rockNorm = texture2D(uRockNormal, uvRock).xyz * 2.0 - 1.0;
        float rockL = dot(rockTex, vec3(0.299,0.587,0.114));
        vec3 rockAlb = rockL * vec3(0.118, 0.088, 0.079) * (0.90 + 0.16*varN);
        albedo = mix(albedo, rockAlb, rockMask);
        vec2 rockN = vec2(dot(RB[0],rockNorm.xy),dot(RB[1],rockNorm.xy));
        Nr = normalize(Nr + vec3(rockN.x, 0.0, rockN.y) * rockMask * 0.42);
        surfAO = mix(surfAO, rockArm.r, rockMask);
        surfRough = mix(surfRough, max(0.58, rockArm.g), rockMask);
        // Scan AO describes blocked ambient light inside grains and cracks;
        // direct headlight energy must still reveal those surface normals.
        float indirectAO = mix(0.84,1.0,surfAO);
        // freshly excavated material is brighter — unweathered, unsputtered
        albedo *= 1.0 + 0.62 * smoothstep(0.02, 0.55, vDent);
        /* ---- wheel tracks ----
           Sampled per PIXEL, not per vertex: a 0.44 m rut across a 0.30 m
           clipmap cell would otherwise be smeared into nothing. Compacted
           regolith is darker and smoother than the fluffy stuff around it,
           which is exactly why Apollo's tracks are still legible from orbit. */
        // The trail buffer is an orthographic view looking down −Z, so world +Z
        // lands on −Y in the texture. Sample with that flip or the tracks end up
        // mirrored across the origin, four hundred metres from the wheels.
        vec2 tuv = vec2(vW.x, -vW.z) / uConst2.w + 0.5;
        float trackFade = 1.0 - smoothstep(120.0, 460.0, dist);
        float tr = (tuv.x>0.004&&tuv.x<0.996&&tuv.y>0.004&&tuv.y<0.996)
                 ? texture2D(uTrail, tuv).r * trackFade : 0.0;
        if (tr > 0.004){
          // Recover the direction of travel from the gradient of the trail
          // field, so the grouser marks lie ACROSS the rut instead of drifting
          // through it on some fixed diagonal.
          float e = 2.0 / uConst2.w;
          vec2 g = vec2(texture2D(uTrail, tuv + vec2(e,0.0)).r - texture2D(uTrail, tuv - vec2(e,0.0)).r,
                        texture2D(uTrail, tuv + vec2(0.0,e)).r - texture2D(uTrail, tuv - vec2(0.0,e)).r);
          vec2 across = vec2(g.x, -g.y);
          vec2 along = (length(across) > 1e-4) ? normalize(vec2(-across.y, across.x)) : vec2(1.0, 0.0);
          float tread = smoothstep(0.05, 0.9, 0.5 + 0.5*sin(dot(vW.xz, along * 27.0)));
          albedo *= mix(1.0, 0.34 + 0.26*tread, tr);
          Nr = normalize(mix(Nr, N, tr*0.8));       // the grain is crushed flat
          surfRough = mix(surfRough,max(0.40,surfRough*0.74),tr*0.65);
        }

        // Pixel-footprint normal variance broadens tiny specular lobes as the
        // camera moves away. Evaluate once, outside light/cone branches, so
        // derivatives are well defined and shared by every source of light.
        vec3 normalDX = dFdx(Nr), normalDY = dFdy(Nr);
        float normalVariance = min(0.20,0.35*max(dot(normalDX,normalDX),dot(normalDY,normalDY)));
        float filteredRough = clamp(sqrt(surfRough*surfRough+normalVariance),0.24,1.0);
        float surfaceF0 = mix(0.028,0.045,rockMask);

        /* ---- shadowing: baked long crater shadows ---- */
        vec2 smu = vW.xz / uSunMaskExt + 0.5;
        float sm = (smu.x>0.0&&smu.x<1.0&&smu.y>0.0&&smu.y<1.0) ? texture2D(uSunMask, smu).r : 1.0;

        /* ---- plus the rover and the boulders, from the real shadow map ----
           Without this the machine floats: nothing sells contact with a surface
           like the shadow it throws across it. */
        if (uRShadowOn > 0.5){
          vec4 sc = uRShadowMat * vec4(vW, 1.0);
          vec3 sp = sc.xyz / sc.w;
          if (sp.x > 0.001 && sp.x < 0.999 && sp.y > 0.001 && sp.y < 0.999 && sp.z < 1.0){
            float d = sp.z - 0.0016;
            float o = uRShadowTexel;
            float s = 0.0;
            s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2(-o,-o))));
            s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2( o,-o))));
            s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2(-o, o))));
            s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy + vec2( o, o))));
            s += step(d, unpackRGBAToDepth(texture2D(uRShadow, sp.xy)));
            // fade the map out at its border so the frustum edge is invisible
            float edge = 1.0 - smoothstep(0.42, 0.5, max(abs(sp.x-0.5), abs(sp.y-0.5)));
            sm *= mix(1.0, s * 0.2, edge);
          }
        }

        /* ---- shared rough dielectric lighting ---- */
        float ci = max(dot(Nr, uSunDir), 0.0);
        vec3 col = terrainLight(albedo,Nr,V,uSunDir,filteredRough,surfaceF0) * uSunCol * sm * 1.12;

        // The optional event uses the same surface response; it does not need
        // an independent synthetic glossy lobe when wetness changes.
        vec3 eventL = normalize(uEventDir);
        if(uEventLight > 0.001){
          col += terrainLight(albedo,Nr,V,eventL,filteredRough,surfaceF0)
            * vec3(0.36,0.65,0.76)*uEventLight*0.72;
        }

        /* ---- opposition surge: coherent backscatter, tight and sun-gated ---- */
        float od = max(dot(V, uSunDir), 0.0);
        col *= 1.0 + 0.28 * (0.42*pow(od,3.0) + 0.58*pow(od,26.0)) * sm;

        /* ---- restrained atmospheric and ground bounce ---- */
        col += albedo * indirectAO * uEarthCol * (0.45 + 0.55*max(dot(Nr, uEarthDir), 0.0));
        col += albedo * indirectAO * uAmbient * (0.5 + 0.5*N.y);
        col += albedo * indirectAO * uSunCol * 0.018 * max(uSunDir.y, 0.0) * (0.35 + 0.65*N.y);
        float faceBounce = pow(max(dot(Nr,V),0.0),1.35) * (1.0-ci);
        float keyEnergy = clamp(dot(uSunCol,vec3(0.333))/2.46,0.0,1.0);
        col += albedo * indirectAO * vec3(0.155,0.172,0.184) * faceBounce * (0.08+0.92*keyEnergy);

        /* ---- authored practical-light pools ----
           Match the authored pools to the same normal/roughness response used
           by daylight. The small home pool keeps its diffuse scattered fill. */
        vec3 fA = uFacilityA.xyz - vW;
        float fdA = length(fA);
        float fa = pow(clamp(1.0 - fdA/max(uFacilityA.w,0.001), 0.0, 1.0), 2.0);
        vec3 flA = fA/max(fdA,0.001);
        if(fa > 0.001){
          col += (albedo*indirectAO*0.28 + terrainLight(albedo,Nr,V,flA,filteredRough,surfaceF0)*0.72)
            * vec3(0.76,0.61,0.43)*fa;
        }

        vec3 fB = uFacilityB.xyz - vW;
        float fdB = length(fB);
        float facB = pow(clamp(1.0 - fdB/max(uFacilityB.w,0.001), 0.0, 1.0), 2.0);
        vec3 flB = fB/max(fdB,0.001);
        float coneB = smoothstep(uFacilityBCone.x,uFacilityBCone.y,dot(-flB,uFacilityBDir));
        if(facB*coneB*uFacilityBPower > 0.001){
          float shadowB = practicalShadow(uFacilityShadow,uFacilityShadowMat,uFacilityShadowOn,uFacilityShadowTexel);
          shadowB *= practicalTerrainVisibility(uFacilityB.xyz,fdB);
          col += terrainLight(albedo,Nr,V,flB,filteredRough,surfaceF0)
            * vec3(2.6,1.94,1.25)*facB*coneB*uFacilityBPower*shadowB;
        }

        /* ---- rover headlights ---- */
        if (uLampPow > 0.001){
          vec3 tl = uLamp - vW; float dl = length(tl); vec3 L = tl/max(dl,1e-3);
          float aim = dot(-L, uLampDir);
          float cone = smoothstep(uLampCone.x, uLampCone.y, aim);
          if(cone > 0.001 && dl < uLampRange){
            float dipped = cone / (1.0 + 0.022*dl*dl);
            float high = cone / (1.0 + 0.0065*dl*dl);
            float rangeFade = 1.0-smoothstep(uLampRange*0.78,uLampRange,dl);
            float att = uLampPow * (dipped + uLampHigh * high * 0.92)*rangeFade;
            att *= practicalShadow(uLampShadow,uLampShadowMat,uLampShadowOn,uLampShadowTexel);
            att *= practicalTerrainVisibility(uLamp,dl);
            col += terrainLight(albedo,Nr,V,L,filteredRough,surfaceF0)
              * vec3(1.30,1.24,1.12)*att*5.5;
          }
        }

        /* ---- GPR pulse sweep ---- */
        if (uScanR > 0.0){
          float dr = distance(vW.xz, uScanC.xz);
          float ring = exp(-pow((dr - uScanR)/2.2, 2.0));
          float grid = smoothstep(0.86,1.0,max(sin(vW.x*1.05),sin(vW.z*1.05)));
          col += vec3(0.10,0.55,0.72) * ring * (0.35 + 0.65*grid) * uScanC.y;
        }

        /* The underground awakening is a single expanding front, not a set
           of perfect neon circles. Noise breaks it into root-like sections. */
        if (uEventPulse > 0.0 && uEventCenter.y > 0.001){
          float ed = distance(vW.xz,uEventCenter.xz);
          float broken = 0.58 + 0.42*n2(vW.xz*0.23+uTime*0.08);
          float wave = exp(-pow((ed-uEventPulse)/(2.4+broken*2.0),2.0));
          wave *= smoothstep(0.34,0.72,broken)*uEventCenter.y;
          col += vec3(0.30,0.72,0.92)*wave*(0.36+0.64*max(dot(Nr,V),0.0));
        }

        /* ---- distant flower carpet and biological route ----
           Geometry supplies readable flowers nearby. At mountain scale this
           silver response represents millions of sub-pixel petals. Two living
           shoulders frame a dark driveable lane and carry light toward the
           relay; the route is still made from flowers, never painted arrows. */
        if (uFlowerFade > 0.001 && uFlowerRadius > 0.01){
          float bloomD = distance(vW.xz, uFlowerCenter.xz);
          float reached = 1.0 - smoothstep(uFlowerRadius - 18.0, uFlowerRadius + 24.0, bloomD);
          vec2 route = uFlowerTarget.xz - uFlowerCenter.xz;
          float routeLen2 = max(dot(route,route), 0.001);
          float routeT = clamp(dot(vW.xz-uFlowerCenter.xz,route)/routeLen2,0.0,1.0);
          float routeD = distance(vW.xz,uFlowerCenter.xz+route*routeT);
          float routeClear = smoothstep(5.5,14.0,routeD);
          float routeEnds = smoothstep(0.008,0.045,routeT)
                          * (1.0-smoothstep(0.955,0.995,routeT));
          float guideBank = smoothstep(5.9,7.0,routeD)
                          * (1.0-smoothstep(10.2,12.6,routeD)) * routeEnds;
          float cluster = n2(vW.xz*0.083+vec2(17.1,9.4))*0.58
                        + n2(RA*vW.xz*0.41+31.7)*0.42;
          float macroPatch = smoothstep(0.40,0.74,cluster);
          float microPetal = smoothstep(0.67,0.91,n2(RB*vW.xz*1.92+vec2(7.6,21.4)));
          float flecks = macroPatch*microPetal;
          float growable = smoothstep(0.40,0.94,Nr.y);
          float carpet = reached*uFlowerFade*growable*routeClear*(0.004+flecks*0.62);
          float petalRim = pow(1.0-max(dot(Nr,V),0.0),2.0);
          vec3 flowerSilver = vec3(0.25,0.31,0.33)*(0.22+uFlowerLight*0.52)
                            + vec3(0.10,0.31,0.36)*petalRim*(0.16+uFlowerLight*0.24);
          // Petals reflect the moon; they are not unshadowed emissive dots.
          float petalVisibility = 0.015 + 0.985*sm*ci;
          col += flowerSilver*carpet*petalVisibility;
          float guideVisible = reached*uFlowerFade*growable*guideBank;
          col += vec3(0.075,0.34,0.45)*guideVisible
               * (0.10+uFlowerLight*0.30)*(0.62+routeT*0.38)*petalVisibility;

          float terminalD = distance(vW.xz,uFlowerTarget.xz);
          float terminalCrown = exp(-pow((terminalD-9.7)/2.25,2.0));
          terminalCrown *= reached*uFlowerFade*growable;
          col += vec3(0.10,0.43,0.55)*terminalCrown
               * (0.12+uFlowerLight*0.34)*0.84*petalVisibility;
          float tideFront = exp(-pow((bloomD-uFlowerRadius)/5.5,2.0))*uFlowerFade*growable;
          col += vec3(0.10,0.48,0.58)*tideFront*(0.10+flecks*0.46)*petalVisibility;
        }

        /* ---- suspended iron-dust distance veil ----
           Mars' thin atmosphere softens distant ridges without hiding the
           black basalt silhouettes that guide the route. */
        float veil = smoothstep(105.0, 900.0, dist) * 0.62;
        veil += smoothstep(680.0, 2400.0, dist) * 0.18;
        veil = clamp(veil * uFogK, 0.0, 0.54);
        vec3 haze = mix(vec3(0.085, 0.036, 0.029), vec3(0.030, 0.034, 0.043), uFlowerFade);
        col = mix(col, haze, veil);
        gl_FragColor = vec4(col, 1.0);
      }`;

    this.material = new THREE.ShaderMaterial({
      uniforms: U, vertexShader: vert, fragmentShader: frag, fog: false,
      defines: this.manualBilinear ? { MANUAL_BILINEAR: 1 } : {}
    });
  }

  /* ============================================================
     clipmap
     ============================================================ */
  buildClipmap() {
    // Reuse the group across rebuilds: main adds it to the scene once at boot,
    // so handing back a fresh one on a quality change would leave the old rings
    // drawn and the new ones orphaned.
    if (this.group) {
      for (const L of this.levels) {
        this.group.remove(L.mesh);
        L.mesh.geometry.dispose(); L.mesh.material.dispose();
      }
    } else {
      this.group = new THREE.Group();
      this.group.frustumCulled = false;
    }
    this.levels = [];
    const M = this.quality.clipM;          // cells per side
    const L = this.quality.clipLevels;
    const c0 = this.quality.clipCell;

    const grid = (nx, nz, hole) => {
      // hole = half-width in cells of the removed centre (0 = solid patch)
      const verts = [], idx = [];
      const w = nx + 1;
      for (let z = 0; z <= nz; z++) for (let x = 0; x <= nx; x++) verts.push(x - nx / 2, 0, z - nz / 2);
      for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        if (hole) {
          const cx = x - nx / 2 + 0.5, cz = z - nz / 2 + 0.5;
          if (Math.abs(cx) < hole && Math.abs(cz) < hole) continue;
        }
        const a = z * w + x, b = a + 1, c = a + w, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setIndex(idx);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      return g;
    };

    for (let i = 0; i < L; i++) {
      const cell = c0 * Math.pow(2, i);
      const geo = grid(M, M, i === 0 ? 0 : M / 4 - 2);   // 2-cell overlap hides any snap mismatch
      // Built directly rather than cloned: ShaderMaterial.clone() deep-copies
      // the uniforms, which warns on every render-target texture in the set
      // (uTrail, uSunMask) and then has its work thrown away by the line below.
      // Harmless at boot, nine warnings a time once the tier can change.
      const mat = new THREE.ShaderMaterial({
        uniforms: Object.assign({}, this.uniforms),      // share the value objects
        vertexShader: this.material.vertexShader,
        fragmentShader: this.material.fragmentShader,
        defines: this.material.defines,
        fog: false
      });
      mat.uniforms.uCell = { value: cell };
      // Sag rises with cell size so a coarser ring always sits UNDER the finer
      // one it overlaps, hiding both the LOD step and any snapping mismatch.
      mat.uniforms.uSag = { value: i === 0 ? 0 : 0.10 * cell };
      mat.uniforms.uLod = { value: new THREE.Vector2(
        Math.max(0, Math.log2(cell / (MACRO_EXT / MACRO_RES))),
        Math.max(0, Math.log2(cell / (FAR_EXT / FAR_RES)))) };
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(cell, 1, cell);
      m.frustumCulled = false;
      m.renderOrder = -10 + i;
      this.group.add(m);
      this.levels.push({ mesh: m, cell, snap: cell * 2 });
    }
  }

  /* ============================================================
     excavation
     ============================================================ */
  /* Mark a rect for GPU upload. Rects are kept as a SHORT LIST, never a single
     union: two dig sites 300 m apart would otherwise produce one rect spanning
     everything between them, and we would re-upload a third of the world. */
  _mark(x0, z0, x1, z1) {
    const M = this._marks;
    for (const m of M) {                        // merge only into a rect it touches
      if (x0 <= m[2] + 8 && x1 >= m[0] - 8 && z0 <= m[3] + 8 && z1 >= m[1] - 8) {
        m[0] = Math.min(m[0], x0); m[1] = Math.min(m[1], z0);
        m[2] = Math.max(m[2], x1); m[3] = Math.max(m[3], z1);
        return;
      }
    }
    if (M.length < 12) M.push([x0, z0, x1, z1]);
    else {                                      // over budget: fold into the first
      const m = M[0];
      m[0] = Math.min(m[0], x0); m[1] = Math.min(m[1], z0);
      m[2] = Math.max(m[2], x1); m[3] = Math.max(m[3], z1);
    }
  }

  /** An excavation that is still settling. Only the drill creates these — a
      compacted wheel rut does not flow, it stays exactly where you put it. */
  _slumpRegion(x0, z0, x1, z1) {
    for (const r of this._slumps) {
      if (x0 <= r[2] + 4 && x1 >= r[0] - 4 && z0 <= r[3] + 4 && z1 >= r[1] - 4) {
        r[0] = Math.min(r[0], x0); r[1] = Math.min(r[1], z0);
        r[2] = Math.max(r[2], x1); r[3] = Math.max(r[3], z1);
        r[4] = SLUMP_TTL;
        return;
      }
    }
    if (this._slumps.length >= 8) this._slumps.shift();
    this._slumps.push([x0, z0, x1, z1, SLUMP_TTL]);
  }

  /** Carve a bowl and pile the spoil into a rim. Volume-conserving. */
  excavate(wx, wz, radius, depth) {
    const DENT_RES = this.dentRes;
    const px = DENT_EXT / DENT_RES, half = DENT_RES * 0.5;
    const R = radius * 1.85;
    const gx0 = Math.max(1, Math.floor((wx - R) / px + half));
    const gx1 = Math.min(DENT_RES - 2, Math.ceil((wx + R) / px + half));
    const gz0 = Math.max(1, Math.floor((wz - R) / px + half));
    const gz1 = Math.min(DENT_RES - 2, Math.ceil((wz + R) / px + half));
    if (gx1 < gx0 || gz1 < gz0) return;
    for (let gz = gz0; gz <= gz1; gz++) {
      const p = (gz - half + 0.5) * px;
      for (let gx = gx0; gx <= gx1; gx++) {
        const q = (gx - half + 0.5) * px;
        const t = Math.hypot(q - wx, p - wz) / radius;
        if (t >= 1.85) continue;
        let d;
        if (t < 1) d = Math.pow(Math.cos(t * Math.PI) * 0.5 + 0.5, 1.35);
        else { const u = (t - 1) / 0.85; d = -Math.sin(u * Math.PI) * (1 - u) * 0.62; }
        const i = gz * DENT_RES + gx;
        this.dent[i] = clamp(this.dent[i] + d * depth, -1.1, 3.6);
      }
    }
    this._mark(gx0, gz0, gx1, gz1);
    this._slumpRegion(gx0, gz0, gx1, gz1);
  }

  /** Cut a wheel rut.
      Regolith is displaced, not destroyed: what the wheel presses down piles up
      into berms along both flanks, which is what turns a dark stripe into an
      actual furrow you can see across the basin. Rolling settles toward a
      target depth and stops there; `dig` accumulates without limit, because
      that is exactly what a spinning wheel does — and it is how you bury
      yourself to the axle.  */
  rut(wx, wz, halfWidth, depth, dig) {
    const DENT_RES = this.dentRes;
    const px = DENT_EXT / DENT_RES, half = DENT_RES * 0.5;
    const R = halfWidth * BERM_OUT;
    const gx0 = Math.max(1, Math.floor((wx - R) / px + half));
    const gx1 = Math.min(DENT_RES - 2, Math.ceil((wx + R) / px + half));
    const gz0 = Math.max(1, Math.floor((wz - R) / px + half));
    const gz1 = Math.min(DENT_RES - 2, Math.ceil((wz + R) / px + half));
    if (gx1 < gx0 || gz1 < gz0) return;
    const D = this.dent;
    for (let gz = gz0; gz <= gz1; gz++) {
      const p = (gz - half + 0.5) * px;
      for (let gx = gx0; gx <= gx1; gx++) {
        const q = (gx - half + 0.5) * px;
        const t = Math.hypot(q - wx, p - wz) / halfWidth;
        const i = gz * DENT_RES + gx;
        if (t < 1) {
          const target = depth * (1 - 0.30 * t * t);        // near-flat floor
          if (dig) D[i] = Math.min(DIG_CAP, D[i] + dig * (1 - 0.5 * t));
          else if (D[i] < target) D[i] = Math.min(target, D[i] + depth * 0.6);
        } else if (t < BERM_OUT) {
          // Never let the berm pass eat a trough. Successive calls overlap as
          // the wheel rolls, so a texel that was rut floor one step ago lands
          // in the berm annulus the next — and without this guard the two
          // passes fight and cancel each other into flat ground.
          if (D[i] > 0.004) continue;
          const u = (t - 1) / (BERM_OUT - 1);
          const lobe = Math.sin(u * Math.PI) * (1 - u) * 1.55;
          const target = -depth * lobe * BERM_GAIN - (dig ? dig * lobe * 2.2 : 0);
          if (D[i] > target) D[i] = Math.max(target, D[i] - Math.max(depth, dig) * 0.5);
        }
      }
    }
    this._mark(gx0, gz0, gx1, gz1);
    // Only a churned rut creeps back; a compacted one stays put for a billion years.
    if (dig) this._slumpRegion(gx0, gz0, gx1, gz1);
  }

  /** Dry regolith cannot hold a wall: relax anything past the angle of repose.
      Each excavation settles on its own clock, inside its own small rect. */
  relax(dt) {
    if (!this._slumps.length) return;
    const DENT_RES = this.dentRes;
    const D = this.dent, n = DENT_RES;
    const px = DENT_EXT / DENT_RES;
    const STEP = 0.62 * px;                    // ≈ 32° repose angle for dry regolith
    const STEPD = STEP * 1.41421;
    const FLOW = Math.min(0.42, dt * 9);
    for (let k = this._slumps.length - 1; k >= 0; k--) {
      const r = this._slumps[k];
      r[4] -= dt;
      const x0 = Math.max(1, r[0] - 1), z0 = Math.max(1, r[1] - 1);
      const x1 = Math.min(DENT_RES - 2, r[2] + 1), z1 = Math.min(DENT_RES - 2, r[3] + 1);
      if (x1 < x0 || z1 < z0 || r[4] <= 0) { this._slumps.splice(k, 1); continue; }
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const i = z * n + x;
        let si = -D[i];
        const move = (j, thr) => {
          const sj = -D[j], d = si - sj;
          if (d > thr) { const m = (d - thr) * FLOW * 0.5; D[i] += m; D[j] -= m; si -= m; }
        };
        move(i - 1, STEP); move(i + 1, STEP); move(i - n, STEP); move(i + n, STEP);
        move(i - n - 1, STEPD); move(i - n + 1, STEPD); move(i + n - 1, STEPD); move(i + n + 1, STEPD);
      }
      this._mark(x0, z0, x1, z1);
    }
  }

  _uploadDirty() {
    if (!this._marks.length) return;
    for (const m of this._marks) this._uploadRect(m[0], m[1], m[2], m[3]);
    this._marks.length = 0;
  }

  _uploadRect(x0, z0, x1, z1) {
    const DENT_RES = this.dentRes;
    x0 = Math.max(0, x0); z0 = Math.max(0, z0);
    x1 = Math.min(DENT_RES - 1, x1); z1 = Math.min(DENT_RES - 1, z1);
    if (x1 < x0 || z1 < z0) return;
    const need = Math.max(x1 - x0 + 1, z1 - z0 + 1);
    const sc = this.scratches.find(s => s.n >= need) || this.scratches[this.scratches.length - 1];
    const S = sc.n, data = sc.tex.image.data;
    const half = THREE.DataUtils.toHalfFloat;
    for (let by = z0; by <= z1; by += S) {
      for (let bx = x0; bx <= x1; bx += S) {
        // The blit always writes a full S-square, so clamp the origin inward
        // rather than running off the edge of the texture.
        const ox = Math.min(bx, DENT_RES - S), oz = Math.min(by, DENT_RES - S);
        for (let y = 0; y < S; y++) {
          const src = (oz + y) * DENT_RES, dst = y * S;
          for (let x = 0; x < S; x++) data[dst + x] = half(this.dent[src + ox + x]);
        }
        sc.tex.needsUpdate = true;
        this.renderer.copyTextureToTexture(new THREE.Vector2(ox, oz), sc.tex, this.texDent);
      }
    }
  }

  /* ============================================================
     wheel trails
     ============================================================ */
  _trailQuad() {
    if (this._trailUsed < this._trailPool.length) return this._trailPool[this._trailUsed++];
    const m = new THREE.Mesh(this._trailGeo, this._trailProto.clone());
    m.frustumCulled = false; m.visible = false;
    this._trailPool.push(m); this._trailUsed++;
    this.trailScene.add(m);
    return m;
  }
  _footQuad() {
    if (this._footUsed < this._footPool.length) return this._footPool[this._footUsed++];
    const m = new THREE.Mesh(this._trailGeo, this._footProto.clone());
    m.frustumCulled = false; m.visible = false;
    this._footPool.push(m); this._footUsed++;
    this.trailScene.add(m);
    return m;
  }
  /** Queue a track segment. The buffer is a top-down orthographic view, so
      +Z in the world maps to −Y in the buffer. */
  addTrack(ax, az, bx, bz, width, strength) {
    if (this._trailUsed >= 96) return;                       // hard per-frame cap
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4 || !Number.isFinite(len)) return;
    const m = this._trailQuad();
    m.position.set((ax + bx) * 0.5, -(az + bz) * 0.5, 0);
    m.rotation.z = Math.atan2(-dz, dx);
    m.scale.set(len + width * 0.5, width, 1);
    const s = clamp(strength, 0, 1);
    m.material.color.setScalar(s);
    m.visible = true;
  }
  /** Queue a single boot print. `heading` follows Character.forward: zero is
      world +Z. A narrow, asymmetric stamp keeps it distinct from wheel ruts. */
  addFootprint(x, z, heading, strength = 0.56) {
    if (this._footUsed >= 24) return;
    const m = this._footQuad();
    m.position.set(x, -z, 0);
    m.rotation.z = heading - Math.PI * 0.5;
    m.scale.set(0.36, 0.145, 1);
    m.material.color.setScalar(clamp(strength, 0, 1));
    m.visible = true;
  }
  _flushTrails() {
    if (this._trailUsed === 0 && this._footUsed === 0) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.trailRT);
    r.render(this.trailScene, this.trailCam);          // one pass, all queued quads
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    for (let i = 0; i < this._trailUsed; i++) this._trailPool[i].visible = false;
    for (let i = 0; i < this._footUsed; i++) this._footPool[i].visible = false;
    this._trailUsed = 0;
    this._footUsed = 0;
  }
  clearTrails() {
    const r = this.renderer, p = r.getRenderTarget();
    const prev = r.getClearColor(new THREE.Color()), prevA = r.getClearAlpha();
    r.setRenderTarget(this.trailRT);
    r.setClearColor(0x000000, 1); r.clear(true, false, false);
    r.setRenderTarget(p);
    r.setClearColor(prev, prevA);
  }

  /** Wipe every excavation and push the whole field back to the GPU. */
  clearDent() {
    this.dent.fill(0);
    this._slumps.length = 0;
    this._marks.length = 0;
    this._uploadRect(0, 0, this.dentRes - 1, this.dentRes - 1);
  }

  /* ============================================================
     live quality change
     ============================================================
     Re-fit everything the tier sizes, without re-baking the basin: bakeTerrain
     takes no quality argument, so the height field is tier-independent and the
     expensive half of the load is reusable. A tier change costs a hitch, not a
     reload.

     One rule holds this together: uniform VALUES are mutated in place and the
     wrapper objects are never replaced. Every clipmap ring shares these exact
     wrappers (buildClipmap does Object.assign to share them), and the dust holds
     uSunDir directly — swapping a wrapper would silently unwire both. */
  setQuality(q) {
    const prev = this.quality;
    this.quality = q;
    this.uniforms.uTerrainLightSteps.value = clamp(Math.round(q.terrainLightSteps || 0), 0, 8);

    if (q.dentRes !== this.dentRes) this._resizeDent(q.dentRes);
    if (q.trailRes !== prev.trailRes) this._resizeTrail(q.trailRes);
    if (q.sunRes !== prev.sunRes) {
      this.sunRT.dispose();
      this.sunRT = new THREE.WebGLRenderTarget(q.sunRes, q.sunRes, {
        format: THREE.RedFormat, type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false
      });
      this.uniforms.uSunMask.value = this.sunRT.texture;
    }
    this.sunMat.uniforms.uSteps.value = q.sunSteps;
    // The mask is derived from the height field and the sun angle, so there is
    // nothing to preserve — just force update() to redraw it next frame.
    this._lastSun.set(9, 9, 9);

    if (q.clipM !== prev.clipM || q.clipLevels !== prev.clipLevels || q.clipCell !== prev.clipCell) {
      this.buildClipmap();
    }
  }

  /** Reallocate the excavation field, resampling what is already dug into it.
      The field is the player's own ruts and drill pits; dropping them on a
      settings change would be a worse bug than the one this fixes. */
  _resizeDent(DR) {
    const src = this.dent, SR = this.dentRes;
    const out = new Float32Array(DR * DR);
    // Both grids cover the same ±DENT_EXT, so texel centres map linearly.
    const ratio = SR / DR;
    for (let z = 0; z < DR; z++) {
      const sz = (z + 0.5) * ratio - 0.5;
      const z0 = Math.floor(sz), fz = sz - z0;
      const za = clamp(z0, 0, SR - 1) * SR, zb = clamp(z0 + 1, 0, SR - 1) * SR;
      for (let x = 0; x < DR; x++) {
        const sx = (x + 0.5) * ratio - 0.5;
        const x0 = Math.floor(sx), fx = sx - x0;
        const xa = clamp(x0, 0, SR - 1), xb = clamp(x0 + 1, 0, SR - 1);
        const h0 = src[za + xa] + (src[za + xb] - src[za + xa]) * fx;
        const h1 = src[zb + xa] + (src[zb + xb] - src[zb + xa]) * fx;
        out[z * DR + x] = h0 + (h1 - h0) * fz;
      }
    }

    this.dent = out;
    this.dentRes = DR;
    this.dentHalf = new Uint16Array(DR * DR);
    const half = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < out.length; i++) this.dentHalf[i] = half(out[i]);

    this.texDent.dispose();
    this.texDent = new THREE.DataTexture(this.dentHalf, DR, DR, THREE.RedFormat, THREE.HalfFloatType);
    this.texDent.magFilter = this.texDent.minFilter =
      this.manualBilinear ? THREE.NearestFilter : THREE.LinearFilter;
    this.texDent.generateMipmaps = false;
    // Upload the whole field as one texture rather than replaying it through
    // the scratch blitter: copyTextureToTexture needs a destination that is
    // already resident, and a fresh DataTexture is not until three uploads it.
    this.texDent.needsUpdate = true;

    this.uniforms.uDent.value = this.texDent;
    this.uniforms.uTexRes.value.w = DR;
    // Both lists index the grid that just went away.
    this._marks.length = 0;
    this._slumps.length = 0;
  }

  /** Reallocate the wheel-track buffer, copying the existing tracks across.
      Tracks are the record of where you have been; a settings change should
      not erase them. */
  _resizeTrail(TR) {
    const old = this.trailRT;
    this.trailRT = new THREE.WebGLRenderTarget(TR, TR, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false
    });
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(this.TRAIL_EXT, this.TRAIL_EXT),
      new THREE.MeshBasicMaterial({ map: old.texture, depthTest: false, depthWrite: false, toneMapped: false })
    );
    quad.frustumCulled = false;
    const sc = new THREE.Scene(); sc.add(quad);
    const r = this.renderer, p = r.getRenderTarget();
    r.setRenderTarget(this.trailRT);
    r.setClearColor(0x000000, 1); r.clear(true, false, false);
    r.render(sc, this.trailCam);
    r.setRenderTarget(p);
    quad.geometry.dispose(); quad.material.dispose();
    old.dispose();
    this.uniforms.uTrail.value = this.trailRT.texture;
  }

  /* ============================================================
     per-frame
     ============================================================ */
  update(dt, camera, sunDir) {
    // clipmap follow + snap
    const cx = camera.position.x, cz = camera.position.z;
    this.uniforms.uCamXZ.value.set(cx, cz, 0);
    for (const L of this.levels) {
      L.mesh.position.x = Math.round(cx / L.snap) * L.snap;
      L.mesh.position.z = Math.round(cz / L.snap) * L.snap;
    }
    this.relax(dt);
    this._uploadDirty();
    this._flushTrails();

    // rebake the sun mask only when the sun has actually moved
    if (sunDir.distanceToSquared(this._lastSun) > 2e-6) {
      this._lastSun.copy(sunDir);
      this.sunMat.uniforms.uSun.value.copy(sunDir);
      const r = this.renderer, p = r.getRenderTarget();
      r.setRenderTarget(this.sunRT);
      r.render(this._sunScene, this._sunCam);
      r.setRenderTarget(p);
    }
  }

  dispose() {
    this.texMacro.dispose(); this.texFar.dispose(); this.texDetail.dispose(); this.texGeology.dispose();
    this.texDent.dispose();
    for (const s of this.scratches) s.tex.dispose();
    this.trailRT.dispose(); this.sunRT.dispose();
    this._emptyShadow?.dispose();
    this._trailTex.dispose(); this._footTex.dispose();
    this._trailProto.dispose(); this._footProto.dispose(); this._trailGeo.dispose();
    for (const m of [...this._trailPool, ...this._footPool]) m.material.dispose();
    for (const L of this.levels) { L.mesh.geometry.dispose(); L.mesh.material.dispose(); }
  }
}

const _v3a = new THREE.Vector3();

/** Cross-section profile of a wheel rut: compacted plateau, soft shoulders.
    Uniform along its length so the quad can be stretched to any distance. */
function makeTrackStamp() {
  const S = 64;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    const v = Math.abs((y + 0.5) / S * 2 - 1);            // 0 centre .. 1 edge
    let a = 1 - sstep(0.55, 1.0, v);
    a *= 0.82 + 0.18 * Math.cos(v * 9.0);                  // faint twin-rut relief
    const k = Math.round(clamp(a, 0, 1) * 255);
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = k;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Apollo-like boot sole: heel, waist and a broad toe with transverse lugs. */
function makeFootprintStamp() {
  const S = 64;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S * 2 - 1;       // heel -X, toe +X
    const v = (y + 0.5) / S * 2 - 1;
    const width = 0.44 + 0.13 * sstep(-0.55, 0.78, u) - 0.09 * Math.exp(-u*u*5.5);
    const end = u < -0.58 ? Math.hypot((u + 0.58) / 0.42, v / 0.43)
              : u > 0.54 ? Math.hypot((u - 0.54) / 0.46, v / 0.56)
                         : Math.abs(v) / width;
    let a = 1 - sstep(0.76, 1.02, end);
    const lug = 0.70 + 0.30 * sstep(0.12, 0.72, Math.abs(Math.sin((u + 0.12) * 23.0)));
    a *= lug;
    const o = (y * S + x) * 4, k = Math.round(clamp(a, 0, 1) * 255);
    img.data[o] = img.data[o + 1] = img.data[o + 2] = k;
    img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
