# 俄罗斯方块 · Tetris

一个零依赖、单文件的经典俄罗斯方块网页游戏，双击 `tetris.html` 即可离线游玩。

![Tetris](https://img.shields.io/badge/依赖-零-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## ✨ 特性

- 🎮 经典规则：7 种标准方块 + 7-bag 随机器，出块公平
- 👻 幽灵落点预览，提前看到方块将落在哪里
- 🧱 简易 Wall Kick，贴墙旋转不卡死
- 📦 Hold 暂存（C 键）+ 4 块 Next 预览队列
- 🔥 现代计分：连击 Combo、Back-to-Back ×1.5、T-Spin 判定（3-corner 规则），加分浮动文字
- 🖐 手感升级：锁定延迟 500ms（可重置 15 次）、DAS/ARR 按住连续移动、消行白闪动画
- 🏁 两种模式：马拉松（无限挑战）/ 竞速 40 行（计时 + 最佳纪录）
- 🔊 WebAudio 合成音效（旋转/锁定/消行/Tetris/升级/结束），M 键开关
- 💾 最高分、竞速最佳、模式与音效设置本地保存（localStorage）
- 📱 响应式布局 + 移动端触控按钮
- ⚡ 零依赖，单 HTML 文件，无需安装

## 🕹 操作

| 按键 | 功能 |
| --- | --- |
| ← / → | 左右移动（支持按住连续移动 DAS/ARR） |
| ↑ / X | 顺时针旋转 |
| Z | 逆时针旋转 |
| ↓ | 软降（+1 分/格，可按住） |
| 空格 | 硬降（+2 分/格） |
| C | 暂存 / 换回方块（每块限一次） |
| P / Esc | 暂停 |
| R | 重新开始 |
| M | 音效开关 |
| Enter / 空格 | 开始界面直接开始（沿用上次模式） |

移动端使用画面下方的触控按钮。

## 🚀 运行

```bash
# 方式一：直接打开
# 双击 tetris.html

# 方式二：本地服务
python -m http.server 8080
# 访问 http://localhost:8080
```

## 📁 结构

```
project3/
├── tetris.html  # 全部代码（HTML + CSS + JS）
└── README.md
```

## License

MIT
