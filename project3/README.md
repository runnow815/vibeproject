# 俄罗斯方块 · Tetris

一个零依赖、单文件的经典俄罗斯方块网页游戏，双击 `tetris.html` 即可离线游玩。

![Tetris](https://img.shields.io/badge/依赖-零-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## ✨ 特性

- 🎮 经典规则：7 种标准方块 + 7-bag 随机器，出块公平
- 👻 幽灵落点预览，提前看到方块将落在哪里
- 🧱 简易 Wall Kick，贴墙旋转不卡死
- 🏆 计分与等级：消行得分（100/300/500/800 × 等级），每 10 行升级加速
- 💾 最高分本地保存（localStorage）
- 📱 响应式布局 + 移动端触控按钮
- ⚡ 零依赖，单 HTML 文件，无需安装

## 🕹 操作

| 按键 | 功能 |
| --- | --- |
| ← / → | 左右移动 |
| ↑ / X | 顺时针旋转 |
| Z | 逆时针旋转 |
| ↓ | 软降（+1 分/格） |
| 空格 | 硬降（+2 分/格） |
| P / Esc | 暂停 |
| R | 重新开始 |

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
