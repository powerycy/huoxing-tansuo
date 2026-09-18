import * as THREE from 'three';

export const VEHICLES = [
  { id: 'transport', name: '远行者', tag: '01 / TRANSPORT', detail: '封闭式运输车 · 厚重车身，穿越火星荒野。' },
  { id: 'survey', name: '仙后座 MR-7', tag: '02 / SURVEY', detail: '六轮勘探车 · 开放悬架与探测桅杆，经典探索轮廓。' }
];
export const PAINTS = [
  { id: 'original', name: '原厂涂装', color: '#49545a' },
  { id: 'red', name: '火星赤', color: '#d45138' },
  { id: 'orange', name: '日落橙', color: '#e7a13b' },
  { id: 'white', name: '月壤白', color: '#e0e6df' },
  { id: 'blue', name: '极光蓝', color: '#38a6c8' },
  { id: 'green', name: '苔原绿', color: '#76987d' }
];

export function normalizeAppearance(value) {
  const vehicle = VEHICLES.some(v => v.id === value?.vehicle) ? value.vehicle : 'transport';
  const paint = PAINTS.some(p => p.id === value?.paint) || value?.paint === 'custom' ? value.paint : 'original';
  const color = /^#[0-9a-f]{6}$/i.test(value?.color || '') ? value.color.toLowerCase() : '#d45138';
  return { vehicle, paint, color };
}

// The imported car shares one material across its body and tyres. Preserve the
// authored vertex colours and use skeleton weights to leave running gear alone.
export function prepareBodyPaint(root) {
  const surfaces = [];
  root.traverse(mesh => {
    if (!mesh.isSkinnedMesh || mesh.material?.name !== 'DS_STANDARD_CAR_BODY') return;
    const geometry = mesh.geometry;
    const source = geometry.getAttribute('color');
    const joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
    if (!source || !joints || !weights) return;
    const colors = new Float32Array(source.count * 4);
    const mask = new Float32Array(source.count);
    const wheels = mesh.skeleton.bones.map(b => /Wheel|Tire|Arm/.test(b.name));
    for (let i = 0; i < source.count; i++) {
      colors.set([source.getX(i), source.getY(i), source.getZ(i), source.itemSize === 4 ? source.getW(i) : 1], i * 4);
      let gear = 0;
      for (let j = 0; j < 4; j++) if (wheels[joints.getComponent(i, j)]) gear += weights.getComponent(i, j);
      mask[i] = gear > 0.05 ? 0 : 1;
    }
    const painted = new THREE.BufferAttribute(colors.slice(), 4);
    surfaces.push({ mesh, source, painted, colors, mask, base: mesh.material.color.clone() });
  });
  return surfaces;
}

export function applyBodyPaint(surfaces, color) {
  for (const { mesh, source, painted, colors, mask, base } of surfaces) {
    if (!color) {
      mesh.geometry.setAttribute('color', source);
      mesh.material.color.copy(base);
      continue;
    }
    for (let i = 0; i < source.count; i++) {
      const tint = mask[i] ? color : base;
      painted.setXYZW(i, colors[i * 4] * tint.r, colors[i * 4 + 1] * tint.g,
        colors[i * 4 + 2] * tint.b, colors[i * 4 + 3]);
    }
    painted.needsUpdate = true;
    mesh.geometry.setAttribute('color', painted);
    mesh.material.color.set(0xffffff);
  }
}
