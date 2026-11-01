'use strict';
/* 移动内核单测：验证「帧率无关」「不丢时间」「无卡帧」 */

const assert = require('assert');
const Motion = require('../public/js/motion.js');

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + e.message);
    process.exitCode = 1;
  }
}

const DIRS = Motion.DIRS;
const BASE = 150;

// 一条 40 格的长走廊，方便统计走位
function makeMap(len) {
  return { tiles: new Uint8Array(len), cols: len };
}
function canEnterOn(map) {
  return (x, y) => x >= 0 && y === 0 && x < map.cols;
}
function newMover() {
  return {
    cellX: 0, cellY: 0, px: 0, py: 0,
    fromX: 0, fromY: 0, toX: 0, toY: 0,
    moving: false, moveStart: 0, moveDur: BASE, speed: 0, dir: 'right',
  };
}

// ---- 旧实现：每到一格就把 moveStart 重置为"当前帧时间"，丢掉余量 ----
function oldAdvance(m, now, dir, canEnter) {
  if (m.moving) {
    const t = (now - m.moveStart) / m.moveDur;
    if (t >= 1) {
      m.moving = false;
      m.cellX = m.toX;
      m.cellY = m.toY;
      m.px = m.cellX;
      m.py = m.cellY;
    } else {
      m.px = m.fromX + (m.toX - m.fromX) * t;
      m.py = m.fromY + (m.toY - m.fromY) * t;
      return;
    }
  }
  if (!m.moving) {
    const [dx, dy] = DIRS[dir];
    const nx = m.cellX + dx;
    const ny = m.cellY + dy;
    m.dir = dir;
    if (!canEnter(nx, ny)) return;
    m.moving = true;
    m.fromX = m.cellX;
    m.fromY = m.cellY;
    m.toX = nx;
    m.toY = ny;
    m.moveStart = now; // ← 问题所在：剩余时间被丢弃
    m.moveDur = BASE;
  }
}

/** 返回"第 cells 格真正到达"的精确时刻（不是帧边界） */
function travel(fps, cells, useOld) {
  const map = makeMap(80);
  const canEnter = canEnterOn(map);
  const m = newMover();
  const dt = 1000 / fps;
  let now = 0;
  let frames = 0;
  let arrived = null;
  const onArrive = (mm) => {
    if (arrived === null && mm.cellX >= cells) arrived = mm.moveStart + mm.moveDur;
  };
  while (arrived === null && frames < 20000) {
    if (useOld) {
      const before = m.cellX;
      oldAdvance(m, now, 'right', canEnter);
      if (before < cells && m.cellX >= cells) arrived = now;
    } else {
      Motion.advance(m, now, { dir: 'right', canEnter, durFor: () => BASE, onArrive });
    }
    now += dt;
    frames++;
  }
  return arrived === null ? Infinity : arrived;
}

console.log('移动内核');

ok('60fps 下走 20 格 = 3000ms（旧实现会明显偏慢）', () => {
  const t = travel(60, 20, false);
  assert.ok(Math.abs(t - 3000) < 1, `实际 ${t.toFixed(1)}ms`);
  const old = travel(60, 20, true);
  assert.ok(old > t + 50, `旧实现 ${old.toFixed(0)}ms 应比新实现慢 50ms 以上`);
});

ok('帧率无关：30 / 60 / 120 / 144fps 走 20 格耗时完全一致', () => {
  const list = [30, 60, 120, 144];
  const ts = list.map((f) => travel(f, 20, false));
  const max = Math.max(...ts);
  const min = Math.min(...ts);
  assert.ok(max - min < 1, `各帧率耗时 ${ts.map((x) => x.toFixed(1)).join(' / ')}ms`);
  for (const t of ts) assert.ok(Math.abs(t - 3000) < 1, `偏离基准：${t.toFixed(1)}ms`);
});

