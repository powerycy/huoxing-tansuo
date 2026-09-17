/* ============================================================
   VITRIFIED FIELD — black glass geology around the delivery route
   ============================================================ */
import * as THREE from 'three';
import { makeRNG, fbm } from '../core/rng.js';
import { HOME } from './props.js';

/** Martian dust settles on upward facets while newly fractured faces keep their
    glass response.  Done in the existing physical shader so every instance
    gets the effect without another mesh or draw call. */
function addGlassDust(material, strength) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlassDust = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vGlassUp;
        varying vec3 vGlassPos;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        vec3 glassWorldNormal = objectNormal;
        #ifdef USE_INSTANCING
          glassWorldNormal = mat3(instanceMatrix) * glassWorldNormal;
        #endif
        vGlassUp = normalize(glassWorldNormal).y;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vGlassPos = worldPosition.xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vGlassUp;
        varying vec3 vGlassPos;
        uniform float uGlassDust;
        float glassDustNoise(vec3 p){
          p = fract(p * 0.173 + vec3(0.11,0.37,0.71));
          p += dot(p, p.yzx + 19.19);
          return fract((p.x + p.y) * p.z);
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float glassCap = smoothstep(0.18, 0.82, vGlassUp);
        float glassBroken = 0.58 + 0.42 * glassDustNoise(floor(vGlassPos * 2.6));
        float glassDust = clamp(glassCap * glassBroken * uGlassDust, 0.0, 0.78);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.245,0.095,0.055), glassDust);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.96, glassDust);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor *= 1.0 - glassDust * 0.92;`);
  };
  material.customProgramCacheKey = () => `regolith-glass-dust-${strength}`;
  material.needsUpdate = true;
  return material;
}

export class GlassField {
  constructor(scene, terrain, props, target, textures = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.props = props;
    this.target = target;
    this.group = new THREE.Group();
    this.group.name = 'VitrifiedGlassField';
    scene.add(this.group);
    this.scanGlow = 0;
    this.material = addGlassDust(new THREE.MeshPhysicalMaterial({
      color: 0x3f3433,
      map: textures.basaltColor || null,
      normalMap: textures.basaltNormal || null,
      normalScale: new THREE.Vector2(0.72, 0.72),
      roughnessMap: textures.basaltARM || null,
      metalnessMap: textures.basaltARM || null,
      metalness: 0.12,
      roughness: 0.64,
      clearcoat: 0.58,
      clearcoatRoughness: 0.25,
      iridescence: 0.08,
      iridescenceIOR: 1.42,
      emissive: 0x00151c,
      emissiveIntensity: 0,
      envMapIntensity: 0.92
    }), 0.72);
    this.plateMaterial = addGlassDust(new THREE.MeshStandardMaterial({
      color: 0x4a3834,
      map: textures.basaltColor || null,
      normalMap: textures.basaltNormal || null,
      normalScale: new THREE.Vector2(0.42, 0.42),
      roughnessMap: textures.basaltARM || null,
      roughness: 0.92,
      metalness: 0.04,
      emissive: 0x00090c,
      emissiveIntensity: 0,
      envMapIntensity: 0.30
    }), 0.46);
    this._build();
  }

  _build() {
    const variants = [
      glassSpireGeometry(3.1), glassGeometry(8.7, 2),
      glassGeometry(13.4, 1), glassGeometry(21.2, 1)
    ];
    const rng = makeRNG(0x61A55);
    const count = 142;
    const matrices = [[], [], [], []];
    const dx = this.target.x - HOME.x, dz = this.target.z - HOME.z;
    const len = Math.hypot(dx, dz);
    const fx = dx / len, fz = dz / len;
    const rx = fz, rz = -fx;
    const dummy = new THREE.Object3D();
    // Concentrate the glass into a handful of readable formations. The empty
    // stretches between them are as important as the silhouettes themselves:
    // they make the relay feel distant and keep the route from reading as a
    // uniformly populated procedural field.
    const formations = [
      { t: 0.20, side: -1, shoulder: 27 },
      { t: 0.43, side:  1, shoulder: 23 },
      { t: 0.67, side: -1, shoulder: 36 },
      { t: 0.88, side:  1, shoulder: 29 }
    ];
    const clusteredPlacement = () => {
      if (rng() < 0.84) {
        const f = formations[Math.floor(rng() * formations.length)];
        return {
          t: Math.max(0.10, Math.min(0.96, f.t + (rng() + rng() - 1) * 0.075)),
          side: f.side,
          shoulder: Math.max(12, f.shoulder + (rng() + rng() - 1) * 15)
        };
      }
      return {
        t: 0.10 + rng() * 0.86,
        side: rng() < 0.5 ? -1 : 1,
        shoulder: 14 + Math.pow(rng(), 1.55) * 38
      };
    };

    for (let i = 0; i < count; i++) {
      const p = clusteredPlacement();
      const { t, side } = p;
      // Major silhouettes sit farther off the traversal lane, framing it
      // without turning the delivery corridor into a slalom course.
      const major = rng() < 0.105;
      const shoulder = p.shoulder + (major ? 7 + rng() * 10 : 0);
      const curve = Math.sin(t * Math.PI * 2.2) * 8;
      const x = HOME.x + dx * t + rx * (side * shoulder + curve);
      const z = HOME.z + dz * t + rz * (side * shoulder + curve);
      const size = major
        ? 1.55 + Math.pow(rng(), 1.55) * 2.05
        : 0.38 + Math.pow(rng(), 1.9) * 2.65;
      const y = this.terrain.heightAt(x, z) - size * (major ? 0.31 : 0.25);
      dummy.position.set(x, y, z);
      dummy.rotation.set(rng() * 0.38, rng() * Math.PI * 2, (rng() - 0.5) * (major ? 0.22 : 0.38));
      dummy.scale.set(
        size * (major ? 0.48 + rng() * 0.28 : 0.66 + rng() * 0.48),
        size * (major ? 0.92 + rng() * 0.64 : 0.72 + rng() * 0.82),
        size * (major ? 0.46 + rng() * 0.30 : 0.68 + rng() * 0.42)
      );
      dummy.updateMatrix();
      const vi = major ? 0 : (size > 1.15 ? 1 : 2);
      matrices[vi].push(dummy.matrix.clone());
      if (size > 1.12) this.props.colliders.push({ x, z, r: size * (major ? 0.48 : 0.55), kind: 'glass' });
    }

    // Half-buried glass sheets join the isolated shards into readable black
    // geology. Their thin geometry intersects the height field deliberately,
    // so the edges break up instead of reading as placed circular decals.
    const up = new THREE.Vector3(0, 1, 0);
    const normal = new THREE.Vector3();
    for (let i = 0; i < 82; i++) {
      const p = clusteredPlacement();
      const { t, side, shoulder } = p;
      const curve = Math.sin(t * Math.PI * 2.2) * 8;
      const x = HOME.x + dx * t + rx * (side * shoulder + curve);
      const z = HOME.z + dz * t + rz * (side * shoulder + curve);
      const s = 0.85 + Math.pow(rng(), 1.65) * 4.8;
      this.terrain.normalAt(x, z, 1.2, normal);
      dummy.position.set(x, this.terrain.heightAt(x, z) + 0.018, z);
      dummy.quaternion.setFromUnitVectors(up, normal);
      dummy.rotateY(rng() * Math.PI * 2);
      dummy.scale.set(s * (0.85 + rng() * 0.85), s * (0.055 + rng() * 0.075), s * (0.58 + rng() * 0.66));
      dummy.updateMatrix();
      matrices[3].push(dummy.matrix.clone());
    }

    for (let vi = 0; vi < variants.length; vi++) {
      const im = new THREE.InstancedMesh(
        variants[vi], vi === 3 ? this.plateMaterial : this.material, matrices[vi].length
      );
      matrices[vi].forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = true;
      this.group.add(im);
    }
  }

  reveal(seconds = 5.5) {
    this.scanGlow = Math.max(this.scanGlow, seconds);
  }

  update(dt) {
    this.scanGlow = Math.max(0, this.scanGlow - dt);
    const k = Math.min(1, this.scanGlow / 1.25);
    this.material.emissiveIntensity = k * 0.72;
    this.material.emissive.setRGB(0.0, 0.055 + k * 0.06, 0.075 + k * 0.11);
    this.plateMaterial.emissiveIntensity = k * 0.34;
    this.plateMaterial.emissive.setRGB(0.0, 0.025 + k * 0.045, 0.034 + k * 0.075);
  }
}

function glassGeometry(seed, detail) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    let d = 0.78 + fbm(v.x * 2.1 + seed, v.z * 2.1 - seed, 3, 2.15, 0.48, seed | 0) * 0.58;
    d = Math.round(d * 7) / 7;
    p.setXYZ(i, v.x * d, v.y * d, v.z * d);
  }
  g.computeVertexNormals();
  return g;
}

function glassSpireGeometry(seed) {
  const g = new THREE.ConeGeometry(1, 3.8, 7, 3, false);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const taper = 0.82 + fbm(x * 1.8 + seed, z * 1.8 - seed, 3, 2.1, 0.5, seed | 0) * 0.34;
    const shear = (y / 3.8 + 0.5) * 0.16;
    p.setXYZ(i, x * taper + shear, y, z * (0.82 + (i % 3) * 0.08));
  }
  g.rotateZ(0.08);
  g.computeVertexNormals();
  return g;
}
