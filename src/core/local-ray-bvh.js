import * as THREE from 'three';

// A small, stackless triangle BVH for the optional contact-ray pass. Geometry
// stays in each rigid root's coordinates; driving only updates its inverse
// matrix. No scene geometry/material is modified by this module.
export const RAY_TRIANGLE_LIMIT = 350000;
export const RAY_LEAF_SIZE = 4;

export function collectRayTriangles(root, { excludeWheels = false, limit = RAY_TRIANGLE_LIMIT } = {}) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const transform = new THREE.Matrix4(), point = new THREE.Vector3();
  const triangles = [];
  function visit(object) {
    if (!object.visible || (excludeWheels && /^Wheel_/.test(object.name))) return;
    if (object.isMesh && !object.isSkinnedMesh && !object.isInstancedMesh
        && !object.geometry?.morphAttributes?.position?.length) {
      const geometry = object.geometry, position = geometry?.attributes.position;
      if (position) {
        transform.multiplyMatrices(inverse, object.matrixWorld);
        const index = geometry.index;
        const count = index ? index.count : position.count;
        const ranges = geometry.groups.length ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
        for (const range of ranges) {
          const material = Array.isArray(object.material) ? object.material[range.materialIndex] : object.material;
          if (!material || !material.visible || material.transparent || material.alphaTest > 0
              || material.transmission > 0 || !material.depthWrite
              || !(material.isMeshStandardMaterial || material.isMeshPhysicalMaterial)) continue;
          const start = Math.max(range.start, geometry.drawRange.start);
          const end = Math.min(count, range.start + range.count, geometry.drawRange.start + geometry.drawRange.count);
          for (let i = start; i + 2 < end; i += 3) {
            const triangle = [];
            for (let j = 0; j < 3; j++) {
              point.fromBufferAttribute(position, index ? index.getX(i + j) : i + j).applyMatrix4(transform);
              triangle.push(point.x, point.y, point.z);
            }
            if (!triangle.every(Number.isFinite)) continue;
            triangles.push(triangle);
            if (triangles.length > limit) throw new Error('模型超出实验光追三角形预算');
          }
        }
      }
    }
    for (const child of object.children) visit(child);
  }
  visit(root);
  return triangles;
}

// Node: [min.xyz, escape-texel], [max.xyz, leaf-count]. An interior's
// children follow immediately; a leaf has 3 vec4s per triangle. Misses jump
// to escape, allowing bounded traversal without a shader stack.
export function packRayBVH(triangles, maxTextureSize = 4096) {
  const words = [];
  function emit(items) {
    const at = words.length / 4;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const triangle of items) for (let j = 0; j < 9; j++) {
      const axis = j % 3; lo[axis] = Math.min(lo[axis], triangle[j]); hi[axis] = Math.max(hi[axis], triangle[j]);
    }
    words.push(...lo, 0, ...hi, items.length <= RAY_LEAF_SIZE ? items.length : 0);
    if (items.length <= RAY_LEAF_SIZE) {
      for (const t of items) for (let j = 0; j < 9; j += 3) words.push(t[j], t[j + 1], t[j + 2], 0);
    } else {
      let axis = 0;
      if (hi[1] - lo[1] > hi[axis] - lo[axis]) axis = 1;
      if (hi[2] - lo[2] > hi[axis] - lo[axis]) axis = 2;
      items.sort((a, b) => (a[axis] + a[axis + 3] + a[axis + 6]) - (b[axis] + b[axis + 3] + b[axis + 6]));
      const middle = Math.floor(items.length / 2);
      emit(items.slice(0, middle)); emit(items.slice(middle));
    }
    words[at * 4 + 3] = words.length / 4;
  }
  if (triangles.length) emit(triangles.slice());
  const texels = words.length / 4;
  const width = Math.min(1024, maxTextureSize), height = Math.max(1, Math.ceil(texels / width));
  if (height > maxTextureSize) throw new Error('设备纹理容量不足以存放实验光追模型');
  const data = new Float32Array(width * height * 4); data.set(words);
  return { data, width, height, texels, triangles: triangles.length };
}

export function rayTexture(packed) {
  const texture = new THREE.DataTexture(packed.data, packed.width, packed.height, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false; texture.needsUpdate = true;
  return texture;
}

// CPU reference for the exact packed layout, also useful for regression tests.
export function tracePackedRay(packed, origin, direction, maxDistance = 4, maxVisits = 256) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const hit = new THREE.Vector3(), ray = new THREE.Ray(origin, direction);
  const data = packed.data;
  let at = 0;
  for (let visit = 0; visit < maxVisits && at < packed.texels; visit++) {
    const i = at * 4, escape = data[i + 3], count = data[i + 7];
    let near = 0, far = maxDistance;
    for (let axis = 0; axis < 3; axis++) {
      const d = direction.getComponent(axis), o = origin.getComponent(axis);
      if (Math.abs(d) < 1e-8) { if (o < data[i + axis] || o > data[i + 4 + axis]) far = -1; }
      else {
        const t1 = (data[i + axis] - o) / d, t2 = (data[i + 4 + axis] - o) / d;
        near = Math.max(near, Math.min(t1, t2)); far = Math.min(far, Math.max(t1, t2));
      }
    }
    if (near > far) { at = escape; continue; }
    for (let j = 0; j < count; j++) {
      const base = (at + 2 + j * 3) * 4;
      a.fromArray(data, base); b.fromArray(data, base + 4); c.fromArray(data, base + 8);
      if (ray.intersectTriangle(a, b, c, false, hit)) {
        const t = hit.clone().sub(origin).dot(direction) / direction.lengthSq();
        if (t > 0.025 && t < maxDistance) return true;
      }
    }
    at = count ? escape : at + 2;
  }
  return false;
}
