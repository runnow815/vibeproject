'use strict';
/**
 * 可视化验收：混合模式 / 人机对战 / 2v2
 * 用本机 Edge 无头模式真实操作界面，按游戏状态驱动截图。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'shots');
const URL = process.env.URL || 'http://127.0.0.1:3000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function until(page, fn, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

async function shot(page, name) {
  await page.bringToFront();
  await page.waitForTimeout(420);
  await page.screenshot({ path: path.join(OUT, name) });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const p1 = await ctx.newPage();
  p1.on('pageerror', (e) => errors.push('[p1] ' + e.message));

  await p1.goto(URL);
  await p1.waitForTimeout(500);
  await shot(p1, 'h1-home-pvp.png');

  // ---- 混合模式配置面板 ----
  await p1.click('#modeTabs .mode[data-mode="hybrid"]');
  await p1.waitForTimeout(200);
  await shot(p1, 'h2-home-hybrid.png');
  console.log('人数提示:', (await p1.textContent('#lineupText')).trim());

  // ---- 快速匹配：2 AI + 2 真人席位，先截图等待界面 ----
  await p1.fill('#nameInput', '皮蛋');
  await p1.click('#btnQuick');
  await p1.waitForSelector('#screenRoom:not([hidden])');
  await p1.waitForTimeout(400);
  await shot(p1, 'h3-room-bots.png');
  console.log('房间提示:', (await p1.textContent('#roomHint')).trim());

  // ---- 第二个真人加入同一间房 ----
  const code = (await p1.textContent('#roomCode')).trim();
  const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push('[p2] ' + e.message));
  await p2.goto(URL);
  await p2.waitForTimeout(350);
  await p2.fill('#nameInput', '黑妞');
  await p2.click('#modeTabs .mode[data-mode="hybrid"]');
  await p2.waitForTimeout(150);
  await p2.click('#btnQuick');
  await p2.waitForSelector('#screenRoom:not([hidden])');
  const sameRoom = (await p2.textContent('#roomCode')).trim();
  console.log('匹配房间一致性:', code, sameRoom, code === sameRoom ? 'OK' : 'FAIL');
  await p2.click('#btnReady');
  await p1.waitForTimeout(500);
  await shot(p1, 'h4-room-full.png');

  // ---- 开局：2 真人 + 2 AI ----
  await p1.click('#btnStart');
  await p1.waitForSelector('#screenRoom', { state: 'hidden' });
  await until(p1, () => window.__game.countDone, 5000);
  await p1.waitForTimeout(300);
  await shot(p1, 'h5-game-hybrid.png');

  const lineup = await p1.evaluate(() => {
    const g = window.__game;
    return [...g.players.values()].map((p) => ({ name: p.name, bot: !!p.isBot, x: p.rx, y: p.ry }));
  });
  console.log('场上阵容:', JSON.stringify(lineup));

  // ---- 等 AI 行动，再截一张对比 ----
  await p1.waitForTimeout(2600);
  await shot(p1, 'h6-game-ai-moving.png');
  const lineup2 = await p1.evaluate(() =>
    [...window.__game.players.values()].map((p) => [p.name, +p.rx.toFixed(1), +p.ry.toFixed(1)])
  );
  console.log('3.5s 后位置:', JSON.stringify(lineup2));

  // 两个客户端收到的权威状态是否一致（rx 是渲染插值，会差半帧，不能作为一致性依据）
  const v1 = await p1.evaluate(() =>
    [...window.__game.players.values()].map((p) => [p.id, +p.tx.toFixed(3), +p.ty.toFixed(3)])
  );
  const v2 = await p2.evaluate(() =>
    [...window.__game.players.values()].map((p) => [p.id, +p.tx.toFixed(3), +p.ty.toFixed(3)])
  );
  console.log(
    '两端权威状态一致:',
    JSON.stringify(v1) === JSON.stringify(v2) ? 'OK' : `FAIL ${JSON.stringify(v1)} vs ${JSON.stringify(v2)}`
  );

  // 渲染位置只能差一帧的量级
  const r1 = await p1.evaluate(() =>
    [...window.__game.players.values()].map((p) => [p.id, p.rx, p.ry])
  );
  const r2 = await p2.evaluate(() =>
    [...window.__game.players.values()].map((p) => [p.id, p.rx, p.ry])
  );
  const maxDelta = r1.reduce((m, row, i) => {
    const o = r2.find((x) => x[0] === row[0]);
    return Math.max(m, Math.abs(row[1] - o[1]) + Math.abs(row[2] - o[2]));
  }, 0);
  console.log('两端渲染位置最大偏差:', maxDelta.toFixed(2), '格', maxDelta < 0.3 ? 'OK' : 'FAIL');

  // ---- 人机对战：1 真人 + 3 AI ----
  const ctx3 = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errors.push('[p3] ' + e.message));
  await p3.goto(URL);
  await p3.waitForTimeout(350);
  await p3.fill('#nameInput', '单机王');
  await p3.click('#modeTabs .mode[data-mode="pve"]');
  await p3.waitForTimeout(150);
  await shot(p3, 'h7-home-pve.png');
  await p3.click('#btnQuick');
  await p3.waitForSelector('#screenRoom', { state: 'hidden' });
  await until(p3, () => window.__game.countDone, 5000);
  await p3.waitForTimeout(2500);
  await shot(p3, 'h8-game-pve.png');
  const pve = await p3.evaluate(() => [...window.__game.players.values()].map((p) => [p.name, !!p.isBot]));
  console.log('人机阵容:', JSON.stringify(pve));

  // ---- 2v2 分队 ----
  const ctx4 = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const p4 = await ctx4.newPage();
  p4.on('pageerror', (e) => errors.push('[p4] ' + e.message));
  await p4.goto(URL);
  await p4.waitForTimeout(350);
  await p4.fill('#nameInput', '蓝队长');
  await p4.click('#modeTabs .mode[data-mode="pve"]');
  await p4.waitForTimeout(150);
  await p4.click('#teamTabs button[data-team="1"]');
  await p4.waitForTimeout(150);
  await shot(p4, 'h9-home-team.png');
  await p4.click('#btnQuick');
  await p4.waitForSelector('#screenRoom', { state: 'hidden' });
  await until(p4, () => window.__game.countDone, 5000);
  await p4.waitForTimeout(1200);
  await shot(p4, 'h10-game-2v2.png');
  const teams = await p4.evaluate(() => {
    const g = window.__game;
    return [...g.players.values()].map((p) => [p.name, p.team]);
  });
  console.log('2v2 分队:', JSON.stringify(teams), 'teamMode=', await p4.evaluate(() => window.__game.teamMode));

  console.log('页面错误:', errors.length ? errors : '无');
  await browser.close();
})();
