'use strict';
/**
 * 结算界面验收：1 真人 + 1 AI，玩家自杀式踩泡 → 出局 → 结算
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'shots');
const URL = process.env.URL || 'http://127.0.0.1:3000/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function until(page, fn, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await page.waitForTimeout(60);
  }
  return false;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(URL);
  await page.waitForTimeout(400);
  await page.fill('#nameInput', '自爆测试员');
  await page.click('#modeTabs .mode[data-mode="pve"]');
  await page.waitForTimeout(150);
  await page.click('#botMinus');
  await page.click('#botMinus'); // 3 → 1 个 AI
  console.log('阵容提示:', (await page.textContent('#lineupText')).trim());
  await page.click('#btnQuick');

  await until(page, () => window.__game && window.__game.countDone, 8000);
  await page.waitForTimeout(200);

  // 站在自己的泡泡上不动 → 被泡封 → 4.2 秒后出局
  await page.keyboard.press('Space');
  const trapped = await until(page, () => window.__game.me && window.__game.me.trapped, 5000);
  console.log('被泡封:', trapped);
  const over = await until(page, () => !document.getElementById('screenOver').hidden, 12000);
  console.log('进入结算:', over);

  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'h11-over.png') });
  console.log('结算文案:', (await page.textContent('#overTitle')).trim(), '|', (await page.textContent('#overSub')).trim());
  console.log('页面错误:', errors.length ? errors : '无');
  await browser.close();
})();
