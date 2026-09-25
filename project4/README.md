# 推箱子 · Sokoban

一个零依赖、单文件的经典推箱子网页游戏，双击 `sokoban.html` 即可离线游玩。

![Sokoban](https://img.shields.io/badge/依赖-零-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## ✨ 特性

- 📦 10 个手工设计关卡（入门 → 环形仓库），难度渐进，全部经 BFS 求解器验证可解
- ↩ 无限撤销 + 一键重玩，走错不慌
- 🏆 每关最佳步数记录与通关进度本地保存（localStorage）
- 🔊 WebAudio 实时合成音效（移动/推动/blocked/通关），可一键静音
- 😀 朝向感知的小表情角色，箱子推上目标点会亮起绿灯
- 📱 响应式布局，移动端支持棋盘滑动 + 虚拟方向键
- ⚡ 零依赖，单 HTML 文件，无需安装

## 🕹 操作

| 按键 | 功能 |
| --- | --- |
| ← / → / ↑ / ↓ 或 WASD | 移动 / 推箱 |
| Z / 退格 | 撤销一步 |
| R | 重玩本关 |
| Enter | 通关后进入下一关 |
| Esc | 关闭弹窗 |

移动端：在棋盘上滑动即可移动，或使用屏幕下方的虚拟方向键。

## 🚀 运行

```bash
# 方式一：直接打开
# 双击 sokoban.html

# 方式二：本地服务
python -m http.server 8080
# 访问 http://localhost:8080
```

## 📁 结构

```
project4/
├── sokoban.html  # 全部代码（HTML + CSS + JS）
└── README.md
```

## License

MIT
