/* Small, terrain-bound lights that wake with the grass. One draw call, no
   textures or lights: the warm halo is part of each depth-tested point. */
import * as THREE from 'three';
import { clamp, makeRNG, sstep } from '../core/rng.js';

const COUNTS = Object.freeze({ LOW: 120, MEDIUM: 210, HIGH: 320, ULTRA: 420 });
const LIVING_PHASES = new Set(['grass', 'first', 'bloom', 'full', 'navigate', 'ascend']);
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

function fireflyGeometry(capacity) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(capacity * 4), 4));
  geometry.setAttribute('aSlope', new THREE.BufferAttribute(new Float32Array(capacity * 2), 2));
  geometry.setDrawRange(0, 0);
  return geometry;
}

function routeDistance(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / Math.max(0.0001, dx * dx + dz * dz), 0, 1);
  return Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
}

// Match the grass shader's stable PCG clump field. Fireflies prefer established
// clumps rather than exposing the bare gaps between them with floating lights.
function grassHash(x, z) {
  const input = (Math.imul(x | 0, 1597334677) + Math.imul(z | 0, 3812015801)) >>> 0;
  const state = (Math.imul(input, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

function grassNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = sstep(0, 1, x - ix), fz = sstep(0, 1, z - iz);
  const a = grassHash(ix, iz) / 4294967295, b = grassHash(ix + 1, iz) / 4294967295;
  const c = grassHash(ix, iz + 1) / 4294967295, d = grassHash(ix + 1, iz + 1) / 4294967295;
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

export class GrassFireflies {
  constructor({ scene, terrain, quality }) {
    this.scene = scene;
    this.terrain = terrain;
    this.quality = quality;
    this.capacity = COUNTS[quality?.name] || COUNTS.MEDIUM;
    this.prepared = false;
    this.disposed = false;
    this._prepareArgs = null;
    this._viewport = new THREE.Vector2();
    this.geometry = fireflyGeometry(this.capacity);
    this.material = new THREE.ShaderMaterial({
      name: 'warm grass fireflies',
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
      uniforms: {
        uTime: { value: 0 }, uWave: { value: 0 },
        uMaturity: { value: 0 }, uFade: { value: 0 },
        uPointScale: { value: 800 }, uPixelRatio: { value: 1 }
      },
      vertexShader: /* glsl */`
        precision highp float;
        attribute vec4 aLife;
        attribute vec2 aSlope;
        uniform float uTime, uWave, uMaturity, uFade, uPointScale, uPixelRatio;
        varying float vGlow;
        void main() {
          float phase = aLife.y * 6.2831853;
          float clock = uTime * (0.19 + aLife.y * 0.065);
          vec2 drift = vec2(sin(clock + phase), cos(clock * 0.79 + phase * 1.7)) * 0.38;
          drift += vec2(cos(clock * 0.43 + phase), sin(clock * 0.51 + phase)) * 0.10;
          vec3 world = position;
          world.xz += drift;
          // A baked local slope follows small wander without terrain samplers.
          world.y += dot(aSlope, drift) + aLife.w + sin(clock * 0.67 + phase * 2.0) * 0.11;
          vec4 viewPosition = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * viewPosition;
          float distanceToGrass = length(world.xz - cameraPosition.xz);
          float nearFade = smoothstep(0.65, 1.8, length(world - cameraPosition));
          float farFade = 1.0 - smoothstep(26.0, 40.0, distanceToGrass);
          float born = smoothstep(aLife.x - 0.032, aLife.x + 0.032, uWave);
          float maturity = smoothstep(0.035, 0.58, uMaturity);
          // The slow envelope never switches off: no blink, synchronized pulse,
          // or brightness discontinuity when a particle's phase wraps.
          float breath = 0.82 + sin(uTime * 0.36 + phase * 2.3) * 0.12;
          vGlow = born * maturity * uFade * nearFade * farFade * breath;
          gl_PointSize = clamp(aLife.z * uPointScale / max(0.1, -viewPosition.z),
                               1.5 * uPixelRatio, 8.5 * uPixelRatio);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying float vGlow;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(p, p);
          if (r2 >= 1.0 || vGlow < 0.0005) discard;
          float core = exp(-r2 * 19.0);
          float halo = exp(-r2 * 4.8) * (1.0 - smoothstep(0.35, 1.0, r2));
          float alpha = (core * 0.75 + halo * 0.25) * vGlow;
          vec3 gold = mix(vec3(0.94, 0.52, 0.14), vec3(1.0, 0.88, 0.48), core);
          gl_FragColor = vec4(gold, alpha * 0.88);
        }
      `
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'grass-born golden fireflies';
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.visible = false;
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(this._viewport);
      this.material.uniforms.uPointScale.value = this._viewport.y * camera.projectionMatrix.elements[5] * 0.5;
      this.material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    };
    scene.add(this.points);
  }

  setQuality(quality) {
    if (this.disposed) return false;
    this.quality = quality;
    const capacity = COUNTS[quality?.name] || COUNTS.MEDIUM;
    if (capacity === this.capacity) return false;
    const oldGeometry = this.geometry;
    this.capacity = capacity;
    this.geometry = fireflyGeometry(capacity);
    this.points.geometry = this.geometry;
    this.prepared = false;
    // Reuse the event's copied anchors and seed, never the current camera or
    // rover. The deterministic stream keeps every existing light in place.
    if (this._prepareArgs) this.prepare(this._prepareArgs, { reset: false });
    this.points.visible = this.points.visible && this.prepared;
    oldGeometry.dispose();
    return true;
  }

  /** Prepare after the event's hero is anchored (and after restoring a save).
      `anchor` concentrates nearby lights; station remains the grass origin. */
  prepare({ anchor, station, target, seed = 0xF1AEF11E }, { reset = true } = {}) {
    if (this.disposed) return false;
    if (![station?.x, station?.z, target?.x, target?.z].every(Number.isFinite)) return false;
    const focus = [anchor?.x, anchor?.z].every(Number.isFinite) ? anchor : station;
    this._prepareArgs = {
      anchor: { x: focus.x, z: focus.z }, station: { x: station.x, z: station.z },
      target: { x: target.x, z: target.z }, seed
    };
    const rng = makeRNG(seed);
    const position = this.geometry.getAttribute('position');
    const life = this.geometry.getAttribute('aLife');
    const slope = this.geometry.getAttribute('aSlope');
    const dx = target.x - station.x, dz = target.z - station.z;
    const length = Math.max(1, Math.hypot(dx, dz));
    let count = 0;
    for (let attempt = 0; count < this.capacity && attempt < this.capacity * 30; attempt++) {
      const family = rng();
      let x, z;
      if (family < 0.60) {
        const center = rng() < 0.68 ? focus : station;
        const angle = rng() * Math.PI * 2, radius = 3 + Math.sqrt(rng()) * 29;
        x = center.x + Math.cos(angle) * radius;
        z = center.z + Math.sin(angle) * radius;
      } else if (family < 0.88) {
        const t = rng(), side = (rng() < 0.5 ? -1 : 1) * (9.4 + rng() * 13);
        x = station.x + dx * t - dz / length * side;
        z = station.z + dz * t + dx / length * side;
      } else {
        const angle = rng() * Math.PI * 2, radius = 32 + Math.sqrt(rng()) * 308;
        x = station.x + Math.cos(angle) * radius;
        z = station.z + Math.sin(angle) * radius;
      }
      const radius = Math.hypot(x - station.x, z - station.z);
      if (radius > 346 || Math.hypot(x, z) > 530) continue;
      // The grass corridor is 7.4 m half-width; this margin contains all drift.
      if (routeDistance(x, z, station, target) < 8.2) continue;
      const clump = sstep(0.29, 0.78,
        grassNoise(x / 1.48, z / 1.48) * 0.72 + grassNoise(x / 4.9 + 13.7, z / 4.9 - 8.4) * 0.38);
      if (clump < 0.32 || rng() > 0.35 + clump * 0.65) continue;
      const y = this.terrain.heightAt(x, z);
      const sx = (this.terrain.heightAt(x + 0.6, z) - this.terrain.heightAt(x - 0.6, z)) / 1.2;
      const sz = (this.terrain.heightAt(x, z + 0.6) - this.terrain.heightAt(x, z - 0.6)) / 1.2;
      if (![y, sx, sz].every(Number.isFinite) || Math.hypot(sx, sz) > 0.75) continue;
      const particleSeed = rng();
      position.setXYZ(count, x, y, z);
      // Slightly behind the local grass birth: roots first, then warm life.
      life.setXYZW(count, clamp(radius / 350 + 0.018 + (particleSeed - 0.5) * 0.025, 0.02, 1.05),
        particleSeed, 0.092 + rng() * 0.055, 0.64 + rng() * 1.02);
      slope.setXY(count, sx, sz);
      count++;
    }
    for (const attribute of [position, life, slope]) attribute.needsUpdate = true;
    this.geometry.setDrawRange(0, count);
    this.prepared = count > 0;
    if (reset) this.reset();
    return this.prepared;
  }

  update({ phase, time, grassWave, grassMaturity, fade }) {
    if (this.disposed) return;
    const U = this.material.uniforms;
    U.uTime.value = Math.max(0, finite(time));
    U.uWave.value = clamp(finite(grassWave), 0, 1.2);
    U.uMaturity.value = clamp(finite(grassMaturity), 0, 1);
    // The scar's 3.5% residual blades do not keep airborne lights alive.
    U.uFade.value = LIVING_PHASES.has(phase) ? clamp((finite(fade) - 0.035) / 0.965, 0, 1) : 0;
    this.points.visible = this.prepared && U.uFade.value > 0.0001
      && U.uWave.value > 0.001 && U.uMaturity.value > 0.035;
  }

  reset() {
    this.points.visible = false;
    for (const name of ['uTime', 'uWave', 'uMaturity', 'uFade']) this.material.uniforms[name].value = 0;
  }

  dispose() {
    if (this.disposed) return;
    this.reset();
    this.scene.remove(this.points);
    this.points.onBeforeRender = () => {};
    this.geometry.dispose();
    this.material.dispose();
    this.prepared = false;
    this._prepareArgs = null;
    this.disposed = true;
  }
}
