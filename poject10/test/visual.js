'use strict';
/**
 * 可视化验收脚本（开发用）
 * 用本机 Edge 无头模式开两个对局页面：建房 → 加入 → 准备 → 开局 → 走位 → 放泡 → 爆炸
 * 每一步都以真实游戏状态为条件再截图，避免时序抖动。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'shots');
const URL = process.env.URL || 'http://127.0.0.1:3000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function until(page, fn, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

async function shot(page, name) {
  // 后台标签页会被浏览器降频，先切到前台再等一帧，保证截到的是最新画面
  await page.bringToFront();
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT, name) });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    // 多开页面时避免后台标签页被降频，保证截图是当前帧
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
  const errors = [];

  const ctx1 = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const p1 = await ctx1.newPage();
  p1.on('pageerror', (e) => errors.push('[p1] ' + e.message));

  await p1.goto(URL);
  await p1.waitForTimeout(600);
  await shot(p1, '1-home.png');

  await p1.fill('#nameInput', '皮蛋');
  await p1.click('#btnCreate');
  await p1.waitForSelector('#screenRoom:not([hidden])');
  const code = (await p1.textContent('#roomCode')).trim();
  await shot(p1, '2-room.png');

  const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push('[p2] ' + e.message));
  await p2.goto(URL);
  await p2.waitForTimeout(400);
  await p2.fill('#nameInput', '黑妞');
  await p2.fill('#codeInput', code);
  await p2.click('#btnJoin');
  await p2.waitForSelector('#screenRoom:not([hidden])');
  await p2.click('#btnReady');
  await p1.waitForTimeout(500);
  await shot(p1, '3-room-2p.png');

  await p1.click('#btnStart');
  await p1.waitForSelector('#screenRoom', { state: 'hidden' });
  await p1.waitForTimeout(700);
  await shot(p1, '4-countdown.png');
  await until(p1, () => window.__game.countDone, 4000);
  await p1.waitForTimeout(200);
  await shot(p1, '4-game.png');

  // 玩家1 向右走 → 截图
  const x0 = await p1.evaluate(() => window.__game.me.cellX);
  await p1.keyboard.down('ArrowRight');
  await until(p1, () => window.__game.me.cellX >= 3);
  await shot(p1, '5-moving.png');
  await p1.keyboard.up('ArrowRight');
  await p1.waitForTimeout(120);

  // 放泡
  await p1.keyboard.press('Space');
  const gotBomb = await until(p1, () => window.__game.bombs.length > 0, 2000);
  await p1.waitForTimeout(150);
  await shot(p1, '6-bomb.png');
  console.log('x:', x0, '→', await p1.evaluate(() => window.__game.me.cellX), '| 泡泡出现:', gotBomb);

  // 爆炸瞬间
  const gotBoom = await until(p1, () => window.__game.explosions.length > 0, 4000);
  await shot(p1, '7-explode.png');
  console.log('爆炸:', gotBoom);

  // 玩家2 也动起来（同时验证对端看到的同步）
  await p2.bringToFront();
  await p2.keyboard.down('ArrowUp');
  await p2.waitForTimeout(700);
  await p2.keyboard.up('ArrowUp');
  await p2.waitForTimeout(600);
  await shot(p2, '8-p2.png');

  // 两端看到的位置是否一致
  const view1 = await p1.evaluate(() => [...window.__game.players.values()].map((p) => [p.id, +p.rx.toFixed(1), +p.ry.toFixed(1)]));
  const view2 = await p2.evaluate(() => [...window.__game.players.values()].map((p) => [p.id, +p.rx.toFixed(1), +p.ry.toFixed(1)]));
  console.log('p1 视角:', JSON.stringify(view1));
  console.log('p2 视角:', JSON.stringify(view2));

  console.log('页面错误:', errors.length ? errors : '无');
  await browser.close();
})();
