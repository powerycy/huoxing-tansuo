/* Imported PBR finishes. Keep the asset's UV sets and packed R/G/B channels;
   dust modifies the evaluated BRDF, never the texture or its colour space. */
import * as THREE from 'three';

const MATERIAL_TEXTURES = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap',
  'specularIntensityMap', 'specularColorMap', 'bumpMap', 'alphaMap'
];

export function setMaterialAnisotropy(material, anisotropy = 8) {
  for (const key of MATERIAL_TEXTURES) {
    const texture = material?.[key];
    if (!texture || texture.anisotropy === anisotropy) continue;
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
  }
}

export function setObjectAnisotropy(root, anisotropy = 8) {
  const seen = new Set();
  root?.traverse(object => {
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      setMaterialAnisotropy(material, anisotropy);
    }
  });
}

/** A map resize needs a fresh render target even if casting remains enabled.
    Three allocates the replacement on its next shadow render. */
export function setPracticalShadow(light, resolution) {
  const cast = resolution > 0;
  const size = cast ? resolution : 512;
  const shadow = light.shadow;
  const changed = light.castShadow !== cast || shadow.mapSize.x !== size || shadow.mapSize.y !== size;
  if (changed) {
    shadow.map?.dispose();
    shadow.mapPass?.dispose();
    shadow.map = null;
    shadow.mapPass = null;
  }
  light.castShadow = cast;
  shadow.mapSize.set(size, size);
  if (changed && cast) shadow.needsUpdate = true;
}

function installDustFinish(material, { dust = 0.10, paintCoat = false, foil = false } = {}) {
  if (!material.isMeshStandardMaterial || material.userData.regolithFinish) return material;
  material.userData.regolithFinish = { dust, paintCoat, foil };
  const beforeCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = function(shader, renderer) {
    beforeCompile.call(this, shader, renderer);
    shader.uniforms.uFinishDust = { value: dust };
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      uniform float uFinishDust;
      ${foil ? 'varying vec3 vFinishPosition;' : ''}`);
    if (foil) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFinishPosition;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vFinishPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // Broad foil creases, fixed to world space and fading before aliasing.
        vec3 foilWorldN = inverseTransformDirection(normal, viewMatrix);
        vec3 foilFold = sin(vFinishPosition.yzx * vec3(32.0, 39.0, 27.0)
          + sin(vFinishPosition.zxy * 19.0));
        foilFold -= foilWorldN * dot(foilFold, foilWorldN);
        float foilFade = 1.0 - smoothstep(12.0, 42.0, length(vViewPosition));
        normal = normalize(normal + mat3(viewMatrix) * foilFold * 0.075 * foilFade);`);
    }
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
      // All normal/ORM texture chunks have run here. Dust settles on upward
      // faces, while authored metal, rubber and paint retain their own response.
      vec3 finishWorldN = inverseTransformDirection(nonPerturbedNormal, viewMatrix);
      float finishDust = uFinishDust * smoothstep(0.15, 0.92, finishWorldN.y);
      float finishPaint = (1.0 - metalnessFactor)
        * smoothstep(0.028, 0.16, dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.095, 0.055), finishDust);
      roughnessFactor = mix(roughnessFactor, max(roughnessFactor, 0.92), finishDust);
      metalnessFactor *= 1.0 - finishDust;
      #include <lights_physical_fragment>
      ${paintCoat ? `#ifdef USE_CLEARCOAT
        material.clearcoat *= finishPaint * (1.0 - finishDust);
      #endif` : ''}`);
  };
  material.customProgramCacheKey = () => `${previousKey}|regolith-finish-v1:${dust}:${paintCoat}:${foil}`;
  material.needsUpdate = true;
  return material;
}

export function prepareRoverMaterial(material) {
  if (material.userData.regolithFinish) return material;
  if (material.name === 'Surfaces') {
    // The source uses ONE ARM atlas for rubber, painted panels and bare metal.
    // Keep its roughness/metalness factors; the original full-strength coat
    // covered the rubber too. Restrict that lobe to bright dielectric paint.
    material.clearcoat *= 0.32;
    material.envMapIntensity = 1.08;
    return installDustFinish(material, { dust: 0.13, paintCoat: true });
  }
  if (material.name === 'Logos') {
    material.envMapIntensity = 0.85;
    return installDustFinish(material, { dust: 0.08 });
  }
  return material;
}

export function prepareStationMaterial(source, { tint, exposure = 1, emissiveScale = 1 } = {}) {
  const material = source.clone();
  if (tint !== undefined && material.color) material.color.lerp(new THREE.Color(tint), 0.10);
  material.color?.multiplyScalar(exposure);
  // Mapped BODY/meca/PIECS and the shelter retain every authored PBR factor.
  // Only these untextured named parts need a separate surface treatment.
  if (material.name === 'ELECTRIC' && !material.roughnessMap) {
    material.roughness = 0.86;
    material.metalness = 0.02;
  } else if (material.name === 'STAIRS' && !material.roughnessMap) {
    material.roughness = 0.76;
  }
  material.envMapIntensity = material.name === 'Ceramic' || material.name === 'ELECTRIC' ? 0.78 : 0.98;
  if ('emissiveIntensity' in material) material.emissiveIntensity *= emissiveScale;
  return installDustFinish(material, { dust: 0.10 });
}

export function prepareScannedRockMaterial(source, { packedARM = false } = {}) {
  const material = source.clone();
  material.color.multiply(new THREE.Color(0x66635d));
  material.envMapIntensity = 0.78;
  // The four shipped Poly Haven images are explicitly *_arm_1k.jpg. G is
  // roughness, R is AO; an arbitrary roughness image must never become AO.
  if (packedARM && !material.aoMap && material.roughnessMap) {
    material.aoMap = material.roughnessMap;
    material.aoMapIntensity = 0.72;
  }
  // Preserve authored roughness and signed normal scale, including UV channel.
  return installDustFinish(material, { dust: 0.12 });
}

export function prepareLanderMaterial(source) {
  const material = source.clone();
  // This legacy Blinn export gives every part roughness .41 and metalness 0.
  // These names are checked against apollo-lunar-module.glb, not guessed from
  // brightness: foil, silver structural metal, black insulation, white paint.
  const name = material.name.split('.')[0];
  const foil = name === 'blinn1SG' || name === 'blinn9SG';
  const silver = ['blinn4SG', 'blinn2SG', 'blinn3SG', 'initialShadingGr'].includes(name);
  const insulation = name === 'blinn6SG';
  if (material.color) {
    material.color.lerp(new THREE.Color(foil ? 0x9a6a2b : 0x525b60), foil ? 0.08 : 0.13);
    material.color.multiplyScalar(foil ? 0.78 : 0.68);
  }
  material.roughness = foil ? 0.46 : silver ? 0.57 : insulation ? 0.89 : 0.75;
  material.metalness = foil ? 0.86 : silver ? 0.72 : 0.02;
  material.envMapIntensity = foil ? 1.03 : silver ? 0.98 : 0.72;
  return installDustFinish(material, { dust: foil ? 0.08 : 0.12, foil });
}
