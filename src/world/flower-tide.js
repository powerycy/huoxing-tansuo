/* ============================================================
   SILENT FLOWER TIDE — impossible life over the lunar basin
   ------------------------------------------------------------
   A resumable world event layered over the rover delivery loop.  A GPU-driven
   silver bloom grows from Halley VI, opens a navigable corridor to the relay,
   then sheds its petals upward in low gravity.  No atmosphere or black rain is
   implied: the impossibility is the point of the event.
   ============================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clamp, sstep, lerp, makeRNG } from '../core/rng.js';
import { FalseEarthGrass, FalseEarthRoseField } from './false-earth-vegetation.js';
import { GrassFireflies } from './fireflies.js';
import { FlowerCinematic, CINEMATIC_PHASES } from '../game/flower-cinematic.js';

const PHASES = Object.freeze([
  ['warning', 20.0],
  ['grass', 12.0],
  ['first', 16.0],
  ['bloom', 22.0],
  ['full', 4.0],
  ['navigate', 50.0],
  ['ascend', 12.0]
]);
const PHASE_INDEX = Object.freeze(Object.fromEntries(PHASES.map(([name], i) => [name, i])));
const V4_GROWTH_DURATIONS = Object.freeze({ grass: 6, first: 8, bloom: 10, full: 3 });
const V5_MOON_DURATION = 11;
const V6_MOON_DURATION = 28;
// The habitat's real ridge is higher than a flat horizon. Start the upper limb
// just above that ridge while keeping most of the disc hidden behind it.
const MOON_START_ELEVATION = -0.14;
const LEGACY_MOON_START_ELEVATION = -0.62;
const OLD_PHASE = Object.freeze({ opening: 'bloom', observe: 'full', escape: 'navigate', collapse: 'ascend' });
const FLOWER_COUNTS = Object.freeze({ LOW: 900, MEDIUM: 1800, HIGH: 3000, ULTRA: 4500 });
const PETAL_CAPACITY = 1450;
const petalCount = (quality) => clamp(Math.round((quality?.dust || 1200) * 0.42), 280, PETAL_CAPACITY);

export class FlowerTide {
  constructor({ scene, sky, terrain, engine, rover, rig, hud, audio, props, delivery, quality }) {
    Object.assign(this, {
      scene, sky, terrain, engine, rover, rig, hud, audio, props, delivery, quality
    });

    this.phase = 'dormant';
    this.phaseT = 0;
    this.totalT = 0;
    this.triggered = false;
    this.completed = false;
    this.interference = 0;
    this.petalIntensity = 0;
    this.rainIntensity = 0; // compatibility with older post-processing hooks
    this.tension = 0;
    this.exposureOffset = 0;
    this.flash = 0;
    this.darkness = 0;
    this.bloomAmount = 0;
    this.moonPresence = 0;
    this.moonKeyStrength = 0;
    this._moonAzimuth = new THREE.Vector3(0.34, 0, -0.87).normalize();
    this._moonDirection = new THREE.Vector3();
    this._moonStartElevation = MOON_START_ELEVATION;
    this._petalClock = 0;
    this._phaseAnnounced = '';
    this.heroFlowers = null;

    this._ensureTerrainUniforms();
    this._buildFlowers();
    const station = this.delivery.station;
    const target = this.delivery.facility?.position || { x: station.x - 120, z: station.z - 100 };
    // Keep the biological route anchored to the lonely station even after delivery
    // changes its gameplay target back to the home pad.
    this.guideTarget = new THREE.Vector3(target.x, 0, target.z);
    const vegetation = { scene, terrain, engine, rover, station, target, quality };
    this.grassSystem = new FalseEarthGrass(vegetation);
    this.roseField = new FalseEarthRoseField(vegetation);
    this.fireflies = new GrassFireflies({ scene, terrain, quality });
    this.cinematic = new FlowerCinematic(this);
    this._buildPetals();
    this._buildSkyFissure();
    this._buildFlowerLight();
    this._capturePracticals();
    this.reset();
  }

  get cinematicActive() { return this.cinematic.active; }
  get cinematicState() { return this.cinematic.state; }
  get phaseProgress() {
    const i = PHASE_INDEX[this.phase];
    return i === undefined ? 0 : clamp(this.phaseT / PHASES[i][1], 0, 1);
  }
  setQuality(quality) {
    this.quality = quality;
    this.grassSystem.setQuality(quality);
    this.roseField.setQuality(quality);
    this.fireflies.setQuality(quality);
    this.flowers.count = Math.min(FLOWER_COUNTS[quality?.name] || 4200, this._flowersPlaced);
    this.petals.geometry.setDrawRange(0, petalCount(quality));
  }
  skipCinematic() { return this.cinematic.skip(); }
  updateCinematic(dt) {
    this.cinematic.update(dt);
    // Camera-dependent vegetation LOD centres are updated after the final
    // camera pose; otherwise a low shot can expose a one-frame empty patch.
    const camera = this.engine.camera;
    for (const mesh of this.grassSystem.meshes) {
      mesh.material.uniforms.uPatchCenter.value.set(camera.position.x, camera.position.z);
    }
    for (const mesh of this.roseField.meshes) {
      mesh.material.uniforms.uLodCamera.value.copy(camera.position);
    }
  }

  _buildGrass() {
    // One instance contains three crossed ribbons. The counts below therefore
    // represent roughly 27k-156k visible blades without asking WebGL2 to draw
    // the million independent instances used by false-earth's WebGPU path.
    const countByTier = { LOW: 9000, MEDIUM: 18000, HIGH: 32000, ULTRA: 52000 };
    const count = countByTier[this.quality?.name] || 20000;
    const geometry = blackGrassGeometry();
    const material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uWave: { value: 0 },
        uFade: { value: 0 },
        uResidual: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.6, 0.2, 0.3).normalize() },
        uSilverLight: { value: 0 }
      },
      vertexShader: /* glsl */`
        precision highp float;
        attribute vec2 aBlade;
        attribute vec4 aGrass;
        uniform float uTime, uWave, uFade, uResidual, uSilverLight;
        varying float vHeight, vGrowth, vSeed;
        varying vec3 vN, vWorld;
        void main(){
          float born = smoothstep(aGrass.x - 0.052, aGrass.x + 0.052, uWave);
          float survivor = step(0.986, aGrass.y) * uResidual;
          float growth = born * max(uFade, survivor);
          float rise = smoothstep(0.0, 0.48, growth);
          vec3 p = position;
          p.y *= rise;
          p.xz *= mix(0.06, 1.0, rise);

          // In the airless basin this is an electrostatic/low-gravity tremor,
          // deliberately much slower and smaller than terrestrial wind.
          float tip = pow(aBlade.x, 1.65);
          float sway = sin(uTime * 0.44 + aGrass.y * 41.0 + aBlade.y * 9.0 + p.y * 3.2);
          float sway2 = cos(uTime * 0.31 + aGrass.y * 29.0 + aBlade.y * 13.0);
          p.x += sway * tip * rise * (0.010 + uSilverLight * 0.020);
          p.z += sway2 * tip * rise * (0.008 + uSilverLight * 0.016);

          vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
          vWorld = world.xyz;
          vHeight = aBlade.x;
          vGrowth = growth;
          vSeed = aGrass.y;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform vec3 uSunDir;
        uniform float uSilverLight;
        varying float vHeight, vGrowth, vSeed;
        varying vec3 vN, vWorld;
        void main(){
          if(vGrowth < 0.016) discard;
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vWorld);
          float ndl = max(dot(N, normalize(uSunDir)), 0.0);
          float rim = pow(1.0 - abs(dot(N, V)), 2.6);
          float tip = smoothstep(0.42, 1.0, vHeight);
          float silverTip = smoothstep(0.76, 1.0, vHeight);
          vec3 root = vec3(0.0020, 0.0032, 0.0035);
          vec3 charcoal = vec3(0.018, 0.029, 0.032) * (0.48 + ndl * 0.55);
          vec3 silver = vec3(0.26, 0.36, 0.38) * (0.24 + ndl * 0.88)
                      + vec3(0.20, 0.43, 0.47) * rim * (0.10 + uSilverLight * 0.32);
          vec3 col = mix(root, charcoal, tip);
          col = mix(col, silver, silverTip * (0.42 + uSilverLight * 0.42));
          col += vec3(0.13, 0.29, 0.32) * rim * tip * (0.035 + uSilverLight * 0.12);
          col *= 0.88 + 0.12 * sin(vSeed * 73.0);
          float distanceGrade = smoothstep(390.0, 205.0, length(cameraPosition - vWorld));
          col *= mix(0.18, 1.0, distanceGrade);
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    this.grass = new THREE.InstancedMesh(geometry, material, count);
    this.grass.name = 'black silver anomaly grass';
    this.grass.frustumCulled = false;
    this.grass.castShadow = false;
    this.grass.receiveShadow = false;
    this.grass.renderOrder = 2;

    const data = new Float32Array(count * 4);
    const rng = makeRNG(0xB1AC6A55);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const yawQ = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const slopeNormal = new THREE.Vector3();
    const station = this.delivery.station;
    const target = this.delivery.facility?.position || { x: station.x - 120, z: station.z - 100 };
    let clusterX = station.x, clusterZ = station.z, clusterRadius = 2;
    let placed = 0;
    for (let attempts = 0; placed < count && attempts < count * 12; attempts++) {
      if (placed % 15 === 0) {
        const clusterAngle = rng() * Math.PI * 2;
        const nearPatch = rng() < 0.64;
        const clusterDistance = nearPatch
          ? 11 + Math.sqrt(rng()) * 118
          : 105 + Math.sqrt(rng()) * 245;
        clusterX = station.x + Math.cos(clusterAngle) * clusterDistance;
        clusterZ = station.z + Math.sin(clusterAngle) * clusterDistance;
        clusterRadius = 0.85 + Math.pow(rng(), 1.7) * 4.8;
      }
      const localAngle = rng() * Math.PI * 2;
      const localRadius = Math.sqrt(rng()) * clusterRadius;
      const x = clusterX + Math.cos(localAngle) * localRadius;
      const z = clusterZ + Math.sin(localAngle) * localRadius;
      const radius = Math.hypot(x - station.x, z - station.z);
      if (Math.hypot(x, z) > 535 || radius < 9.5) continue;
      if (segmentDistance(x, z, station.x, station.z, target.x, target.z) < 7.5) continue;
      const y = this.terrain.heightAt(x, z);
      const dx = this.terrain.heightAt(x + 0.62, z) - y;
      const dz = this.terrain.heightAt(x, z + 0.62) - y;
      if (Math.hypot(dx, dz) > 0.70) continue;

      const seed = rng();
      const bladeScale = 0.32 + Math.pow(rng(), 1.65) * 0.72;
      pos.set(x, y + 0.018, z);
      slopeNormal.set(-dx, 0.62, -dz).normalize();
      q.setFromUnitVectors(up, slopeNormal);
      yawQ.setFromAxisAngle(up, rng() * Math.PI * 2);
      q.multiply(yawQ);
      s.set(bladeScale * (0.72 + rng() * 0.42), bladeScale * (0.74 + rng() * 0.72), bladeScale);
      m.compose(pos, q, s);
      this.grass.setMatrixAt(placed, m);
      data[placed * 4] = clamp(radius / 350 + (rng() - 0.5) * 0.085, 0.015, 1.05);
      data[placed * 4 + 1] = seed;
      data[placed * 4 + 2] = clusterRadius;
      data[placed * 4 + 3] = rng();
      placed++;
    }
    this.grass.count = placed;
    this.grass.geometry.setAttribute('aGrass', new THREE.InstancedBufferAttribute(data, 4));
    this.grass.instanceMatrix.needsUpdate = true;
    this.grass.visible = false;
    this.scene.add(this.grass);
  }

  _ensureTerrainUniforms() {
    const U = this.terrain.uniforms;
    U.uEventCenter ||= { value: new THREE.Vector3() };
    U.uEventPulse ||= { value: -1 };
    U.uEventWet ||= { value: 0 };
    U.uEventLight ||= { value: 0 };
    U.uEventDir ||= { value: new THREE.Vector3(0.3, 0.7, -0.6).normalize() };
    U.uFlowerCenter ||= { value: new THREE.Vector3() };
    U.uFlowerTarget ||= { value: new THREE.Vector3() };
    U.uFlowerRadius ||= { value: 0 };
    U.uFlowerFade ||= { value: 0 };
    U.uFlowerLight ||= { value: 0 };
  }

  _buildFlowers() {
    // Lightweight lotus silhouettes are now only the middle/far coverage. The
    // near field is reserved for the authored 142-frame VAT roses.
    // Keep the guide banks, destination crown and scatter in a single stable
    // pool. Tier switches reveal a longer prefix without moving any flowers.
    const count = FLOWER_COUNTS.ULTRA;
    const geometry = flowerGeometry();
    const material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uWave: { value: 0 },
        uFade: { value: 0 },
        uResidual: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.6, 0.2, 0.3).normalize() },
        uSilverLight: { value: 0 }
      },
      vertexShader: /* glsl */`
        precision highp float;
        attribute float aPart;
        attribute vec3 aFlower;
        uniform float uTime, uWave, uFade, uResidual;
        varying float vPart, vGrowth, vSeed, vGuide, vRouteT;
        varying vec3 vN, vWorld;
        void main(){
          float born = smoothstep(aFlower.x - 0.040, aFlower.x + 0.040, uWave);
          float survivor = step(0.965, aFlower.z) * uResidual;
          float life = max(uFade, survivor);
          float growth = born * life;
          float petal = step(0.5, aPart);
          float petalOpen = smoothstep(0.14, 0.92, growth);
          vec3 p = position;
          p.y *= smoothstep(0.0, 0.44, growth);
          p.xz *= mix(0.035, 1.0, mix(growth, petalOpen, petal));
          p.x += sin(uTime * 0.52 + aFlower.z * 31.0 + p.y * 2.0) * 0.012 * petalOpen;
          p.z += cos(uTime * 0.43 + aFlower.z * 27.0 + p.y * 1.7) * 0.010 * petalOpen;
          vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
          mat3 normalMatrixWorld = mat3(modelMatrix) * mat3(instanceMatrix);
          vN = normalize(normalMatrixWorld * normal);
          vWorld = world.xyz;
          vPart = aPart;
          vGrowth = growth;
          vSeed = aFlower.z;
          // The second component is negative only for the two authored guide
          // banks. Its magnitude stores progress from habitat to relay.
          vGuide = 1.0 - step(0.0, aFlower.y);
          vRouteT = clamp(-aFlower.y - 0.10, 0.0, 1.0);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform vec3 uSunDir;
        uniform float uSilverLight, uTime;
        varying float vPart, vGrowth, vSeed, vGuide, vRouteT;
        varying vec3 vN, vWorld;
        void main(){
          if(vGrowth < 0.018) discard;
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vWorld);
          float lit = 0.18 + 0.82 * max(dot(N, normalize(uSunDir)), 0.0);
          float rim = pow(1.0 - abs(dot(N, V)), 2.2);
          vec3 stem = vec3(0.007, 0.014, 0.015) * (0.38 + lit * 0.42);
          vec3 silver = vec3(0.48, 0.58, 0.60) * (0.24 + lit * 0.86)
                      + vec3(0.16, 0.56, 0.66) * rim * (0.16 + uSilverLight * 0.38);
          vec3 core = vec3(0.78, 0.16, 0.025) * (0.46 + uSilverLight * 1.45)
                    + vec3(0.92, 0.62, 0.18) * rim * 0.38;
          vec3 col = vPart < 0.5 ? stem : (vPart < 1.5 ? silver : core);
          // Narrow highlights travel from Halley VI toward the relay. The
          // flowers remain physical silhouettes; only their silver edges carry
          // direction, so this reads as an organism rather than a neon road.
          float guidePetal = step(0.5, vPart) * vGuide;
          col += vec3(0.12, 0.48, 0.62) * guidePetal
               * (0.08 + uSilverLight*0.28) * (0.62 + vRouteT*0.38);
          col *= 0.90 + 0.10 * sin(vSeed * 71.0);
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    this.flowers = new THREE.InstancedMesh(geometry, material, count);
    this.flowers.name = 'silent silver flower field';
    this.flowers.frustumCulled = false;
    this.flowers.castShadow = false;
    this.flowers.receiveShadow = false;
    this.flowers.renderOrder = 3;

    const wave = new Float32Array(count * 3);
    const rng = makeRNG(0xF10A7E);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const station = this.delivery.station;
    const target = this.delivery.facility?.position || { x: station.x - 120, z: station.z - 100 };
    let placed = 0;

    // Build a pair of continuous flower banks before scattering the field.
    // Their centre remains bare and wide enough for the rover, while their
    // birth values rise along the route so the bloom visibly points forward.
    const routeX = target.x - station.x;
    const routeZ = target.z - station.z;
    const routeLength = Math.max(1, Math.hypot(routeX, routeZ));
    const forwardX = routeX / routeLength;
    const forwardZ = routeZ / routeLength;
    const sideX = -forwardZ;
    const sideZ = forwardX;
    const guidePairs = Math.min(
      Math.floor((count - 28) / 2),
      Math.max(28, Math.ceil(routeLength / 4.2))
    );
    for (let i = 0; i < guidePairs && placed + 1 < count; i++) {
      const t = (i + 1) / (guidePairs + 1);
      const along = (rng() - 0.5) * 1.25;
      for (const side of [-1, 1]) {
        const shoulder = side * (8.4 + Math.sin(t * 24.0 + side) * 0.55 + (rng() - 0.5) * 0.45);
        const x = station.x + routeX * t + forwardX * along + sideX * shoulder;
        const z = station.z + routeZ * t + forwardZ * along + sideZ * shoulder;
        const y = this.terrain.heightAt(x, z);
        const dx = this.terrain.heightAt(x + 0.75, z) - y;
        const dz = this.terrain.heightAt(x, z + 0.75) - y;
        const scale = 0.46 + rng() * 0.30;
        pos.set(x, y + 0.025, z);
        a.set(-dx, 0.75, -dz).normalize();
        q.setFromUnitVectors(up, a);
        q.multiply(new THREE.Quaternion().setFromAxisAngle(up, rng() * Math.PI * 2));
        s.set(scale * (0.88 + rng() * 0.18), scale * (1.0 + rng() * 0.32), scale);
        m.compose(pos, q, s);
        this.flowers.setMatrixAt(placed, m);
        wave[placed * 3] = 0.08 + t * 0.90;
        wave[placed * 3 + 1] = -0.10 - t;
        wave[placed * 3 + 2] = rng();
        placed++;
      }
    }

    // A denser crown around the relay makes the destination legible from the
    // final approach and closes the visual sentence begun by the two banks.
    const terminalCount = Math.min(28, count - placed);
    for (let i = 0; i < terminalCount; i++) {
      const angle = (i / terminalCount) * Math.PI * 2 + (rng() - 0.5) * 0.12;
      const radius = 8.2 + (i % 3) * 1.35 + rng() * 0.45;
      const x = target.x + Math.cos(angle) * radius;
      const z = target.z + Math.sin(angle) * radius;
      const y = this.terrain.heightAt(x, z);
      const dx = this.terrain.heightAt(x + 0.75, z) - y;
      const dz = this.terrain.heightAt(x, z + 0.75) - y;
      const scale = 0.56 + rng() * 0.30;
      pos.set(x, y + 0.025, z);
      a.set(-dx, 0.75, -dz).normalize();
      q.setFromUnitVectors(up, a);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(up, rng() * Math.PI * 2));
      s.set(scale, scale * (1.05 + rng() * 0.24), scale);
      m.compose(pos, q, s);
      this.flowers.setMatrixAt(placed, m);
      wave[placed * 3] = 0.93 + rng() * 0.05;
      wave[placed * 3 + 1] = -1.10;
      wave[placed * 3 + 2] = rng();
      placed++;
    }

    for (let attempts = 0; placed < count && attempts < count * 9; attempts++) {
      const angle = rng() * Math.PI * 2;
      // Half the budget belongs to the playable station/rover area. A uniform
      // 350 m disc looked empty nearby even with thousands of instances.
      const nearPatch = rng() < 0.52;
      const radius = nearPatch
        ? 48 + Math.sqrt(rng()) * 100
        : 132 + Math.sqrt(rng()) * 218;
      const x = station.x + Math.cos(angle) * radius;
      const z = station.z + Math.sin(angle) * radius;
      if (Math.hypot(x, z) > 535) continue;
      if (segmentDistance(x, z, station.x, station.z, target.x, target.z) < 6.6) continue;
      const y = this.terrain.heightAt(x, z);
      const dx = this.terrain.heightAt(x + 0.75, z) - y;
      const dz = this.terrain.heightAt(x, z + 0.75) - y;
      if (Math.hypot(dx, dz) > 0.78) continue;
      const heroFlower = rng() < 0.032;
      const scale = heroFlower
        ? 0.72 + rng() * 0.36
        : 0.22 + Math.pow(rng(), 1.8) * 0.56;
      pos.set(x, y + 0.025, z);
      a.set(-dx, 0.75, -dz).normalize();
      q.setFromUnitVectors(up, a);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(up, rng() * Math.PI * 2));
      s.set(scale * (0.82 + rng() * 0.30), scale * (0.82 + rng() * 0.58), scale);
      m.compose(pos, q, s);
      this.flowers.setMatrixAt(placed, m);
      wave[placed * 3] = clamp(radius / 350 + (rng() - 0.5) * 0.075, 0.02, 1.04);
      wave[placed * 3 + 1] = clamp(segmentDistance(x, z, station.x, station.z, target.x, target.z) / 20, 0, 1);
      wave[placed * 3 + 2] = rng();
      placed++;
    }
    this._flowersPlaced = placed;
    this.flowers.count = Math.min(FLOWER_COUNTS[this.quality?.name] || 4200, placed);
    this.flowers.geometry.setAttribute('aFlower', new THREE.InstancedBufferAttribute(wave, 3));
    this.flowers.instanceMatrix.needsUpdate = true;
    this.flowers.visible = false;
    this.scene.add(this.flowers);
  }

  async _buildHeroFlowers() {
    // The authored false-earth rose provides a real petal/leaf silhouette close
    // to the rover. The lightweight procedural flower above remains the middle
    // and far LOD, so this layer can fail safely on an old save or offline load.
    const countByTier = { LOW: 120, MEDIUM: 280, HIGH: 520, ULTRA: 780 };
    const count = countByTier[this.quality?.name] || 320;
    try {
      const gltf = await new GLTFLoader().loadAsync('assets/models/vegetation/false-earth-rose-low-poly.glb');
      let source = null;
      gltf.scene.traverse((o) => { if (!source && o.isMesh) source = o; });
      if (!source?.geometry) throw new Error('rose mesh missing');

      const geometry = source.geometry.clone();
      // Source height is roughly 10 cm. Baking the scale keeps instanceMatrix
      // variation readable and leaves the event shader identical for both LODs.
      geometry.applyMatrix4(new THREE.Matrix4().makeScale(9.2, 9.2, 9.2));
      const colors = geometry.getAttribute('color');
      const parts = new Float32Array(geometry.getAttribute('position').count);
      for (let i = 0; i < parts.length; i++) {
        const r = colors ? colors.getX(i) : 0.7;
        // false-earth encodes petals near 0.7, stems at 0 and leaves at 1.
        parts[i] = Math.abs(r - 0.7) < 0.08 ? 1 : 0;
      }
      geometry.setAttribute('aPart', new THREE.BufferAttribute(parts, 1));
      geometry.computeBoundingSphere();

      const mesh = new THREE.InstancedMesh(geometry, this.flowers.material, count);
      mesh.name = 'authored false-earth rose near lod';
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 4;

      const wave = new Float32Array(count * 3);
      const rng = makeRNG(0xF451E477);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const yawQ = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const pos = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      const slopeNormal = new THREE.Vector3();
      const station = this.delivery.station;
      const target = this.delivery.facility?.position || { x: station.x - 120, z: station.z - 100 };
      let clusterX = station.x, clusterZ = station.z, clusterRadius = 2;
      let placed = 0;
      for (let attempts = 0; placed < count && attempts < count * 14; attempts++) {
        if (placed % 8 === 0) {
          const angle = rng() * Math.PI * 2;
          const radius = 12 + Math.sqrt(rng()) * 105;
          clusterX = station.x + Math.cos(angle) * radius;
          clusterZ = station.z + Math.sin(angle) * radius;
          clusterRadius = 0.75 + rng() * 2.8;
        }
        const localAngle = rng() * Math.PI * 2;
        const localRadius = Math.sqrt(rng()) * clusterRadius;
        const x = clusterX + Math.cos(localAngle) * localRadius;
        const z = clusterZ + Math.sin(localAngle) * localRadius;
        const radius = Math.hypot(x - station.x, z - station.z);
        if (Math.hypot(x, z) > 535 || radius < 10.0) continue;
        if (segmentDistance(x, z, station.x, station.z, target.x, target.z) < 7.2) continue;
        const y = this.terrain.heightAt(x, z);
        const dx = this.terrain.heightAt(x + 0.65, z) - y;
        const dz = this.terrain.heightAt(x, z + 0.65) - y;
        if (Math.hypot(dx, dz) > 0.68) continue;

        const scale = 0.56 + Math.pow(rng(), 1.4) * 0.82;
        pos.set(x, y + 0.018, z);
        slopeNormal.set(-dx, 0.65, -dz).normalize();
        q.setFromUnitVectors(up, slopeNormal);
        yawQ.setFromAxisAngle(up, rng() * Math.PI * 2);
        q.multiply(yawQ);
        s.set(scale * (0.88 + rng() * 0.20), scale * (0.90 + rng() * 0.32), scale);
        m.compose(pos, q, s);
        mesh.setMatrixAt(placed, m);
        wave[placed * 3] = clamp(radius / 350 + (rng() - 0.5) * 0.065, 0.02, 1.04);
        wave[placed * 3 + 1] = clamp(segmentDistance(x, z, station.x, station.z, target.x, target.z) / 20, 0, 1);
        wave[placed * 3 + 2] = rng();
        placed++;
      }
      mesh.count = placed;
      geometry.setAttribute('aFlower', new THREE.InstancedBufferAttribute(wave, 3));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = this.flowers.visible;
      this.heroFlowers = mesh;
      this.scene.add(mesh);
    } catch (error) {
      console.warn('Authored flower LOD unavailable; keeping procedural flower field.', error);
    }
  }

  _buildPetals() {
    const count = PETAL_CAPACITY;
    const rng = makeRNG(0x51A7E1);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const angle = rng() * Math.PI * 2;
      const radius = 2 + Math.sqrt(rng()) * 34;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = rng() * 32;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
      seeds[i * 3] = rng(); seeds[i * 3 + 1] = rng(); seeds[i * 3 + 2] = rng();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geometry.setDrawRange(0, petalCount(this.quality));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 15, 0), 60);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uClock: { value: 0 },
        uIntensity: { value: 0 },
        uPx: { value: Math.min(2, window.devicePixelRatio || 1) }
      },
      vertexShader: /* glsl */`
        attribute vec3 aSeed;
        uniform float uClock, uIntensity, uPx;
        varying float vAlpha, vSeed;
        void main(){
          vec3 p = position;
          float speed = 0.32 + aSeed.x * 0.72;
          p.y = mod(position.y + uClock * speed, 32.0) + 0.4;
          p.x += sin(uClock * 0.16 + aSeed.y * 23.0 + p.y * 0.16) * (0.5 + aSeed.x * 0.8);
          p.z += cos(uClock * 0.13 + aSeed.z * 27.0 + p.y * 0.13) * (0.4 + aSeed.y * 0.7);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float perspective = clamp(68.0 / max(16.0, -mv.z), 0.42, 1.35);
          gl_PointSize = (2.8 + aSeed.y * 5.2) * uPx * perspective;
          vAlpha = uIntensity * (0.34 + aSeed.x * 0.62);
          vSeed = aSeed.z;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying float vAlpha, vSeed;
        void main(){
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float angle = vSeed * 6.2831853;
          q = mat2(cos(angle),-sin(angle),sin(angle),cos(angle)) * q;
          q.x *= 0.48;
          float diamond = abs(q.x) * 0.72 + abs(q.y);
          float petal = 1.0 - smoothstep(0.62, 0.94, diamond);
          float vein = exp(-abs(q.x) * 9.0) * 0.15;
          float alpha = petal * vAlpha;
          if(alpha < 0.014) discard;
          vec3 col = vec3(0.42, 0.56, 0.60) + vec3(0.18, 0.42, 0.48) * vein
                   + vec3(vSeed * 0.025);
          gl_FragColor = vec4(col, alpha);
        }
      `
    });
    this.petals = new THREE.Points(geometry, material);
    this.petals.name = 'low gravity ascending silver petals';
    this.petals.frustumCulled = false;
    this.petals.renderOrder = 42;
    this.petals.visible = false;
    this.scene.add(this.petals);
  }

  _buildSkyFissure() {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uOpen: { value: 0 },
        uCenter: { value: new THREE.Vector3(0.30, 0.53, -0.79).normalize() }
      },
      vertexShader: /* glsl */`
        varying vec3 vD;
        void main(){
          vD = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vD;
        uniform float uTime, uOpen;
        uniform vec3 uCenter;
        void main(){
          vec3 d = normalize(vD), c = normalize(uCenter);
          vec3 right = normalize(cross(vec3(0.0,1.0,0.0), c));
          vec3 up = normalize(cross(c, right));
          float front = dot(d, c);
          if(front < 0.72) discard;
          vec2 p = vec2(dot(d,right), dot(d,up)) / max(front, 0.2);
          float path = p.y - p.x * 0.34 - sin(p.x * 17.0 + 0.7) * 0.009 - sin(p.x * 43.0) * 0.003;
          float lengthMask = smoothstep(0.19, 0.125, abs(p.x));
          float core = exp(-pow(path / 0.0018, 2.0)) * lengthMask;
          float halo = exp(-pow(path / 0.010, 2.0)) * lengthMask;
          vec3 col = vec3(0.50,0.72,0.78) * core + vec3(0.055,0.16,0.20) * halo;
          float alpha = clamp((core * 0.92 + halo * 0.24) * uOpen * 0.86, 0.0, 0.92);
          if(alpha < 0.004) discard;
          gl_FragColor = vec4(col, alpha);
        }
      `
    });
    this.fissure = new THREE.Mesh(new THREE.SphereGeometry(7350, 48, 28), material);
    this.fissure.name = 'hairline false-sky fracture';
    this.fissure.frustumCulled = false;
    this.fissure.renderOrder = -994;
    this.fissure.visible = false;
    this.sky.group.add(this.fissure);
  }

  _buildFlowerLight() {
    this.flowerLight = new THREE.DirectionalLight(0xa9e7ee, 0);
    this.flowerLight.castShadow = false;
    this.flowerLightTarget = new THREE.Object3D();
    this.scene.add(this.flowerLight, this.flowerLightTarget);
    this.flowerLight.target = this.flowerLightTarget;
  }

  _capturePracticals() {
    this.practicals = [];
    const roots = [this.props?.station];
    for (const root of roots) {
      root?.traverse((o) => {
        if (!o.isLight) return;
        const warm = o.color?.r > (o.color?.b || 0) * 1.16;
        const intensity = o.userData.stationBaseIntensity ?? o.intensity;
        this.practicals.push({ light: o, intensity, warm });
      });
    }
  }

  _captureViewDirection() {
    const d = new THREE.Vector3();
    this.engine.camera.getWorldDirection(d);
    d.y = 0;
    if (Math.hypot(d.x, d.z) < 0.2) d.set(0.34, 0, -0.87);
    this._moonAzimuth.copy(d).normalize();
    // Begin close to the ridge: the old below-horizon travel hid the moon for
    // the first eight seconds. Its edge now fades in as the camera settles.
    this._setMoonRise(0);
  }

  _setMoonRise(progress, refreshEnvironment = false) {
    const k = sstep(0, 1, clamp(progress, 0, 1));
    const elevation = lerp(this._moonStartElevation ?? MOON_START_ELEVATION, 0.30, k);
    this._moonDirection.set(this._moonAzimuth.x, elevation, this._moonAzimuth.z).normalize();
    this.sky.setAnomalyMoonDirection?.(this._moonDirection, refreshEnvironment);
    this.fissure.material.uniforms.uCenter.value.copy(this._moonDirection);
  }

  reset() {
    this.cinematic.cancel({ resetSeen: true });
    this.fireflies.reset();
    this.roseField.eventPrepared = false;
    this.phase = 'dormant';
    this.phaseT = 0;
    this.totalT = 0;
    this.triggered = false;
    this.completed = false;
    this._phaseAnnounced = '';
    this._petalClock = 0;
    this._moonStartElevation = MOON_START_ELEVATION;
    // reset is a new run, not a one-frame fade toward the dormant target.
    this.moonPresence = 0;
    this.moonKeyStrength = 0;
    this.petalIntensity = 0;
    this.darkness = 0;
    this.bloomAmount = 0;
    this.rig.eventLookUp = 0;
    this._setPulse(-1, 0);
    this._applyVisuals({ wave: 0, fade: 0, residual: 0, petals: 0, light: 0,
      dark: 0, fissure: 0, flash: 0, moon: 0, moonRise: 0 });
  }

  trigger() {
    // This is a one-way world change. Once the anomaly has completed, the
    // false moon remains part of the sky and the event cannot restart.
    if (this.phase !== 'dormant') return false;
    this.triggered = true;
    this.completed = false;
    this.totalT = 0;
    this.roseField.prepareEvent();
    this._prepareFireflies();
    this._captureViewDirection();
    this._enter('warning');
    this.cinematic.start();
    return true;
  }

  _prepareFireflies() {
    // Use the same saved hero anchor, but let the station-centered grass wave
    // decide when each nearby insect appears. Camera changes never reseed it.
    this.fireflies.prepare({
      anchor: this.roseField.heroPosition,
      station: this.delivery.station,
      target: this.guideTarget
    });
  }

  /** Development-only selection used by ?event-preview=<phase>. */
  debugPhase(requested, progress = 0.48) {
    const phase = OLD_PHASE[requested] || requested;
    if (phase === 'scar') {
      this.cinematic.cancel();
      this.triggered = true;
      this.completed = true;
      this.phase = 'scar';
      this.phaseT = 0;
      this._phaseAnnounced = 'scar';
      this._applyVisuals({ wave: 1.12, fade: 0.035, residual: 1, petals: 0,
        light: 0.08, dark: 0, fissure: 0, flash: 0, moon: 1 });
      return true;
    }
    if (!Object.hasOwn(PHASE_INDEX, phase)) return false;
    if (!this.triggered) this.trigger();
    this.phase = phase;
    this.phaseT = PHASES[PHASE_INDEX[phase]][1] * clamp(progress, 0, 0.98);
    this._phaseAnnounced = phase;
    if (CINEMATIC_PHASES.includes(phase)) this.cinematic.start({ force: true });
    else this.cinematic.cancel();
    return true;
  }

  _enter(phase, silent = false) {
    this.phase = phase;
    this.phaseT = 0;
    if (!silent) this._announce(phase);
  }

  _announce(phase) {
    if (this._phaseAnnounced === phase) return;
    this._phaseAnnounced = phase;
    if (phase === 'warning') {
      this.hud.log('地下回波扩散 · 检测到非矿物根状结构', 'warn');
      this.audio.radio();
    } else if (phase === 'grass') {
      this.hud.flashDiscovery('地表异常', '草本结构正在扩散', '表土液态水与有机质依然低于检出限');
      this.hud.log('地表出现靛紫色根状生长体', 'bad');
      this.audio.echo();
    } else if (phase === 'first') {
      this.hud.flashDiscovery('未知生命反应', '地表出现单一生长点', '环境条件不支持任何有机生长');
      this.hud.log('车辆附近出现一枚银白花苞', 'bad');
      this.audio.discovery();
    } else if (phase === 'bloom') {
      this.hud.log('生长波正在覆盖盆地 · 远山反照率急剧上升', 'warn');
      this.audio.echo();
      this.audio.thud(0.72);
    } else if (phase === 'full') {
      this.hud.flashDiscovery('寂静花潮', '全盆地同步盛开', '所有花冠正在转向本车');
      this.hud.log('双列花带正在接通孤寂中站 · 后舱电池包已锁定', 'bad');
      this.audio.radio();
    } else if (phase === 'navigate') {
      this.hud.log('孤寂中站仍有响应 · 运送电池包，沿流动银光前进', 'good');
      this.delivery.scan.reveal = Math.max(this.delivery.scan.reveal, 10.0);
      this.delivery.glass?.reveal?.(10.0);
      this.audio.ui('warn');
    } else if (phase === 'ascend') {
      this.hud.log('花海正在凋零 · 巨月仍停留在盆地上空', 'good');
      this.audio.echo();
    } else if (phase === 'scar') {
      this.hud.flashDiscovery('永久天体异常', '花潮消退，巨月未落', '轨道数据库中不存在对应天体');
      this.hud.log('盆地恢复静默 · 巨月与少量银白生长体仍然存在', 'good');
      this.audio.discovery();
    }
  }

  _advance() {
    const i = PHASE_INDEX[this.phase];
    if (i === undefined) return;
    if (i >= PHASES.length - 1) {
      this.completed = true;
      this._enter('scar');
    } else this._enter(PHASES[i + 1][0]);
  }

  update(dt) {
    if (this.phase === 'dormant') return;
    this.totalT += dt;
    this.phaseT += dt;

    if (this.phase !== 'scar') {
      const duration = PHASES[PHASE_INDEX[this.phase]][1];
      const destinationDistance = this.phase === 'navigate'
        ? Math.hypot(this.rover.pos.x - this.guideTarget.x, this.rover.pos.z - this.guideTarget.z)
        : Infinity;
      const phaseDone = this.phase === 'navigate'
        // The guide cannot disappear on a timer. It remains part of the world
      // until the rover actually reaches the lonely station's flower crown.
        ? (this.phaseT >= 14 && destinationDistance <= 19)
        : this.phaseT >= duration;
      if (phaseDone) {
        this.phaseT = this.phase === 'navigate' ? 0 : Math.max(0, this.phaseT - duration);
        this._advance();
      }
    }

    const duration = this.phase === 'scar' ? 1 : PHASES[PHASE_INDEX[this.phase]][1];
    const p = clamp(this.phaseT / duration, 0, 1);
    let v;
    if (this.phase === 'warning') {
      const pulse = sstep(0, 1, p);
      v = { wave: 0, grassWave: 0, heroGrowth: 0, fade: 0, residual: 0, petals: 0,
        light: 0.04, dark: p * 0.18, fissure: 0, focus: 0,
        // Reveal overlaps the camera's 1.9 s settling shot, rather than being
        // stretched over most of the rise. Presence still smooths every frame.
        flash: 0, moon: sstep(0, 2.0, this.phaseT),
        // _setMoonRise eases once. A second smoothstep here used to compress
        // most of the apparent rise into a fast burst in the middle.
        moonRise: p };
      this._setPulse(6 + pulse * 126, 1 - sstep(0.70, 1, p));
    } else if (this.phase === 'grass') {
      const grassBirth = sstep(0.04, 0.96, p);
      v = { wave: 0, grassWave: lerp(0.012, 0.13, grassBirth),
        grassMaturity: grassBirth * 0.62, heroGrowth: 0, fade: 1, residual: 0,
        petals: 0, light: 0.08 + grassBirth * 0.10, dark: 0.18 + p * 0.08,
        fissure: 0, focus: -0.38 * sstep(0.04, 0.28, p),
        flash: 0, moon: 1, moonRise: 1 };
      this._setPulse(-1, 0);
    } else if (this.phase === 'first') {
      // Let the close-up settle, then spend almost twelve seconds unfolding
      // the actual VAT. Nearby buds respond only after the hero has opened.
      const heroGrowth = sstep(0.16, 0.90, p);
      const nearbyWake = sstep(0.94, 1.0, p);
      const focus = -0.86 * sstep(0.02, 0.20, p);
      v = { wave: nearbyWake * 0.11,
        grassWave: lerp(0.13, 0.22, sstep(0.0, 0.92, p)),
        grassMaturity: lerp(0.62, 1.0, sstep(0.0, 0.78, p)),
        heroGrowth, fade: 1, residual: 0,
        petals: sstep(0.64, 1, p) * 0.035, light: 0.10 + heroGrowth * 0.16,
        dark: 0.20 + p * 0.10, fissure: 0, focus,
        flash: 0, moon: 1, moonRise: 1 };
      this._setPulse(-1, 0);
    } else if (this.phase === 'bloom') {
      const grass = sstep(0.00, 0.78, p);
      const k = sstep(0.10, 0.96, p);
      v = { wave: lerp(0.11, 1.12, k), grassWave: lerp(0.22, 1.12, grass),
        grassMaturity: 1, heroGrowth: 1,
        fade: 1, residual: 0, petals: p * 0.44,
        light: 0.26 + k * 0.54, dark: 0.30 + k * 0.44,
        fissure: sstep(0.38, 0.88, p) * 0.38,
        focus: lerp(-0.86, 0, sstep(0.0, 0.24, p)),
        flash: 0, moon: 1, moonRise: 1 };
    } else if (this.phase === 'full') {
      v = { wave: 1.12, grassWave: 1.12, heroGrowth: 1, fade: 1, residual: 0,
        petals: 0.14, light: 0.88, dark: 0.72, fissure: 0.30, focus: 0,
        flash: 0, moon: 1, moonRise: 1 };
    } else if (this.phase === 'navigate') {
      v = { wave: 1.12, grassWave: 1.12, heroGrowth: 1, fade: 1, residual: 0,
        petals: 0.09, light: 0.74, dark: 0.64,
        fissure: lerp(0.22, 0.08, p), focus: 0, flash: 0, moon: 1, moonRise: 1 };
      this.gameDrain(dt, 0.025);
    } else if (this.phase === 'ascend') {
      const k = 1 - sstep(0, 1, p);
      v = { wave: 1.12, grassWave: 1.12, heroGrowth: 1,
        fade: lerp(1, 0.035, p), residual: sstep(0.16, 0.72, p),
        petals: k * 0.48 + Math.sin(p * Math.PI) * 0.72, light: lerp(0.74, 0.08, p),
        dark: k * 0.62, fissure: k * 0.08, focus: 0, flash: 0,
        moon: 1, moonRise: 1 };
    } else {
      v = { wave: 1.12, grassWave: 1.12, heroGrowth: 1, fade: 0.035, residual: 1,
        petals: 0, light: 0.08, dark: 0, fissure: 0, focus: 0, flash: 0,
        moon: 1, moonRise: 1 };
      this._setPulse(-1, 0);
    }
    this._applyVisuals(v, dt);
  }

  gameDrain(dt, rate) {
    if (this.cinematicActive) return;
    this.delivery.game.power = Math.max(0, this.delivery.game.power - rate * dt);
  }

  _setPulse(radius, intensity) {
    const U = this.terrain.uniforms;
    U.uEventPulse.value = radius;
    U.uEventCenter.value.set(this.delivery.station.x, intensity, this.delivery.station.z);
  }

  _applyVisuals(v, dt = 1 / 60) {
    const smooth = (current, target, speed) => lerp(current, target, Math.min(1, dt * speed));
    this.petalIntensity = smooth(this.petalIntensity, v.petals, 2.6);
    this.rainIntensity = 0;
    this.darkness = smooth(this.darkness, v.dark, 2.1);
    this.bloomAmount = smooth(this.bloomAmount, v.fade, 2.8);
    this.moonPresence = smooth(this.moonPresence, v.moon ?? 0, 0.72);
    this._setMoonRise(v.moonRise ?? v.moon ?? 0);
    // The old solar key was 2.6. The false moon peaks at 46% of that energy:
    // bright enough to carve the terrain, but dim enough for practical lights
    // and headlights to remain meaningful.
    this.moonKeyStrength = this.moonPresence * 0.46;
    this.sky.setAnomalyMoon?.(this.moonPresence, this.moonKeyStrength);
    this.tension = Math.max(v.wave * 0.34, v.petals * 0.22, v.dark * 0.38);
    // The flower tide changes the world, not the camera signal. Screen-space
    // glitches made the otherwise calm growth sequence read as brightness
    // flicker, so event phases never inject sensor interference.
    this.interference = 0;
    this.exposureOffset = v.light * 0.075 - v.dark * 0.08;
    this.flash = v.flash;
    // Cinematic framing has one owner. Skipping restores the user's own view;
    // continuing world growth must not pull that view up or down afterwards.
    this.rig.eventLookUp = 0;

    const fm = this.flowers.material.uniforms;
    this.flowers.visible = v.fade > 0.002 || v.residual > 0.002;
    fm.uTime.value = this.totalT;
    fm.uWave.value = v.wave;
    fm.uFade.value = v.fade;
    fm.uResidual.value = v.residual;
    fm.uSunDir.value.copy(this.sky.anomalyMoonDir);
    fm.uSilverLight.value = v.light;
    const vegetationState = {
      time: this.totalT, wave: v.wave, grassWave: v.grassWave ?? v.wave,
      grassMaturity: v.grassMaturity ?? 1, heroGrowth: v.heroGrowth || 0,
      fade: v.fade, residual: v.residual,
      light: v.light, sunDir: this.sky.anomalyMoonDir
    };
    this.grassSystem.update(vegetationState);
    this.roseField.update(vegetationState);
    this.fireflies.update({ ...vegetationState, phase: this.phase });

    this._petalClock += dt * (0.72 + v.petals * 0.65);
    this.petals.visible = this.petalIntensity > 0.008;
    this.petals.material.uniforms.uClock.value = this._petalClock;
    this.petals.material.uniforms.uIntensity.value = this.petalIntensity;
    const ground = this.terrain.heightAt(this.rover.pos.x, this.rover.pos.z);
    this.petals.position.x = lerp(this.petals.position.x, this.rover.pos.x, Math.min(1, dt * 2.0));
    this.petals.position.z = lerp(this.petals.position.z, this.rover.pos.z, Math.min(1, dt * 2.0));
    this.petals.position.y = lerp(this.petals.position.y, ground, Math.min(1, dt * 2.5));

    this.fissure.visible = v.fissure > 0.002;
    this.fissure.material.uniforms.uTime.value = this.totalT;
    this.fissure.material.uniforms.uOpen.value = v.fissure;

    const U = this.terrain.uniforms;
    const station = this.delivery.station;
    const target = this.guideTarget || this.delivery.facility?.position || station;
    U.uEventWet.value = 0;
    U.uEventLight.value = v.light * 0.26;
    U.uEventDir.value.set(0.18, 0.92, -0.34).normalize();
    U.uFlowerCenter.value.set(station.x, 1, station.z);
    U.uFlowerTarget.value.set(target.x, 0, target.z);
    U.uFlowerRadius.value = v.wave * 430;
    U.uFlowerFade.value = v.fade;
    U.uFlowerLight.value = v.light;

    const dayScale = lerp(1, 0.34, this.darkness);
    U.uSunCol.value.multiplyScalar(dayScale);
    this.engine.sun.intensity *= dayScale;
    this.engine.fill.intensity *= lerp(1, 0.46, this.darkness);
    this.engine.silverFill.intensity = 0.10 + this.moonPresence * 0.20 + v.light * 0.06;

    const rp = this.rover.pos;
    this.flowerLight.intensity = v.light * 1.35;
    this.flowerLight.position.copy(rp).add(new THREE.Vector3(-24, 48, 18));
    this.flowerLightTarget.position.copy(rp);
    this.flowerLight.updateMatrixWorld();
    this.flowerLightTarget.updateMatrixWorld();

    // Station practicals belong to its restored power sequence. The old event
    // override dimmed cool lamps to 16%, making a recovered base look dead.
  }

  hudState() {
    if (this.phase === 'dormant' || this.phase === 'scar') return null;
    const labels = {
      warning: ['异常回波', '地下结构正在苏醒', '保持车辆扫描系统在线', '根状回波扩散中'],
      grass: ['地表异常', '草本结构正在生长', '观察生长波的扩散方向', '靛紫色植被覆盖火星表土'],
      first: ['未知生命', '第一朵花正在生长', '观察车辆附近的银白花苞', '生命信号无法分类'],
      bloom: ['寂静花潮', '银白花海正在扩散', '等待开放通道形成', '生长波覆盖盆地'],
      full: ['同步盛开', '花带正在接通孤寂中站', '等待双列引导花带完全点亮', '后舱电池包已锁定'],
      navigate: ['电池转运', '前往孤寂中站', '沿两侧依次点亮的花带运送电池包', '终点花环已与中站对接区对齐'],
      ascend: ['低重力凋零', '花瓣正在升向天空', '继续驶向孤寂中站', '电池包与中塔仍保持同步']
    };
    const a = labels[this.phase];
    return a ? { tag: a[0], name: a[1], objective: a[2], status: a[3] } : null;
  }

  save() {
    const d = this.sky.anomalyMoonDir;
    return { version: 7, phase: this.phase, phaseT: this.phaseT, totalT: this.totalT,
      moonStart: this._moonStartElevation ?? MOON_START_ELEVATION,
      triggered: this.triggered, completed: this.completed,
      cinematicSeen: this.cinematic.seen,
      heroMatrix: this.roseField.eventPrepared ? this.roseField.heroMatrix?.toArray() : null,
      moonDir: d ? [d.x, d.y, d.z] : null };
  }

  load(s) {
    if (!s || ![1, 2, 3, 4, 5, 6, 7].includes(s.version)) return false;
    let phase = OLD_PHASE[s.phase] || s.phase;
    const valid = ['dormant', ...PHASES.map(([name]) => name), 'scar'];
    if (!valid.includes(phase)) return false;
    this.cinematic.cancel();
    this.cinematic.seen = phase !== 'dormant' || !!s.cinematicSeen;
    this.phase = phase;
    this.phaseT = Math.max(0, Number(s.phaseT) || 0);
    // Continue an old rise from its original baseline, even when it was below
    // the new starting elevation. Subsequent V7 saves keep this baseline too.
    this._moonStartElevation = s.version < 7 && phase === 'warning'
      ? LEGACY_MOON_START_ELEVATION
      : Number.isFinite(s.moonStart)
        ? clamp(s.moonStart, LEGACY_MOON_START_ELEVATION, MOON_START_ELEVATION)
        : MOON_START_ELEVATION;
    // Preserve progress in an existing V4 event: a half-open field must not
    // shrink back to buds just because its remaining growth is now slower.
    if (s.version === 4 && Object.hasOwn(V4_GROWTH_DURATIONS, phase)) {
      this.phaseT = clamp(this.phaseT / V4_GROWTH_DURATIONS[phase], 0, 1)
        * PHASES[PHASE_INDEX[phase]][1];
    }
    if ((s.version === 4 || s.version === 5) && phase === 'warning') {
      // Older moon motion was smoothstep(smoothstep(p)). Retain its actual
      // elevation, not just elapsed seconds, when loading the slower curve.
      this.phaseT = sstep(0, 1, this.phaseT / V5_MOON_DURATION)
        * PHASES[PHASE_INDEX.warning][1];
    }
    if (s.version === 6 && phase === 'warning') {
      this.phaseT = clamp(this.phaseT / V6_MOON_DURATION, 0, 1)
        * PHASES[PHASE_INDEX.warning][1];
    }
    this.totalT = Math.max(0, Number(s.totalT) || 0);
    this.triggered = !!s.triggered;
    this.completed = !!s.completed || phase === 'scar';
    this._phaseAnnounced = phase;
    if (Array.isArray(s.heroMatrix) && s.heroMatrix.length === 16
      && s.heroMatrix.every(Number.isFinite)) {
      this.roseField.eventPrepared = true;
      this.roseField.heroMatrix = new THREE.Matrix4().fromArray(s.heroMatrix);
      this.roseField.heroPosition.setFromMatrixPosition(this.roseField.heroMatrix);
      for (const mesh of this.roseField.meshes) {
        mesh.setMatrixAt(0, this.roseField.heroMatrix);
        for (let i = 0; i < this.roseField.companionSpecs.length && i + 1 < mesh.count; i++) {
          mesh.setMatrixAt(i + 1,
            this.roseField._makeCompanionMatrix(this.roseField.companionSpecs[i]));
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    } else if (phase !== 'dormant') this.roseField.prepareEvent();
    if (phase !== 'dormant') this._prepareFireflies();
    else this.fireflies.reset();
    let d = null;
    if (Array.isArray(s.moonDir) && s.moonDir.length === 3) {
      d = new THREE.Vector3(...s.moonDir);
    } else if (phase !== 'dormant') {
      // Older saves did not persist the event sky direction. Put the false moon
      // over the active route instead of inheriting an arbitrary menu camera.
      const target = this.delivery._target?.() || this.delivery.station;
      d = new THREE.Vector3(target.x - this.rover.pos.x, 0, target.z - this.rover.pos.z);
      if (d.lengthSq() < 0.01) d.set(0.34, 0, -0.87);
      d.normalize().multiplyScalar(0.96);
      d.y = 0.28;
      d.normalize();
    }
    if (d) {
      this._moonAzimuth.set(d.x, 0, d.z);
      if (this._moonAzimuth.lengthSq() < 0.01) this._moonAzimuth.set(0.34, 0, -0.87);
      this._moonAzimuth.normalize();
      this.sky.setAnomalyMoonDirection?.(d);
      this.fissure.material.uniforms.uCenter.value.copy(d);
    }
    return true;
  }
}

function segmentDistance(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const d = abx * abx + abz * abz;
  const t = d > 1e-5 ? clamp(((px - ax) * abx + (pz - az) * abz) / d, 0, 1) : 0;
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

function blackGrassGeometry() {
  const positions = [];
  const normals = [];
  const blades = [];
  const indices = [];
  const segments = 4;

  const addBlade = (angle, ox, oz, height, width, seed) => {
    const base = positions.length / 3;
    const sideX = Math.cos(angle);
    const sideZ = Math.sin(angle);
    const normalX = -sideZ;
    const normalZ = sideX;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const halfWidth = width * (1 - t * 0.88) * 0.5;
      const forward = Math.sin(t * Math.PI * 0.52) * 0.145 * (0.45 + seed);
      const cx = ox + normalX * forward;
      const cz = oz + normalZ * forward;
      positions.push(cx - sideX * halfWidth, t * height, cz - sideZ * halfWidth);
      positions.push(cx + sideX * halfWidth, t * height, cz + sideZ * halfWidth);
      normals.push(normalX, 0.16 + t * 0.28, normalZ, normalX, 0.16 + t * 0.28, normalZ);
      blades.push(t, seed, t, seed);
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };

  addBlade(0.05, -0.028, 0.008, 0.92, 0.062, 0.17);
  addBlade(2.10, 0.025, 0.022, 0.72, 0.052, 0.53);
  addBlade(4.24, 0.005, -0.032, 1.08, 0.056, 0.86);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aBlade', new THREE.Float32BufferAttribute(blades, 2));
  geometry.setIndex(indices);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.52, 0), 0.72);
  return geometry;
}

