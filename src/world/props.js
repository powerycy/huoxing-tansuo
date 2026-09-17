/* ============================================================
   THINGS ON THE FLOOR OF ANAXAGORAS
   ------------------------------------------------------------
   Boulder fields (instanced), the descent sled you arrived on,
   what is left of Beacon-9, survey pylons, deployable relays,
   and the lattice itself.
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { makeRNG, vnoise, fbm, clamp, sstep } from '../core/rng.js';
import { PLAYABLE_R } from './terrain.js';
import { prepareStationMaterial, prepareLanderMaterial, prepareScannedRockMaterial,
  setMaterialAnisotropy, setObjectAnisotropy, setPracticalShadow } from '../core/model-materials.js';

const SCANNED_ROCKS = [
  'moon_rock_01', 'moon_rock_05', 'moon_rock_06', 'moon_rock_07'
];
const MAX_SCAN_ROCKS = 640;

/* ---------------- irregular rock ----------------
   Shattered anorthosite: big conchoidal faces from the fracture that made it,
   then progressively finer chipping on top. Three octaves rather than one, so
   the silhouette is angular at every scale you can see it at. */
function boulderGeo(seed, detail = 3, keepUV = false) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    n.copy(v).normalize();
    let d = 1.0;
    d += (fbm(n.x * 1.7 + seed, n.z * 1.7 - seed, 2, 2.1, 0.5, seed | 0) - 0.5) * 0.66;
    d += (fbm(n.x * 4.3 + seed * 2, n.y * 4.3 - seed, 3, 2.1, 0.5, (seed * 13) | 0) - 0.5) * 0.30;
    d += (vnoise(n.x * 11.0 + seed * 5, n.z * 11.0 - seed * 3, (seed * 31) | 0) - 0.5) * 0.11;
    // facet it: quantising the radius turns smooth lumps into flat fracture planes
    d = Math.round(d * 11) / 11 * 0.34 + d * 0.66;
    d *= 1 - 0.32 * Math.max(0, -n.y);              // flatter where it meets the ground
    v.copy(n).multiplyScalar(d);
    v.y *= 0.76;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  if (!keepUV) g.deleteAttribute('uv');             // triplanar in the procedural shader
  return g;
}

/** Procedural rock surface, injected into a standard material.
    Triplanar so it works on an arbitrary lump with no UVs, world-space so
    neighbouring boulders never repeat, and dust settles on the up-faces. */
