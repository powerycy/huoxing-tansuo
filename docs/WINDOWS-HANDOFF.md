# Windows 开发交接｜死亡搁浅 荒野来信

打包日期：2026-09-05。当前项目目录：`mars-delivery-v1`。

## 一、先启动

1. 完整解压 ZIP，例如放到 `D:\Projects\mars-delivery-v1`，不要在压缩包内运行。
2. 安装 Node.js LTS。游戏的 `package.json` 声明 Node >=18；运行开发检查建议使用 >=22。
3. 双击 `start-windows.cmd`。或者在项目文件夹打开终端，运行 `node server.js 5176` / `npm start`。
4. 打开 `http://127.0.0.1:5176/`。保持命令窗口开启，按 Ctrl+C 停止。

没有 npm 依赖安装，也没有构建步骤。Three.js、本地模型和贴图已经包含。
不要直接双击 `index.html`：本地 ES 模块和模型加载需要 HTTP 服务。
若 PowerShell 提示 npm.ps1 被执行策略阻止，直接运行 `node server.js 5176`，无需修改系统策略。
端口被占用时可改用 `node server.js 5177`，随后使用对应网址；端口变化也会改变存档来源。
当前是开发静态服务器，不要直接暴露到公网。

## 二、4070 Super 演示

- 系统设置选「极致 · 4070S」。Mac 日常开发选「高 · Mac」。原有四档全部保留。
- 可用 `http://127.0.0.1:5176/?quality=ultra` 指定启动档位；之后手动设置会保存。
- 先测试默认关闭实验光追的稳定版本，再打开「实验光追 · 接触遮蔽」进行对比。
- 实验通道是真实三角形 BVH 求交的近景遮蔽，不是 RTX RT Core / 全场景路径追踪 / 光追反射。
- 它随时可关闭，关闭释放新增资源；不改任务与玩法。Mac 不强开 HDR 或 MSAA。
- 4070S 的实际帧率尚未验证。1440p 是演示测试起点，不是 60 FPS 承诺。
- 如果未使用独显，请检查浏览器硬件加速和 Windows 对浏览器的显卡选择；不要为了开功能强行启用不明实验标志。

## 三、当前可玩的流程

主菜单 → 开始运输 → 从下降平台出发 → 驾驶到阿瑞斯六号基地 → 恢复基地记录与灯光 →
花海演出（巨月缓升、草生长与萤火虫、首花开放、成片花海）→ 顺花海引导前往孤立中继站 →
交付通信单元 → 锁镜头观看中塔蓝光升空、油画星空和地震地裂 → 镜头归位后超载撤离 →
返回母港 / 地表平台，停车按住 E 向地球传输记录并结束灾变。

最新中塔事件已从二维画卷换为星空地裂，具体时间、效果边界和预览入口见 [最新事件说明](STARFALL-ESCAPE.md)。

当前正式游戏保持「只能在车上」，没有恢复 Sam 或人物上下车玩法。
Sam 模型和行走实验仍保留在 `character-preview.html` 等独立页面；不自动加入正式游戏。

常用按键：WASD 驾驶，Space 制动，Shift 配合 W/S 增力脱困，E 交互，G 扫描，
L 车灯，停车按一下 T 开始充电（母港、恢复供电后的基地、孤立中继站），再按 T 或驶离停止；
C 切换车辆镜头，Esc 暂停/设置。花海镜头期间 Space 提前交还驾驶镜头，但不跳过生长。

## 四、测试入口

- 正式游戏：`http://127.0.0.1:5176/`
- 花海夜间演出：`http://127.0.0.1:5176/?event-preview=1&time-preview=night`
- 中塔星空与地裂：`http://127.0.0.1:5176/?escape-preview=1&time-preview=night`
- 基地恢复灯光：`http://127.0.0.1:5176/?station-preview=powered&time-preview=night`
- 独立接触光追诊断：`http://127.0.0.1:5176/ray-tracing-check.html`
- 人物实验预览：`http://127.0.0.1:5176/character-preview.html`

预览参数通常需要从菜单进入后才开始。预览存档与正式存档隔离。

## 五、存档不会随 ZIP 自动迁移

游戏没有远程数据库，进度和设置保存在浏览器 localStorage。
Windows 是新浏览器环境；即使使用同一个网址，也不会自动带来 Mac 存档。
`localhost`、`127.0.0.1`、不同端口之间的存档也相互独立。

如需继续 Mac 正式进度，可在原浏览器对应来源的开发者工具 Storage / Application → Local Storage 中，
手动复制以下两项的完整值，随后在 Windows 同源页面中创建相同键值并刷新：

