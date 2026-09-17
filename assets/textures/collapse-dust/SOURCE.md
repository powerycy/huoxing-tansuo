# Smoke flipbook provenance

`impact-flipbook.png` is a format-converted copy of the CC0 smoke texture
`explosion_04.tga` from the public Godot Flipbook Particles texture mirror.
It contains 25 frames arranged 5 × 5, at 1024 × 1024 pixels, with alpha.
The image was visually checked: this is the smoke-only sequence, not the
neighboring fire/explosion textures. No AI-generated replacement was used.

- Original author/source: Thomas Iché / Unity Technologies, **Free VFX image sequences and flipbooks**.
  https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks
- Original page explicitly releases these image sequences under **CC0**:
  https://creativecommons.org/publicdomain/zero/1.0/
- Mirror: https://gitlab.com/MrMinimal/godot-flipbook-particles
- Mirror README explicitly lists **Flipbook textures → UnityBlog → CC0 1.0 Universal**.
  https://gitlab.com/MrMinimal/godot-flipbook-particles/-/blob/master/README.md
- Exact downloaded blob:
  https://gitlab.com/api/v4/projects/MrMinimal%2Fgodot-flipbook-particles/repository/blobs/e9c2850bc5d5f64385f16c18cf28ebee03e7c733/raw
- Original TGA SHA-256: `42199142b9319ad2db2541920da8acd220f8aa9af9a2c96c9340e1d4dc5ca043`
- Converted PNG SHA-256: `ecd2592b17777c5c5b28df41951a5de7caec65bdf8f54cd3417b6b3a0d49de4b`

Only this CC0 texture was imported. No Godot scripts, shaders, scenes, or other
AGPL repository code were copied. The webpage runtime shader was written here.
Conversion used ffmpeg TGA → PNG without resizing or baking color changes;
rock-dust tint is applied dynamically by the preview shader.

The Unity legacy ZIP endpoints returned 504 during this task, hence use of the
credited public texture mirror. No purchase or account login was required.

## Other resources checked

- Brackeys VFX Bundle: CC0 repackaged textures/flipbooks, includes Thomas Iché material.
  https://brackeysgames.itch.io/brackeys-vfx-bundle
- JangaFX free VDB animations: CC0 Building Implosion, Grenade Dust Impact, Dust Shockwave.
  https://jangafx.com/software/embergen/download/free-vdb-animations
  These are large offline volume sequences and would require rendering to a
  game-ready atlas first. They were not downloaded or integrated in this version.