function rockMaterial(textures = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: 0x5f4035, roughness: 0.95, metalness: 0.0, envMapIntensity: 0.72
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRockColor = { value: textures.regolithColor || null };
    sh.uniforms.uRockARM = { value: textures.regolithARM || null };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockW; varying vec3 vRockN;')
      // After <begin_vertex> both `transformed` and `objectNormal` exist. The
      // instance matrix has to be applied by hand — every boulder carries its
      // own rotation, and without it the detail would sit in the wrong place.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 rkP = vec4(transformed, 1.0);
          vec3 rkN = objectNormal;
          #ifdef USE_INSTANCING
            rkP = instanceMatrix * rkP;
            rkN = mat3(instanceMatrix) * rkN;
          #endif
          vRockW = (modelMatrix * rkP).xyz;
          vRockN = normalize(mat3(modelMatrix) * rkN);
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRockW; varying vec3 vRockN;
        uniform sampler2D uRockColor, uRockARM;
        float rkH(vec2 p){ p = fract(p*vec2(0.1031,0.1030)); p += dot(p,p.yx+33.33); return fract((p.x+p.y)*p.x); }
        float rkN(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(rkH(i),rkH(i+vec2(1,0)),f.x), mix(rkH(i+vec2(0,1)),rkH(i+vec2(1,1)),f.x), f.y); }
        float rkF(vec2 p){ return rkN(p)*0.55 + rkN(p*2.13+7.7)*0.28 + rkN(p*4.31+19.3)*0.17; }
        // triplanar: three planar samples blended by the surface normal
        float rkTri(vec3 w, vec3 n, float s){
          vec3 b = pow(abs(n), vec3(4.0)); b /= (b.x+b.y+b.z);
          return rkF(w.yz*s)*b.x + rkF(w.xz*s)*b.y + rkF(w.xy*s)*b.z;
        }
        vec3 rkTexTri(sampler2D tex, vec3 w, vec3 n, float s){
          vec3 b = pow(abs(n), vec3(5.0)); b /= (b.x+b.y+b.z);
          return texture2D(tex,w.yz*s).rgb*b.x + texture2D(tex,w.xz*s).rgb*b.y + texture2D(tex,w.xy*s).rgb*b.z;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 rn = normalize(vRockN);
          float rkFade = 1.0 - smoothstep(25.0, 110.0, length(vViewPosition));
          float coarse = rkTri(vRockW, rn, 1.7);
          float fine   = mix(0.5, rkTri(vRockW, rn, 8.0), rkFade);
          vec3 scan = rkTexTri(uRockColor, vRockW, rn, 0.72);
          vec3 rarm = rkTexTri(uRockARM, vRockW, rn, 0.72);
          float scanL = dot(scan, vec3(0.299,0.587,0.114));
          // Dark Martian basalt with oxidised fines accumulated in its pits.
          diffuseColor.rgb = scanL * vec3(0.205,0.125,0.095) * (0.76 + 0.30*coarse + 0.14*fine);
          diffuseColor.rgb *= mix(0.72,1.0,rarm.r);
          // iron-rich fines accumulate on upward faces
          float up = smoothstep(0.12, 0.85, rn.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.205,0.082,0.052), up*(0.34 + 0.34*coarse));
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        {
          vec3 rn = normalize(vRockN);
          float scanRough = rkTexTri(uRockARM, vRockW, rn, 0.72).g;
          roughnessFactor *= scanRough * (0.86 + 0.18*rkTri(vRockW, rn, 3.0));
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // three's "normal" here is in VIEW space, but the gradient below is
          // derived in WORLD space — they have to be rotated into the same
          // frame or the perturbation swings with the camera and speckles.
          // It also has to fade with distance, or a 0.2 m pebble at 80 m turns
          // into a pixel-sized noise generator.
          vec3 rn = normalize(vRockN);
          float fade = 1.0 - smoothstep(18.0, 85.0, length(vViewPosition));
          if (fade > 0.01) {
            float e = 0.035;
            float h0 = rkTri(vRockW, rn, 6.0);
            vec3 grad = vec3(rkTri(vRockW+vec3(e,0,0), rn, 6.0)-h0,
                             rkTri(vRockW+vec3(0,e,0), rn, 6.0)-h0,
                             rkTri(vRockW+vec3(0,0,e), rn, 6.0)-h0) / e;
            vec3 pert = grad - rn*dot(grad, rn);
            normal = normalize(normal - mat3(viewMatrix) * pert * 0.055 * fade);
          }
        }`);
  };
  m.customProgramCacheKey = () => 'regolith-rock-pbr-v2';
  return m;
}

/* The field is always placed at the densest tier's count so that lowering the
   tier hides a suffix rather than re-rolling the scatter. Keep in step with
   QUALITY.ultra.boulders in core/engine.js. */
const MAX_BOULDERS = 2200;

export class Props {
  constructor(scene, terrain, quality, textures = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.quality = quality;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.colliders = [];        // {x,z,r,restitution}
    this.curved = [];           // objects that must follow the horizon curve
    this.homeRingReveal = 0;
    this.stationPower = 0;
    this.stationOnline = false;
    this.stationExteriorMaterials = [];
    this.stationExteriorLights = [];
    this.stationNativeEmissives = [];

    this.rockMat = rockMaterial(textures);
    this.buildBoulders();
  }

  /* ---------------- photogrammetry rock field ----------------
     Keep one InstancedMesh per source/LOD and repack instance matrices a few
     times per second. Moon Rock 01 supplies four scan LODs; the other current
     packages supply the scan up close and use tiny deterministic silhouettes
     at distance. That keeps the scanned face where it matters without paying
     one draw call or one high-poly mesh per rock. */
  async loadScannedRocks(camera) {
    const loader = new GLTFLoader();
    const loaded = await Promise.allSettled(SCANNED_ROCKS.map((id) =>
      loader.loadAsync(`assets/models/moon-rocks/${id}/${id}_1k.gltf`)
        .then((gltf) => this._prepareScannedVariant(gltf, id))
    ));
    loaded.forEach((r,i) => {
      if (r.status === 'rejected') console.warn(`[REGOLITH] ${SCANNED_ROCKS[i]} failed: ${r.reason?.message || r.reason}`);
    });
    const variants = loaded.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (variants.length < 2) {
      console.warn('[REGOLITH] scanned rock field unavailable — retaining procedural boulders');
      return false;
    }
    this.scanVariants = variants;
    this.scanRockGroup = new THREE.Group();
    this.scanRockGroup.name = 'ScannedMoonRockField';
    this.group.add(this.scanRockGroup);
    this._buildScannedPlacements();

    for (let vi = 0; vi < variants.length; vi++) {
      const V = variants[vi];
      const cap = this.scanPlacements[vi].length;
      V.meshes = V.geometries.map((geo, lod) => {
        const im = new THREE.InstancedMesh(geo, V.material, cap);
        im.name = `${V.id}_LOD${lod}`;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.count = 0;
        im.castShadow = lod < 2;
        im.receiveShadow = true;
        im.frustumCulled = false;
        this.scanRockGroup.add(im);
        return im;
      });
    }
    this._scanReady = true;
    this.setQuality(this.quality);
    this._updateScannedLOD(camera, 0, true);
    console.info(`[REGOLITH] ${variants.length} scanned moon-rock variants loaded`);
    return true;
  }

  _prepareScannedVariant(gltf, id) {
    gltf.scene.updateMatrixWorld(true);
    const nodes = [];
    gltf.scene.traverse((o) => { if (o.isMesh && /LOD\d/i.test(o.name)) nodes.push(o); });
    nodes.sort((a, b) => Number(a.name.match(/LOD(\d)/i)?.[1] || 0) - Number(b.name.match(/LOD(\d)/i)?.[1] || 0));
    if (!nodes.length) throw new Error(`${id}: no scanned mesh found`);

    const normalise = (input, matrix = null) => {
      const geo = input.clone();
      if (matrix) geo.applyMatrix4(matrix);
      geo.computeBoundingBox();
      const box = geo.boundingBox;
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const k = 1 / Math.max(size.x, size.y, size.z, 1e-4);
      geo.translate(-centre.x, -box.min.y, -centre.z);
      geo.scale(k, k, k);
      if (geo.attributes.uv && !geo.attributes.uv1) geo.setAttribute('uv1', geo.attributes.uv.clone());
      geo.computeBoundingBox(); geo.computeBoundingSphere();
      return geo;
    };
    const geometries = nodes.slice(0,4).map((node) => normalise(node.geometry,node.matrixWorld));
    // Some Poly Haven rocks currently ship only LOD0 despite being tagged for
    // LODs. Preserve that scan up close, then hand off to tiny deterministic
    // silhouettes rather than drawing a 13K mesh hundreds of metres away.
    const seed = 27 + SCANNED_ROCKS.indexOf(id) * 11;
    while (geometries.length < 4) {
      const detail = Math.max(0, 3 - geometries.length);
      geometries.push(normalise(boulderGeo(seed + geometries.length * 3.7, detail, true)));
    }
    const material = prepareScannedRockMaterial(nodes[0].material, { packedARM: SCANNED_ROCKS.includes(id) });
    material.name = `${id}_cold_regolith`;
    setMaterialAnisotropy(material, this.quality?.anisotropy ?? 8);
    return { id, geometries, material, meshes: [] };
  }

  _buildScannedPlacements() {
    const rng = makeRNG(0x5CA44ED);
    const count = this.scanVariants.length;
    this.scanPlacements = Array.from({ length: count }, () => []);
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0,1,0), normal = new THREE.Vector3();
    const geology = { bowl: 0, ejecta: 0, exposed: 0, dust: 0.5 };
    let made = 0, guard = 0;
    while (made < MAX_SCAN_ROCKS && guard++ < MAX_SCAN_ROCKS * 80) {
      const a = rng() * Math.PI * 2;
      const r = 28 + Math.sqrt(rng()) * (PLAYABLE_R - 42);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const size = 0.34 + Math.pow(rng(), 2.25) * 5.4;
      const slope = this.terrain.slopeAt(x,z);
      if (Math.hypot(x - HOME.x, z - HOME.z) < 28 || slope > 34) continue;
      this.terrain.geologyAt(x, z, geology);
      const foot = sstep(6, 22, slope) * (1 - sstep(24, 34, slope));
      const geologicChance = 0.08 + geology.ejecta * 0.68 + geology.exposed * 0.42 + foot * 0.22
        + (size < 0.9 ? 0.14 : 0);
      if (rng() > geologicChance) continue;
      const vi = made % count;
      this.terrain.normalAt(x,z,0.9,normal);
      dummy.position.set(x, this.terrain.heightAt(x,z) - size*0.055, z);
      dummy.quaternion.setFromUnitVectors(up,normal);
      dummy.rotateY(rng()*Math.PI*2);
      dummy.rotateX((rng()-0.5)*0.20);
      dummy.scale.set(size*(0.78+rng()*0.38), size*(0.76+rng()*0.42), size*(0.80+rng()*0.36));
      dummy.updateMatrix();
      this.scanPlacements[vi].push({
        rank: made, x, z, size, matrix: dummy.matrix.clone(),
        collider: size > 0.95 ? { x, z, r:size*0.52, kind:'scanrock' } : null
      });
      made++;
    }
  }

  _scanBudget() {
    const n = this.quality.name;
    return n === 'LOW' ? 90 : n === 'MEDIUM' ? 190 : n === 'HIGH' ? 300 : 430;
  }

  setScanDensity(N) {
    this._scanDensity = Math.min(N, MAX_SCAN_ROCKS);
    this.colliders = this.colliders.filter((c) => c.kind !== 'scanrock');
    if (this.scanPlacements) for (const list of this.scanPlacements) for (const p of list) {
      if (p.rank < this._scanDensity && p.collider) this.colliders.push(p.collider);
    }
    this._scanLodDirty = true;
  }

  _updateScannedLOD(camera, t, force = false) {
    if (!this._scanReady || !camera) return;
    if (!force && !this._scanLodDirty && t - (this._scanLodT || 0) < 0.32) return;
    this._scanLodT = t; this._scanLodDirty = false;
    const cx = camera.position.x, cz = camera.position.z;
    for (let vi = 0; vi < this.scanVariants.length; vi++) {
      const V = this.scanVariants[vi], counts = [0,0,0,0];
      for (const p of this.scanPlacements[vi]) {
        if (p.rank >= this._scanDensity) continue;
        const d = Math.hypot(p.x-cx,p.z-cz);
        const metric = d / Math.max(p.size,0.35);
        const lod = metric < 10 ? 0 : metric < 30 ? 1 : metric < 88 ? 2 : 3;
        V.meshes[lod].setMatrixAt(counts[lod]++,p.matrix);
      }
      for (let lod=0;lod<4;lod++) {
        V.meshes[lod].count = counts[lod];
        V.meshes[lod].instanceMatrix.needsUpdate = true;
      }
    }
  }

  /* ---------------- boulder fields ---------------- */
  buildBoulders() {
    const rng = makeRNG(0xB0D1E);
    // Spend the triangles where they show: the big rocks you drive up to get
    // 1280 faces, the pebble scatter gets 320 and leans on the shader instead.
    const variants = [
      { geo: boulderGeo(1.7, 3), min: 1.10, max: 4.60, share: 0.14 },
      { geo: boulderGeo(5.3, 3), min: 0.80, max: 2.60, share: 0.16 },
      { geo: boulderGeo(9.1, 2), min: 0.30, max: 1.10, share: 0.32 },
      { geo: boulderGeo(13.7, 2), min: 0.18, max: 0.60, share: 0.38 }
    ];
    /* Always place the ULTRA field, then show a prefix of it. Density is a
       render knob, but a boulder is also a collider — re-rolling the scatter
       when the tier changes would slide rocks around a player who is driving
       between them, and could drop one inside the rover. Placing once and
       moving only `count` makes every tier a strict subset of the next. */
    const N = MAX_BOULDERS;
    const dummy = new THREE.Object3D();
    const geology = { bowl: 0, ejecta: 0, exposed: 0, dust: 0.5 };
    this.boulderMeshes = [];
    this._boulderRocks = [];      // per-variant collider lists, in draw order

    for (let vi = 0; vi < variants.length; vi++) {
      const V = variants[vi];
      const per = Math.ceil(N * V.share);
      const rocks = [];
      this._boulderRocks.push(rocks);
      const im = new THREE.InstancedMesh(V.geo, this.rockMat, per);
      im.castShadow = true; im.receiveShadow = true;
      im.frustumCulled = false;
      let k = 0, guard = 0;
      while (k < per && guard++ < per * 90) {
        // Uniform candidate positions are filtered by the geology below. This
        // produces real clusters without concentric placement bands.
        const a = rng() * Math.PI * 2;
        const r = 26 + Math.sqrt(rng()) * (PLAYABLE_R + 20);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (Math.hypot(x, z) > PLAYABLE_R + 60) continue;
        const slope = this.terrain.slopeAt(x, z);
        if (slope > 34) continue;                              // rocks roll off steep faces
        // keep the landing pad clear
        if (Math.hypot(x - HOME.x, z - HOME.z) < 26) continue;
        this.terrain.geologyAt(x, z, geology);
        const foot = sstep(7, 23, slope) * (1 - sstep(25, 34, slope));
        const baseChance = vi < 2 ? 0.055 : vi === 2 ? 0.13 : 0.20;
        const geologicChance = baseChance + geology.ejecta * (vi < 2 ? 0.88 : 0.62)
          + geology.exposed * 0.44 + foot * 0.24;
        if (rng() > geologicChance) continue;
        let size = V.min + Math.pow(rng(), 1.9) * (V.max - V.min);
        size *= 0.86 + geology.ejecta * 0.28 + geology.exposed * 0.16;
        const y = this.terrain.heightAt(x, z) - size * 0.24;
        dummy.position.set(x, y, z);
        dummy.rotation.set(rng() * 6.28, rng() * 6.28, rng() * 6.28);
        dummy.scale.set(size * (0.8 + rng() * 0.4), size * (0.7 + rng() * 0.4), size * (0.8 + rng() * 0.4));
        dummy.updateMatrix();
        im.setMatrixAt(k, dummy.matrix);
        rocks.push(size > 1.05 ? { x, z, r: size * 0.72, kind: 'rock' } : null);
        k++;
      }
      im.userData.placed = k;
      im.userData.share = V.share;
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.boulderMeshes.push(im);
    }
    this.setBoulderDensity(this.quality.boulders);
  }

  /** Show the first N boulders of the field and collide with exactly those.
      Anything the tier hides must not be solid, or you would be stopped by a
      rock that is not there. */
  setBoulderDensity(N) {
    this.colliders = this.colliders.filter(c => c.kind !== 'rock');
    for (let vi = 0; vi < this.boulderMeshes.length; vi++) {
      const im = this.boulderMeshes[vi];
      const show = Math.min(im.userData.placed, Math.ceil(N * im.userData.share));
      im.count = show;
      const rocks = this._boulderRocks[vi];
      for (let i = 0; i < show; i++) if (rocks[i]) this.colliders.push(rocks[i]);
    }
  }

  setQuality(q) {
    this.quality = q;
    setObjectAnisotropy(this.group, q.anisotropy ?? 8);
    this.setBoulderDensity(Math.round(q.boulders * (this._scanReady ? 0.48 : 0.78)));
    if (this._scanReady) this.setScanDensity(this._scanBudget());
    if (this.stationHeroLight) {
      const res = q.stationShadow ?? ((q.shadow || 0) >= 2048 ? 1024 : 0);
      setPracticalShadow(this.stationHeroLight, res);
    }
  }

  /* ============================================================
     the descent sled — home, recharge, sample drop-off
     ============================================================ */
  buildHome() {
    const g = new THREE.Group();
    g.name = 'SledHome';
    // This compact procedural lander is retained as an offline/loading
    // fallback. The detailed flight asset replaces it once the GLB is ready.
    const fallbackCore = new THREE.Group();
    fallbackCore.name = 'SledFallbackCore';
    g.add(fallbackCore);
    const mAlu = new THREE.MeshStandardMaterial({ color: 0x777b79, metalness: 0.72, roughness: 0.68 });
    const mGold = new THREE.MeshPhysicalMaterial({ color: 0x8e673b, metalness: 0.72, roughness: 0.70, clearcoat: 0.05 });
    const mDark = new THREE.MeshStandardMaterial({ color: 0x111416, metalness: 0.48, roughness: 0.78 });
    const mWhite = new THREE.MeshStandardMaterial({ color: 0x696d6c, metalness: 0.12, roughness: 0.86 });
    const mOrange = new THREE.MeshStandardMaterial({ color: 0xb35b22, metalness: 0.22, roughness: 0.72 });
    const mFrame = new THREE.MeshStandardMaterial({ color: 0x272c2e, metalness: 0.68, roughness: 0.58 });
    const mMarker = new THREE.MeshStandardMaterial({
      color: 0x32190b, emissive: 0xff7b2c, emissiveIntensity: 0.35,
      metalness: 0.18, roughness: 0.36
    });
    const mBeacon = new THREE.MeshStandardMaterial({
      color: 0x3a1b0c, emissive: 0xff7b2c, emissiveIntensity: 0.42,
      metalness: 0.08, roughness: 0.42
    });

    // octagonal deck
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.6, 0.42, 8), mDark);
    deck.position.y = 1.55; deck.castShadow = deck.receiveShadow = true; fallbackCore.add(deck);
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(2.62, 2.30, 0.30, 8), mAlu);
    skirt.position.y = 1.25; fallbackCore.add(skirt);
    // Thermal foil survives as small functional blankets rather than one huge
    // toy-gold platform, keeping the orange accent subordinate to the moon.
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI * 0.5;
      const blanket = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.58, 0.07), mGold);
      blanket.position.set(Math.sin(a) * 2.53, 1.63, Math.cos(a) * 2.53);
      blanket.rotation.y = a; blanket.castShadow = true; fallbackCore.add(blanket);
    }

    // four legs with footpads
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2 + Math.PI / 4;
      const dx = Math.cos(a), dz = Math.sin(a);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 2.6, 10), mAlu);
      leg.position.set(dx * 2.0, 0.72, dz * 2.0);
      leg.rotation.z = -dx * 0.44; leg.rotation.x = dz * 0.44;
      leg.castShadow = true; fallbackCore.add(leg);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.40, 0.14, 14), mAlu);
      pad.position.set(dx * 3.30, 0.06, dz * 3.30); pad.castShadow = true; fallbackCore.add(pad);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.9, 8), mAlu);
      strut.position.set(dx * 2.55, 0.75, dz * 2.55);
      strut.rotation.z = -dx * 1.05; strut.rotation.x = dz * 1.05; fallbackCore.add(strut);
    }

    // descent engine bells
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2;
      const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.30, 0.46, 14, 1, true), mDark);
      bell.position.set(Math.cos(a) * 1.35, 1.10, Math.sin(a) * 1.35);
      bell.material.side = THREE.DoubleSide; fallbackCore.add(bell);
    }

    // charge mast + floodlights + antenna
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 4.2, 12), mAlu);
    mast.position.y = 3.8; mast.castShadow = true; fallbackCore.add(mast);
    const cross = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.09, 0.09), mAlu);
    cross.position.y = 5.5; fallbackCore.add(cross);
    const dishPts = [];
    for (let i = 0; i <= 12; i++) { const t = i / 12, r = t * 0.62; dishPts.push(new THREE.Vector2(r, r * r * 0.5)); }
    const dish = new THREE.Mesh(new THREE.LatheGeometry(dishPts, 26),
      new THREE.MeshStandardMaterial({ color: 0xe9e5db, metalness: 0.4, roughness: 0.4, side: THREE.DoubleSide }));
    dish.position.set(0, 5.9, 0); dish.rotation.x = -1.15; dish.castShadow = true; fallbackCore.add(dish);

    // Industrial service hardware turns the flight vehicle into a working
    // mother port: a rear cargo pallet, field-replaceable containers, a
    // maintenance manipulator and a separate high-gain communications mast.
    const industrial = new THREE.Group();
    industrial.name = 'SledIndustrialServiceDeck';
    g.add(industrial);
    const yAxis = new THREE.Vector3(0, 1, 0);
    const addStrut = (parent, a, b, radius = 0.045, material = mFrame, sides = 8) => {
      const d = new THREE.Vector3().subVectors(b, a);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, d.length(), sides), material);
      strut.position.copy(a).add(b).multiplyScalar(0.5);
      strut.quaternion.setFromUnitVectors(yAxis, d.normalize());
      strut.castShadow = true;
      parent.add(strut);
      return strut;
    };

    const pallet = new THREE.Mesh(new THREE.BoxGeometry(4.65, 0.18, 1.62), mFrame);
    pallet.position.set(0, 0.18, -4.18); pallet.castShadow = pallet.receiveShadow = true;
    industrial.add(pallet);
    for (const x of [-2.04, -0.68, 0.68, 2.04]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.34, 1.78), mAlu);
      rail.position.set(x, 0.30, -4.18); rail.castShadow = true; industrial.add(rail);
    }
    for (const s of [-1, 1]) {
      const pod = new THREE.Group();
      pod.position.set(s * 1.24, 0, -4.16);
      industrial.add(pod);
      const caseBody = new THREE.Mesh(new THREE.BoxGeometry(1.68, 1.12, 1.22), mWhite);
      caseBody.position.y = 0.86; caseBody.castShadow = caseBody.receiveShadow = true; pod.add(caseBody);
      for (const cx of [-0.78, 0.78]) for (const cz of [-0.56, 0.56]) {
        const guard = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.22, 0.10), mFrame);
        guard.position.set(cx, 0.86, cz); guard.castShadow = true; pod.add(guard);
      }
      for (const y of [0.37, 1.35]) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.09, 1.32), mFrame);
        band.position.y = y; pod.add(band);
      }
      const servicePanel = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.54, 0.035), mDark);
      servicePanel.position.set(0, 0.88, 0.628); pod.add(servicePanel);
      const identityStripe = new THREE.Mesh(new THREE.BoxGeometry(1.03, 0.10, 0.045), mOrange);
      identityStripe.position.set(0, 1.15, 0.65); pod.add(identityStripe);
      for (const lx of [-0.39, 0, 0.39]) {
        const latch = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.19, 0.055), mAlu);
        latch.position.set(lx, 0.70, 0.66); pod.add(latch);
      }
      const status = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.06), mMarker);
      status.position.set(s * 0.52, 1.07, 0.665); pod.add(status);
    }
    for (const s of [-1, 1]) {
      addStrut(industrial, new THREE.Vector3(s * 2.12, 0.30, -4.88), new THREE.Vector3(s * 2.12, 1.18, -3.46));
      addStrut(industrial, new THREE.Vector3(s * 2.12, 0.30, -3.46), new THREE.Vector3(s * 2.12, 1.18, -4.88));
    }

    const arm = new THREE.Group();
    arm.name = 'SledServiceManipulator';
    arm.position.set(-3.58, 0, 2.46);
    industrial.add(arm);
    const armBase = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.48, 0.58, 18), mFrame);
    armBase.position.y = 0.29; armBase.castShadow = true; arm.add(armBase);
    const armCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.31, 0.27, 18), mOrange);
    armCollar.position.y = 0.70; armCollar.castShadow = true; arm.add(armCollar);
    const armYaw = new THREE.Group();
    armYaw.position.y = 0.80; arm.add(armYaw);
    const shoulder = new THREE.Group();
    armYaw.add(shoulder);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.76, 0.28), mAlu);
    upper.position.y = 0.88; upper.castShadow = true; shoulder.add(upper);
    const upperGuard = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.62, 0.34), mOrange);
    upperGuard.position.y = 0.38; shoulder.add(upperGuard);
    const elbow = new THREE.Group();
    elbow.position.y = 1.76; shoulder.add(elbow);
    const elbowHub = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.30, 18), mFrame);
    elbowHub.rotation.x = Math.PI / 2; elbow.add(elbowHub);
    const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.17, 1.48, 0.22), mAlu);
    forearm.position.y = 0.74; forearm.castShadow = true; elbow.add(forearm);
    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.20, 0.28, 16), mFrame);
    wrist.position.y = 1.50; elbow.add(wrist);
    for (const s of [-1, 1]) {
      const claw = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.42, 0.11), mOrange);
      claw.position.set(s * 0.16, 1.77, 0); claw.rotation.z = s * 0.34; elbow.add(claw);
    }
    shoulder.rotation.z = 0.22;
    elbow.rotation.z = -0.82;
    armYaw.rotation.y = -0.24;
    this.homeServiceArm = { yaw: armYaw, shoulder, elbow, deploy: 0 };

    const comms = new THREE.Group();
    comms.name = 'SledLongRangeComms';
    comms.position.set(3.62, 0, -2.62);
    industrial.add(comms);
    const commBase = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.62, 0.42, 18), mFrame);
    commBase.position.y = 0.21; commBase.castShadow = true; comms.add(commBase);
    addStrut(comms, new THREE.Vector3(-0.34, 0.38, 0), new THREE.Vector3(-0.15, 4.16, 0), 0.055, mAlu, 10);
    addStrut(comms, new THREE.Vector3(0.34, 0.38, 0), new THREE.Vector3(0.15, 4.16, 0), 0.055, mAlu, 10);
    for (let y = 0.78; y < 4.0; y += 0.48) {
      const flip = Math.round(y / 0.48) % 2 ? 1 : -1;
      addStrut(comms, new THREE.Vector3(-0.29, y, 0), new THREE.Vector3(0.29, y + 0.44 * flip, 0), 0.026, mFrame, 6);
    }
    const rotor = new THREE.Group();
    rotor.position.y = 4.22; comms.add(rotor);
    const commDish = new THREE.Mesh(new THREE.LatheGeometry(dishPts, 28),
      new THREE.MeshStandardMaterial({ color: 0x9ca4a4, metalness: 0.64, roughness: 0.48, side: THREE.DoubleSide }));
    commDish.scale.setScalar(0.82); commDish.rotation.x = -1.04; commDish.castShadow = true; rotor.add(commDish);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 8), mBeacon);
    beacon.position.y = 0.58; rotor.add(beacon);
    this.homeBeaconRotor = rotor;
    this.homeMarkerMat = mMarker;
    this.homeBeaconMat = mBeacon;

    const serviceLight = new THREE.PointLight(0xffb878, 22, 18, 2);
    serviceLight.position.set(0, 3.7, 1.5);
    serviceLight.castShadow = false;
    g.add(serviceLight);
    this.homeServiceLight = serviceLight;

    // Low pad lights remain independent of the fallback/model swap. Their
    // grazing pools reveal the landing feet without flattening the whole site.
    this.homeLights = [];
    this.homeFloodLights = [];
    for (const s of [-1, 1]) {
      const bollard = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.10, 1.05, 12), mDark);
      bollard.position.set(s * 4.45, 0.53, 2.15); bollard.castShadow = true; g.add(bollard);
      const hood = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.28, 0.34), mDark);
      hood.position.set(s * 4.45, 1.08, 2.15); hood.rotation.x = -0.22; g.add(hood);
      const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.16),
        new THREE.MeshBasicMaterial({ color: 0x2a251c }));
      lens.position.set(s * 4.45, 1.03, 2.325); lens.rotation.x = -0.22; g.add(lens);
      this.homeLights.push(lens);

      const flood = new THREE.SpotLight(0xffdfb5, 380, 34, Math.PI * 0.23, 0.68, 2);
      flood.position.set(s * 4.45, 1.02, 2.35);
      flood.castShadow = false;
      const target = new THREE.Object3D();
      target.position.set(s * 2.2, 0.03, 6.9);
      g.add(target);
      flood.target = target;
      g.add(flood);
      this.homeFloodLights.push({ light: flood, intensity: 380 });
    }

    // sample intake + charge pad
    const intake = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.64, 0.78), mWhite);
    intake.position.set(0, 0.52, 4.25); intake.castShadow = true; g.add(intake);
    const intakeFace = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.32, 0.035), mDark);
    intakeFace.position.set(0, 0.54, 4.655); g.add(intakeFace);
    const chute = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.27, 24),
      new THREE.MeshBasicMaterial({ color: 0x2ad2ff, side: THREE.DoubleSide }));
    chute.position.set(0, 0.54, 4.68); g.add(chute);
    this.homeChute = chute;

    // charge ring painted on the ground
    const ring = new THREE.Mesh(new THREE.RingGeometry(6.0, 6.24, 64),
      new THREE.MeshBasicMaterial({ color: 0x2ad2ff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    this.homeRing = ring;
    g.add(ring);

    // flag
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 2.3, 8), mAlu);
    pole.position.set(3.4, 1.15, -1.2); g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.58, 12, 6), makeFlagMaterial());
    flag.position.set(3.86, 2.02, -1.2); flag.castShadow = true; g.add(flag);
    this.flag = flag;

    const y = this.terrain.heightAt(HOME.x, HOME.z);
    g.position.set(HOME.x, y, HOME.z);
    g.rotation.y = -0.6;
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    ring.castShadow = false; ring.receiveShadow = false;
    chute.castShadow = false;
    this.group.add(g);
    this.home = g;
    this.colliders.push({ x: HOME.x, z: HOME.z, r: 5.0, kind: 'home' });
    this.levelPad();
    this.homeReady = this._loadHomeAsset(g, fallbackCore);
    return g;
  }

  async _loadHomeAsset(home, fallbackCore) {
    let dracoLoader;
    try {
      const loader = new GLTFLoader();
      dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath('vendor/three/examples/jsm/libs/draco/');
      loader.setDRACOLoader(dracoLoader);
      const gltf = await loader.loadAsync('assets/models/sled/apollo-lunar-module.glb');
      const source = gltf.scene;
      source.updateMatrixWorld(true);
      const original = new THREE.Box3().setFromObject(source);
      const size = original.getSize(new THREE.Vector3());
      // A 7.4 m foot-to-foot span leaves readable clearance inside the 12 m
      // charge ring and keeps the rover/lander scale physically believable.
      const scale = 7.4 / Math.max(size.x, size.z);
      source.scale.setScalar(scale);
      source.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(source);
      const centre = bounds.getCenter(new THREE.Vector3());
      source.position.set(-centre.x, -bounds.min.y - 0.08, -centre.z);

      const copies = new Map();
      const prepareMaterial = (material) => {
        if (!copies.has(material)) {
          copies.set(material, prepareLanderMaterial(material));
        }
        return copies.get(material);
      };
      source.traverse((o) => {
        if (!o.isMesh) return;
        o.material = Array.isArray(o.material)
          ? o.material.map(prepareMaterial)
          : prepareMaterial(o.material);
        o.castShadow = true;
        o.receiveShadow = true;
      });

      const assembly = new THREE.Group();
      assembly.name = 'SledApolloLander';
      source.name = 'NASAApolloLunarModule';
      assembly.add(source);
      home.add(assembly);
      fallbackCore.visible = false;
      this.homeAsset = assembly;
      setObjectAnisotropy(assembly, this.quality?.anisotropy ?? 8);
      dracoLoader.dispose();
      console.info('[REGOLITH] detailed NASA lunar lander loaded for Sled');
      return true;
    } catch (error) {
      dracoLoader?.dispose();
      console.warn(`[REGOLITH] detailed Sled unavailable — retaining fallback: ${error?.message || error}`);
      fallbackCore.visible = true;
      return false;
    }
  }

  /** Flatten the regolith under the sled's footpads so it never floats. */
  levelPad() {
    for (let i = 0; i < 3; i++) this.terrain.excavate(HOME.x, HOME.z, 7.5, 0.10);
  }

  /* ============================================================
     BEACON-9 — what the night left behind
     ============================================================ */
  buildStation(x, z) {
    const g = new THREE.Group();
    g.name = 'Beacon9Station';
    const mHab = new THREE.MeshStandardMaterial({ color: 0x555a59, metalness: 0.16, roughness: 0.91 });
    const mAlu = new THREE.MeshStandardMaterial({ color: 0x666a68, metalness: 0.68, roughness: 0.66 });
    const mDark = new THREE.MeshStandardMaterial({ color: 0x101315, metalness: 0.42, roughness: 0.82 });
    const mBurn = new THREE.MeshStandardMaterial({ color: 0x171718, metalness: 0.18, roughness: 0.98 });
    // A small procedural pressure tube remains as a zero-network fallback. It
    // is hidden as soon as the textured Halley VI hero pod is ready.
    const fallbackCore = new THREE.Group();
    fallbackCore.name = 'Beacon9FallbackCore';
    g.add(fallbackCore);

    // habitat cylinder, half buried by 214 days of ejecta and slumping
    const hab = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.05, 6.4, 28, 1, false), mHab);
    hab.rotation.z = Math.PI / 2; hab.rotation.y = 0.22;
    hab.position.set(0, 1.15, 0); hab.castShadow = hab.receiveShadow = true; fallbackCore.add(hab);
    // Dark pressure ribs turn the smooth tube into a believable assembled
    // structure and provide the missing scale cues in grazing moonlight.
    for (const d of [-2.45, -1.25, 0, 1.25, 2.45]) {
      const rib = new THREE.Mesh(new THREE.CylinderGeometry(2.10, 2.10, 0.13, 28), mDark);
      rib.rotation.copy(hab.rotation);
      rib.position.set(d * Math.cos(0.22), 1.15, -d * Math.sin(0.22));
      rib.castShadow = true; fallbackCore.add(rib);
    }
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(2.05, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), mHab);
      cap.rotation.z = s * Math.PI / 2; cap.position.set(s * 3.2 * Math.cos(0.22), 1.15, -s * 3.2 * Math.sin(0.22));
      cap.rotation.y = 0.22; cap.castShadow = true; fallbackCore.add(cap);
    }
    // airlock, door hanging open
    const lock = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 1.5, 18), mAlu);
    lock.position.set(0.6, 1.5, 2.35); lock.rotation.x = Math.PI / 2; lock.castShadow = true; fallbackCore.add(lock);
    const door = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.12, 18), mDark);
    door.position.set(1.9, 1.5, 3.0); door.rotation.set(Math.PI / 2, 0, 1.1); fallbackCore.add(door);

    // collapsed solar farm
    for (let i = 0; i < 6; i++) {
      const a = -0.9 + i * 0.34;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 1.1),
        new THREE.MeshStandardMaterial({ color: 0x10171d, metalness: 0.38, roughness: 0.64 }));
      panel.position.set(-7 + i * 0.9, 0.35 + (i % 2) * 0.4, 4.5 + Math.sin(a) * 2.2);
      panel.rotation.set(a * 0.7, a, 0.4 + a * 0.5);
      panel.castShadow = panel.receiveShadow = true; g.add(panel);
    }
    // toppled comms mast
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.14, 9.5, 12), mAlu);
    mast.position.set(5.5, 0.6, -3.2); mast.rotation.set(0, 0.6, Math.PI / 2 - 0.14);
    mast.castShadow = true; g.add(mast);
    const brokenDish = new THREE.Mesh(new THREE.SphereGeometry(1.1, 20, 12, 0, Math.PI * 1.35, 0, Math.PI / 2.4),
      new THREE.MeshStandardMaterial({ color: 0x6d716f, metalness: 0.34, roughness: 0.72, side: THREE.DoubleSide }));
    brokenDish.position.set(10.0, 0.9, -3.9); brokenDish.rotation.set(1.3, 0.4, 0.9);
    brokenDish.castShadow = true; g.add(brokenDish);

    // scorch: something discharged out of the ground here
    const scorch = new THREE.Mesh(new THREE.CircleGeometry(9.0, 40), new THREE.MeshBasicMaterial({
      color: 0x0a0a0c, transparent: true, opacity: 0.55, depthWrite: false
    }));
    scorch.rotation.x = -Math.PI / 2; scorch.position.y = 0.06; g.add(scorch);

    // scattered debris
    const rng = makeRNG(0x9EAC0);
    for (let i = 0; i < 22; i++) {
      const a = rng() * 6.28, r = 3 + rng() * 13;
      const bit = new THREE.Mesh(
        rng() < 0.5 ? new THREE.BoxGeometry(0.2 + rng() * 0.6, 0.08, 0.15 + rng() * 0.5)
                    : new THREE.CylinderGeometry(0.06, 0.06, 0.3 + rng() * 0.9, 7),
        rng() < 0.4 ? mBurn : mAlu);
      bit.position.set(Math.cos(a) * r, 0.10 + rng() * 0.1, Math.sin(a) * r);
      bit.rotation.set(rng() * 3, rng() * 6, rng() * 3);
      bit.castShadow = true; g.add(bit);
    }

    const y = this.terrain.heightAt(x, z);
    g.position.set(x, y, z);
    g.rotation.y = 1.05;

    // A recessed induction pad belongs to the sealed Moon rover far more than
    // a folding solar wing.  It sits on the established approach line, clear
    // of the long Halley hull and its collision volumes.
    const chargePad = new THREE.Group();
    chargePad.name = 'HalleyInductiveChargePad';
    chargePad.position.set(0, 0.08, -9.2);
    this.stationChargeMat = new THREE.MeshStandardMaterial({
      color: 0x101719, emissive: 0x2ad2ff, emissiveIntensity: 0.16,
      metalness: 0.72, roughness: 0.58, transparent: true, opacity: 0.62
    });
    for (const r of [1.65, 2.18]) {
      const coil = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.10, 64), this.stationChargeMat);
      coil.rotation.x = -Math.PI / 2;
      chargePad.add(coil);
    }
    const spineMat = new THREE.MeshBasicMaterial({
      color: 0x48ddf5, transparent: true, opacity: 0.14,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    for (const sx of [-2.42, 2.42]) {
      const guide = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 5.6), spineMat);
      guide.rotation.x = -Math.PI / 2;
      guide.position.x = sx;
      chargePad.add(guide);
    }
    g.add(chargePad);
    this.stationChargePad = chargePad;
    this.stationChargeGuides = spineMat;

    const chargeWorld = new THREE.Vector3(0, 0, -9.2)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y);
    this.stationChargePoint = { x: x + chargeWorld.x, z: z + chargeWorld.z, r: 4.4 };
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scorch.castShadow = false; scorch.receiveShadow = false;
    this.group.add(g);
    this.station = g;
    // Approximate the long Halley VI hull with three circles, then reserve a
    // fourth for the much smaller utility shelter. This keeps the rover out of
    // the visible structure without needing a heavy triangle-mesh collider.
    for (const localX of [-8, 0, 8]) {
      const hull = new THREE.Vector3(localX, 0, 0)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y);
      this.colliders.push({ x: x + hull.x, z: z + hull.z, r: 4.7, kind: 'station' });
    }
    const utility = new THREE.Vector3(-10.5, 0, -8.2)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y);
    this.colliders.push({ x: x + utility.x, z: z + utility.z, r: 4.2, kind: 'station' });
    this.stationReady = this._loadStationBuildings(g, fallbackCore);
    return g;
  }

  async _loadStationBuildings(station, fallbackCore) {
    try {
      const loader = new GLTFLoader();
      const [halleyResult, shelterResult] = await Promise.allSettled([
        loader.loadAsync('assets/models/beacon-9/halley-vi-dorm-pod-2k.glb'),
        loader.loadAsync('assets/models/beacon-9/beacon-9-shelter-2k.glb')
      ]);
      if (halleyResult.status !== 'fulfilled') throw halleyResult.reason;

      const prepareAsset = (source, {
        targetLength, tint, exposure, emissiveScale = 1
      }) => {
        source.updateMatrixWorld(true);
        const originalBounds = new THREE.Box3().setFromObject(source);
        const originalSize = originalBounds.getSize(new THREE.Vector3());
        const scale = targetLength / Math.max(originalSize.x, originalSize.z);
        source.scale.setScalar(scale);
        source.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(source);
        const centre = bounds.getCenter(new THREE.Vector3());
        source.position.x -= centre.x;
        source.position.y -= bounds.min.y;
        source.position.z -= centre.z;

        const materialCopies = new Map();
        const emissiveMaterials = [];
        const prepareMaterial = (material) => {
          if (!materialCopies.has(material)) {
            const copy = prepareStationMaterial(material, { tint, exposure, emissiveScale });
            setMaterialAnisotropy(copy, this.quality?.anisotropy ?? 8);
            const emissiveEnergy = copy.emissive
              ? copy.emissive.r + copy.emissive.g + copy.emissive.b
              : 0;
            if ('emissiveIntensity' in copy && (copy.emissiveMap || emissiveEnergy > 0.002)) {
              emissiveMaterials.push({
                material: copy,
                intensity: Math.max(0.35, copy.emissiveIntensity || 0)
              });
            }
            materialCopies.set(material, copy);
          }
          return materialCopies.get(material);
        };
        source.traverse((o) => {
          if (!o.isMesh) return;
          o.material = Array.isArray(o.material)
            ? o.material.map(prepareMaterial)
            : prepareMaterial(o.material);
          o.castShadow = true;
          o.receiveShadow = true;
        });
        const normalized = new THREE.Group();
        normalized.add(source);
        normalized.userData.stationEmissives = emissiveMaterials;
        return normalized;
      };

      // The real-world Halley silhouette supplies the visual centre and human
      // scale. Full source geometry is retained; only the 4K maps are served as
      // high-quality 2K WebP derivatives for sensible browser startup time.
      const halley = prepareAsset(halleyResult.value.scene, {
        targetLength: 24.0,
        tint: 0x788187,
        exposure: 0.94,
        emissiveScale: 0.65
      });
      const assembly = new THREE.Group();
      assembly.name = 'Beacon9HalleyAssembly';
      halley.name = 'HalleyVIDormPod';
      halley.position.y -= 0.28; // settle the skis/feet into loose regolith
      assembly.add(halley);
      this.stationNativeEmissives.push(...(halley.userData.stationEmissives || []));

      // Keep one low-poly sci-fi shelter as a subordinate garage/equipment
      // annex. It is offset and partially turned away so it cannot compete with
      // the hero pod or read as duplicated kit pieces.
      if (shelterResult.status === 'fulfilled') {
        const utilityShelter = prepareAsset(shelterResult.value.scene, {
          targetLength: 7.8,
          tint: 0x626b6d,
          exposure: 0.64,
          emissiveScale: 0.16
        });
        utilityShelter.name = 'Beacon9UtilityShelter';
        utilityShelter.position.set(-10.5, -0.16, -8.2);
        utilityShelter.rotation.y = Math.PI * 0.56;
        assembly.add(utilityShelter);
        this.stationNativeEmissives.push(...(utilityShelter.userData.stationEmissives || []));
      } else {
        console.warn(`[REGOLITH] Utility shelter unavailable: ${shelterResult.reason?.message || shelterResult.reason}`);
      }

      // Sparse warm lamps expose the raised hull and stairs at grazing angles,
      // while leaving most of the abandoned station in lunar darkness.
      const emergencyMat = new THREE.MeshStandardMaterial({
        color: 0x31170c, emissive: 0xff6b24, emissiveIntensity: 2.6,
        roughness: 0.34, metalness: 0.12
      });
      for (const [lx, ly, lz] of [[-7.2, 6.7, -4.72], [5.6, 6.7, -4.72], [-10.2, 2.0, -7.0]]) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.14, 0.10), emergencyMat);
        lamp.position.set(lx, ly, lz);
        assembly.add(lamp);
      }
      const emergency = new THREE.PointLight(0xffa15c, 86, 26, 2);
      emergency.position.set(-6.6, 6.4, -5.15);
      assembly.add(emergency);
      const maintenanceFlood = new THREE.SpotLight(0xffd39a, 210, 46, 0.66, 0.55, 2);
      maintenanceFlood.position.set(1.8, 7.3, -5.5);
      const maintenanceTarget = new THREE.Object3D();
      maintenanceTarget.position.set(0, 0.15, -13.2);
      maintenanceFlood.target = maintenanceTarget;
      maintenanceFlood.castShadow = true;
      maintenanceFlood.shadow.mapSize.set(1024, 1024);
      maintenanceFlood.shadow.bias = -0.00045;
      maintenanceFlood.shadow.normalBias = 0.045;
      maintenanceFlood.shadow.camera.near = 0.35;
      maintenanceFlood.shadow.camera.far = 46;
      assembly.add(maintenanceTarget, maintenanceFlood);
      this.stationHeroLight = maintenanceFlood;
      this.stationGroundLight = maintenanceFlood;
      this.setQuality(this.quality);
      const silverRim = new THREE.SpotLight(0xb5c4cd, 88, 38, 0.68, 0.76, 2);
      silverRim.position.set(8.2, 8.4, 7.4);
      const silverTarget = new THREE.Object3D();
      silverTarget.position.set(-2, 5.5, -1.0);
      silverRim.target = silverTarget;
      assembly.add(silverTarget, silverRim);

      // The downloaded pod has convincing geometry but no readable power
      // transition. These inset panes guarantee that recovering the local
      // records produces an unmistakable warm interior wake-up.
      const windowFrameMat = new THREE.MeshStandardMaterial({
        color: 0x111516, metalness: 0.58, roughness: 0.64
      });
      this.stationWindowMat = new THREE.MeshStandardMaterial({
        color: 0x160d08, emissive: 0xffb35f, emissiveIntensity: 0,
        metalness: 0.08, roughness: 0.34
      });
      // Positions measured from the normalized GLB's actual window frames:
      // the previous y=3.32,z=-4.03 panes sat inside the lower hull, not the
      // windows (y=5.69). Both sides must read as inhabited after recovery.
      for (const side of [
        { xs: [-5.275,-0.025,2.64], z: -4.75 },
        { xs: [-5.445,-0.225,2.68], z: 3.63 }
      ]) {
        for (const lx of side.xs) {
          const frame = new THREE.Mesh(new THREE.BoxGeometry(0.77,1.14,0.035),windowFrameMat);
          frame.position.set(lx,5.69,side.z);
          const pane = new THREE.Mesh(new THREE.BoxGeometry(0.63,0.97,0.04),this.stationWindowMat);
          pane.position.set(lx,5.69,side.z+Math.sign(side.z)*0.023);
          assembly.add(frame,pane);
        }
      }
      this.stationInteriorLight = new THREE.PointLight(0xffb46b, 0, 30, 2);
      this.stationInteriorLight.position.set(0, 5.70, -5.12);
      assembly.add(this.stationInteriorLight);

      // A steady amber roof marker gives the recovered base an identifiable
      // silhouette even on the bloom-free Mac path. It never strobes.
      const roofBeaconMat = new THREE.MeshStandardMaterial({
        color:0x1b1007,emissive:0xffad55,emissiveIntensity:0,roughness:0.28,metalness:0.08
      });
      for (const lx of [-4.2,1.8]) {
        const beacon = new THREE.Mesh(new THREE.CapsuleGeometry(0.16,0.18,4,10),roofBeaconMat);
        beacon.position.set(lx,9.22,-0.58);
        assembly.add(beacon);
      }

      // A local recovery terminal is the first element to wake, giving the
      // sequence a clear source before the habitat and approach lights follow.
      const terminalShellMat = new THREE.MeshStandardMaterial({
        color: 0x111516, metalness: 0.62, roughness: 0.70
      });
      const terminalShell = new THREE.Mesh(new THREE.BoxGeometry(0.82, 1.28, 0.58), terminalShellMat);
      terminalShell.position.set(2.75, 0.64, -10.55);
      terminalShell.rotation.y = -0.18;
      this.stationTerminalMat = new THREE.MeshStandardMaterial({
        color: 0x000000, emissive: 0x43e9ff, emissiveIntensity: 0,
        metalness: 0.36, roughness: 0.30
      });
      const terminalScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.54, 0.34), this.stationTerminalMat);
      terminalScreen.position.set(2.69, 0.82, -10.86);
      terminalScreen.rotation.y = -0.18;
      assembly.add(terminalShell, terminalScreen);

      // Low approach markers establish distance and a safe drive line without
      // filling the site with tall sci-fi lamp posts.
      const markerPostMat = new THREE.MeshStandardMaterial({
        color: 0x171a1b, metalness: 0.62, roughness: 0.72
      });
      const markerLensMat = new THREE.MeshStandardMaterial({
        color: 0x4a1c0b, emissive: 0xff7432, emissiveIntensity: 2.1,
        roughness: 0.38, metalness: 0.10
      });
      const markerPostGeo = new THREE.CylinderGeometry(0.045, 0.065, 0.38, 9);
      const markerLensGeo = new THREE.SphereGeometry(0.075, 10, 8);
      for (const lx of [-8, -4, 0, 4, 8]) {
        const marker = new THREE.Group();
        const post = new THREE.Mesh(markerPostGeo, markerPostMat);
        post.position.y = 0.19;
        const lens = new THREE.Mesh(markerLensGeo, markerLensMat);
        lens.position.y = 0.42;
        marker.position.set(lx, 0, -12.2);
        marker.add(post, lens);
        assembly.add(marker);
      }
      const approachGlow = new THREE.PointLight(0xff7c38, 18, 14, 2);
      approachGlow.position.set(0, 1.1, -11.8);
      assembly.add(approachGlow);

      this.stationExteriorMaterials = [
        { material: emergencyMat, intensity: 3.1 },
        { material: markerLensMat, intensity: 2.4 },
        { material: roofBeaconMat, intensity: 3.8 }
      ];
      this.stationExteriorLights = [
        { light: emergency, intensity: 86 },
        { light: maintenanceFlood, intensity: 210 },
        { light: silverRim, intensity: 88 },
        { light: approachGlow, intensity: 28 }
      ];
      for (const item of this.stationExteriorLights) {
        item.light.userData.stationBaseIntensity = item.intensity;
      }
      this.stationInteriorLight.userData.stationBaseIntensity = 48;

      station.add(assembly);
      fallbackCore.visible = false;
      this.stationShelter = assembly;
      this.setStationPowerProgress(this.stationPower);
      console.info(`[REGOLITH] Beacon-9 loaded (Halley VI hero pod${shelterResult.status === 'fulfilled' ? ' + utility shelter' : ''}, 2K PBR)`);
      return true;
    } catch (error) {
      console.warn(`[REGOLITH] Beacon-9 buildings unavailable — using fallback: ${error?.message || error}`);
      return false;
    }
  }

  /* ---------------- survey pylon ---------------- */
  buildPylon(x, z, idx) {
    const g = new THREE.Group();
    const mAlu = new THREE.MeshStandardMaterial({ color: 0x9d9a92, metalness: 0.9, roughness: 0.4 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.5, 10), mAlu);
    post.position.y = 1.25; post.castShadow = true; g.add(post);
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * Math.PI * 2;
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 1.15, 6), mAlu);
      foot.position.set(Math.cos(a) * 0.32, 0.48, Math.sin(a) * 0.32);
      foot.rotation.z = -Math.cos(a) * 0.55; foot.rotation.x = Math.sin(a) * 0.55;
      g.add(foot);
    }
    const refl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.36, 0.04),
      new THREE.MeshStandardMaterial({ color: 0xf2efe6, metalness: 0.2, roughness: 0.3 }));
    refl.position.y = 2.35; refl.castShadow = true; g.add(refl);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff5a3c }));
    led.position.set(0, 2.62, 0); g.add(led);
    const y = this.terrain.heightAt(x, z);
    g.position.set(x, y, z);
    g.userData.led = led; g.userData.phase = idx * 0.7;
    this.group.add(g);
    this.colliders.push({ x, z, r: 0.5, kind: 'pylon' });
    (this.pylons ||= []).push(g);
    return g;
  }

  // A dedicated, terrain-conforming bay outside the relay collision volume.
  // Its buffer battery is available even before the communications delivery.
  buildRelayCharger(x, z) {
    if(this.relayChargePoint)return;
    this.relayChargePoint = {x,z,r:4.4};
    const g = new THREE.Group(); g.name = 'LoneRelayChargeBay';
    const y = this.terrain.heightAt(x,z); g.position.set(x,y,z);
    const mat = new THREE.MeshBasicMaterial({color:0x59bdce,transparent:true,opacity:.34,
      side:THREE.DoubleSide,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1});
    for(const r of [2.8,4.4]) {
      const geo = new THREE.RingGeometry(r-.10,r,64); geo.rotateX(-Math.PI/2);
      const pos=geo.attributes.position;
      for(let i=0;i<pos.count;i++)pos.setY(i,this.terrain.heightAt(x+pos.getX(i),z+pos.getZ(i))-y+.07);
      geo.computeVertexNormals();g.add(new THREE.Mesh(geo,mat));
    }
    const cabinet = new THREE.Mesh(new THREE.BoxGeometry(.8,1.5,.65),new THREE.MeshStandardMaterial({
      color:0x333e42,roughness:.76,metalness:.42}));
    cabinet.position.set(5.4,this.terrain.heightAt(x+5.4,z)-y+.75,0);
    cabinet.castShadow=cabinet.receiveShadow=true;g.add(cabinet);
    this.colliders.push({x:x+5.4,z,r:.6,kind:'charge-cabinet'});
    this.group.add(g);this.relayChargeRingMat=mat;
  }

  /* ---------------- deployable relay ---------------- */
  buildRelay(x, z) {
    const g = new THREE.Group();
    const mAlu = new THREE.MeshStandardMaterial({ color: 0xb0aca2, metalness: 0.85, roughness: 0.35 });
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 7), mAlu);
      leg.position.set(Math.cos(a) * 0.36, 0.62, Math.sin(a) * 0.36);
      leg.rotation.z = -Math.cos(a) * 0.48; leg.rotation.x = Math.sin(a) * 0.48;
      leg.castShadow = true; g.add(leg);
    }
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.24, 0.46, 12), mAlu);
    core.position.y = 1.36; core.castShadow = true; g.add(core);
    const emit = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.42, 14),
      new THREE.MeshBasicMaterial({ color: 0x5ce8ff }));
    emit.position.y = 1.80; g.add(emit);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x2ad2ff, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.position.y = 1.62; g.add(halo);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.02, 40, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x2ad2ff, transparent: true, opacity: 0.10,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.y = 21.5; g.add(beam);
    const y = this.terrain.heightAt(x, z);
    g.position.set(x, y, z);
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    halo.castShadow = false; beam.castShadow = false; emit.castShadow = false;
    g.userData.emit = emit; g.userData.halo = halo;
    this.group.add(g);
    this.colliders.push({ x, z, r: 0.55, kind: 'relay' });
    (this.relays ||= []).push(g);
    return g;
  }

  /* ============================================================
     THE LATTICE — vitrified tubes pushing up through the floor
     ============================================================ */
  buildLatticeNode(x, z, scale = 1, big = false) {
    const g = new THREE.Group();
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x1a3d4a, metalness: 0.0, roughness: 0.08,
      transmission: 0.85, thickness: 1.4, ior: 1.52,
      clearcoat: 1.0, clearcoatRoughness: 0.05,
      emissive: 0x0a3a4a, emissiveIntensity: 0.5,
      envMapIntensity: 2.2, transparent: true, opacity: 0.92
    });
    const shards = [];
    const rng = makeRNG(Math.floor(x * 31 + z * 17) | 1);
    const n = big ? 11 : 5;
    for (let i = 0; i < n; i++) {
      const a = rng() * 6.2832;
      const len = (1.1 + rng() * 2.4) * scale;
      const rad = (0.10 + rng() * 0.20) * scale;
      const tube = new THREE.CylinderGeometry(rad * 0.55, rad, len, 6, 1);
      const m = new THREE.Matrix4();
      const tilt = 0.15 + rng() * 0.75;
      m.makeRotationZ(Math.cos(a) * tilt);
      m.multiply(new THREE.Matrix4().makeRotationX(Math.sin(a) * tilt));
      tube.applyMatrix4(m);
      tube.translate(Math.cos(a) * 0.5 * scale * rng(), len * 0.34, Math.sin(a) * 0.5 * scale * rng());
      shards.push(tube);
    }
    const merged = mergeGeometries(shards, false);
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, glass);
    mesh.castShadow = true; g.add(mesh);

    const glow = new THREE.Mesh(new THREE.SphereGeometry(1.5 * scale, 18, 14),
      new THREE.MeshBasicMaterial({ color: 0x1ea8c8, transparent: true, opacity: 0.055,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.y = 0.7 * scale; g.add(glow);

    const y = this.terrain.heightAt(x, z);
    g.position.set(x, y - 0.25 * scale, z);
    g.rotation.y = rng() * 6.2832;
    this.group.add(g);
    g.userData.glow = glow; g.userData.mat = glass;
    (this.lattice ||= []).push(g);
    this.colliders.push({ x, z, r: 0.9 * scale, kind: 'lattice' });
    return g;
  }

  /** Remove anything the player deployed, so a restart starts clean. */
  clearDeployables() {
    if (this.relays) {
      for (const r of this.relays) {
        this.group.remove(r);
        r.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
      }
      this.relays.length = 0;
    }
    this.colliders = this.colliders.filter(c => c.kind !== 'relay');
  }

  /* ---------------- collision query ---------------- */
  resolve(rover) {
    const px = rover.pos.x, pz = rover.pos.z;
    for (const c of this.colliders) {
      const dx = px - c.x, dz = pz - c.z;
      const d2 = dx * dx + dz * dz;
      const R = c.r + 1.05;
      if (d2 > R * R || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const push = (R - d);
      const nx = dx / d, nz = dz / d;
      rover.pos.x += nx * push; rover.pos.z += nz * push;
      const vn = rover.vel.x * nx + rover.vel.z * nz;
      if (vn < 0) {
        rover.vel.x -= vn * nx * 1.35; rover.vel.z -= vn * nz * 1.35;
        rover.omega.y += (Math.random() - 0.5) * Math.min(-vn, 4) * 0.10;
        return -vn;                      // impact speed, for damage + audio
      }
    }
    return 0;
  }

  /** The pad boundary is navigational information, not permanent decoration. */
  revealHomeGuidance(seconds = 6.5) {
    this.homeRingReveal = Math.max(this.homeRingReveal, seconds);
  }

  /**
   * Wake Beacon-9 in readable layers: recovery terminal, habitat windows,
   * exterior floods, then the induction charger. A normalized progress value
   * makes the sequence resumable and keeps mission timing outside rendering.
   */
  setStationPowerProgress(progress = 0) {
    const p = clamp(progress, 0, 1);
    this.stationPower = p;
    this.stationOnline = p >= 0.999;
    // The terrain is custom shaded and cannot see Three.js point lights. Keep
    // its warm pool on the same power circuit as the physical station lights.
    const terminal = sstep(0.02, 0.13, p);
    const windows = sstep(0.14, 0.38, p);
    const exterior = sstep(0.40, 0.72, p);

    if (this.stationTerminalMat) this.stationTerminalMat.emissiveIntensity = terminal * 2.6;
    if (this.stationWindowMat) this.stationWindowMat.emissiveIntensity = windows * 3.2;
    if (this.stationInteriorLight) this.stationInteriorLight.intensity = windows * 48;
    for (const item of this.stationNativeEmissives) {
      item.material.emissiveIntensity = item.intensity * windows;
    }
    for (const item of this.stationExteriorMaterials) {
      item.material.emissiveIntensity = item.intensity * exterior;
    }
    for (const item of this.stationExteriorLights) {
      item.light.intensity = item.intensity * exterior;
    }
  }

  update(dt, t, camera) {
    this._updateScannedLOD(camera,t);
    if (this.pylons) for (const p of this.pylons) {
      p.userData.led.visible = ((t * 1.35 + p.userData.phase) % 1) < 0.16;
    }
    if (this.relays) for (const r of this.relays) {
      const k = 0.55 + 0.45 * Math.sin(t * 2.4 + r.position.x);
      r.userData.halo.material.opacity = 0.10 + 0.10 * k;
      r.userData.emit.rotation.y += dt * 1.4;
    }
    if (this.lattice) for (const l of this.lattice) {
      const k = 0.5 + 0.5 * Math.sin(t * 0.9 + l.position.z * 0.3);
      l.userData.mat.emissiveIntensity = 0.30 + 0.55 * k;
      l.userData.glow.material.opacity = 0.035 + 0.045 * k;
    }
    if (this.homeRing) {
      this.homeRingReveal = Math.max(0, this.homeRingReveal - dt);
      const d = camera ? Math.hypot(camera.position.x - HOME.x, camera.position.z - HOME.z) : 1e9;
      const near = 1 - sstep(18, 46, d);
      const scanned = clamp(this.homeRingReveal / 1.25, 0, 1);
      const charging = this.chargingSite === 'SLED' ? 1 : 0;
      const cue = Math.max(near, scanned, charging);
      const pulse = charging
        ? 0.34 + 0.20 * (0.5 + 0.5 * Math.sin(t * 7.0))
        : 0.065 + 0.035 * (0.5 + 0.5 * Math.sin(t * 2.0));
      this.homeRing.material.opacity = pulse * cue;
      this.homeRing.visible = cue > 0.01;
      this.homeRing.position.y = 0.10;
    }
    if(this.relayChargeRingMat)this.relayChargeRingMat.opacity=this.chargingSite==='RELAY'?.65:.34;
    if (this.stationChargeMat) {
      const charging = this.stationOnline && this.chargingSite === 'HALLEY VI';
      const power = sstep(0.70, 1.0, this.stationPower);
      const pulse = 0.5 + 0.5 * Math.sin(t * 7.0);
      this.stationChargeMat.emissiveIntensity = power * (charging ? 2.8 + pulse * 3.2 : 0.42);
      this.stationChargeMat.opacity = power * (charging ? 0.92 : 0.42);
      if (this.stationChargeGuides) this.stationChargeGuides.opacity = power * (charging ? 0.30 + pulse * 0.28 : 0.10);
    }
    // With no ordinary solar key, the mother-port is the safe pool of warm
    // light at the start of the game. When the false moon arrives, dim these
    // floods unless terrain shadow still covers the pad.
    if (this.homeLights) {
      const night = 1 - clamp(this.globalKeyStrength ?? 0, 0, 1) / 0.46;
      const k = Math.max(this.padLight ?? 0, night);
      const v = 0.10 + k * 1.5;
      for (const l of this.homeLights) l.material.color.setRGB(v, v * 0.94, v * 0.85);
      for (const item of this.homeFloodLights || []) {
        item.light.intensity = item.intensity * (0.10 + k * 0.90);
      }
    }
    const homeCharging = this.chargingSite === 'SLED';
    if (this.homeServiceArm) {
      const arm = this.homeServiceArm;
      const target = homeCharging ? 1 : 0;
      arm.deploy += (target - arm.deploy) * Math.min(1, dt * (homeCharging ? 1.8 : 0.72));
      const k = arm.deploy;
      arm.yaw.rotation.y = -0.24 + k * 0.52;
      arm.shoulder.rotation.z = 0.22 - k * 0.74;
      arm.elbow.rotation.z = -0.82 + k * 1.20;
    }
    if (this.homeBeaconRotor) {
      this.homeBeaconRotor.rotation.y += dt * (homeCharging ? 0.34 : 0.045);
    }
    if (this.homeMarkerMat) {
      const pulse = 0.5 + 0.5 * Math.sin(t * (homeCharging ? 5.8 : 1.4));
      this.homeMarkerMat.emissiveIntensity = homeCharging ? 0.82 + pulse * 0.76 : 0.20 + pulse * 0.12;
      if (this.homeBeaconMat) this.homeBeaconMat.emissiveIntensity = homeCharging ? 0.55 + pulse * 0.48 : 0.18;
      if (this.homeServiceLight) this.homeServiceLight.intensity = homeCharging ? 32 + pulse * 12 : 6;
    }
    if (this.homeChute) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 6.4);
      this.homeChute.material.color.setRGB(0.09, homeCharging ? 0.66 + pulse * 0.22 : 0.38, homeCharging ? 1.0 : 0.62);
    }
    if (this.flag) {
      // no wind — but the pole rings for a long time after it is planted
      this.flag.rotation.y = Math.sin(t * 0.7) * 0.02;
    }
    void camera;
  }
}

/** Where the sled put you down. */
export const HOME = { x: 96, z: 214 };

function makeFlagMaterial() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 156;
  const g = c.getContext('2d');
  g.fillStyle = '#0d1220'; g.fillRect(0, 0, 256, 156);
  g.strokeStyle = '#6fe3f5'; g.lineWidth = 3; g.strokeRect(8, 8, 240, 140);
  g.fillStyle = '#d8d2c6';
  g.font = '600 26px ui-monospace, monospace';
  g.fillText('月神', 26, 62);
  g.font = '500 14px ui-monospace, monospace';
  g.fillStyle = '#6fe3f5';
  g.fillText('理事会', 26, 86);
  g.fillStyle = '#8b8578';
  g.font = '500 11px ui-monospace, monospace';
  g.fillText('向月而行 · 穿越长夜', 26, 116);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.0 });
}

void clamp; void sstep;
