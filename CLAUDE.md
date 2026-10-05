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
│   ├── tools/
│   │   └── verify-levels.js ← 关卡求解验证器（Node）
│   └── README.md      ← 项目说明
├── project5/          ← 数独 · Sudoku
│   ├── sudoku.html    ← 经典数独（DOM 网格渲染，单文件，生成器保证唯一解）
│   └── README.md      ← 项目说明
├── project6/          ← 贪吃蛇 · Snake
│   ├── snake.html     ← 经典贪吃蛇（Canvas，单文件）
│   └── README.md      ← 项目说明
├── project7/          ← 飞机大战 · Sky Raid
│   ├── plane.html     ← 纵版飞行射击（Canvas，单文件）
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
- 红队（玩家）vs 蓝队（AI），可调人数（3-7），三档 AI 难度（困难含视线检测）
- 三兵种系统（突击/重装/狙击）+ 血量系统，可切回经典模式
- 点击选中队员 → 鼠标瞄准 → 空格蓄力 → 发射
- 子弹穿透敌人造成伤害，队员移动到落点
- 6 张地图，地图缩放（滚轮）、平移（拖拽）
- WebAudio 合成音效
- 完整 UI：主菜单、暂停菜单、设置、统计数据、存档
- localStorage 持久化统计/设置/存档

### project2 — 五子棋 · 古典棋韵

古典中国风五子棋游戏：
- 15×15 标准棋盘，Canvas 绘制
- 双人对弈 / 人机对战（三档棋力 AI，棋型评分 + 两层搜索）
- 黑棋禁手规则开关（简化连珠：长连/双四/双活三）
- 落子回弹动画、WebAudio 音效
- 计时器（可不限时）、悔棋、回合记录、胜负统计

### project3 — 俄罗斯方块 · Tetris

现代规则俄罗斯方块：
- 10×20 棋盘，7 种标准方块 + 7-bag 随机器（出块公平）
- Hold 暂存（C）+ 4 块 Next 预览队列、幽灵落点预览、简易 Wall Kick
- 现代计分：连击 Combo、Back-to-Back ×1.5、T-Spin（3-corner），加分浮动文字
- 手感：锁定延迟（可重置 15 次）、DAS/ARR 连续移动、消行闪烁动画
- 马拉松 / 竞速 40 行两种模式，竞速计时与最佳纪录
- WebAudio 合成音效（M 键开关）
- 键盘操作 + 移动端触控按钮，暂停/重开
- localStorage 持久化最高分/竞速最佳/设置

### project4 — 推箱子 · Sokoban

经典规则推箱子解谜游戏：
- 18 个关卡（入门 → 仓储中心），全部经 BFS 求解器验证可解（`node tools/verify-levels.js`）
- 星级评价（以求解器 par 为基准）、顺序解锁关卡、死锁角落提示
- 撤销/重玩、每关最佳步数与通关进度持久化（localStorage）
- WebAudio 合成音效，移动端滑动 + 虚拟方向键
- DOM 网格渲染（非 Canvas），CSS 过渡动画

### project5 — 数独 · Sudoku

经典规则数独游戏：
- 谜题实时生成：随机回溯终盘 + 挖洞出题，逐步校验保证唯一解（三档难度 40/31/26 提示）
- 笔记模式（3×3 铅笔备注，填数自动清理同行/列/宫笔记）、提示 ×3、撤销
- 行列宫冲突标红、选中/同数字/关联区高亮、数字面板显示剩余可填数
- 暂停（棋盘模糊）、计时、各难度最佳时间持久化（localStorage）
- WebAudio 合成音效，响应式布局

### project6 — 贪吃蛇 · Snake

经典规则贪吃蛇游戏：
- 吃食物 +1 分长一格，金色特殊果实 +5 分限时出现（倒计时环）
- 撞墙 / 撞自己结束，可选穿墙模式（设置持久化）
- 速度每 5 分提一级（140ms → 70ms），方向队列防 180° 回头
- WebAudio 合成音效，最高分持久化
- 键盘 + 移动端滑动/虚拟方向键，Canvas 渲染

### project7 — 飞机大战 · Sky Raid

纵版飞行射击游戏：
- 8 个设计关卡 + 无尽模式：每关独立小怪组合与击坠配额，配额达成后 Boss 降临
- Boss 三阶段战斗（瞄准扇形 → 环形交替 → 双螺旋暴走），顶部血条与关底奖励
- 7 种小怪（直落/蛇形/重装/俯冲/悬停炮艇/分裂/精英），全部会开火
- 道具：火力升级（三档）、炸弹、护盾、生命回复；J 键炸弹清屏
- 生命 ×3（上限 5）+ 无敌闪烁，爆炸粒子与浮动得分，关卡横幅
- WebAudio 合成音效，最高分持久化
- 鼠标/触摸/键盘三操控，Canvas 渲染

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
# 打开数独
start project5/sudoku.html
# 打开贪吃蛇
start project6/snake.html
# 打开飞机大战
start project7/plane.html
```

## 通用代码模式

- **单文件应用**：所有代码在一个 HTML 中（CSS + HTML + JS）
- **IIFE 封装**：`(function() { 'use strict'; ... })()` 零全局变量
- **集中状态**：`const state = { ... }` 管理所有可变状态
- **Canvas 渲染**：分层绘制管线，全量重绘
- **事件驱动**：用户事件 → 状态变更 → 重绘
- **坐标转换**：`getBoundingClientRect` + 缩放比适配 HiDPI
- **响应式画布**：画布尺寸用 `min(固有宽, 视口宽, 视口高 × 宽高比)` 三重约束（dvh 优先、vh 回退），保证手机竖屏/横屏与桌面矮窗口都完整可见；触屏设备提供虚拟按钮（D-pad/炸弹/暂停），坐标换算一律走 rect 缩放比
