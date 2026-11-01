'use strict';
/**
 * 美术验收：把道具图标 / 炸弹 / 爆炸放大画到一张图上，检查绘制不报错、样式一致。
 * 产物：shots/art-sheet.png
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(__dirname, '..', 'shots');

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 420 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:3000/');

  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const W = 880;
    const H = 400;
    c.width = W * 2;
    c.height = H * 2;
    const g = c.getContext('2d');
    g.scale(2, 2);

    // 草地底
    for (let y = 0; y < H; y += 44) {
      for (let x = 0; x < W; x += 44) {
        g.fillStyle = ((x / 44 + y / 44) | 0) % 2 === 0 ? '#addda3' : '#a6d89c';
        g.fillRect(x, y, 44, 44);
      }
    }

    g.fillStyle = '#33506a';
    g.font = '700 15px system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('道具图标（炸弹+1 / 火力+1 / 速度+1）', 40, 46);
    g.fillText('炸弹（引信剩余 100% / 20%）', 40, 216);
    g.fillText('爆炸冲击（中心 / 横臂 / 竖臂）', 400, 216);

    // 道具 3 种，放大 1.8 倍
    const types = [1, 2, 3];
    types.forEach((t, i) => {
      g.save();
      g.translate(80 + i * 130, 120);
      g.scale(2.4, 2.4);
      window.Render.preview.drawItem(g, 0, 0, t, 1000);
      g.restore();
    });

    // 炸弹：满引信 / 快炸
    [2400, 480].forEach((left, i) => {
      g.save();
      g.translate(90 + i * 130, 290);
      g.scale(2.2, 2.2);
      window.Render.preview.drawBomb(g, 0, 0, left, 1, 1000, 1);
      g.restore();
    });

    // 爆炸：中心 + 横向臂 + 纵向臂
    const cells = [
      { x: 0, y: 0, dir: 'center' },
      { x: 0, y: 0, dir: 'left' },
      { x: 0, y: 0, dir: 'up' },
    ];
    cells.forEach((cell, i) => {
      g.save();
      g.translate(470 + i * 120, 300);
      g.scale(1.9, 1.9);
      window.Render.preview.drawExplosion(g, { ...cell, x: 0, y: 0 }, 160);
      g.restore();
    });

    return c.toDataURL('image/png');
  });

  fs.writeFileSync(path.join(OUT, 'art-sheet.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('页面错误:', errors.length ? errors.join(' | ') : '无');
  console.log('已生成 shots/art-sheet.png');
  await browser.close();
})();
