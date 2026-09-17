/* A finite, skippable camera sequence. World growth is owned by FlowerTide,
   not this camera: skipping never advances, resets or hides the living field. */
import * as THREE from 'three';
import { clamp, lerp, sstep } from '../core/rng.js';

const TITLES = Object.freeze({
  warning: '巨月升起', grass: '荒原苏醒', first: '第一朵花',
  bloom: '寂静花潮', full: '通向远方'
});
const DETAILS = Object.freeze({
  warning: '低位观测 · 巨月正在越过远方山脊',
  grass: '靛紫色草本缓慢生长 · 草尖萤光渐渐浮现',
  first: '记录首个花苞 · 花瓣缓慢展开',
  bloom: '生长波向外扩散 · 盆地逐渐盛开',
  full: '双列花带已连通 · 准备继续前往孤立中继'
});
export const CINEMATIC_PHASES = Object.freeze(Object.keys(TITLES));

/** Read the actual instanced hero and its last VAT frame, not a guessed point
    in front of the vehicle. The crown is measured from the authored petals. */
export function readHeroFlower(field) {
  const mesh = field.meshes?.find((item) => item.count > 0);
  const matrix = new THREE.Matrix4();
  if (mesh) {
    mesh.getMatrixAt(0, matrix);
    mesh.updateWorldMatrix(true, false);
    matrix.premultiply(mesh.matrixWorld);
  } else if (field.heroMatrix) matrix.copy(field.heroMatrix);
  else return null;
  const root = new THREE.Vector3().setFromMatrixPosition(matrix);
  let crown = root.clone();
  const geometry = mesh?.geometry;
  const U = mesh?.material?.uniforms;
  const image = U?.uVatPosition?.value?.image;
  const uv = geometry?.getAttribute('uv1');
  const positions = geometry?.getAttribute('position');
  const masks = geometry?.getAttribute('aColorMask');
  if (image?.data && uv && positions && masks) {
    const bounds = new THREE.Box3();
    const point = new THREE.Vector3();
    const channels = image.data.length / (image.width * image.height);
    const lastFrame = U.uFrameCount.value - 1;
    for (let i = 0; i < positions.count; i++) {
      if (Math.abs(masks.getX(i) - 0.7) > 0.055) continue;
      const x = clamp(Math.floor(uv.getX(i) * image.width + lastFrame), 0, image.width - 1);
      const y = clamp(Math.floor(uv.getY(i) * image.height), 0, image.height - 1);
      const index = (y * image.width + x) * channels;
      point.fromBufferAttribute(positions, i);
      point.x += image.data[index];
      point.y += image.data[index + 1];
      point.z += image.data[index + 2];
      point.applyMatrix4(matrix);
      if ([point.x, point.y, point.z].every(Number.isFinite)) bounds.expandByPoint(point);
    }
    if (!bounds.isEmpty()) bounds.getCenter(crown);
  }
  return { root, crown, measured: crown.distanceToSquared(root) > 0.001 };
}

export class FlowerCinematic {
  constructor(event) {
    this.event = event;
    this.rig = event.rig;
    this.terrain = event.terrain;
    this.active = false;
    this.ending = false;
    this.seen = false;
    this.phase = '';
    this.position = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.fov = 58;
    this.phaseElapsed = 0;
  }

  get state() {
    if (!this.active) return null;
    return {
      phase: this.ending ? 'return' : this.event.phase,
      title: this.ending ? '正在交还驾驶视角' : TITLES[this.event.phase] || '寂静花潮',
      detail: this.ending ? '恢复原来的镜头模式 · 花海仍将继续生长' : DETAILS[this.event.phase],
      skippable: !this.ending,
      hint: '空格跳过镜头 · Esc 暂停'
    };
  }

  start({ force = false } = {}) {
    if (this.active || (this.seen && !force)) return false;
    const hero = readHeroFlower(this.event.roseField);
    if (!hero) return false;
    this.hero = hero;
    this.forward = this.event._moonAzimuth.clone().setY(0).normalize();
    this.side = new THREE.Vector3(-this.forward.z, 0, this.forward.x);
    this.position.copy(this.rig.cam.position);
    this.rig.cam.getWorldDirection(this.look);
    this.look.multiplyScalar(12).add(this.position);
    this.fov = this.rig.cam.fov / this.rig.fovScale;
    this.phase = '';
    this.phaseElapsed = 0;
    this.active = true;
    this.ending = false;
    this.seen = true;
    this.rig.lockCinematic();
    return true;
  }

  skip() {
    if (!this.active || this.ending) return false;
    this.ending = true;
    this.rig.releaseCinematic();
    return true;
  }

  cancel({ resetSeen = false } = {}) {
    this.rig.releaseCinematic(true);
    this.active = false;
    this.ending = false;
    this.phase = '';
    if (resetSeen) this.seen = false;
  }

  _ground(position, clearance = 0.55) {
    // Sample the camera footprint as well as its centre, avoiding the near
    // plane clipping into a rock slope while the lens is close to the ground.
    let h = this.terrain.heightAt(position.x, position.z);
    for (const [x, z] of [[0.32, 0], [-0.32, 0], [0, 0.32], [0, -0.32]]) {
      h = Math.max(h, this.terrain.heightAt(position.x + x, position.z + z));
    }
    position.y = Math.max(position.y, h + clearance);
    return position;
  }

