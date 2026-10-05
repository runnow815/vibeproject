# 贪吃蛇 · Snake

一个零依赖、单文件的经典贪吃蛇网页游戏，双击 `snake.html` 即可离线游玩。

![Snake](https://img.shields.io/badge/依赖-零-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## ✨ 特性

- 🐍 经典规则：撞墙 / 撞自己即结束，吃食物 +1 分、长度 +1
- ✨ 特殊果实：金色限时果实 +5 分、长度 +2，倒计时环走完即消失（吃完 3 个食物后概率出现）
- 🧱 穿墙模式开关：撞墙 / 从另一侧环绕，随玩随切（localStorage 记住偏好）
- ⚡ 速度渐进：每 5 分提速一级（140ms/步 → 最快 70ms/步）
- 🎨 手感细节：蛇身头亮尾暗渐变、眼睛跟随朝向、食物脉动、方向队列防 180° 回头
- 🔊 WebAudio 合成音效（进食/特殊果实/死亡），可开关
- 💾 最高分与设置本地保存（localStorage）
- 📱 响应式布局，移动端支持棋盘滑动 + 虚拟方向键
- ⚡ 零依赖，单 HTML 文件，无需安装

## 🕹 操作

| 按键 | 功能 |
| --- | --- |
| ↑ ↓ ← → / WASD | 转向（方向队列防误触回头） |
| P / Esc | 暂停 |
| R | 重新开始 |
| 空格 / Enter | 开始 / 继续 |

移动端：棋盘上滑动转向，或使用下方虚拟方向键。

## 🛠 逻辑验证

核心逻辑（`snakeCreateGame` / `snakeStep` / `snakeTurn`）独立在第一个 `<script>` 块并通过
`module.exports` 暴露，可在 Node 中验证：吃食物计分与生长、撞墙 / 穿墙 / 自撞判定、
180° 回头忽略、特殊果实加分与超时、500 步随机模拟的得分/长度/占格不变量。

## 📁 结构

```
project6/
├── snake.html  # 全部代码（HTML + CSS + JS，逻辑与 UI 分两个 script 块）
└── README.md
```

## License

MIT
