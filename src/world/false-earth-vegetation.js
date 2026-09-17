/* ============================================================
   FALSE-EARTH VEGETATION PORT
   ------------------------------------------------------------
   WebGL2 adaptation of false-earth's WebGPU vegetation ideas:
   - stable camera-centred PCG grid
   - clumped procedural blades with three geometry LODs
   - terrain texture sampling, slope alignment and rover push
   - authored high/low rose meshes driven by the original 142-frame VAT

   It deliberately keeps this game's WebGL renderer and post stack. The
   original WebGPU compute/atomic routing is replaced by shader-derived
   instances and fixed LOD rings, while the visual data and growth logic remain.
   ============================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { TERRAIN_GLSL } from './terrain.js';
import { clamp, makeRNG } from '../core/rng.js';

const GRASS_AREA = 80;
const GRASS_AXIS = Object.freeze({ LOW: 320, MEDIUM: 512, HIGH: 768, ULTRA: 1024 });
const ROSE_COUNT = Object.freeze({ LOW: 220, MEDIUM: 420, HIGH: 720, ULTRA: 1100 });
const GRASS_LODS = Object.freeze([
  { segments: 15, size: 10, minDistance: 0, maxDistance: 5.4 },
  { segments: 5, size: 40, minDistance: 4.6, maxDistance: 20.6 },
  { segments: 2, size: 80, minDistance: 19.4, maxDistance: 41.0 }
]);

function terrainUniforms(terrain) {
  const U = terrain.uniforms;
  return {
    uMacro: U.uMacro, uFar: U.uFar, uDetail: U.uDetail,
    uDent: U.uDent, uTrail: U.uTrail,
    uConst: U.uConst, uConst2: U.uConst2,
    uCamXZ: U.uCamXZ, uLod: U.uLod, uTexRes: U.uTexRes
  };
}

function makeInstancedBladeGeometry(segments, axis) {
  const source = new THREE.PlaneGeometry(1, 1, 1, segments);
  source.translate(0, 0.5, 0);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(source.index);
  for (const [name, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(name, attribute);
  }
  geometry.instanceCount = axis * axis;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), GRASS_AREA);
  return geometry;
}

function grassMaterial(terrain, config) {
  const uniforms = Object.assign(terrainUniforms(terrain), {
    uTime: { value: 0 },
    uWave: { value: 0 },
    uMaturity: { value: 0 },
    uFade: { value: 0 },
    uResidual: { value: 0 },
    uSilverLight: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.6, 0.2, 0.3).normalize() },
    uPatchCenter: { value: new THREE.Vector2() },
    uRoverPos: { value: new THREE.Vector3() },
    uEventCenter: { value: new THREE.Vector2() },
    uRouteA: { value: new THREE.Vector2() },
    uRouteB: { value: new THREE.Vector2() },
    uAxis: { value: config.axis },
    uSpacing: { value: config.spacing },
    uMinDist: { value: config.minDistance },
    uMaxDist: { value: config.maxDistance }
  });

  return new THREE.ShaderMaterial({
    name: `false-earth grass lod ${config.segments}`,
    uniforms,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
    vertexShader: /* glsl */`
      precision highp float;
      precision highp int;
      ${TERRAIN_GLSL}

      uniform float uTime, uWave, uMaturity, uFade, uResidual, uSilverLight;
      uniform float uSpacing, uMinDist, uMaxDist;
      uniform int uAxis;
      uniform vec2 uPatchCenter, uEventCenter, uRouteA, uRouteB;
      uniform vec3 uRoverPos;
      varying float vHeight, vGrowth, vVisible, vClump, vBladeSeed;
      varying vec3 vWorld, vNormal;

      uint pcgHash(uint inputValue){
        uint state = inputValue * 747796405u + 2891336453u;
        uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
        return (word >> 22u) ^ word;
      }
      float hash21(ivec2 p){
        uint s = uint(p.x) * 1597334677u + uint(p.y) * 3812015801u;
        return float(pcgHash(s)) / 4294967295.0;
      }
      vec2 hash22(ivec2 p){
        return vec2(hash21(p), hash21(p + ivec2(127, 311)));
      }
      float valueNoise(vec2 p){
        ivec2 i = ivec2(floor(p));
        vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i), b = hash21(i + ivec2(1, 0));
        float c = hash21(i + ivec2(0, 1)), d = hash21(i + ivec2(1, 1));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float segmentDistance2D(vec2 p, vec2 a, vec2 b){
        vec2 ab = b - a;
        float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.0001), 0.0, 1.0);
        return length(p - (a + ab * t));
      }
      vec3 bezier3(vec3 p0, vec3 p1, vec3 p2, vec3 p3, float t){
        float it = 1.0 - t;
        return p0 * it * it * it + p1 * 3.0 * it * it * t
             + p2 * 3.0 * it * t * t + p3 * t * t * t;
      }
      vec3 bezierTangent(vec3 p0, vec3 p1, vec3 p2, vec3 p3, float t){
        float it = 1.0 - t;
        return normalize((p1-p0)*3.0*it*it + (p2-p1)*6.0*it*t + (p3-p2)*3.0*t*t);
      }

      void main(){
        vHeight = uv.y; vGrowth = 0.0; vVisible = 0.0; vClump = 0.0;
        vBladeSeed = 0.0; vWorld = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0);

        int ix = gl_InstanceID % uAxis;
        int iz = gl_InstanceID / uAxis;
        ivec2 centerCell = ivec2(floor(uPatchCenter / uSpacing));
        ivec2 globalCell = centerCell + ivec2(ix - uAxis / 2, iz - uAxis / 2);
        vec2 jitter = (hash22(globalCell) - 0.5) * uSpacing;
        vec2 worldXZ = (vec2(globalCell) + 0.5) * uSpacing + jitter;
        float bladeSeed = hash21(globalCell + ivec2(19, 73));
        float bladeSeed2 = hash21(globalCell + ivec2(149, 37));

        float cameraDistance = length(worldXZ - uPatchCenter);
        float lodNoise = (bladeSeed - 0.5) * 1.15;
        float lodVisible = step(uMinDist, cameraDistance + lodNoise)
                         * step(cameraDistance + lodNoise, uMaxDist);
        float routeVisible = step(7.4, segmentDistance2D(worldXZ, uRouteA, uRouteB));
        float eventDistance = length(worldXZ - uEventCenter);
        float eventMask = 1.0 - smoothstep(348.0, 372.0, eventDistance);

        // Smooth clump field using the same stable world grid principle as the
        // source compute shader. Two scales remove the cellular/checker pattern.
        float clumpA = valueNoise(worldXZ / 1.48);
        float clumpB = valueNoise(worldXZ / 4.9 + vec2(13.7, -8.4));
        float clump = smoothstep(0.29, 0.78, clumpA * 0.72 + clumpB * 0.38);
        float density = mix(0.012, 0.94, pow(clump, 1.72));
        float densityVisible = step(bladeSeed2, density);

        float birth = clamp(eventDistance / 350.0 + (bladeSeed - 0.5) * 0.075, 0.01, 1.05);
        float born = smoothstep(birth - 0.042, birth + 0.042, uWave)
                   * step(0.001, uWave);
        float survivor = step(0.989, bladeSeed) * uResidual;
        float growth = born * max(uFade, survivor) * max(uMaturity, survivor);
        float visible = lodVisible * routeVisible * eventMask * densityVisible * step(0.012, growth);
        if(visible < 0.5){
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }

        float clumpSeed = valueNoise(floor(worldXZ / 1.48) + vec2(0.37));
        float height = mix(0.40, 0.82, clumpSeed)
                     * mix(0.70, 1.30, bladeSeed);
        float width = mix(0.010, 0.050, valueNoise(floor(worldXZ / 1.48) + vec2(4.1, 1.7)))
                    * mix(0.72, 1.28, bladeSeed2);
        float bend = mix(0.20, 0.62, valueNoise(floor(worldXZ / 1.48) + vec2(-2.4, 7.3)))
                   * mix(0.74, 1.26, hash21(globalCell + ivec2(51, 211)));
        float rise = smoothstep(0.0, 0.58, growth);
        height *= rise;

        float type = floor(hash21(globalCell + ivec2(503, 97)) * 3.0);
        vec3 p0 = vec3(0.0);
        vec3 p1 = type < 0.5 ? vec3(0.0, height*0.40, bend*0.50)
                : type < 1.5 ? vec3(0.0, height*0.35, bend*0.60)
                             : vec3(0.0, height*0.30, bend*0.70);
        vec3 p2 = type < 0.5 ? vec3(0.0, height*0.75, bend*0.70)
                : type < 1.5 ? vec3(0.0, height*0.70, bend*0.80)
                             : vec3(0.0, height*0.65, bend);
        vec3 p3 = vec3(0.0, height, bend * (0.92 + clump * 0.20));

        float electro = sin(uTime * 0.35 + dot(worldXZ, vec2(0.11, 0.07)) + bladeSeed * 6.28318);
        float flutter = sin(uTime * 1.9 + bladeSeed2 * 17.0 + uv.y * 4.8);
        vec3 impulse = vec3(0.18, 0.0, -0.31) * height * (electro * 0.018 + flutter * 0.004)
                     * (0.35 + uSilverLight * 0.65);
        p1 += impulse * 0.25; p2 += impulse * 0.60; p3 += impulse;

        vec3 spine = bezier3(p0, p1, p2, p3, uv.y);
        vec3 tangent = bezierTangent(p0, p1, p2, p3, uv.y);
        vec3 localSide = normalize(cross(vec3(0.0, 0.0, 1.0), tangent));
        float widthFactor = (uv.y + 0.35) * pow(1.0 - uv.y, 0.90);
        spine += localSide * width * widthFactor * ((uv.x - 0.5) * 2.0);

        float angle = (bladeSeed - 0.5) * 1.2 + (clumpSeed - 0.5) * 2.7;
        float ca = cos(angle), sa = sin(angle);
        vec3 rotated = vec3(spine.x*ca - spine.z*sa, spine.y, spine.x*sa + spine.z*ca);
        vec3 rotatedNormal = normalize(vec3(tangent.z*ca - tangent.x*sa, 0.18, tangent.z*sa + tangent.x*ca));

        float h = terrainH(worldXZ);
        float e = 0.28;
        float hx = terrainH(worldXZ + vec2(e, 0.0));
        float hz = terrainH(worldXZ + vec2(0.0, e));
        vec3 groundN = normalize(vec3(h - hx, e, h - hz));
        vec3 groundT = normalize(cross(vec3(0.0, 0.0, 1.0), groundN));
        vec3 groundB = normalize(cross(groundN, groundT));
        vec3 worldOffset = groundT * rotated.x + groundN * rotated.y + groundB * rotated.z;
        vec3 worldN = normalize(groundT * rotatedNormal.x + groundN * rotatedNormal.y + groundB * rotatedNormal.z);

        vec2 roverDiff = worldXZ - uRoverPos.xz;
        float roverDistance = length(roverDiff);
        float push = smoothstep(1.45, 0.18, roverDistance);
        vec2 pushDir = roverDiff / max(roverDistance, 0.001);
        worldOffset.xz += pushDir * push * 0.48 * uv.y * uv.y;
        worldOffset.y *= 1.0 - push * 0.42 * uv.y;

        vec3 world = vec3(worldXZ.x, h + 0.012, worldXZ.y) + worldOffset;
        vHeight = uv.y; vGrowth = growth; vVisible = visible; vClump = clump;
        vBladeSeed = bladeSeed; vWorld = world; vNormal = worldN;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uSunDir;
      uniform float uTime, uSilverLight;
      varying float vHeight, vGrowth, vVisible, vClump, vBladeSeed;
      varying vec3 vWorld, vNormal;
      void main(){
        if(vVisible < 0.5 || vGrowth < 0.012) discard;
        vec3 N = normalize(vNormal);
        vec3 V = normalize(cameraPosition - vWorld);
        // Thin double-sided blades need a small lunar fill term. Using only a
        // one-sided sun dot made half the field mathematically black even when
        // its authored colour was silver-grey.
        float sunFacing = abs(dot(N, normalize(uSunDir)));
        float lit = 0.20 + sunFacing * 0.72 + uSilverLight * 0.10;
        float rim = pow(1.0 - abs(dot(N, V)), 3.2);
        float ao = pow(clamp(vHeight + 0.06, 0.0, 1.0), 4.4);
        vec3 base = vec3(0.007, 0.006, 0.026);
        vec3 newborn = vec3(0.018, 0.042, 0.090);
        vec3 mature = vec3(0.105, 0.052, 0.185);
        vec3 body = mix(newborn, mature, smoothstep(0.08, 0.86, vGrowth))
                  * (0.46 + lit * 0.76);
        vec3 tip = vec3(0.30, 0.36, 0.72) * (0.25 + lit * 0.86)
                 + vec3(0.05, 0.43, 0.60) * rim * (0.12 + uSilverLight * 0.27)
                 + vec3(0.13, 0.045, 0.28) * 0.62 * (0.025 + uSilverLight * 0.045);
        vec3 col = mix(base, body, smoothstep(0.02, 0.34, vHeight));
        col = mix(col, tip, smoothstep(0.70, 1.0, vHeight) * (0.45 + uSilverLight * 0.38));
        col *= mix(0.78, 1.08, vClump) * mix(0.90, 1.05, vBladeSeed);
        col *= 0.48 + ao * 0.52;
        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
}

export class FalseEarthGrass {
  constructor({ scene, terrain, engine, rover, station, target, quality }) {
    Object.assign(this, { scene, terrain, engine, rover, station, target, quality });
    this.disposed = false;
    this.group = new THREE.Group();
    this.group.name = 'false-earth dense grass port';
    this.group.visible = false;
    scene.add(this.group);

    const fullAxis = GRASS_AXIS[quality?.name] || 512;
    const spacing = GRASS_AREA / fullAxis;
    this.meshes = GRASS_LODS.map((definition) => {
      const axis = Math.max(8, Math.round(definition.size / spacing));
      const config = { ...definition, axis, spacing };
      const geometry = makeInstancedBladeGeometry(definition.segments, axis);
      const material = grassMaterial(terrain, config);
      material.uniforms.uEventCenter.value.set(station.x, station.z);
      material.uniforms.uRouteA.value.set(station.x, station.z);
      material.uniforms.uRouteB.value.set(target.x, target.z);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `grass lod ${definition.segments} segments`;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      return mesh;
    });
  }

  setQuality(quality) {
    if (this.disposed) return false;
    this.quality = quality;
    const spacing = GRASS_AREA / (GRASS_AXIS[quality?.name] || 512);
    // Blades are shader-generated from gl_InstanceID. No vertex buffers or
    // materials need replacing, so growth and shared terrain uniforms survive.
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      const axis = Math.max(8, Math.round(GRASS_LODS[i].size / spacing));
      mesh.geometry.instanceCount = axis * axis;
      mesh.material.uniforms.uAxis.value = axis;
      mesh.material.uniforms.uSpacing.value = spacing;
    }
    return true;
  }

  update({ time, wave, grassWave = wave, grassMaturity = 1, fade, residual, light, sunDir }) {
    if (this.disposed) return;
    this.group.visible = fade > 0.002 || residual > 0.002;
    const camera = this.engine.camera;
    for (const mesh of this.meshes) {
      const U = mesh.material.uniforms;
      U.uTime.value = time;
      U.uWave.value = grassWave;
      U.uMaturity.value = grassMaturity;
      U.uFade.value = fade;
      U.uResidual.value = residual;
      U.uSilverLight.value = light;
      U.uSunDir.value.copy(sunDir);
      U.uPatchCenter.value.set(camera.position.x, camera.position.z);
      U.uRoverPos.value.copy(this.rover.pos);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.group);
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.group.clear();
    this.meshes.length = 0;
  }
}

function setupVATGeometry(geometry, meta) {
  const position = geometry.getAttribute('position');
  const sourceColor = geometry.getAttribute('color');
  const count = position.count;
  const padding = meta.padding ?? 2;
  const adjustedFrameCount = meta.frameCount + padding;
  const uv1 = new Float32Array(count * 2);
  const flipped = new Float32Array(count * 3);
  const colorMask = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const columnIndex = Math.floor(i / meta.textureHeight);
    const verticalIndex = i % meta.textureHeight;
    uv1[i * 2] = (columnIndex * adjustedFrameCount + 0.5) / meta.textureWidth;
    uv1[i * 2 + 1] = (verticalIndex + 0.5) / meta.textureHeight;
    flipped[i * 3] = -position.getX(i);
    flipped[i * 3 + 1] = position.getY(i);
    flipped[i * 3 + 2] = position.getZ(i);
    colorMask[i] = sourceColor ? sourceColor.getX(i) : 0.7;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(flipped, 3));
  geometry.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  geometry.setAttribute('aColorMask', new THREE.BufferAttribute(colorMask, 1));
  geometry.computeBoundingSphere();
}

function firstMeshGeometry(scene) {
  let geometry = null;
  scene.traverse((object) => {
    if (!geometry && object.isMesh && object.geometry) geometry = object.geometry.clone();
  });
  return geometry;
}

function roseMaterial(textures, meta, lodMin, lodMax) {
  return new THREE.ShaderMaterial({
    name: `false-earth rose VAT ${lodMin}-${lodMax}`,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
    uniforms: {
      uVatPosition: { value: textures.position },
      uVatNormal: { value: textures.normal },
      uPetalMap: { value: textures.petal },
      uOutlineMap: { value: textures.outline },
      uPetalNormal: { value: textures.petalNormal },
      uFrameCount: { value: meta.frameCount },
      uTextureWidth: { value: meta.textureWidth },
      uTime: { value: 0 },
      uWave: { value: 0 },
      uHeroGrowth: { value: 0 },
      uFade: { value: 0 },
      uResidual: { value: 0 },
      uSilverLight: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.6, 0.2, 0.3).normalize() },
      uRoverPos: { value: new THREE.Vector3() },
      uLodCamera: { value: new THREE.Vector3() },
      uLodMin: { value: lodMin },
      uLodMax: { value: lodMax }
    },
    vertexShader: /* glsl */`
      precision highp float;
      attribute float aColorMask;
      attribute vec4 aRose;
      uniform sampler2D uVatPosition, uVatNormal;
      uniform float uFrameCount, uTextureWidth;
      uniform float uTime, uWave, uHeroGrowth, uFade, uResidual, uSilverLight;
      uniform float uLodMin, uLodMax;
      uniform vec3 uRoverPos, uLodCamera;
      varying vec2 vUv;
      varying vec3 vWorld, vNormal;
      varying float vMask, vSeed, vGrowth, vVisible, vHero;

      vec3 decodeOctNormal(vec4 texel){
        vec2 encoded = texel.xy * 2.0 - 1.0;
        vec3 v = vec3(encoded, 1.0 - abs(encoded.x) - abs(encoded.y));
        if(v.z < 0.0) v.xy = (1.0 - abs(v.yx)) * sign(v.xy);
        return normalize(v);
      }

      void main(){
        vUv = uv; vMask = aColorMask; vSeed = aRose.y; vGrowth = 0.0; vVisible = 0.0; vHero = 0.0;
        vWorld = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0);
        vec3 instanceOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float distanceToRover = length(instanceOrigin.xz - uLodCamera.xz);
        float lodJitter = (aRose.y - 0.5) * 0.65;
        float lodVisible = step(uLodMin, distanceToRover + lodJitter)
                         * step(distanceToRover + lodJitter, uLodMax);
        float hero = step(0.5, aRose.w);
        vHero = hero;
        float fieldBorn = smoothstep(aRose.x - 0.050, aRose.x + 0.065, uWave)
                        * step(0.001, uWave);
        float fieldGrowth = smoothstep(aRose.x - 0.012, aRose.x + 0.095 + aRose.z * 0.035, uWave);
        float heroBorn = smoothstep(0.015, 0.075, uHeroGrowth);
        float born = mix(fieldBorn, heroBorn, hero);
        float localGrowth = mix(fieldGrowth, smoothstep(0.0, 1.0, uHeroGrowth), hero);
        float survivor = step(0.978, aRose.y) * uResidual;
        float life = max(uFade, survivor);
        float frame = clamp(localGrowth * life, 0.0, 1.0);
        float visible = lodVisible * step(0.006, born * life);
        if(visible < 0.5){
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }

        float frameIndex = (uFrameCount - 1.0) * frame;
        vec2 vatUv = vec2(uv1.x + frameIndex / uTextureWidth, uv1.y);
        vec3 vatPosition = texture2D(uVatPosition, vatUv).rgb;
        vec3 vatNormal = decodeOctNormal(texture2D(uVatNormal, vatUv));
        vec3 local = position + vatPosition;

        float heightFactor = smoothstep(0.0, 0.08, abs(vatPosition.y)) * 0.20;
        float electro = sin(uTime * 0.34 + aRose.y * 31.0 + instanceOrigin.x * 0.08);
        local.xz += vec2(0.18, -0.31) * electro * heightFactor * (0.018 + uSilverLight * 0.025);

        vec2 toRose = instanceOrigin.xz - uRoverPos.xz;
        float roverDistance = length(toRose);
        float push = smoothstep(1.15, 0.18, roverDistance);
        vec2 pushDir = toRose / max(roverDistance, 0.001);
        local.xz += pushDir * push * heightFactor * 1.25;
        local.y *= 1.0 - push * heightFactor * 0.30;

        vec4 world = modelMatrix * instanceMatrix * vec4(local, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(mat3(modelMatrix * instanceMatrix) * vatNormal);
        vSeed = aRose.y; vGrowth = frame; vVisible = visible;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D uPetalMap, uOutlineMap, uPetalNormal;
      uniform vec3 uSunDir;
      uniform float uTime, uSilverLight;
      varying vec2 vUv;
      varying vec3 vWorld, vNormal;
      varying float vMask, vSeed, vGrowth, vVisible, vHero;

      mat3 cotangentFrame(vec3 N, vec3 p, vec2 uvCoord){
        vec3 dp1 = dFdx(p), dp2 = dFdy(p);
        vec2 duv1 = dFdx(uvCoord), duv2 = dFdy(uvCoord);
        vec3 dp2perp = cross(dp2, N);
        vec3 dp1perp = cross(N, dp1);
        vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
        vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
        float invmax = inversesqrt(max(dot(T,T), dot(B,B)) + 0.00001);
        return mat3(T * invmax, B * invmax, N);
      }

      void main(){
        if(vVisible < 0.5 || vGrowth < 0.005) discard;
        float isPetal = 1.0 - step(0.055, abs(vMask - 0.70));
        float isStem = 1.0 - step(0.055, abs(vMask));
        float isLeaf = 1.0 - step(0.055, abs(vMask - 1.0));
        vec2 petalUv = vec2((vUv.x - 0.5) * 0.8 + 0.5, vUv.y);
        vec3 texColor = texture2D(uPetalMap, petalUv).rgb;
        vec3 outline = texture2D(uOutlineMap, vUv).rgb;
        float luminance = dot(texColor, vec3(0.2126, 0.7152, 0.0722));
        vec3 petalDark = vec3(0.035, 0.105, 0.145);
        vec3 petalSilver = vec3(0.76, 0.88, 0.90) * (0.68 + luminance * 0.54);
        vec3 petal = mix(petalDark, petalSilver, smoothstep(0.035, 0.64, luminance));
        petal = mix(petal * 0.76, petal, outline.r);
        petal *= mix(0.86, 1.08, fract(vSeed * 87.65));
        vec3 stem = mix(vec3(0.003, 0.008, 0.009), vec3(0.024, 0.072, 0.068), vUv.y);
        vec3 baseColor = petal * isPetal + stem * max(isStem, isLeaf);

        vec3 baseN = normalize(vNormal);
        vec3 mapN = texture2D(uPetalNormal, petalUv).xyz * 2.0 - 1.0;
        mapN.xy *= 1.7;
        vec3 N = normalize(cotangentFrame(baseN, vWorld, petalUv) * mapN);
        N = normalize(mix(baseN, N, isPetal * 0.72));
        vec3 V = normalize(cameraPosition - vWorld);
        float lit = max(dot(N, normalize(uSunDir)), 0.0);
        float fresnel = pow(1.0 - abs(dot(N, V)), 4.2);
        float travelling = smoothstep(0.18, 0.0,
          abs(vUv.y - mix(-0.2, 1.2, fract(-uTime * 0.17 + vSeed * 9.7))));
        vec3 glow = vec3(0.16, 0.68, 0.82) * (travelling * 0.23 + fresnel * (0.10 + uSilverLight * 0.28));
        vec3 col = baseColor * (0.16 + lit * 0.88) + glow * max(isPetal, isLeaf * 0.15);
        float petalBase = isPetal * (1.0 - smoothstep(0.18, 0.48, vUv.y));
        float uvCore = isPetal * (1.0 - smoothstep(0.20, 0.52, length(petalUv - vec2(0.5, 0.44))));
        float amberCore = max(petalBase * 0.46, uvCore * 0.82)
                        * smoothstep(0.04, 0.30, vGrowth)
                        * (0.070 + uSilverLight * 0.052 + vHero * 0.040);
        col += vec3(1.00, 0.31, 0.045) * amberCore;
        float heroAura = vHero * smoothstep(0.015, 0.22, vGrowth)
                       * (0.055 + fresnel * 0.12 + (1.0 - vGrowth) * 0.08);
        col += vec3(0.20, 0.78, 0.92) * heroAura * max(isPetal, isLeaf * 0.25);
        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
}

function disposeGLTF(scene) {
  const resources = new Set();
  scene.traverse((object) => {
    if (object.geometry) resources.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  for (const resource of resources) resource.dispose();
}

function disposeRoseAssets(assets) {
  if (!assets) return;
  const resources = new Set(assets.textures);
  for (const lod of assets.lods) {
    resources.add(lod.geometry);
    resources.add(lod.position);
    resources.add(lod.normal);
  }
  for (const resource of resources) resource.dispose();
}

async function loadRoseLOD(basePath, name) {
  // Wait for every request even on failure, so late textures can be released
  // instead of escaping the lifetime of the field which requested them.
  const results = await Promise.allSettled([
    new THREE.FileLoader().loadAsync(`${basePath}/${name}_meta.json`),
    new GLTFLoader().loadAsync(`${basePath}/${name}.glb`),
    new EXRLoader().setDataType(THREE.FloatType).loadAsync(`${basePath}/${name}_pos.exr`),
    new THREE.TextureLoader().loadAsync(`${basePath}/${name}_nrm.png`)
  ]);
  const [metaText, gltf, position, normal] = results.map((result) => result.value);
  let geometry;
  try {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const meta = JSON.parse(metaText);
    geometry = firstMeshGeometry(gltf.scene);
    if (!geometry) throw new Error(`${name} geometry missing`);
    setupVATGeometry(geometry, meta);
    position.colorSpace = THREE.NoColorSpace;
    normal.colorSpace = THREE.NoColorSpace;
    position.wrapS = position.wrapT = normal.wrapS = normal.wrapT = THREE.ClampToEdgeWrapping;
    position.minFilter = position.magFilter = THREE.LinearFilter;
    normal.minFilter = normal.magFilter = THREE.LinearFilter;
    position.generateMipmaps = normal.generateMipmaps = false;
    position.needsUpdate = normal.needsUpdate = true;
    return { geometry, position, normal, meta };
  } catch (error) {
    geometry?.dispose();
    position?.dispose();
    normal?.dispose();
    throw error;
  } finally {
    // Only the cloned geometry is used by VAT; release the authored scene's
    // original geometry, materials and any embedded texture resources.
    if (gltf) disposeGLTF(gltf.scene);
  }
}

export class FalseEarthRoseField {
  constructor({ scene, terrain, engine, rover, station, target, quality }) {
    Object.assign(this, { scene, terrain, engine, rover, station, target, quality });
    this.group = new THREE.Group();
    this.group.name = 'false-earth 142 frame VAT roses';
    this.group.visible = false;
    this.meshes = [];
    this.state = {
      time: 0, wave: 0, heroGrowth: 0, fade: 0, residual: 0, light: 0,
      sunDir: new THREE.Vector3(0, 1, 0)
    };
    this.heroMatrix = null;
    this.eventPrepared = false;
    this.heroPosition = new THREE.Vector3();
    this.companionSpecs = [];
    this.disposed = false;
    this._assets = null;
    scene.add(this.group);
    this.ready = this._load();
  }

  async _load() {
    const base = 'assets/models/vegetation/false-earth';
    let ktx;
    let assets;
    try {
      ktx = new KTX2Loader()
        .setTranscoderPath('vendor/three/examples/jsm/libs/basis/')
        .detectSupport(this.engine.renderer);
      const results = await Promise.allSettled([
        loadRoseLOD(base, 'Rose'),
        loadRoseLOD(base, 'RoseLowPoly'),
        ktx.loadAsync(`${base}/Rose_Petal_Diff.ktx2`),
        ktx.loadAsync(`${base}/Rose_Outline.ktx2`),
        ktx.loadAsync(`${base}/Rose_Petal_Normal.ktx2`)
      ]);
      assets = {
        lods: results.slice(0, 2).filter((result) => result.status === 'fulfilled').map((result) => result.value),
        textures: results.slice(2).filter((result) => result.status === 'fulfilled').map((result) => result.value)
      };
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (this.disposed) {
        disposeRoseAssets(assets);
        return false;
      }
      const [high, low, petal, outline, petalNormal] = results.map((result) => result.value);
      petal.colorSpace = THREE.SRGBColorSpace;
      outline.colorSpace = THREE.NoColorSpace;
      petalNormal.colorSpace = THREE.NoColorSpace;
      // The largest tier uses only 1100 transforms (~88 KB per LOD including
      // attributes). Keep this stable prefix once; quality changes draw counts,
      // without asset reloads, new random placement or GPU buffer churn.
      const placement = this._placements(ROSE_COUNT.ULTRA);
      // One shared boundary prevents overlapping VAT meshes fighting for depth
      // as the cinematic lens moves through the former 4.7–5.3 m overlap.
      this._addLOD(high, { petal, outline, petalNormal }, placement, 0, 5.0);
      this._addLOD(low, { petal, outline, petalNormal }, placement, 5.0, 128.0);
      this._assets = assets;
      this.setQuality(this.quality);
      this.update(this.state);
      return true;
    } catch (error) {
      this._disposeMeshes();
      disposeRoseAssets(assets);
      this._assets = null;
      if (!this.disposed) console.warn('Full false-earth VAT roses unavailable; procedural far flowers remain active.', error);
      return false;
    } finally {
      ktx?.dispose();
    }
  }

  setQuality(quality) {
    if (this.disposed) return false;
    this.quality = quality;
    const count = ROSE_COUNT[quality?.name] || 460;
    for (const mesh of this.meshes) mesh.count = Math.min(count, mesh.instanceMatrix.count);
    return true;
  }

  _placements(count) {
    const matrices = [];
    const attributes = new Float32Array(count * 4);
    const rng = makeRNG(0x142F10A7);
    const up = new THREE.Vector3(0, 1, 0);
    const normal = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const yaw = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    let clusterX = this.station.x, clusterZ = this.station.z, clusterRadius = 2;
    // An asynchronous load must not re-seed the first flower from a camera
    // which is already orbiting it. prepareEvent owns this anchor for the run.
    this.heroMatrix = this.eventPrepared && this.heroMatrix
      ? this.heroMatrix : this._makeHeroMatrix();
    matrices.push(this.heroMatrix.clone());
    // aRose.w marks the one cinematic flower whose opening is independent
    // from the later basin-wide wave.
    attributes[0] = 0;
    attributes[1] = 0.72;
    attributes[2] = 0.18;
    attributes[3] = 1;
    this.companionSpecs.length = 0;
    const companionCount = Math.min(14, Math.max(0, count - 1));
    for (let i = 0; i < companionCount; i++) {
      const spec = {
        angle: i * 2.399963 + (rng() - 0.5) * 0.34,
        radius: 2.8 + (i % 5) * 1.18 + rng() * 0.55,
        scale: 9.5 + rng() * 5.8,
        yaw: rng() * Math.PI * 2
      };
      this.companionSpecs.push(spec);
      matrices.push(this._makeCompanionMatrix(spec));
      const index = i + 1;
      attributes[index * 4] = 0.052 + (i / Math.max(1, companionCount - 1)) * 0.050;
      attributes[index * 4 + 1] = 0.12 + rng() * 0.76;
      attributes[index * 4 + 2] = rng();
      attributes[index * 4 + 3] = 0;
    }
    let placed = 1 + companionCount;
    let randomPlaced = 0;
    for (let attempts = 0; placed < count && attempts < count * 18; attempts++) {
      if (randomPlaced % 10 === 0) {
        const angle = rng() * Math.PI * 2;
        const nearPatch = rng() < 0.68;
        const radius = nearPatch
          ? 5.5 + Math.sqrt(rng()) * 36
          : 38 + Math.sqrt(rng()) * 86;
        const aroundRover = rng() < 0.34;
        const originX = aroundRover ? this.rover.pos.x : this.station.x;
        const originZ = aroundRover ? this.rover.pos.z : this.station.z;
        clusterX = originX + Math.cos(angle) * radius;
        clusterZ = originZ + Math.sin(angle) * radius;
        clusterRadius = 0.7 + Math.pow(rng(), 1.5) * 3.8;
      }
      const localAngle = rng() * Math.PI * 2;
      const localRadius = Math.sqrt(rng()) * clusterRadius;
      const x = clusterX + Math.cos(localAngle) * localRadius;
      const z = clusterZ + Math.sin(localAngle) * localRadius;
      const radius = Math.hypot(x - this.station.x, z - this.station.z);
      if (Math.hypot(x, z) > 535 || radius < 8.0) continue;
      if (segmentDistance(x, z, this.station.x, this.station.z, this.target.x, this.target.z) < 7.4) continue;
      const y = this.terrain.heightAt(x, z);
      const dx = this.terrain.heightAt(x + 0.55, z) - y;
      const dz = this.terrain.heightAt(x, z + 0.55) - y;
      if (Math.hypot(dx, dz) > 0.66) continue;

      const seed = rng();
      const hero = seed > 0.94;
      const sourceScale = hero ? 19.0 + rng() * 7.0 : 9.0 + seed * 12.0;
      pos.set(x, y + 0.012, z);
      normal.set(-dx, 0.55, -dz).normalize();
      q.setFromUnitVectors(up, normal);
      yaw.setFromAxisAngle(up, rng() * Math.PI * 2);
      q.multiply(yaw);
      scale.setScalar(sourceScale * (0.88 + rng() * 0.18));
      const matrix = new THREE.Matrix4().compose(pos, q, scale);
      matrices.push(matrix);
      attributes[placed * 4] = clamp(radius / 350 + (rng() - 0.5) * 0.065, 0.045, 1.04);
      attributes[placed * 4 + 1] = seed;
      attributes[placed * 4 + 2] = rng();
      attributes[placed * 4 + 3] = 0;
      placed++;
      randomPlaced++;
    }
    return { matrices, attributes: attributes.subarray(0, placed * 4), count: placed };
  }

  _makeHeroMatrix() {
    const view = new THREE.Vector3();
    this.engine.camera.getWorldDirection(view);
    view.y = 0;
    if (view.lengthSq() < 0.01) view.copy(this.rover.forward || new THREE.Vector3(0, 0, 1));
    view.normalize();
    // Project the flower into the lower-left side of the actual event shot,
    // instead of assuming the rover heading and letting its hull occlude it.
    const screenLeft = new THREE.Vector3(view.z, 0, -view.x);
    const x = this.engine.camera.position.x + view.x * 7.3 + screenLeft.x * 2.25;
    const z = this.engine.camera.position.z + view.z * 7.3 + screenLeft.z * 2.25;
    const y = this.terrain.heightAt(x, z);
    this.heroPosition.set(x, y, z);
    const dx = this.terrain.heightAt(x + 0.48, z) - y;
    const dz = this.terrain.heightAt(x, z + 0.48) - y;
    const normal = new THREE.Vector3(-dx, 0.48, -dz).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(up, normal);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(up, 1.82));
    return new THREE.Matrix4().compose(
      new THREE.Vector3(x, y + 0.014, z), q,
      new THREE.Vector3(18, 18, 18)
    );
  }

  _makeCompanionMatrix(spec) {
    const x = this.heroPosition.x + Math.cos(spec.angle) * spec.radius;
    const z = this.heroPosition.z + Math.sin(spec.angle) * spec.radius;
    const y = this.terrain.heightAt(x, z);
    const dx = this.terrain.heightAt(x + 0.48, z) - y;
    const dz = this.terrain.heightAt(x, z + 0.48) - y;
    const normal = new THREE.Vector3(-dx, 0.48, -dz).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(up, normal);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(up, spec.yaw));
    return new THREE.Matrix4().compose(
      new THREE.Vector3(x, y + 0.012, z), q,
      new THREE.Vector3(spec.scale, spec.scale, spec.scale)
    );
  }

  prepareEvent() {
    if (this.disposed) return;
    this.eventPrepared = true;
    this.heroMatrix = this._makeHeroMatrix();
    for (const mesh of this.meshes) {
      if (mesh.count < 1) continue;
      mesh.setMatrixAt(0, this.heroMatrix);
      for (let i = 0; i < this.companionSpecs.length && i + 1 < mesh.count; i++) {
        mesh.setMatrixAt(i + 1, this._makeCompanionMatrix(this.companionSpecs[i]));
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  _addLOD(lod, sharedTextures, placement, minDistance, maxDistance) {
    const geometry = lod.geometry;
    geometry.setAttribute('aRose', new THREE.InstancedBufferAttribute(placement.attributes, 4));
    const material = roseMaterial({
      position: lod.position, normal: lod.normal, ...sharedTextures
    }, lod.meta, minDistance, maxDistance);
    const mesh = new THREE.InstancedMesh(geometry, material, placement.count);
    for (let i = 0; i < placement.count; i++) mesh.setMatrixAt(i, placement.matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = minDistance === 0 ? 'rose VAT high lod' : 'rose VAT low lod';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 4;
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  update(state) {
    if (this.disposed) return;
    Object.assign(this.state, state);
    this.group.visible = state.fade > 0.002 || state.residual > 0.002;
    for (const mesh of this.meshes) {
      const U = mesh.material.uniforms;
      U.uTime.value = state.time;
      U.uWave.value = state.wave;
      U.uHeroGrowth.value = state.heroGrowth || 0;
      U.uFade.value = state.fade;
      U.uResidual.value = state.residual;
      U.uSilverLight.value = state.light;
      U.uSunDir.value.copy(state.sunDir);
      U.uRoverPos.value.copy(this.rover.pos);
      U.uLodCamera.value.copy(this.engine.camera.position);
    }
  }

  _disposeMeshes() {
    for (const mesh of this.meshes) {
      mesh.dispose();
      mesh.material.dispose();
    }
    this.group.clear();
    this.meshes.length = 0;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.group);
    this._disposeMeshes();
    disposeRoseAssets(this._assets);
    this._assets = null;
    this.companionSpecs.length = 0;
  }
}

function segmentDistance(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const denom = abx * abx + abz * abz;
  const t = denom > 1e-5 ? clamp(((px - ax) * abx + (pz - az) * abz) / denom, 0, 1) : 0;
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}
