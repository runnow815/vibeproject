'use strict';
/** 直接从 canvas 取图，绕开合成器缓存，验证"当前帧"的真实渲染 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function grab(page, name) {
  const data = await page.evaluate(() => document.getElementById('board').toDataURL('image/png'));
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data.split(',')[1], 'base64'));
}

async function until(page, fn, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await page.waitForTimeout(25);
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const a = await ctx.newPage();
  const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const b = await ctx2.newPage();

  await a.goto('http://127.0.0.1:3000/');
  await b.goto('http://127.0.0.1:3000/');
  await a.waitForTimeout(500);
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
  await until(a, () => window.__game.countDone, 6000);

  // 走一步、放炸弹，然后退开一格，让炸弹完整露出来
  await a.keyboard.down('ArrowRight');
  await sleep(320);
  await a.keyboard.up('ArrowRight');
  await sleep(140);
  await a.keyboard.press('Space');
  await sleep(160);
  await a.keyboard.down('ArrowLeft');
  await sleep(230);
  await a.keyboard.up('ArrowLeft');
  await sleep(120);
  await grab(a, 'c1-bomb.png');

  // 等爆炸（自己站在射程内，会被炸晕）
  await until(a, () => window.__game.explosions.length > 0, 5000);
  await sleep(90); // 等这一帧真正画出来
  await grab(a, 'c2-boom.png');

  // 眩晕状态：等爆炸特效散掉，才看得到头顶转圈的星星
  await until(a, () => window.__game.me && window.__game.me.trapped, 2000);
  await sleep(760);
  await grab(a, 'c2b-stun.png');

  // 炸开的箱子 + 掉落道具
  await until(a, () => window.__game.items.length > 0, 6000);
  await sleep(500);
  await grab(a, 'c3-items.png');

  console.log('trapped:', await a.evaluate(() => window.__game.me.trapped));
  console.log('items:', await a.evaluate(() => window.__game.items));
  console.log('boxes left:', await a.evaluate(() => window.__game.tiles.filter((t) => t === 2).length));

  await browser.close();
})();
