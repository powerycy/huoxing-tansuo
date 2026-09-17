/* ============================================================
   SAM PORTER — first playable walking slice
   ------------------------------------------------------------
   The authored suit and deformation rig come from
   SAM_PORTER_SUIT.blend. Locomotion is deliberately small for this first
   pass: idle, forward walk and backwards walk, with a rigid cargo stack.
   ============================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clamp } from '../core/rng.js';

const MODEL_PATH = 'assets/models/sam/sam-porter-walk.glb';
const CHARACTER_HEIGHT = 1.82;
const WALK_SPEED = 1.55;
const BACK_SPEED = 1.05;
const TURN_SPEED = 1.95;

export class Porter {
  constructor({ scene, terrain, renderer }) {
    this.scene = scene;
    this.terrain = terrain;
    this.renderer = renderer;
    this.root = new THREE.Group();
    this.root.name = 'SamPorterPlayer';
    this.scene.add(this.root);
    this.speed = 0;
    this.yaw = 0;
    this.actions = {};
    this.weights = { Idle: 1, Walk: 0 };
    this.ready = this.load();
  }

  async load() {
    const gltf = await new GLTFLoader().loadAsync(MODEL_PATH);
    this.model = gltf.scene;
    this.model.name = 'SamPorterSuit';

    const clips = new Map(gltf.animations.map((clip) => [clip.name, clip]));
    for (const name of ['Idle', 'Walk']) {
      if (!clips.has(name)) throw new Error(`Sam animation clip missing: ${name}`);
    }

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const name of ['Idle', 'Walk']) {
      const action = this.mixer.clipAction(clips.get(name));
      action.enabled = true;
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveWeight(name === 'Idle' ? 1 : 0);
      action.play();
      this.actions[name] = action;
    }
    this.mixer.update(0);

    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.model.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      object.frustumCulled = false;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
          if (material[key]) material[key].anisotropy = anisotropy;
        }
        material.needsUpdate = true;
      }
    });

    // Normalize the authored export to human scale and plant the boots on y=0.
    this.model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.model);
    const sourceHeight = bounds.getSize(new THREE.Vector3()).y || 1;
    this.model.scale.setScalar(CHARACTER_HEIGHT / sourceHeight);
    this.model.updateMatrixWorld(true);
    const scaledBounds = new THREE.Box3().setFromObject(this.model);
    this.model.position.y = -scaledBounds.min.y;
    this.root.add(this.model);

    this.cargo = buildCargoStack();
    this.root.add(this.cargo);
    return this;
  }

  /** Turn the existing rover state into a lightweight character controller.
      Keeping this shared state means navigation, objectives and saves continue
      to work while their old vehicle presentation is replaced incrementally. */
  placeAt(proxy, yaw = null) {
    this.yaw = yaw ?? Math.atan2(proxy.forward.x, proxy.forward.z);
    this.speed = 0;
    proxy.pos.y = this.terrain.heightAt(proxy.pos.x, proxy.pos.z);
    proxy.vel.set(0, 0, 0);
    proxy.omega.set(0, 0, 0);
    proxy.quat.setFromAxisAngle(_up, this.yaw);
    this.resetActions();
    this.sync(proxy);
  }

  step(dt, ctl, proxy) {
    const throttle = clamp(ctl.throttle || 0, -1, 1);
    const steer = clamp(ctl.steer || 0, -1, 1);
    const wanted = throttle >= 0 ? throttle * WALK_SPEED : throttle * BACK_SPEED;
    const response = Math.abs(wanted) > Math.abs(this.speed) ? 7.5 : 10.5;
    this.speed += (wanted - this.speed) * (1 - Math.exp(-dt * response));
    if (Math.abs(this.speed) < 0.015 && Math.abs(wanted) < 0.015) this.speed = 0;

    // A little turn authority remains at rest; once walking, Sam turns with
    // his path rather than skating sideways because this pass has one gait.
    const movingTurn = 0.42 + 0.58 * clamp(Math.abs(this.speed) / WALK_SPEED, 0, 1);
    this.yaw += steer * TURN_SPEED * movingTurn * dt;
    proxy.quat.setFromAxisAngle(_up, this.yaw);
    const forward = _forward.set(0, 0, 1).applyQuaternion(proxy.quat);

    const dx = forward.x * this.speed * dt;
    const dz = forward.z * this.speed * dt;
    proxy.pos.x += dx;
    proxy.pos.z += dz;
    const radius = Math.hypot(proxy.pos.x, proxy.pos.z);
    if (radius > 558) {
      proxy.pos.x *= 558 / radius;
      proxy.pos.z *= 558 / radius;
    }
    proxy.pos.y = this.terrain.heightAt(proxy.pos.x, proxy.pos.z);
    proxy.vel.set(forward.x * this.speed, 0, forward.z * this.speed);
    proxy.omega.set(0, steer * TURN_SPEED * movingTurn, 0);
    proxy.odo += Math.abs(this.speed) * dt;
    proxy.airborne = false;
    proxy.hardHit = 0;
    proxy.motorLoad = Math.abs(throttle) * 0.08;
    for (const wheel of proxy.wheels) {
      wheel.contact = true;
      wheel.slipLong = wheel.slipLat = wheel.sink = 0;
      wheel.load = 0;
      wheel.spinVel = 0;
    }

    this.updateAnimation(dt, throttle);
    this.sync(proxy);
  }

  updateAnimation(dt, throttle) {
    if (!this.mixer) return;
    const moving = Math.abs(this.speed) > 0.07;
    const selected = moving ? 'Walk' : 'Idle';
    const blend = 1 - Math.exp(-dt * 10);
    for (const name of ['Idle', 'Walk']) {
      const target = name === selected ? 1 : 0;
      this.weights[name] = THREE.MathUtils.lerp(this.weights[name], target, blend);
      this.actions[name].setEffectiveWeight(this.weights[name]);
    }
    this.actions.Walk.setEffectiveTimeScale(clamp(Math.abs(this.speed) / WALK_SPEED, 0.72, 1.2));
    this.actions.Idle.setEffectiveTimeScale(1);
    this.mixer.update(dt);
  }

  resetActions() {
    if (!this.mixer) return;
    for (const name of ['Idle', 'Walk']) {
      this.weights[name] = name === 'Idle' ? 1 : 0;
      this.actions[name].reset().setEffectiveWeight(this.weights[name]).play();
    }
    this.mixer.update(0);
  }

  sync(proxy) {
    this.root.position.copy(proxy.pos);
    // Both the authored model and this controller use +Z as forward.
    this.root.rotation.set(0, this.yaw, 0);
    this.root.updateMatrixWorld(true);
  }
}

