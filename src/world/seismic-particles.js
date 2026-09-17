import { sstep } from '../core/rng.js';
import { ESCAPE } from '../game/dimensional-escape.js';
import { STARFALL } from './starfall-field.js';

// Invert the authored front's travel once per emitter. World-space births do
// not slide forward with the chase line, and seeking can reconstruct a cloud.
export function seismicArrivalTime(front) {
  if (front < -320) return Infinity;
  if (front > ESCAPE.start) return STARFALL.intro + ESCAPE.warning + (front - ESCAPE.start) / ESCAPE.speed;
  const target = Math.max(0, Math.min(1, (front + 320) / 255));
  let lo = 0, hi = 1;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (mid * mid * (3 - 2 * mid) < target) lo = mid; else hi = mid;
  }
  return 17 + (lo + hi) * 0.5 * 8.6;
}

export function seismicDustPose(source, time, layer = 0) {
  const age = time - source.birth - layer * 0.24;
  const life = layer === 1 ? 11.5 : 9.0;
  if (age <= 0 || age >= life) return null;
  const t = age / life, grow = 1 - Math.exp(-age * 0.48);
  const width = source.size * (layer === 1 ? 2.7 : 1.75) * (0.5 + grow * 0.85);
  const height = width * (layer === 1 ? 0.24 : 0.64);
  return {
    x: source.x + Math.sin(source.seed) * grow * (layer === 1 ? 4.0 : 1.8),
    y: source.y + height * 0.4 + age * (layer === 1 ? 0.06 : 0.48),
    z: source.z + Math.cos(source.seed) * grow * (layer === 1 ? 4.0 : 1.8),
    width, height, frame: Math.min(24, t * 24), mirror: source.seed % 2 > 1 ? 1 : 0,
    opacity: sstep(0, 0.65, age) * (1 - sstep(0.5, 1, t)) * (layer === 1 ? 0.3 : 0.36)
  };
}

export function seismicRockPose(source, time) {
  const age = time - source.birth;
  if (age <= 0 || age >= 4.2) return null;
  const speed = 1.4 + source.seed % 1 * 1.8;
  return {
    x: source.x + Math.sin(source.seed) * age * speed,
    y: source.y + 0.45 + (2.2 + source.seed % 1 * 2) * age - 0.5 * 3.71 * age * age,
    z: source.z + Math.cos(source.seed) * age * speed,
    size: 0.28 + (source.seed % 1) * 0.82,
    spin: source.seed + age * (0.65 + source.seed % 1),
    // The fragment falls into the opened fault; no repeated grow/shrink loop.
    fade: 1 - sstep(3.5, 4.2, age)
  };
}
