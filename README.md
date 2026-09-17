# 火星探索

花海与个人档案预览：[花海来信](http://localhost:5176/tools/flower-archive-preview.html)。
姓名、简介、创作方向、作品与联系方式统一配置于 `src/profile.js`。
花海镜头依次显示来信、创作方向、姓名、作品与相遇邀请；结束后按 `I` 查看档案。

Windows 迁移：先读 [开发交接与启动说明](docs/WINDOWS-HANDOFF.md)，安装 Node.js 后双击
`start-windows.cmd`。开发对话及聊天附件保留在本地，不包含在公开仓库。

A separate Mars reinterpretation of the playable rover-delivery slice built on
[`winchxyz/moon-rover`](https://github.com/winchxyz/moon-rover).

The current vertical slice restores the original investigation-and-transmission
arc around the newer rover-only delivery:

1. Leave the Mars descent stage and investigate the silent Ares VI habitat.
2. Recover the Beacon-9 local store and progressively unlock its field codex.
3. Scan the vitrified black-rock field with a cyan Odradek pulse.
4. Witness the impossible silver flower tide and follow its open corridor.
5. Deliver the sealed communications unit to the isolated relay.
6. Return to the surface port and queue the recovered record for Earth uplink.

Everything runs as native ES modules on WebGL2. There is no build step and no
package installation.

## 获取完整文件

大型模型与演示录像通过 Git LFS 保存。请先安装 [Git LFS](https://git-lfs.com/)，再执行：

```bash
git lfs install
git clone https://github.com/powerycy/huoxing-tansuo.git
cd huoxing-tansuo
git lfs pull
```

仓库名称为「火星探索」；游戏内沿用「死亡搁浅 荒野来信」标题。

## Run

```bash
npm start
```

Open <http://localhost:5176>.

## 画质与演示

Mac 建议选择「高 · Mac」（High），RTX 4070 Super 演示可选择「极致 · 4070S」
（Ultra）。两档分别使用 240 万 / 420 万像素预算；这是内部渲染上限，
不代表固定输出分辨率或帧率。设置面板会显示实际渲染尺寸。

启动时依次采用有效的 `?quality=` 参数、已保存档位、设备默认值；没有前两项时，
桌面 Mac 默认 High。手动切换会保存选择，并移除当前 URL 的 `quality` 参数，
使后续刷新继续采用新的选择。切换同步更新地面、阴影、模型贴图过滤以及草、
VAT 玫瑰、远景花、花瓣和萤火虫的显示预算，保留任务与花海演出进度。
重建后期管线时也保留当前曝光和演出黑边，暂停切档不会恢复成默认画面状态。

Mac 的 High 和 Ultra 都使用稳定 8-bit LDR + FXAA，不开启 MSAA 或后期 Bloom。
支持 HDR 的非 Apple 设备可在 High/Ultra 使用 HDR、最高 4× MSAA + FXAA，
Bloom 还受用户设置控制。两档已经在 Mac 浏览器检查场景和暂停时切换；
另已确认 High 保存后刷新仍选中，运行中 Ultra → High 保留任务时间、电量与导航。
4070 Super 尚未实测，2560 × 1440 仅作为目标机器上的演示测试起点。

[High 入口](http://localhost:5176/?quality=high) ·
[Ultra 入口](http://localhost:5176/?quality=ultra) ·
[参数、预览链接与验证边界](docs/quality-demo-v1.md)

## Controls

| Key | Action |
|---|---|
| `W` `A` `S` `D` | Drive |
| `Space` | Rover brake |
| Hold `Shift` + `W` / `S` | Strong recovery boost: hill-climbing assist, torque/grip and +38% speed ceiling |
| `E` | Interact, dock cargo and transmit |
| `G` | Cyan terrain scan |
| `L` | Rover lamps |
| Tap `T` while stopped inside a charging ring | Toggle charging; driving away disconnects (home, powered base, isolated relay) |
| `C` | Cycle chase, orbit and mast cameras |
| `P` | Photo mode |
| `I` | Personal archive terminal |
| `K` | Save screenshot |
| `H` | Toggle HUD |
| `Esc` | Systems/pause |

During the flower-tide camera sequence, Space returns the driving camera early;
Escape pauses. The roughly 75-second sequence reveals the slowly rising moon, growing
grass with softly glowing fireflies, the first rose, and the widening flower field. Skipping the camera does
not skip growth. The rover is held safely and battery consumption is suspended
while the camera is locked; manual charging resumes after camera control returns.

Use `?event-preview=1&time-preview=night` to rehearse the sequence without driving
to the habitat. Preview saves are isolated from the normal mission save.

The playable entry remains rover-only. Sam and its models are preserved in the
independent `character-preview.html`; no character assets load in the game.

Lighting and camera changes, test commands, and limitations are recorded in
[the scene update notes](docs/scene-lighting-cinematic-v1.md).

## Main additions

- Rover-only delivery with automated cargo docking and persistent state
- Three-stage Ares VI → Lone Relay → surface-port mission with an Earth-uplink ending
- Impact-sensitive cargo integrity and progressive Beacon-9 codex recovery
- Iron-oxide graded scanned PBR soil with dynamic tracks and excavation
- Four photogrammetry rock variants, regraded as dust-capped Martian basalt
- Clustered scanned-surface black-glass sheets, shards and monoliths with scan emissive response
- Cyan traversal markers and scan wavefront
- Dust-darkened surface structures and an isolated relay with orange-white activation lights
- Ares VI hero habitat with a subordinate utility shelter, ruined solar farm and communications hardware
- Resumable silver flower-tide event with camera-centred PCG grass, 15/5/2-segment distance LOD, terrain/rover interaction, original 142-frame high/low rose VATs, lightweight distant coverage, route guidance and ascending low-gravity petals
- Dedicated `localStorage` autosave namespace
- Rust-red terrain, desaturated violet dusk and a 30-second mission-time sunset into star-lit Martian night
- Mars gravity (3.71 m/s²), retuned suspension and drag-softened tyre dust
- High/Ultra: capability-dependent HDR and up to 4× MSAA + FXAA on non-Apple devices; stable LDR + FXAA on Mac
- Default-off experimental world-triangle contact rays for the nearby habitat and rover body. Toggle in system settings; this uses shader BVH traversal, not RTX hardware or ray-traced reflections. See [scope and checks](docs/experimental-contact-rays.md).

The large local `Death Stranding_resources` archive is intentionally not used.
It is not web-sized and its redistribution rights are unclear.

## Structure

- `src/game/delivery.js` — rover docking, cargo, scan, facility and save state
- `src/world/glass-rocks.js` — vitrified field
- `src/world/haze.js` — suspended iron-dust mist and rust horizon veil
- `src/main.js` — integration with the original rover simulation

## Credits and licence

The original moon-rover code is MIT licensed; its existing `LICENSE` is kept in
this project. Third-party environment and vehicle assets are listed in
[ASSET_CREDITS.md](ASSET_CREDITS.md).