ok('旧实现在不同帧率下耗时不一致（证明原问题真实存在）', () => {
  const a = travel(60, 20, true);
  const b = travel(144, 20, true);
  assert.ok(Math.abs(a - b) > 40, `60fps=${a.toFixed(0)}ms, 144fps=${b.toFixed(0)}ms`);
});

ok('匀速：逐帧位移标准差极小（无忽快忽慢）', () => {
  const map = makeMap(60);
  const canEnter = canEnterOn(map);
  const m = newMover();
  const dt = 1000 / 60;
  let now = 0;
  const speeds = [];
  let prev = 0;
  for (let i = 0; i < 120; i++) {
    Motion.advance(m, now, { dir: 'right', canEnter, durFor: () => BASE });
    const moved = m.cellX + (m.px - m.cellX) - prev;
    if (i > 2) speeds.push(moved);
    prev = m.cellX + (m.px - m.cellX);
    now += dt;
  }
  const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const vary = Math.max(...speeds) - Math.min(...speeds);
  assert.ok(avg > 0.05, '应当持续前进');
  assert.ok(vary < avg * 0.08, `每帧位移波动 ${(vary / avg * 100).toFixed(1)}% 应 < 8%`);
});

ok('不卡帧：连续 600 帧里没有一帧位移为 0（按住方向键时）', () => {
  const map = makeMap(900);
  const canEnter = canEnterOn(map);
  const m = newMover();
  const dt = 1000 / 60;
  let now = 0;
  let prev = 0;
  let stalls = 0;
  for (let i = 0; i < 600; i++) {
    Motion.advance(m, now, { dir: 'right', canEnter, durFor: () => BASE });
    const pos = m.cellX + (m.px - m.cellX);
    if (i > 1 && pos - prev < 0.01) stalls++;
    prev = pos;
    now += dt;
  }
  assert.strictEqual(stalls, 0, `出现 ${stalls} 次停顿帧`);
});

ok('撞墙立刻停住且不抖动', () => {
  const map = makeMap(3); // 只有 x=0,1,2
  const canEnter = canEnterOn(map);
  const m = newMover();
  let now = 0;
  for (let i = 0; i < 90; i++) {
    Motion.advance(m, now, { dir: 'right', canEnter, durFor: () => BASE });
    now += 16.67;
  }
  assert.strictEqual(m.cellX, 2);
  assert.strictEqual(m.px, 2);
  assert.strictEqual(m.moving, false);
});

ok('速度加成生效：speed=3 时每格 < speed=0', () => {
  const d0 = Motion.moveDur(0);
  const d3 = Motion.moveDur(3);
  assert.strictEqual(d0, 150);
  assert.ok(d3 < d0 && d3 >= 78, `speed3=${d3}`);
});

ok('远端插值：样本之间线性取值', () => {
  const s = [
    { t: 0, x: 0, y: 0 },
    { t: 60, x: 0.4, y: 0 },
    { t: 120, x: 0.8, y: 0 },
  ];
  assert.ok(Math.abs(Motion.sampleAt(s, 30).x - 0.2) < 1e-9);
  assert.ok(Math.abs(Motion.sampleAt(s, 90).x - 0.6) < 1e-9);
  assert.ok(Math.abs(Motion.sampleAt(s, 120).x - 0.8) < 1e-9);
});

ok('远端插值：短暂越过最新样本时按速度外推且封顶', () => {
  const s = [
    { t: 0, x: 0, y: 0 },
    { t: 60, x: 0.4, y: 0 },
  ];
  const p = Motion.sampleAt(s, 90);
  assert.ok(p.x > 0.4 && p.x <= 0.6 + 1e-9, `外推 ${p.x}`);
  const far = Motion.sampleAt(s, 9999);
  assert.ok(far.x <= 1.2 + 1e-9, `外推应封顶，实际 ${far.x}`);
});

console.log(`\n移动内核测试通过 ${pass} 项`);