export function buildCargoStack() {
  const root = new THREE.Group();
  root.name = 'PorterCargoStack';
  root.position.set(0, 0, 0);

  const shell = new THREE.MeshStandardMaterial({
    color: 0x8c9398, metalness: 0.64, roughness: 0.38,
  });
  const edge = new THREE.MeshStandardMaterial({
    color: 0x171b1e, metalness: 0.76, roughness: 0.45,
  });
  const orange = new THREE.MeshStandardMaterial({
    color: 0xe06b25, emissive: 0x4a1605, emissiveIntensity: 0.3,
    metalness: 0.38, roughness: 0.42,
  });

  for (const [i, y] of [1.07, 1.35, 1.63].entries()) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.52 - i * 0.035, 0.235, 0.31), shell);
    box.position.set(0, y, -0.315);
    box.castShadow = box.receiveShadow = true;
    root.add(box);
    for (const x of [-1, 1]) {
      const corner = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.255, 0.33), edge);
      corner.position.set(x * (0.245 - i * 0.018), y, -0.315);
      corner.castShadow = true;
      root.add(corner);
    }
    const tag = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.055, 0.012), orange);
    tag.position.set(0, y, -0.477);
    root.add(tag);
  }
  for (const x of [-0.29, 0.29]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.88, 0.045), edge);
    rail.position.set(x, 1.35, -0.39);
    rail.castShadow = true;
    root.add(rail);
  }
  return root;
}

const _up = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3();
