'use strict';
/* ============================================================
   v1.1 体验增强验收（真实浏览器）
   ------------------------------------------------------------
   覆盖：
     A. 设置中心：打开/焦点陷阱/Esc/inert、减少动效、
        操作提示、音量持久化、重载后生效
     B. 本地战绩：预置数据渲染、汇总统计、二次确认清空
     C. 邀请链接：?room= 预填、无效房号清理
     D. 房间聊天：启用状态、字数统计、发送回显、
        XSS 注入防护、剪贴板复制、离开时清理
     E. 对局中：聊天禁用
   前置：服务器已运行在 127.0.0.1:3000（npm start）
   ============================================================ */
const { chromium } = require('playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:3000';
const ORIGIN = 'http://127.0.0.1:3000';
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

  /* ================= A. 设置中心 ================= */
  {
    console.log('【A. 设置中心】');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(BASE + '/');
    await page.waitForTimeout(400);

    check(
      'A1 首页有「设置/战绩」入口',
      (await page.isVisible('#btnSettings')) && (await page.isVisible('#btnStats'))
    );

    await page.click('#btnSettings');
    await page.waitForSelector('#screenSettings:not([hidden])');
    check('A2 点击打开设置弹层', true);
    check(
      'A3 打开时背景被标记 inert + aria-hidden',
      await page.evaluate(
        () => document.getElementById('screenHome').hasAttribute('inert') && document.getElementById('app').hasAttribute('inert')
      )
    );
    check(
      'A4 默认未开启减少动效',
      await page.evaluate(() => !document.body.classList.contains('reduce-motion'))
    );

    await page.waitForTimeout(120);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    check(
      'A5 Shift+Tab 焦点仍被困在弹层内',
      await page.evaluate(() => {
        const panel = document.querySelector('#screenSettings .panel');
        return panel.contains(document.activeElement);
      })
    );

    await page.click('#motionTabs button[data-motion="reduce"]');
    await page.waitForTimeout(350);
    check(
      'A6 选择「减少」后 body.reduce-motion 生效',
      await page.evaluate(() => document.body.classList.contains('reduce-motion'))
    );
    const savedMotion = await page.evaluate(() => {
      try {
        return (JSON.parse(localStorage.getItem('bubble.settings') || '{}') || {}).motion;
      } catch (e) {
        return null;
      }
    });
    check('A7 设置写入 localStorage', savedMotion === 'reduce', 'motion=' + savedMotion);

    check('A8 默认操作提示可见', await page.isVisible('.hint'));
    await page.click('#setTips');
    await page.waitForTimeout(350);
    check('A9 关闭操作提示后 .hint 隐藏', !(await page.isVisible('.hint')));

    await page.$eval('#setVolume', (el) => {
      el.value = '30';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(350);
    const savedVol = await page.evaluate(() => {
      try {
        return (JSON.parse(localStorage.getItem('bubble.settings') || '{}') || {}).volume;
      } catch (e) {
        return null;
      }
    });
    check('A10 音量 30% 持久化', savedVol === 0.3, 'volume=' + savedVol);
    check('A11 音量百分比文案同步', (await page.textContent('#volText')).trim() === '30%');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('A12 Esc 关闭设置弹层', await page.evaluate(() => document.getElementById('screenSettings').hidden));
    check(
      'A13 关闭后焦点回到触发按钮',
      await page.evaluate(() => document.activeElement && document.activeElement.id === 'btnSettings')
    );
    check(
      'A14 关闭后背景 inert 解除',
      await page.evaluate(() => !document.getElementById('screenHome').hasAttribute('inert'))
    );

    await page.reload();
    await page.waitForTimeout(400);
    check(
      'A15 重载后设置仍然生效（hide-tips + reduce-motion）',
      await page.evaluate(
        () => document.body.classList.contains('hide-tips') && document.body.classList.contains('reduce-motion')
      )
    );
    check('A16 设置页无脚本错误', errs.length === 0, errs.join('; '));

    await ctx.close();
  }

  /* ================= B. 本地战绩 ================= */
  {
    console.log('【B. 本地战绩】');
    const statsPayload = {
      v: 1,
      updatedAt: Date.now(),
      matches: [
        { id: 'm1', at: Date.now() - 1000, mode: 'pvp', teamMode: false, team: null, result: 'win', kills: 5, durationMs: 120000, humans: 2, bots: 0 },
        { id: 'm2', at: Date.now() - 2000, mode: 'hybrid', teamMode: true, team: 1, result: 'win', kills: 3, durationMs: 90000, humans: 2, bots: 2 },
        { id: 'm3', at: Date.now() - 3000, mode: 'pve', teamMode: false, team: null, result: 'lose', kills: 1, durationMs: 60000, humans: 1, bots: 3 },
      ],
    };
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((p) => {
      try {
        localStorage.setItem('bubble.stats', JSON.stringify(p));
      } catch (e) {}
    }, statsPayload);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(BASE + '/');
    await page.waitForTimeout(400);

    await page.click('#btnStats');
    await page.waitForSelector('#screenStats:not([hidden])');
    await page.waitForTimeout(120);

    check('B1 场次统计正确', (await page.textContent('#statTotal')).trim() === '3');
    check('B2 胜率统计正确（2/3）', (await page.textContent('#statWinRate')).trim() === '66.7%');
    check('B3 最高淘汰正确', (await page.textContent('#statBest')).trim() === '5');
    const rows = await page.evaluate(() => document.querySelectorAll('#statList .stat-item').length);
    check('B4 战绩列表渲染 3 条', rows === 3, `rows=${rows}`);

    // 二次确认清空：第一次点击只进入确认态
    await page.click('#btnClearStats');
    await page.waitForTimeout(120);
    check(
      'B5 第一次点击进入「确认清空？」而非直接清空',
      (await page.evaluate(() => document.getElementById('statList').children.length)) === 3
    );
    await page.click('#btnClearStats');
    await page.waitForTimeout(200);
    check('B6 第二次点击才真正清空', (await page.textContent('#statTotal')).trim() === '0');
    check(
      'B7 清空后显示空态提示',
      (await page.evaluate(() => !!document.querySelector('#statList .stat-empty')))
    );

    await page.click('#btnStatsDone');
    await page.waitForTimeout(150);
    check('B8 关闭战绩弹层', await page.evaluate(() => document.getElementById('screenStats').hidden));
    check('B9 战绩页无脚本错误', errs.length === 0, errs.join('; '));

    await ctx.close();
  }

  /* ================= C. 邀请链接参数 ================= */
  {
    console.log('【C. 邀请链接参数】');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));

    await page.goto(BASE + '/?room=ABCD');
    await page.waitForTimeout(500);
    check('C1 合法房号自动填入输入框', (await page.inputValue('#codeInput')) === 'ABCD');

    await page.goto(BASE + '/?room=zz!!');
    await page.waitForTimeout(500);
    const urlClean = await page.evaluate(() => !location.search.includes('room'));
    check('C2 无效房号被从地址栏清理', urlClean, 'search=' + (await page.evaluate(() => location.search)));
    check('C3 无效房号不填入输入框', (await page.inputValue('#codeInput')) === '');
    check('C4 参数页无脚本错误', errs.length === 0, errs.join('; '));

    await ctx.close();
  }

  /* ================= D. 房间聊天 + 邀请复制 ================= */
  {
    console.log('【D. 房间聊天 + 邀请复制】');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));

    await page.goto(BASE + '/');
    await page.waitForTimeout(400);
    await page.fill('#nameInput', '甲');
    await page.click('#btnCreate');
    await page.waitForSelector('#screenRoom:not([hidden])');
    const code = (await page.textContent('#roomCode')).trim();
    check('D1 进房后地址栏带上 ?room=', await page.evaluate(() => location.search.includes('room=')), 'search=' + (await page.evaluate(() => location.search)));

    check('D2 等待期聊天可用', await page.evaluate(() => !document.getElementById('chatInput').disabled));
    const chips = await page.evaluate(() => document.querySelectorAll('#chatQuick .chip').length);
    check('D3 快捷语 8 条', chips === 8, `chips=${chips}`);
    check('D4 初始字数 0/40', (await page.textContent('#chatCount')).trim() === '0/40');

    await page.fill('#chatInput', '大家好');
    await page.waitForTimeout(120);
    check('D5 输入后字数同步 3/40', (await page.textContent('#chatCount')).trim() === '3/40');
    await page.click('#btnChatSend');
    await page.waitForSelector('#chatLog .chat-item');
    check('D6 消息发送后回显', (await page.textContent('#chatLog')).includes('大家好'));
    check('D7 发送后输入框清空', (await page.inputValue('#chatInput')) === '');

    // XSS 注入防护：文本只能以纯文本呈现
    await page.fill('#chatInput', '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>');
    await page.click('#btnChatSend');
    await page.waitForTimeout(500);
    check(
      'D8 聊天内容不执行注入脚本',
      await page.evaluate(() => !window.__xss)
    );
    check(
      'D9 聊天日志里没有 img/script 节点',
      await page.evaluate(
        () => !document.querySelector('#chatLog img') && !document.querySelector('#chatLog script')
      )
    );

    // 复制邀请链接
    await page.click('#btnInvite');
    await page.waitForTimeout(400);
    let clipOk = false;
    let clipText = '';
    try {
      clipText = await page.evaluate(() => navigator.clipboard.readText());
      clipOk = clipText.includes('?room=' + code);
    } catch (e) {
      clipText = String(e).slice(0, 60);
    }
    const fallbackShown = await page.evaluate(() => !document.getElementById('inviteUrl').hidden);
    check('D10 邀请链接复制成功或降级显示', clipOk || fallbackShown, clipOk ? clipText : 'fallback=' + fallbackShown);

    // 离开房间：URL 与聊天一并清理
    await page.click('#btnLeave');
    await page.waitForSelector('#screenHome:not([hidden])');
    await page.waitForTimeout(200);
    check('D11 离开后地址栏去掉 ?room=', await page.evaluate(() => !location.search.includes('room')));
    check(
      'D12 离开后聊天日志清空且禁用',
      await page.evaluate(
        () => document.getElementById('chatLog').children.length === 0 && document.getElementById('chatInput').disabled
      )
    );
    check('D13 聊天页无脚本错误', errs.length === 0, errs.join('; '));

    await ctx.close();
  }

  /* ================= E. 对局中聊天禁用 ================= */
  {
    console.log('【E. 对局中聊天禁用】');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));

    await page.goto(BASE + '/');
    await page.waitForTimeout(400);
    await page.click('#modeTabs .mode[data-mode="pve"]');
    await page.fill('#nameInput', '独行侠');
    await page.click('#btnQuick');
    // 人机对战：1 真人 + 3 AI，直接开局
    await page.waitForFunction(() => window.__game && window.__game.screen === 'game', null, { timeout: 20000 });
    await page.waitForTimeout(500);
    check(
      'E1 对局进行中聊天被禁用',
      await page.evaluate(() => document.getElementById('chatInput').disabled)
    );
    check(
      'E2 禁用态占位文案切换',
      (await page.getAttribute('#chatInput', 'placeholder')) === '对局进行中不可聊天'
    );
    check('E3 对局页无脚本错误', errs.length === 0, errs.join('; '));

    await ctx.close();
  }

  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail === 0) console.log('v1.1 体验增强验收全部通过');
})().catch((e) => {
  console.error('测试执行失败：', e);
  process.exit(1);
});
