import * as THREE from 'three';
import { VEHICLES, PAINTS, normalizeAppearance } from '../game/vehicle-appearance.js';

const $ = id => document.getElementById(id);

// Clone skeletons as well as nodes so rotating the display cannot move the
// playable car's bones. Geometry/textures stay shared; preview materials do not.
function displayClone(source) {
  const copy = source.clone(true), mapping = new Map();
  function pair(a, b) {
    mapping.set(a, b);
    a.children.forEach((child, i) => pair(child, b.children[i]));
  }
  pair(source, copy);
  source.traverse(node => {
    const target = mapping.get(node);
    if (node.material) target.material = Array.isArray(node.material)
      ? node.material.map(m => m.clone()) : node.material.clone();
    if (node.isSkinnedMesh) {
      target.skeleton = node.skeleton.clone();
      target.skeleton.bones = node.skeleton.bones.map(b => mapping.get(b));
      target.bindMatrix.copy(node.bindMatrix);
      target.bindMatrixInverse.copy(node.bindMatrixInverse);
    }
  });
  copy.visible = true;
  return copy;
}

export class Garage {
  constructor(rover, saved, onSave, onClose) {
    this.rover = rover;
    this.onSave = onSave;
    this.onClose = onClose;
    this.selection = rover.setAppearance(normalizeAppearance(saved));
    this.active = false;
    this.angle = -0.65;
    $('garageVehicles').replaceChildren(...VEHICLES.map(v => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'garage-vehicle'; b.dataset.vehicle = v.id;
      const label = document.createElement('small'); label.textContent = v.tag;
      const name = document.createElement('strong'); name.textContent = v.name;
      const detail = document.createElement('span'); detail.textContent = v.detail;
      b.append(label, name, detail);
      b.disabled = v.id === 'transport' && !rover.visualModel;
      if (b.disabled) detail.textContent = '模型未能载入，暂不可选';
      b.onclick = () => this.select({ vehicle: v.id });
      return b;
    }));
    $('garagePaints').replaceChildren(...PAINTS.map(p => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'garage-swatch'; b.dataset.paint = p.id;
      b.setAttribute('aria-label', p.name); b.title = p.name;
      b.style.setProperty('--paint', p.color);
      b.onclick = () => this.select({ paint: p.id });
      return b;
    }));
    $('garageColor').addEventListener('input', e => this.select({ paint: 'custom', color: e.target.value }));
    $('garageOriginal').onclick = () => this.select({ paint: 'original' });
    $('garageApply').onclick = () => {
      const saved = this.onSave({ ...this.selection });
      $('garageSummary').textContent = `${VEHICLES.find(v => v.id === this.selection.vehicle).name} · ${this.paintName()}`;
      $('garageSummary').title = saved ? '已保存在这台设备' : '本次已应用，浏览器未允许保存';
      this.close(true);
    };
    $('garageBack').onclick = () => this.close(false);
    $('garageRotateLeft').onclick = () => { this.angle -= Math.PI / 6; };
    $('garageRotateRight').onclick = () => { this.angle += Math.PI / 6; };
    const canvas = $('garageCanvas');
    canvas.addEventListener('pointerdown', e => {
      this.pointer = { id: e.pointerId, x: e.clientX };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.pointer || this.pointer.id !== e.pointerId) return;
      this.angle += (e.clientX - this.pointer.x) * 0.012;
      this.pointer.x = e.clientX;
    });
    const release = () => { this.pointer = null; };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', release);
    $('garage').addEventListener('keydown', e => {
      // Keep the driving input handler from swallowing native Tab/Space keys.
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.key !== 'Tab') return;
      const nodes = [...$('garage').querySelectorAll('button:not(:disabled), input')];
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    $('garageSummary').textContent = `${VEHICLES.find(v => v.id === this.selection.vehicle).name} · ${this.paintName()}`;
  }

  paintName() { return PAINTS.find(p => p.id === this.selection.paint)?.name || '自选喷漆'; }

  open() {
    this.original = { ...this.selection };
    this.active = true;
    $('garage').classList.remove('hidden');
    $('menu').inert = true;
    try {
      this.initPreview();
      this.refresh();
      $('garagePreviewError').hidden = true;
    } catch (error) {
      console.warn('[Garage] Preview unavailable:', error);
      $('garagePreviewError').hidden = false;
      this.updateLabels();
    }
    $('garageBack').focus();
  }

  close(apply = false) {
    if (!this.active) return;
    if (!apply) this.selection = this.rover.setAppearance(this.original);
    this.active = false;
    this.pointer = null;
    $('garage').classList.add('hidden');
    $('menu').inert = false;
    this.onClose();
    $('btnGarage').focus();
  }

  select(change) {
    this.selection = this.rover.setAppearance({ ...this.selection, ...change });
    this.refresh();
  }

  updateLabels() {
    for (const b of $('garageVehicles').children) b.setAttribute('aria-pressed', b.dataset.vehicle === this.selection.vehicle);
    for (const b of $('garagePaints').children) b.setAttribute('aria-pressed', b.dataset.paint === this.selection.paint);
    const vehicle = VEHICLES.find(v => v.id === this.selection.vehicle);
    $('garageModelName').textContent = vehicle.name;
    $('garageModelTag').textContent = vehicle.tag;
    $('garagePaintName').textContent = this.paintName();
    $('garageColor').value = this.selection.color;
    $('garageColorLabel').classList.toggle('selected', this.selection.paint === 'custom');
  }

  initPreview() {
    if (this.renderer) return;
    this.renderer = new THREE.WebGLRenderer({ canvas: $('garageCanvas'), antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.6;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 60);
    this.scene.add(new THREE.HemisphereLight(0xe3f3ff, 0x75685e, 3));
    for (const [color, power, pos] of [[0xffedd9, 5, [4, 6, 5]], [0x9ae6ff, 3, [-4, 3, -3]]]) {
      const light = new THREE.DirectionalLight(color, power); light.position.set(...pos); this.scene.add(light);
    }
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 0.10, 80),
      new THREE.MeshStandardMaterial({ color: 0x243332, metalness: 0.25, roughness: 0.65 }));
    floor.position.y = -0.09; this.scene.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.96, 3.0, 100),
      new THREE.MeshBasicMaterial({ color: 0x76b5af, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = -0.03; this.scene.add(ring);
  }

  refresh() {
    this.updateLabels();
    if (!this.renderer) return;
    if (this.display) {
      this.scene.remove(this.display);
      this.display.traverse(o => {
        if (o.isSkinnedMesh) o.skeleton.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m?.dispose();
      });
    }
    // Position the procedural wheels without advancing the driving simulation.
    if (!this.rover.wheels[0].local) {
      for (const w of this.rover.wheels) {
        w.worldPos.copy(w.mount).add(new THREE.Vector3(0, -0.46, 0))
          .applyQuaternion(this.rover.quat).add(this.rover.pos);
      }
      this.rover.updateVisuals(0, {});
    }
    const source = this.selection.vehicle === 'survey' ? this.rover.body : this.rover.visualModel;
    this.display = new THREE.Group();
    const model = displayClone(source);
    this.display.add(model);
    this.display.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.add(new THREE.Vector3(-center.x, -box.min.y, -center.z));
    this.height = box.max.y - box.min.y;
    this.scene.add(this.display);
  }

  render() {
    if (!this.active || !this.renderer || !this.display) return;
    const canvas = $('garageCanvas');
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (w !== this.width || h !== this.heightPx) {
      this.width = w; this.heightPx = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }
    const distance = Math.max(9.5, 8 / this.camera.aspect);
    this.camera.position.set(Math.sin(this.angle) * distance, this.height * 0.5 + distance * 0.38, Math.cos(this.angle) * distance);
    this.camera.lookAt(0, this.height * 0.43, 0);
    this.renderer.render(this.scene, this.camera);
  }
}
