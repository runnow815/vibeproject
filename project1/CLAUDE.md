# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

**五子棋 · 古典棋韵** — 基于纯 HTML/CSS/JavaScript 的古典中国风五子棋游戏。

- 文件：`gomoku.html`（单页应用，零外部依赖）
- 运行方式：直接在浏览器打开 `gomoku.html` 即可
- 对弈模式：双人轮流点击（人人对战）

## 功能特性

| 功能 | 说明 |
|------|------|
| 15×15 标准棋盘 | Canvas 绘制，木纹背景，朱砂红星位 |
| 胜负判定 | 横、竖、斜四方向检测五子连珠 |
| 悔棋 | 撤销上一步落子，可连续悔棋 |
| 计时器 | 每方 15 分钟倒计时，超时判负 |
| 回合记录 | 右侧历史列表，点击可标记对应位置 |
| 胜负统计 | localStorage 持久化，记录黑胜/白胜/平局 |
| 古典中国风 | 宣纸色背景、木纹棋盘、毛笔书法字体、朱砂红点缀 |

## 代码架构

整个应用在一个 `gomoku.html` 文件中，分为三部分：

- **CSS (~200 行)** — 古典中国风样式，含响应式断点
- **JavaScript IIFE (~350 行)** — 游戏逻辑，包括：
  - 棋盘绘制（Canvas API）
  - 棋子渲染（径向渐变立体效果）
  - 胜利检测（四方向连珠）
  - 计时器系统（每秒 tick）
  - 悔棋 / 新局 / 回合记录交互
  - localStorage 统计持久化
- **HTML (~30 行)** — 结构骨架

## 关键常量

- `BOARD_SIZE = 15` — 棋盘大小
- `CELL_SIZE = 36` — 格子间距（px）
- `TOTAL_TIME = 900` — 每方总时间（秒）
- 星位：传统围棋九星位

## 开发指南

- 直接编辑 `gomoku.html`，刷新浏览器即可看到效果
- 无构建步骤、无需安装依赖
- 所有代码均为原生 JS，无框架依赖
- Canvas 坐标转换使用 `getBoundingClientRect` + 缩放比
