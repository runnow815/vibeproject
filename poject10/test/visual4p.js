'use strict';
/** 4 人房 + 全员出局后的结算界面验收 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'shots');
const URL = process.env.URL || 'http://127.0.0.1:3000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const names = ['皮蛋', '黑妞', '胖墩', '葱头'];
  const pages = [];

  for (let i = 0; i < 4; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('[err]', names[i], e.message));
    await p.goto(URL);
    pages.push(p);
  }
  await sleep(500);

  await pages[0].fill('#nameInput', names[0]);
  await pages[0].click('#btnCreate');
  await pages[0].waitForSelector('#screenRoom:not([hidden])');
  const code = (await pages[0].textContent('#roomCode')).trim();
  console.log('房间:', code);

  for (let i = 1; i < 4; i++) {
    await pages[i].fill('#nameInput', names[i]);
    await pages[i].fill('#codeInput', code);
    await pages[i].click('#btnJoin');
  }
  await pages[0].waitForTimeout(600);

  for (let i = 1; i < 4; i++) {
    await pages[i].bringToFront();
    await pages[i].click('#btnReady');
  }
  await pages[0].bringToFront();
  await pages[0].waitForTimeout(600);
  await pages[0].screenshot({ path: path.join(OUT, '9-room-4p.png') });

  await pages[0].click('#btnStart');
  await pages[0].waitForSelector('#screenRoom', { state: 'hidden' });
  await pages[0].waitForTimeout(2000);
  await pages[0].screenshot({ path: path.join(OUT, '10-four-players.png') });

  // 三个人各自原地放泡自杀，留下最后一人 → 触发结算
  for (let i = 0; i < 3; i++) {
    await pages[i].bringToFront();
    await pages[i].keyboard.press('Space');
    await pages[i].waitForTimeout(120);
  }
  await pages[0].bringToFront();
  await pages[0].waitForTimeout(8000);
  await pages[0].screenshot({ path: path.join(OUT, '11-over.png') });

  const alive = await pages[3].evaluate(() =>
    [...window.__game.players.values()].map((p) => [p.name, p.alive])
  );
  console.log('存活情况:', JSON.stringify(alive));

  await browser.close();
})();
