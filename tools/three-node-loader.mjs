// Resolve the same Three.js implementation used by the preview for CPU checks.
export async function resolve(specifier, context, next) {
  if (specifier === 'three') return {url:new URL('../vendor/three/three.module.js',import.meta.url).href,shortCircuit:true};
  if (specifier.startsWith('three/addons/')) return {url:new URL('../vendor/three/examples/jsm/' + specifier.slice(13),import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}
