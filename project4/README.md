# 推箱子 · Sokoban

一个零依赖、单文件的经典推箱子网页游戏，双击 `sokoban.html` 即可离线游玩。

![Sokoban](https://img.shields.io/badge/依赖-零-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## ✨ 特性

- 📦 18 个关卡（入门 → 仓储中心），难度渐进，全部经 BFS 求解器验证可解
- ⭐ 星级评价：以求解器最少步数 par 为基准（≤1.2×par 三星 / ≤1.6×par 两星）
- 🔒 顺序解锁：通关本关解锁下一关（选关弹窗内可一键"解锁全部"）
- ⚠ 死锁提示：箱子被推进非目标角落时顶部浮条提醒（Z 撤销 / R 重玩）
- ↩ 无限撤销 + 一键重玩，走错不慌
- 🏆 每关最佳步数与星级记录、通关进度本地保存（localStorage）
- 🔊 WebAudio 实时合成音效（移动/推动/blocked/通关），可一键静音
- 😀 朝向感知的小表情角色，箱子推上目标点会亮起绿灯
- 📱 响应式布局，移动端支持棋盘滑动 + 虚拟方向键
- ⚡ 零依赖，单 HTML 文件，无需安装

## 🛠 关卡验证

```bash
node tools/verify-levels.js
```

从 `sokoban.html` 提取 `LEVELS`，校验箱子数 = 目标点数，并用 BFS 求出每关最少步数（即星级评价的 par 基准）。新增关卡后运行即可验证。

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
├── sokoban.html            # 全部代码（HTML + CSS + JS）
├── tools/
│   └── verify-levels.js    # 关卡求解验证器（Node）
└── README.md
```

## License

MIT