- `red-regolith.mars-relay.v1`：正式任务存档。
- `red-regolith.mars-relay.v1.set`：正式画质及操作设置。

预览分别是 `red-regolith.mars-relay.v1.preview` 和 `red-regolith.mars-relay.v1.preview.set`，
不要误覆盖正式存档。覆盖 Windows 现有进度前先另存原值。本次没有导出或更改你的浏览器存档。

## 六、交接重点与不能误改的决定

- 名称「死亡搁浅 荒野来信」，个人名称「好奇的小逸」；中文主界面。
- 当前是从月球版本复制演变出的火星项目，未把旧月球项目合并进来。
- 正式游戏车行优先，人物后续单独验收，不恢复旧上下车/第一人称人物系统。
- 开场日落按约 0–30 秒进入夜间；巨月与花海是叙事事件。不要简单恢复早期随机天体循环。
- 草先长、花后开；萤火虫随草出现。演出约 75 秒，镜头慢节奏，但入场不能长时间无事发生。
- 不重新加入全屏强制任务弹窗、随机闪黑、强闪烁、默认满屏噪点。
- 车灯由玩家控制；电量、补电、近远光与增力脱困遵循现有实现，不因画质修改重置。
- 「去掉个人档案」在录制开头 UI 时的要求，已体现在无个人档案版视频里；正式游戏个人档案入口仍保留。
- 实验光追默认关闭。普通画质、花海演出、镜头、游戏时钟不能因开关而重置。

## 七、文件与外部依赖边界

源码：`src/`；运行资产：`assets/`；本地引擎：`vendor/`；检查和离线工具：`tools/`；录屏：`output/recordings/`。

推荐先读：

- 开发对话及聊天附件仅保留在原始本地交接包中，不随公开仓库发布。
- [画质档位与演示说明](quality-demo-v1.md)
- [最新接触光追的范围和限制](experimental-contact-rays.md)
- [灯光、镜头、事件说明](scene-lighting-cinematic-v1.md)
- 项目根目录 `README.md` 与 `ASSET_CREDITS.md`。

包内包含当前项目完整文件和已有独立人物预览，不包含项目外部的 `SAM_PORTER_SUIT.blend`、
巨大 `Death Stranding_resources` 原始素材目录、`false-earth` 源工程或旧 `moon-rover`/WebGPU 样板工程。
当前正式游戏无需这些外部源文件。若以后重新导出 Sam，需另迁原始素材、安装 Blender，并调整
`prepare_sam_character.py`、`prepare_ds_weighted_loadout.py`、`retarget_sam_fk.py`、`inspect_sam_walk.py`
等离线脚本中的 Mac 绝对路径。Python 录制脚本也不是游戏启动依赖。

历史对话中的外部绝对路径、工具内生成但未落地的图片链接可能无法在 Windows 打开。
能够找到的本地对话图片已复制到 `docs/conversation-attachments/`；缺失列表在对话文件末尾。
对话包含个人信息和开发历史，不建议直接公开部署整个文档目录。
资产的使用和分发仍按 `ASSET_CREDITS.md` 与原许可处理，本次打包不改变许可。

## 八、开发验证

在项目目录执行：

```powershell
node tools/check-quality-profiles.mjs
node tools/check-local-raytracing.mjs
node tools/check-terrain-pbr.mjs
node tools/check-model-materials.mjs
node tools/check-vegetation-quality.mjs
node tools/check-lighting-upgrade.mjs
node tools/check-scene-integration.mjs
node tools/check-flower-cinematic.mjs
node tools/check-fireflies.mjs
node tools/check-rover-boost.mjs
node tools/check-manual-charging.mjs
node tools/check-starfall-event.mjs
node tools/check-dimensional-escape.mjs
```

打包前上述检查已在 Mac 通过；CPU 检查不能证明 Windows GPU 帧率或视觉效果。
Windows 上重点回归：首次加载 → 正式驾驶 → 开关灯 → 基地恢复 → 花海 → 切换画质 → 光追开/关 → 保存/重载。

## 九、给下一次开发对话的提示

> 这是《死亡搁浅 荒野来信》的现有 WebGL2 / Three.js r160 项目。请先读 docs/WINDOWS-HANDOFF.md、
> README.md、docs/experimental-contact-rays.md；需要历史决定时再检索 docs/CONVERSATION.md。
> 当前目标在 Windows + RTX 4070 Super 上继续开发和演示，不要擅自重建项目、迁移引擎、恢复人物、
> 改任务时序或默认开启实验光追。先实测现有版本，再提出有依据的画质/性能改进。
