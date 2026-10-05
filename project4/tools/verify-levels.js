#!/usr/bin/env node
/**
 * 关卡求解验证器 —— 从 sokoban.html 提取 LEVELS，用 BFS 求最少步数。
 *
 * 用法：node tools/verify-levels.js
 * 输出：每关的可解性与最优步数（par），全部通过时以 JSON 打印 par 表，
 *       可直接回填到 sokoban.html 的关卡数据中。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "sokoban.html"), "utf8");
const firstScript = html.match(/<script>([\s\S]*?)<\/script>/);
if (!firstScript) {
  console.error("未能在 sokoban.html 中找到关卡脚本");
  process.exit(1);
}
const LEVELS = new Function(firstScript[1] + "\nreturn LEVELS;")();

/* ---------- 关卡解析 ---------- */
function parseLevel(lv) {
  const rows = lv.map.trim().split("\n").map((r) => r.replace(/\r$/, ""));
  const rowsN = rows.length;
  const colsN = Math.max(...rows.map((r) => r.length));
  const walls = new Set();
  const goals = new Set();
  const boxes = new Set();
  let player = -1;

  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      const k = y * colsN + x;
      if (c === "#") walls.add(k);
      if (c === "." || c === "*" || c === "+") goals.add(k);
      if (c === "$" || c === "*") boxes.add(k);
      if (c === "@" || c === "+") player = k;
    }
  });
  return { walls, goals, boxes, player, cols: colsN, rows: rowsN };
}

/* ---------- BFS 求最少玩家步数 ---------- */
function solve(lv) {
  const { walls, goals, boxes: boxStart, player: pStart, cols, rows } = parseLevel(lv);
  if (boxStart.size !== goals.size) {
    return { solvable: false, reason: `箱子数 ${boxStart.size} ≠ 目标点数 ${goals.size}` };
  }

  const key = (p, boxes) => p + "|" + [...boxes].sort((a, b) => a - b).join(",");
  const startBoxes = [...boxStart].sort((a, b) => a - b);
  const start = { p: pStart, boxes: startBoxes };
  const seen = new Set([key(pStart, startBoxes)]);
  let frontier = [start];
  let depth = 0;
  const DIRS = [
    [0, -1], [0, 1], [-1, 0], [1, 0],
  ];

  const isWin = (boxes) => boxes.every((b) => goals.has(b));
  if (isWin(startBoxes)) return { solvable: true, par: 0 };

  while (frontier.length) {
    depth++;
    const next = [];
    for (const st of frontier) {
      const px = st.p % cols, py = Math.floor(st.p / cols);
      for (const [dx, dy] of DIRS) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const np = ny * cols + nx;
        if (walls.has(np)) continue;

        let boxes = st.boxes;
        const bi = boxes.indexOf(np);
        if (bi >= 0) {
          // 推箱
          const bx = nx + dx, by = ny + dy;
          if (bx < 0 || by < 0 || bx >= cols || by >= rows) continue;
          const nb = by * cols + bx;
          if (walls.has(nb) || boxes.includes(nb)) continue;
          boxes = boxes.slice();
          boxes[bi] = nb;
          boxes.sort((a, b) => a - b);
        }
        const kk = key(np, boxes);
        if (seen.has(kk)) continue;
        seen.add(kk);
        if (isWin(boxes)) return { solvable: true, par: depth };
        next.push({ p: np, boxes });
      }
    }
    frontier = next;
    // 状态数保护
    if (seen.size > 4e6) return { solvable: false, reason: "搜索空间过大" };
  }
  return { solvable: false, reason: "穷尽所有状态不可达" };
}

/* ---------- 主流程 ---------- */
let allOk = true;
const pars = [];
LEVELS.forEach((lv, i) => {
  const r = solve(lv);
  if (!r.solvable) {
    allOk = false;
    console.log(`✗ 第 ${i + 1} 关「${lv.name}」不可解：${r.reason || ""}`);
    pars.push(null);
  } else {
    console.log(`✓ 第 ${i + 1} 关「${lv.name}」可解，最少 ${r.par} 步`);
    pars.push(r.par);
  }
});

console.log("");
if (allOk) {
  console.log("全部关卡验证通过，par 表：");
  console.log(JSON.stringify(pars));
  process.exit(0);
} else {
  console.log("存在不可解关卡，请修正后重试。");
  process.exit(1);
}
