# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库概览

这是一个收集 **vibe coding** 小项目的单仓库（monorepo）。每个项目均为独立的纯前端 HTML 页面，零外部依赖、无构建步骤。

### 目录结构

```
/
├── project1/          ← 红蓝对决 · 回合制战术对战
│   ├── contactv1.html ← 战术对战游戏（Canvas，单文件）
│   └── README.md      ← 项目说明
├── project2/          ← 五子棋 · 古典棋韵
│   ├── gomoku.html    ← 古典中国风五子棋
│   └── README.md      ← 项目说明
├── project3/          ← 俄罗斯方块 · Tetris
│   ├── tetris.html    ← 经典俄罗斯方块（Canvas，单文件）
│   └── README.md      ← 项目说明
├── project4/          ← 推箱子 · Sokoban
│   ├── sokoban.html   ← 经典推箱子（DOM 网格渲染，单文件）
│   └── README.md      ← 项目说明
├── CLAUDE.md          ← 本文件
└── .gitignore
```

## 开发方式

- **编辑**：直接编辑对应项目的 HTML 文件，保存后刷新浏览器即可
- **运行**：在浏览器中直接打开 HTML 文件（无需服务器、无需构建）
- **测试**：全部为手动测试
- **依赖**：零外部依赖

## 项目简介

### project1 — 红蓝对决（回合制战术对战）

基于 Canvas 的回合制对战游戏：
- 红队（玩家）vs 蓝队（AI），可调人数（3-7）
- 点击选中队员 → 鼠标瞄准 → 空格蓄力 → 发射
- 子弹穿透敌人，队员移动到落点
- 地图缩放（滚轮）、平移（拖拽）
- 完整 UI：主菜单、暂停菜单、设置、统计数据、存档
- localStorage 持久化统计/设置/存档

### project2 — 五子棋 · 古典棋韵

古典中国风五子棋游戏：
- 15×15 标准棋盘，Canvas 绘制
- 双人轮流点击（人人对战）
- 计时器、悔棋、回合记录、胜负统计

### project3 — 俄罗斯方块 · Tetris

经典规则俄罗斯方块：
- 10×20 棋盘，7 种标准方块 + 7-bag 随机器（出块公平）
- 幽灵落点预览、简易 Wall Kick 贴墙旋转
- 消行计分（100/300/500/800 × 等级），每 10 行升级加速
- 键盘操作 + 移动端触控按钮，暂停/重开
- localStorage 持久化最高分

### project4 — 推箱子 · Sokoban

经典规则推箱子解谜游戏：
- 10 个手工关卡（入门 → 环形仓库），全部经 BFS 求解器验证可解
- 撤销/重玩、每关最佳步数与通关进度持久化（localStorage）
- WebAudio 合成音效，移动端滑动 + 虚拟方向键
- DOM 网格渲染（非 Canvas），CSS 过渡动画

## 常用命令

```bash
# 打开对战游戏
start project1/contactv1.html
# 打开五子棋
start project2/gomoku.html
# 打开俄罗斯方块
start project3/tetris.html
# 打开推箱子
start project4/sokoban.html
```

## 通用代码模式

- **单文件应用**：所有代码在一个 HTML 中（CSS + HTML + JS）
- **IIFE 封装**：`(function() { 'use strict'; ... })()` 零全局变量
- **集中状态**：`const state = { ... }` 管理所有可变状态
- **Canvas 渲染**：分层绘制管线，全量重绘
- **事件驱动**：用户事件 → 状态变更 → 重绘
- **坐标转换**：`getBoundingClientRect` + 缩放比适配 HiDPI
