'use strict';
/* ============================================================
   响应式布局验收（真实浏览器，多视口）
   ------------------------------------------------------------
   每个视口检查：
     · 断点标记正确 / 无横向溢出
     · 首页面板完整可见（不超出视口、不被裁切）
     · 正文最小字号 ≥ 12px，触屏点击目标 ≥ 44px
     · 进入对局后：棋盘完整可见、比例正确、不与 HUD / 摇杆重叠
   ============================================================ */
const { chromium } = require('playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:3000/';

const CASES = [
  { name: '手机竖屏 320×568', w: 320, h: 568, touch: true, bp: 'xs', ctrl: 'bottom' },
  { name: '手机竖屏 390×844', w: 390, h: 844, touch: true, bp: 'xs', ctrl: 'bottom' },
  { name: '大屏手机 430×932', w: 430, h: 932, touch: true, bp: 'xs', ctrl: 'bottom' },
  { name: '手机横屏 812×375', w: 812, h: 375, touch: true, bp: 'md', ctrl: 'side' },
  { name: '平板竖屏 768×1024', w: 768, h: 1024, touch: true, bp: 'md', ctrl: 'bottom' },
  { name: '平板横屏 1024×768', w: 1024, h: 768, touch: true, bp: 'lg', ctrl: 'side' },
  { name: '笔记本 1366×768', w: 1366, h: 768, touch: false, bp: 'xl' },
  { name: '桌面 1440×900', w: 1440, h: 900, touch: false, bp: 'xl' },
  { name: '宽屏 1920×1080', w: 1920, h: 1080, touch: false, bp: 'xl' },
];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name} — ${detail}`);
    console.log(`  ✗ ${name}  ${detail || ''}`);
  }
}

const r = (n) => Math.round(n * 10) / 10;

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });

  for (const c of CASES) {
    console.log(`\n【${c.name}】`);
    const ctx = await browser.newContext({
      viewport: { width: c.w, height: c.h },
      hasTouch: c.touch,
      isMobile: c.touch,
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForTimeout(420);

    // ---------- 基本信息 ----------
    const info = await page.evaluate(() => ({
      bp: document.body.dataset.bp,
      orient: document.body.dataset.orient,
      touchOn: document.body.classList.contains('touch-on'),
      coarse: matchMedia('(pointer: coarse)').matches,
      docScrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      bodyScrollW: document.body.scrollWidth,
    }));
    check('断点标记 ' + c.bp, info.bp === c.bp, `实际 ${info.bp}`);
    check('无横向溢出', info.docScrollW <= info.innerW + 1, `scrollW ${info.docScrollW} > ${info.innerW}`);
    if (c.touch) check('触屏识别', info.touchOn, `coarse=${info.coarse}`);

    // ---------- 首页面板 ----------
    const home = await page.evaluate(() => {
      const p = document.querySelector('#screenHome .panel');
      const b = p.getBoundingClientRect();
      const quick = document.getElementById('btnQuick').getBoundingClientRect();
      const name = document.getElementById('nameInput').getBoundingClientRect();
      const cs = (el) => parseFloat(getComputedStyle(el).fontSize);
      const hint = document.querySelector('.hint');
      const sub = document.querySelector('#screenHome .sub');
      const cards = [...document.querySelectorAll('.modes .mode')].map((x) => x.getBoundingClientRect());
      return {
        rect: { top: b.top, left: b.left, right: b.right, bottom: b.bottom, w: b.width, h: b.height },
        vw: window.innerWidth,
        vh: window.innerHeight,
        scrollable: p.scrollHeight > p.clientHeight + 1,
        hintPx: cs(hint),
        subPx: cs(sub),
        inputPx: cs(document.getElementById('nameInput')),
        quickH: quick.height,
        nameH: name.height,
        modeH: cards.map((x) => r2(x.height)),
        modeOverflow: cards.some((x) => x.right > b.right + 0.5 || x.left < b.left - 0.5),
      };
      function r2(n) { return Math.round(n * 10) / 10; }
    });
    check(
      '面板完整落在视口内',
      home.rect.top >= -0.5 && home.rect.bottom <= home.vh + 0.5 && home.rect.left >= -0.5 && home.rect.right <= home.vw + 0.5,
      `rect ${JSON.stringify(home.rect)} vw=${home.vw} vh=${home.vh}`
    );
    check('面板内容不溢出（可滚动或无裁切）', !home.scrollable || home.rect.h <= home.vh, `scrollable=${home.scrollable}`);
    check('模式按钮不溢出面板', !home.modeOverflow, JSON.stringify(home.modeH));
    check('正文 ≥ 12px', home.hintPx >= 12 && home.subPx >= 12, `hint ${home.hintPx} / sub ${home.subPx}`);
    check('输入框字号 ≥ 16px（避免 iOS 聚焦缩放）', home.inputPx >= 16, `${home.inputPx}px`);
    check('主按钮高度 ≥ 44px', home.quickH >= 44, `${r(home.quickH)}px`);
    if (c.touch) {
      check('输入框高度 ≥ 44px', home.nameH >= 44, `${r(home.nameH)}px`);
      check('模式按钮高度 ≥ 40px', home.modeH.every((h) => h >= 40), JSON.stringify(home.modeH));
    }

    await page.screenshot({ path: require('path').join(__dirname, '..', 'shots', `r-home-${c.w}x${c.h}.png`) });

    // ---------- 进入对局（人机，单人即开） ----------
    await page.fill('#nameInput', '布局');
    await page.click('[data-mode="pve"]');
    await page.click('#btnQuick');
    await page.waitForFunction(() => window.__game && window.__game.screen === 'game', null, { timeout: 8000 });
    await page.waitForFunction(() => window.__game.countDone, null, { timeout: 8000 });
    await page.waitForTimeout(260);

    const game = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el || el.hidden) return null;
        const b = el.getBoundingClientRect();
        if (b.width < 1 && b.height < 1) return null; // 父级 display:none
        return { top: b.top, left: b.left, right: b.right, bottom: b.bottom, w: b.width, h: b.height };
      };
      const board = box('#board');
      const wrap = box('#boardWrap');
      const hud = box('#hud');
      const stage = box('.stage');
      const dpad = box('.dpad');
      const bomb = box('#touchBomb');
      const topbar = box('.topbar');
      return {
        board, wrap, hud, stage, dpad, bomb, topbar,
        vw: window.innerWidth,
        vh: window.innerHeight,
        boardCss: getComputedStyle(document.getElementById('board')).width,
        hudOverflowX: (() => {
          const h = document.getElementById('hud');
          return h.scrollWidth > h.clientWidth + 1;
        })(),
        vvh: getComputedStyle(document.documentElement).getPropertyValue('--vvh').trim(),
      };
    });

    check('棋盘完整可见', !!game.board && game.board.w >= 140 && game.board.bottom <= game.vh + 0.5 && game.board.top >= 0, JSON.stringify(game.board));
    check(
      '棋盘比例 15:13',
      Math.abs(game.board.w / game.board.h - 15 / 13) < 0.04,
      `${r(game.board.w)}×${r(game.board.h)} → ${(game.board.w / game.board.h).toFixed(3)}`
    );
    check('棋盘不超出舞台', game.board.left >= game.stage.left - 0.5 && game.board.right <= game.stage.right + 0.5);

    const rail = c.bp === 'xl';
    if (rail) {
      check('宽屏 HUD 在右侧且不重叠', game.hud.left >= game.board.right - 0.5, `hud.left ${r(game.hud.left)} board.right ${r(game.board.right)}`);
    } else {
      check('HUD 在棋盘下方且不重叠', game.hud.top >= game.board.bottom - 0.5, `hud.top ${r(game.hud.top)} board.bottom ${r(game.board.bottom)}`);
    }
    check('HUD 不横向溢出', !game.hudOverflowX);

    if (c.touch) {
      check('摇杆已显示', !!game.dpad && !!game.bomb);
      if (c.ctrl === 'side') {
        check('横屏摇杆在棋盘左侧', game.dpad.right <= game.board.left + 0.5, `dpad.right ${r(game.dpad.right)} board.left ${r(game.board.left)}`);
        check('横屏放弹键在棋盘右侧', game.bomb.left >= game.board.right - 0.5, `bomb.left ${r(game.bomb.left)} board.right ${r(game.board.right)}`);
        check('摇杆不遮挡 HUD', game.dpad.bottom <= game.hud.top + 0.5 || game.dpad.top >= game.hud.bottom - 0.5 || game.dpad.right <= game.hud.left + 0.5, '');
      } else {
        check('竖屏摇杆在棋盘下方', game.dpad.top >= game.board.bottom - 0.5, `dpad.top ${r(game.dpad.top)} board.bottom ${r(game.board.bottom)}`);
      }
      check('放弹键直径 ≥ 64px', game.bomb.w >= 64, `${r(game.bomb.w)}px`);
      check('摇杆按钮 ≥ 44px', await page.evaluate(() => {
        const b = document.querySelector('.tbtn.up').getBoundingClientRect();
        return b.width >= 44 && b.height >= 44;
      }));
    } else {
      check('桌面端不显示摇杆', !game.dpad);
    }

    console.log(`  棋盘 ${r(game.board.w)}×${r(game.board.h)}（比例 ${(game.board.w / game.board.h).toFixed(3)}）`);
    check('视口变量已写入', !!game.vvh, game.vvh);
    check('无页面报错', errs.length === 0, errs[0]);

    // 存图供人工复核
    const tag = `${c.w}x${c.h}`;
    await page.screenshot({ path: require('path').join(__dirname, '..', 'shots', `r-${tag}.png`) });

    await ctx.close();
  }

  await browser.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项：\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exit(1);
  }
  console.log('响应式布局验收全部通过');
})();
