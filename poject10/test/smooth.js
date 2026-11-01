'use strict';
/**
 * 真实浏览器里的移动平滑度验收：
 * 按住方向键，逐帧采样角色坐标，统计
 *  - 每帧位移的波动（有没有"一顿一顿"）
 *  - 有没有停顿帧（位移为 0）
 *  - 走一格的实际耗时（是否稳定在 150ms）
 *  - 输入到起动的延迟
 */
const path = require('path');
const { chromium } = require('playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name + (detail ? `（${detail}）` : ''));
  } else {
    fail++;
    console.log('  ✗ ' + name + (detail ? `（${detail}）` : ''));
    process.exitCode = 1;
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctxA = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const ctxB = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const errs = [];
  a.on('pageerror', (e) => errs.push(e.message));
  b.on('pageerror', (e) => errs.push(e.message));

  await a.goto('http://127.0.0.1:3000/');
  await b.goto('http://127.0.0.1:3000/');
  await a.waitForTimeout(400);
  await a.fill('#nameInput', '皮蛋');
  await a.click('#btnCreate');
  await a.waitForSelector('#screenRoom:not([hidden])');
  const code = (await a.textContent('#roomCode')).trim();
  await b.fill('#nameInput', '黑妞');
  await b.fill('#codeInput', code);
  await b.click('#btnJoin');
  await b.waitForSelector('#screenRoom:not([hidden])');
  await b.click('#btnReady');
  await a.waitForTimeout(300);
  await a.click('#btnStart');
  await a.waitForSelector('#screenRoom', { state: 'hidden' });
  await a.waitForFunction(() => window.__game.countDone, { timeout: 6000 });

  // 逐帧采样
  await a.evaluate(() => {
    window.__samples = [];
    window.__sampling = true;
    const tick = (t) => {
      window.__samples.push([t, window.__game.me.px, window.__game.me.py]);
      if (window.__sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // 记录按键到第一批位移的时间
  const latency = await a.evaluate(async () => {
    const t0 = performance.now();
    const before = window.__game.me.px;
    return { t0, before };
  });
  await a.keyboard.down('ArrowRight');
  await a.waitForFunction(
    (before) => window.__game.me.px > before + 0.02,
    latency.before,
    { timeout: 2000, polling: 'raf' }
  );
  const startDelay = await a.evaluate((t0) => performance.now() - t0, latency.t0);

  // 出生点旁边只有一格空地，来回走 8 趟，凑出足够的"运动中"帧
  for (let i = 0; i < 8; i++) {
    const dir = i % 2 === 0 ? 'ArrowRight' : 'ArrowLeft';
    await a.keyboard.down(dir);
    await sleep(215);
    await a.keyboard.up(dir);
    await sleep(45);
  }
  await sleep(200);

  const raw = await a.evaluate(() => {
    window.__sampling = false;
    return window.__samples;
  });

  // 逐帧位移序列
  const seq = [];
  for (let i = 1; i < raw.length; i++) {
    seq.push({
      dt: raw[i][0] - raw[i - 1][0],
      dp: raw[i][1] - raw[i - 1][1],
    });
  }
  // 只取"直线匀速段"：前后同向、且在动。
  // 起停和反向的那一两帧本来就是加速/减速，混进来会把方差撑大。
  const deltas = [];
  for (let i = 1; i < seq.length - 1; i++) {
    const a0 = seq[i - 1].dp;
    const a1 = seq[i].dp;
    const a2 = seq[i + 1].dp;
    if (a0 * a1 > 0 && a1 * a2 > 0 && Math.abs(a1) > 0.002 && seq[i].dt < 100) {
      deltas.push({ dt: seq[i].dt, dp: Math.abs(a1) });
    }
  }
  // 用「速度」而不是「每帧位移」衡量，才不受浏览器帧间隔抖动干扰
  const avgDt = deltas.reduce((s, d) => s + d.dt, 0) / deltas.length;
  const vs = deltas.map((d) => d.dp / d.dt);
  const avg = vs.reduce((s, v) => s + v, 0) / vs.length;
  const std = Math.sqrt(vs.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / vs.length);
  const cellTime = 1 / avg; // 走一格需要多少毫秒

  // 运动中夹着的停顿帧（两侧都在动，中间不动 = 卡顿）
  let stalls = 0;
  for (let i = 1; i < raw.length - 2; i++) {
    const d0 = Math.abs(raw[i][1] - raw[i - 1][1]) + Math.abs(raw[i][2] - raw[i - 1][2]);
    const d1 = Math.abs(raw[i + 1][1] - raw[i][1]) + Math.abs(raw[i + 1][2] - raw[i][2]);
    const d2 = Math.abs(raw[i + 2][1] - raw[i + 1][1]) + Math.abs(raw[i + 2][2] - raw[i + 1][2]);
    if (d0 > 0.02 && d1 < 0.002 && d2 > 0.02) stalls++;
  }

  console.log('移动平滑度（真实浏览器，逐帧采样）');
  console.log(
    `  运动中 ${deltas.length} 帧 / 帧间隔 ${avgDt.toFixed(1)}ms / 速度 ${(avg * 44 * 1000).toFixed(0)}px/s / 标准差 ${(std * 44 * 1000).toFixed(0)}px/s`
  );
  console.log(`  推算单格耗时 ${cellTime.toFixed(0)}ms / 起步延迟 ${startDelay.toFixed(0)}ms`);

  check('运动中无停顿帧', stalls === 0, `停 ${stalls} 次`);
  check('逐帧速度波动 < 15%', std / avg < 0.15, `变异系数 ${((std / avg) * 100).toFixed(1)}%`);
  check('单格耗时 ≈ 150ms（±12ms）', Math.abs(cellTime - 150) <= 12, `${cellTime.toFixed(0)}ms`);
  check('按键到起步 ≤ 1 帧', startDelay <= 20, `${startDelay.toFixed(0)}ms`);
  check('无页面报错', errs.length === 0, errs[0] || 'clean');

  // 远端平滑度：B 看 A 的位置是否连续
  const remote = await b.evaluate(() => {
    const me = [...window.__game.players.values()].find((p) => p.id !== window.__game.myId);
    return me ? { rx: me.rx, samples: me.samples ? me.samples.length : 0 } : null;
  });
  check('远端插值样本已积累', !!remote && remote.samples >= 2, `${remote && remote.samples} 个样本`);

  await browser.close();
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
})();
