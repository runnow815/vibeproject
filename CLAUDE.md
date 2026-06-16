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

## 常用命令

```bash
# 打开对战游戏
start project1/contactv1.html
# 打开五子棋
start project2/gomoku.html
```

## 通用代码模式

- **单文件应用**：所有代码在一个 HTML 中（CSS + HTML + JS）
- **IIFE 封装**：`(function() { 'use strict'; ... })()` 零全局变量
- **集中状态**：`const state = { ... }` 管理所有可变状态
- **Canvas 渲染**：分层绘制管线，全量重绘
- **事件驱动**：用户事件 → 状态变更 → 重绘
- **坐标转换**：`getBoundingClientRect` + 缩放比适配 HiDPI