function flowerGeometry() {
  const positions = [], normals = [], parts = [];
  const tri = (a, b, c, n, part) => {
    for (const p of [a, b, c]) {
      positions.push(p[0], p[1], p[2]);
      normals.push(n[0], n[1], n[2]);
      parts.push(part);
    }
  };

  // Three crossed dark quads form a readable stem without cylinder overhead.
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI / 3;
    const x = Math.cos(a) * 0.025, z = Math.sin(a) * 0.025;
    const n = [Math.sin(a), 0, -Math.cos(a)];
    tri([-x, 0, -z], [x, 0, z], [x, 0.76, z], n, 0);
    tri([-x, 0, -z], [x, 0.76, z], [-x, 0.76, -z], n, 0);
  }

  // A low outer ring and a cupped inner ring read as a glass lotus rather than
  // a flat pinwheel when the rover camera is close to the ground.
  const petals = 8;
  for (let i = 0; i < petals; i++) {
    const a = i / petals * Math.PI * 2;
    const side = 0.27;
    const r0 = 0.08, r1 = 0.54;
    const left = [Math.cos(a - side) * 0.30, 0.79, Math.sin(a - side) * 0.30];
    const right = [Math.cos(a + side) * 0.30, 0.79, Math.sin(a + side) * 0.30];
    const tip = [Math.cos(a) * r1, 0.84, Math.sin(a) * r1];
    const root = [Math.cos(a) * r0, 0.77, Math.sin(a) * r0];
    const n = [Math.cos(a) * 0.14, 0.97, Math.sin(a) * 0.14];
    tri(root, left, tip, n, 1);
    tri(root, tip, right, n, 1);
  }

  const inner = 7;
  for (let i = 0; i < inner; i++) {
    const a = (i + 0.5) / inner * Math.PI * 2;
    const side = 0.34;
    const left = [Math.cos(a - side) * 0.18, 0.82, Math.sin(a - side) * 0.18];
    const right = [Math.cos(a + side) * 0.18, 0.82, Math.sin(a + side) * 0.18];
    const tip = [Math.cos(a) * 0.34, 1.10, Math.sin(a) * 0.34];
    const root = [Math.cos(a) * 0.055, 0.79, Math.sin(a) * 0.055];
    const n = [Math.cos(a) * 0.66, 0.72, Math.sin(a) * 0.66];
    tri(root, left, tip, n, 1);
    tri(root, tip, right, n, 1);
  }

  // A cyan polygonal core gives each flower one controlled emissive accent.
  const coreN = [0, 1, 0];
  for (let i = 0; i < 7; i++) {
    const a0 = i / 7 * Math.PI * 2, a1 = (i + 1) / 7 * Math.PI * 2;
    tri([0, 0.785, 0], [Math.cos(a0) * 0.13, 0.79, Math.sin(a0) * 0.13],
      [Math.cos(a1) * 0.13, 0.79, Math.sin(a1) * 0.13], coreN, 2);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(parts, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.55, 0), 1.1);
  return g;
}
