'use strict';
const { chromium } = require('playwright-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await p.goto('http://127.0.0.1:3000/');
  await p.waitForTimeout(500);
  console.log('has __game:', await p.evaluate(() => !!window.__game));
  console.log(
    'net:',
    await p.evaluate(() => ({ id: Net.id, name: Net.name }))
  );
  await p.fill('#nameInput', '测试员');
  await p.click('#btnQuick');
  await p.waitForTimeout(600);
  console.log(
    'after quick:',
    await p.evaluate(() => ({
      screen: window.__game && window.__game.screen,
      room: window.__game && window.__game.room && window.__game.room.code,
      me: window.__game && window.__game.myId,
    }))
  );

  // 加一个机器人凑够 2 人
  const ctx2 = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const p2 = await ctx2.newPage();
  await p2.goto('http://127.0.0.1:3000/');
  await p2.waitForTimeout(400);
  const code = await p.evaluate(() => window.__game.room.code);
  await p2.click('#btnJoin');
  await p2.fill('#codeInput', code);
  await p2.click('#btnJoin');
  await p2.waitForTimeout(400);
  await p2.click('#btnReady');
  await p.waitForTimeout(300);
  const startVisible = await p.isVisible('#btnStart');
  console.log('start button visible:', startVisible);
  await p.click('#btnStart');
  await p.waitForTimeout(1000);

  console.log(
    'in game:',
    await p.evaluate(() => ({
      screen: window.__game.screen,
      playing: window.__game.playing,
      me: window.__game.me && { x: window.__game.me.cellX, y: window.__game.me.cellY, alive: window.__game.me.alive },
      meId: window.__game.myId,
      players: [...window.__game.players.values()].map((x) => [x.id, x.rx, x.ry]),
      cols: window.__game.cols,
      tileAt11: window.__game.tiles[1 * 15 + 1],
      tileAt21: window.__game.tiles[1 * 15 + 2],
      inputDir: window.__game.inputDir,
    }))
  );

  await p.keyboard.down('ArrowRight');
  await p.waitForTimeout(500);
  await p.keyboard.up('ArrowRight');
  await p.waitForTimeout(200);
  console.log(
    'after ArrowRight:',
    await p.evaluate(() => ({
      inputDir: window.__game.inputDir,
      seq: window.__game.seq,
      me: window.__game.me && { x: window.__game.me.cellX, y: window.__game.me.cellY, px: window.__game.me.px },
      players: [...window.__game.players.values()].map((x) => [x.id, +x.rx.toFixed(2), +x.ry.toFixed(2)]),
    }))
  );

  await p.keyboard.press('Space');
  await p.waitForTimeout(300);
  console.log(
    'after Space:',
    await p.evaluate(() => ({
      bombs: window.__game.bombs,
      pending: window.__game.me.pending.length,
    }))
  );

  await browser.close();
})();
