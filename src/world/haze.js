/* ============================================================
   MARTIAN DUST HAZE — rust horizon veil and windborne fines
   ============================================================ */
import * as THREE from 'three';
import { makeRNG } from '../core/rng.js';

export class ElectrostaticHaze {
  constructor(scene, terrain, quality) {
    this.scene = scene;
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'MartianDustHaze';
    scene.add(this.group);
    this._buildHorizon();
    this._buildGroundMist(quality);
  }

  _buildHorizon() {
    const geo = new THREE.CylinderGeometry(1180, 1180, 520, 96, 1, true);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
      fog: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        varying float vY;
        void main(){
          vUv = uv; vY = position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv; varying float vY; uniform float uTime;
        float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
        float noise(vec2 p){
          vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);
        }
        void main(){
          float band = exp(-pow(abs(vY) / 126.0, 1.42));
          float broken = 0.58 + 0.42 * noise(vec2(vUv.x*34.0 + uTime*0.003, vY*0.018));
          float a = band * broken * 0.095;
          gl_FragColor = vec4(vec3(0.235,0.095,0.065), a);
        }`
    });
    this.horizon = new THREE.Mesh(geo, mat);
    this.horizon.renderOrder = -850;
    this.group.add(this.horizon);
  }

  _buildGroundMist(quality) {
    const count = quality.name === 'LOW' ? 120 : quality.name === 'MEDIUM' ? 190 : 280;
    const rng = makeRNG(0xEA71D057);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = 45 + Math.pow(rng(), 0.72) * 720;
      const x = Math.cos(a) * r - 45;
      const z = Math.sin(a) * r - 35;
      pos[i*3] = x;
      pos[i*3+1] = this.terrain.heightAt(x, z) + 0.45 + rng() * 2.8;
      pos[i*3+2] = z;
      size[i] = 7 + rng() * 17;
      seed[i] = rng();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      fog: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aSize, aSeed;
        varying float vAlpha, vSeed;
        uniform float uTime;
        void main(){
          vec3 p = position;
          p.x += uTime * 0.14 * (0.35 + aSeed);
          p.y += sin(uTime*0.09 + aSeed*18.0) * 0.24;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = length(mv.xyz);
          gl_PointSize = clamp(aSize * (360.0 / max(30.0,-mv.z)), 2.0, 72.0);
          vAlpha = smoothstep(28.0, 85.0, d) * (1.0-smoothstep(410.0, 830.0, d));
          vSeed = aSeed;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        precision highp float;
        varying float vAlpha, vSeed;
        void main(){
          vec2 p = gl_PointCoord - 0.5;
          p.x *= 0.62;
          float soft = 1.0-smoothstep(0.18,0.50,length(p));
          float strands = 0.72 + 0.28*sin((p.x+p.y)*19.0+vSeed*31.0);
          float a = soft * strands * vAlpha * 0.024;
          if(a < 0.002) discard;
          gl_FragColor = vec4(vec3(0.300,0.125,0.080), a);
        }`
    });
    this.mist = new THREE.Points(geo, mat);
    this.mist.frustumCulled = false;
    this.group.add(this.mist);
  }

  update(dt, camera, elapsed) {
    void dt;
    this.horizon.position.set(camera.position.x, camera.position.y, camera.position.z);
    this.horizon.material.uniforms.uTime.value = elapsed;
    this.mist.material.uniforms.uTime.value = elapsed;
  }
}
