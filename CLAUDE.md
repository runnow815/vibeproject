# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库概览

这是一个收集 **vibe coding** 小项目的单仓库（monorepo）。每个项目均为独立的纯前端 HTML 页面，零外部依赖、无构建步骤。

### 目录结构

```
/
├── project1/          ← 五子棋 v1（含 CLAUDE.md）
│   ├── gomoku.html    ← 古典中国风五子棋（单文件应用）
│   └── CLAUDE.md      ← 该项目的详细文档
├── project2/          ← 五子棋 v2（迭代版本）
│   ├── gomoku.html    ← 功能相同的五子棋游戏
│   └── README.md      ← 项目说明
└── CLAUDE.md          ← 本文件
```

两个项目均为 **五子棋 · 古典棋韵** — 基于纯 HTML/CSS/JavaScript 的古典中国风五子棋游戏，代码几乎一致但可能各有迭代。

## 开发方式

- **编辑**：直接编辑对应项目的 `gomoku.html`，保存后刷新浏览器即可看到效果
- **运行**：在浏览器中直接打开对应的 HTML 文件（无需服务器、无需构建）
- **测试**：无测试框架，全部为手动测试
- **依赖**：零外部依赖

## 功能特性（两个项目通用）

| 功能 | 说明 |
|------|------|
| 15×15 标准棋盘 | Canvas 绘制，木纹背景，朱砂红星位 |
| 胜负判定 | 横、竖、斜四方向检测五子连珠 |
| 悔棋 | 撤销上一步落子，可连续悔棋 |
| 计时器 | 每方 15 分钟倒计时，超时判负 |
| 回合记录 | 右侧历史列表，点击可标记对应位置 |
| 胜负统计 | localStorage 持久化（key: `gomoku_stats_chinese`） |
| 古典中国风 | 宣纸色背景、木纹棋盘、毛笔书法字体、朱砂红点缀 |

## 代码架构（共通）

每个 `gomoku.html` 均为单一 HTML 文件，结构如下：

- **CSS (~200 行)** — 古典中国风样式，含响应式断点（820px）
- **JavaScript IIFE (~450 行)** — 自执行函数，无全局变量泄漏
  - 核心状态对象 `state` 集中管理
  - `draw()` 全量 Canvas 重绘管线
  - `checkWin()` 四方向连珠检测
  - `setInterval(1000)` 倒计时系统
  - `localStorage` 持久化统计
- **HTML (~30 行)** — 结构骨架

## 常用命令

```bash
# 直接在浏览器中打开（Windows）
start project1/gomoku.html
start project2/gomoku.html
```

## 注意事项

- Canvas 坐标转换使用 `getBoundingClientRect` + 缩放比，适配 HiDPI 屏幕
- localStorage key 为 `gomoku_stats_chinese`，可手动清除重置统计
- 两个项目使用相同的 localStorage key，共享胜负统计
