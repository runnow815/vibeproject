'use strict';
/** 手机端布局检查：首页 / 房间 / 对局（另一个位置由 Node 机器人占位） */
const path = require('path');
const { chromium } = require('playwright-core');
const WebSocket = require('ws');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(__dirname, '..', 'shots');
const URL = 'http://127.0.0.1:3000/';

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto(URL);
  await p.waitForTimeout(800);
  console.log('touch 控件可见:', await p.isVisible('#touch'));
  await p.screenshot({ path: path.join(OUT, 'm1-home.png') });

  await p.fill('#nameInput', '小手机');
  await p.tap('#btnCreate');
  await p.waitForTimeout(700);
  await p.screenshot({ path: path.join(OUT, 'm2-room.png') });
  const code = (await p.textContent('#roomCode')).trim();

  // 机器人加入
  const bot = new WebSocket('ws://127.0.0.1:3000');
  await new Promise((r) => bot.on('open', r));
  const send = (o) => bot.send(JSON.stringify(o));
  send({ t: 'hello', id: 'bot-1', name: '机器人' });
  send({ t: 'join', code, name: '机器人' });
  await new Promise((r) => setTimeout(r, 300));
  send({ t: 'ready', value: true });
  await new Promise((r) => setTimeout(r, 500));

  await p.tap('#btnStart');
  await p.waitForTimeout(3200);
  await p.screenshot({ path: path.join(OUT, 'm3-game.png') });

  // 用触屏摇杆走两步
  const up = await p.locator('.tbtn.up').boundingBox();
  await p.touchscreen.tap(up.x + up.width / 2, up.y + up.height / 2);
  await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(OUT, 'm4-play.png') });

  bot.close();
  await browser.close();
})();
