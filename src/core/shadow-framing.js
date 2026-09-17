import * as THREE from 'three';

const up = new THREE.Vector3(), right = new THREE.Vector3(), vertical = new THREE.Vector3();
const axis = new THREE.Vector3();

// Both light and target move together, snapped in the light's own image plane.
// This stabilizes translation without changing the visible moon/key direction.
export function snapShadowTarget(target, lightDirection, halfExtent, mapSize, out) {
  out.copy(target);
  if (!(mapSize > 0) || !(halfExtent > 0)) return out;
  axis.copy(lightDirection).normalize();
  up.set(0, Math.abs(axis.y) > 0.999 ? 0 : 1, Math.abs(axis.y) > 0.999 ? 1 : 0);
  right.crossVectors(up, axis).normalize();
  vertical.crossVectors(axis, right).normalize();
  const step = halfExtent * 2 / mapSize;
  const x = target.dot(right), y = target.dot(vertical);
  out.addScaledVector(right, Math.round(x / step) * step - x);
  out.addScaledVector(vertical, Math.round(y / step) * step - y);
  return out;
}
