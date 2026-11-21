# Phase 1 Style Candidates

本目录是 **Style 缺失素材的产品确认包**，不是运行时资源目录。

## 使用边界

- 所有图片均由 `generate_candidates.py` 使用 Pillow 程序绘制，未使用外部图片素材。
- 候选稿 **未接线运行时**；本阶段不修改业务代码、不替换生产资源。
- 已有真实 `cleric`、`axeEnhanceMaster1`、`mageKitty1` 素材优先，任何后续任务都不得覆盖它们。
- `yixiao` 是中性纪念抽象候选，尚 **待产品定义**；确认前不得赋予具体人物、事件或纪念对象。
- GIF 是评审格式。动画确认后应转换为 **带 alpha 的 VP9 WebM**，再另行接入目标逻辑路径。

## 目录

- `chat-bubbles/runtime/`：7 张 640×320 RGBA 气泡。
- `chat-bubbles/preview/`：7 张 800×320 RGBA 商店/评审预览。
- `profile-backgrounds/`：5 张 1200×720 背景。
- `battle/avatars/`：4 张 550×550 透明职业头像。
- `battle/scenes/`：4 张 1152×864 职业场景。
- `avatar-borders/static/`：15 张 320×320 透明静态框。
- `avatar-borders/animated/`：4 张 320×320 透明动画 GIF。
- `animated-avatars/`：3 张 550×550 与 1 张 512×512 透明动画 GIF。
- `contact-sheets/`：5 张联系表；动画表仅展示首帧。
- `manifest.json` / `manifest.md`：key、规格、中文名称、描述和目标逻辑路径。
- `validate.py` / `validation-report.json`：可重复执行的完整性验证与结果。

## 评审建议

1. 先看五张联系表确认整体区分度与配色。
2. 单独打开 GIF 检查循环节奏；联系表只代表首帧。
3. 对照 `manifest.md` 确认中文名称、description 和目标逻辑路径。
4. 对 `yixiao` 明确产品定义后再定稿。
5. 通过后冻结 key，另开任务完成 alpha VP9 WebM 转码与运行时接线。

## 复验

使用本会话 `load_workspace_dependencies` 返回的 Python（含 Pillow）运行：

```powershell
& <bundled-python> .\phase1-style-candidates\validate.py
```

通过标准：解码、尺寸、格式、alpha 声明、GIF 帧数，以及头像框中央直径 58% 圆形净空全部通过。
