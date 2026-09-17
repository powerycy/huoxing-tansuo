# Asset credits

## Silent flower tide vegetation

- Runtime files: `assets/models/vegetation/false-earth/`
- Original project: [false-earth](https://github.com/momentchan/false-earth)
- Source files: the high/low rose GLBs, 142-frame position/normal VATs and
  compressed petal diffuse, outline and normal textures under `public/vat/`
  and `public/textures/Rose/`.
- Licence: MIT; the preserved licence text is stored beside the runtime model.
- Runtime preparation: the authored high/low LOD meshes, VAT layout, vertex
  colour masks and material textures are retained. The original WebGPU compute
  routing is adapted to fixed WebGL2 LOD rings; the lunar black/silver grading
  and event growth wave are applied by this project's shaders. The source
  project's separately purchased astronaut is not included.

## Sled lunar lander

- Runtime file: `assets/models/sled/apollo-lunar-module.glb`
- Original model: [Apollo Lunar Module](https://science.nasa.gov/3d-resources/apollo-lunar-module/)
- Creator: NASA / Michael D. Carbajal
- Source: [NASA 3D Resources repository](https://github.com/nasa/NASA-3D-Resources/tree/master/3D%20Models/Apollo%20Lunar%20Module)
- Runtime preparation: the complete source mesh and embedded textures are
  retained. Materials are graded at runtime toward the project’s darker,
  dustier industrial palette; the procedural Sled remains only as a loading
  fallback.

## Moon rover

- Runtime file: `assets/models/moon-rover/moon-rover-4k.glb`
- Original model: [Lunar Rover from the Movie "Moon"](https://sketchfab.com/3d-models/lunar-rover-from-the-movie-moon-80030560a5a84b67903ff705291445b7)
- Creator: [Watndit](https://sketchfab.com/Watndit)
- Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Runtime preparation: original 4K PBR textures retained; the six wheel assemblies
  were grouped into named animation pivots without reducing the source mesh.

## Environment PBR scans

The runtime environment uses reduced 1K/2K derivatives of the following
[Poly Haven](https://polyhaven.com/) assets:

- [Moon 03](https://polyhaven.com/a/moon_03) — primary regolith colour, normal and ARM maps
- [Moon Flat Macro 01](https://polyhaven.com/a/moon_flat_macro_01) — close-range grain detail
- [Seaside Rock](https://polyhaven.com/a/seaside_rock) — recoloured basalt/glass rock surface
- [Moon Rock 01](https://polyhaven.com/a/moon_rock_01) — scanned model with four source LOD meshes
- [Moon Rock 05](https://polyhaven.com/a/moon_rock_05) — scanned near-field model; simplified distance LODs are generated at runtime
- [Moon Rock 06](https://polyhaven.com/a/moon_rock_06) — scanned near-field model; simplified distance LODs are generated at runtime
- [Moon Rock 07](https://polyhaven.com/a/moon_rock_07) — scanned near-field model; simplified distance LODs are generated at runtime
- Licence: [CC0](https://polyhaven.com/license)

The checked-in files are JPEG runtime derivatives. Original high-resolution
downloads remain available from the linked asset pages.

## Beacon-9 main habitat

- Runtime file: `assets/models/beacon-9/halley-vi-dorm-pod-2k.glb`
- Preserved source download: `assets/models/beacon-9/halley-vi-dorm-pod-4k-original.glb`
- Original model: [Halley VI Antarctic Research Station Dorm Pod](https://sketchfab.com/3d-models/halley-vi-antarctic-research-station-dorm-pod-88dbccb1cb6e487585a6505d64cb36e8)
- Creator: [Andre Lages](https://sketchfab.com/lages.miguel)
- Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Runtime preparation: all source geometry and UVs are retained. The largest 4K
  textures were resized to 2K and the complete texture set was encoded as
  high-quality WebP for browser delivery.

## Beacon-9 utility shelter

- Runtime file: `assets/models/beacon-9/beacon-9-shelter-2k.glb`
- Preserved source download: `assets/models/beacon-9/sci-fi-base-camp-shelter-2k-original.glb`
- Original model: [Sci Fi Base Camp Shelter](https://sketchfab.com/3d-models/sci-fi-base-camp-shelter-b5721b9435884684a994e16db20821e0)
- Creator: [Cosimo](https://sketchfab.com/Cosimo_)
- Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Runtime preparation: the supplied 2K PBR textures were converted from PNG to
  WebP; geometry and UVs remain at their original resolution. One module is used
  as a subordinate garage/equipment annex and graded toward the project’s cold,
  dusty palette.

## Giant lunar primary

- `assets/textures/environment/moon-color-8k.jpg`
- Solar System Scope 8K lunar texture, distributed through
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Solarsystemscope_texture_8k_moon.jpg)
- Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Attribution: Solar System Scope