  _offset(root, forward, sideways, height) {
    const p = root.clone().addScaledVector(this.forward, forward).addScaledVector(this.side, sideways);
    p.y = this.terrain.heightAt(p.x, p.z) + height;
    // Keep the low lens out of the parked vehicle's body.
    const rover = this.event.rover.pos;
    const distance = Math.hypot(p.x - rover.x, p.z - rover.z);
    if (distance < 3.4 && height < 2.8) {
      const away = new THREE.Vector3(p.x - rover.x, 0, p.z - rover.z);
      if (away.lengthSq() < 0.01) away.copy(this.side);
      away.normalize().multiplyScalar(3.4);
      p.x = rover.x + away.x; p.z = rover.z + away.z;
      p.y = this.terrain.heightAt(p.x, p.z) + height;
    }
    return this._ground(p);
  }

  _grassBank() {
    // The drivable centre is deliberately bare. Show the seeded grass shoulder
    // (outside its 7.4 m exclusion), rather than aiming at that empty lane.
    const a = this.event.delivery.station;
    const b = this.event.guideTarget;
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.max(1, Math.hypot(dx, dz));
    const h = this.hero.root;
    const t = clamp(((h.x - a.x) * dx + (h.z - a.z) * dz) / (length * length), 0, 1);
    const points = [-1, 1].map((sign) => new THREE.Vector3(
      a.x + dx * t - dz / length * 10.6 * sign, 0,
      a.z + dz * t + dx / length * 10.6 * sign
    ));
    points.sort((p, q) => p.distanceToSquared(h) - q.distanceToSquared(h));
    const point = points[0];
    point.y = this.terrain.heightAt(point.x, point.z) + 0.32;
    return point;
  }

  _pose(phase, p) {
    const { root, crown } = this.hero;
    if (phase === 'warning') {
      const position = this._offset(root, -4.4, 2.6, lerp(0.62, 1.10, p));
      const look = position.clone().addScaledVector(this.forward, 75);
      // Tilt slowly up while the moon's geometry rises from below the horizon.
      // Never track its initial below-ground centre with the camera.
      look.y += lerp(0.4, 13.8, sstep(0.08, 1, p));
      return { position, look, fov: lerp(66, 62, p) };
    }
    if (phase === 'grass') {
      const bank = this._grassBank();
      return {
        position: this._offset(bank, lerp(-4.8, -3.8, p), 1.2, 0.82),
        look: bank, fov: lerp(57, 51, p)
      };
    }
    if (phase === 'first') {
      return {
        position: this._offset(root, lerp(-3.0, -2.6, p), lerp(1.45, 1.1, p),
          Math.max(0.72, crown.y - root.y + 0.10)),
        look: root.clone().lerp(crown, 0.84), fov: 39
      };
    }
    // Stay within the 80 m camera-centred grass patch and keep the first flower
    // and neighbouring VAT flowers readable as the wider wave opens behind it.
    const k = phase === 'full' ? 1 : sstep(0, 1, p);
    const position = this._offset(root, lerp(-3.0, -17.0, k), lerp(1.1, 6.4, k),
      lerp(Math.max(0.72, crown.y - root.y + 0.10), 5.8, k));
    const look = crown.clone().addScaledVector(this.forward, k * 13);
    look.y = lerp(crown.y, this.terrain.heightAt(look.x, look.z) + 1.5, k);
    return { position, look, fov: lerp(39, 63, k) };
  }

  update(dt) {
    if (!this.active) return;
    if (this.ending) {
      if (!this.rig.cinematicReturning) this.active = this.ending = false;
      return;
    }
    const phase = this.event.phase;
    if (!CINEMATIC_PHASES.includes(phase)) { this.skip(); return; }
    // Loading can finish during the moon shot; resolve the actual petal crown
    // once without relocating the world anchor when the camera changes.
    if (!this.hero.measured) this.hero = readHeroFlower(this.event.roseField) || this.hero;
    if (phase !== this.phase) {
      this.phase = phase;
      this.phaseElapsed = 0;
      this.phaseFrom = {
        position: this.position.clone(), look: this.look.clone(), fov: this.fov
      };
    }
    this.phaseElapsed += dt;
    const p = this.event.phaseProgress;
    const pose = this._pose(phase, p);
    const transition = sstep(0, phase === 'first' ? 1.6 : 1.9, this.phaseElapsed);
    this.position.lerpVectors(this.phaseFrom.position, pose.position, transition);
    this.look.lerpVectors(this.phaseFrom.look, pose.look, transition);
    this.fov = lerp(this.phaseFrom.fov, pose.fov, transition);
    this._ground(this.position);
    // Lift the lens if terrain between it and the subject would hide the shot.
    // This tests the actual segment, not just the camera's ground height.
    if (phase !== 'warning') {
      let lift = 0;
      for (let i = 1; i <= 7; i++) {
        const t = i / 9;
        const x = lerp(this.position.x, this.look.x, t);
        const z = lerp(this.position.z, this.look.z, t);
        const obstruction = this.terrain.heightAt(x, z) + 0.14
          - lerp(this.position.y, this.look.y, t);
        lift = Math.max(lift, obstruction / (1 - t));
      }
      this.position.y += Math.max(0, lift);
    }
    this.rig.applyCinematicPose(this.position, this.look, this.fov);
  }
}
