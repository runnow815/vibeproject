/* 墨战 · 手机端响应式真机实测（CDP + 本机 Edge，零依赖）
 * 用法：node tools/check-mobile.js
 *
 * smoke-ui 的响应式断言是「CSS 静态匹配 + JS 打桩」两路，量不到**真实布局**；
 * 本工具起一个无头 Edge，按 8 档机型（手机/窄屏/横屏/平板）做设备模拟，
 * 逐档量：横纵向溢出 / 棋盘宽高与 16:9 / 卡栏是否出屏 / 提示是否可见 / 手牌张数 /
 *         触控热区（O9 要求 ≥44px）/ 菜单面板是否可滚，并把每档截图存到临时目录。
 * 需要本机装 Edge（自动探测常见路径）；退出码非 0 = 有问题。 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const EDGE = EDGE_CANDIDATES.find(p => fs.existsSync(p));
const FILE = 'file:///' + path.join(__dirname, '..', 'inkwar.html').replace(/\\/g, '/') + '?debug';
const PORT = process.env.MOB_PORT || 9333;

const DEVICES = [
  { name: 'iPhone13-竖',  w: 390,  h: 844,  mobile: true,  dsf: 3, land: false },
  { name: 'iPhoneSE-竖',  w: 375,  h: 667,  mobile: true,  dsf: 2, land: false },
  { name: 'Android-竖',   w: 360,  h: 640,  mobile: true,  dsf: 3, land: false },
  { name: '极窄-竖',      w: 320,  h: 568,  mobile: true,  dsf: 2, land: false },
  { name: 'iPhone13-横',  w: 844,  h: 390,  mobile: true,  dsf: 3, land: true  },
  { name: 'Android-横',   w: 640,  h: 360,  mobile: true,  dsf: 3, land: true  },
  { name: 'iPad-竖',      w: 820,  h: 1180, mobile: true,  dsf: 2, land: false },
  { name: 'iPad-横',      w: 1180, h: 820,  mobile: true,  dsf: 2, land: true  },
];

const MEASURE = `(() => {
  const de = document.documentElement;
  const r = s => { const e = document.querySelector(s); if (!e) return null;
    const b = e.getBoundingClientRect();
    return { t: Math.round(b.top), l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height),
             b: Math.round(b.bottom), r: Math.round(b.right),
             disp: getComputedStyle(e).display, vis: getComputedStyle(e).visibility }; };
  const cs = getComputedStyle(de);
  return {
    vw: innerWidth, vh: innerHeight,
    scrollW: de.scrollWidth, scrollH: de.scrollHeight,
    reserve: cs.getPropertyValue('--stage-reserve').trim(),
    vvh: cs.getPropertyValue('--vvh').trim(),
    /* v1.27：画布比例参数化（竖屏放宽到 1.35 让棋盘变大），实测按当前断点的目标比例判定 */
    boardAr: parseFloat(cs.getPropertyValue('--board-ar')) || 16 / 9,
    topbar: r('.topbar'), stage: r('.stage'), board: r('#board'),
    cardbar: r('.cardbar'), cards: r('.cards'), hint: r('.hint'), piles: r('.piles'),
    ratio: r('.ratio'), dpad: r('.dpad'),
    handCount: document.querySelectorAll('#cards .card').length,
    /* 触控热区：手牌 / 比例 / 暂停 / 牌堆 的实际盒子（<44px 记为不可用） */
    pointerCoarse: matchMedia('(pointer:coarse)').matches,
    hoverNone: matchMedia('(hover:none)').matches,
    /* 触控热区：手牌 / 比例档位 / 暂停 / 难度 / 选项 / 大按钮 / 联机入口 / 屏内缩放三键 */
    taps: ['#cards .card', '.ratio b', '#btnPause', '.lvl', '.opt', '.bb', '#btnHostCode', '#zIn', '#zOut', '#zFit']
      .map(s => { const e = document.querySelector(s); if (!e) return { s, w: 0, h: 0 };
                  const b = e.getBoundingClientRect();
                  return { s, w: Math.round(b.width), h: Math.round(b.height) }; }),
    panelOverflowY: (document.querySelector('.panel') ? getComputedStyle(document.querySelector('.panel')).overflowY : ''),
    /* v1.37 屏内缩放条（触屏必须出现） */
    zbar: r('.zbar'),
    zbarOn: (function(){ var e = document.querySelector('.zbar'); return !!(e && e.classList && e.classList.contains('on')); })(),
    /* v1.37 联机入口可达性：菜单面板可滚，但入口埋在两屏之外等于找不到 —— 量它在滚动内容里的偏移 */
    pvpHostTop: (function(){
      var b = document.getElementById('btnHostCode'); if (!b) return -1;
      var p = document.querySelector('.panel');
      return Math.round(b.getBoundingClientRect().top - (p ? p.getBoundingClientRect().top : 0) + (p ? p.scrollTop : 0));
    })(),
    cardbarPos: (document.querySelector('.cardbar') ? getComputedStyle(document.querySelector('.cardbar')).position : ''),
    overlay: r('.overlay'), panel: r('.panel'),
    panelScrollH: (document.querySelector('.panel') || {}).scrollHeight || 0,
    bodyOverflowX: de.scrollWidth - innerWidth,
    bodyOverflowY: de.scrollHeight - innerHeight,
    mode: (window.__ink && window.__ink.mode) ? window.__ink.mode() : 'n/a',
    /* v1.38 开局视野：竖屏 cover 会裁掉大半地图，至少得让玩家看见自己的家 */
    side: (window.__ink && window.__ink.side) ? window.__ink.side() : 0,
    homeInView: (function(){
      var I = window.__ink; if (!I || !I.sim || !I.view || !I.side) return -1;
      var s = I.sim(); if (!s || !s.castles) return -1;
      var v = I.view(), c = document.getElementById('board'); if (!c) return -1;
      var cw = c.width || 1, ch = c.height || 1, n = 0, me = I.side();
      s.castles.forEach(function(cc){
        if (cc.owner !== me) return;
        var dx = (cc.x - 1600 / 2 - v.px) * v.k + cw / 2, dy = (cc.y - 900 / 2 - v.py) * v.k + ch / 2;
        if (dx >= 0 && dx <= cw && dy >= 0 && dy <= ch) n++;
      });
      return n;
    })(),
    /* v1.38 是否裁切（可见地图宽度 < 全图宽）：未裁切时平移本就无意义，不该判失败 */
    cropped: (function(){
      var I = window.__ink, c = document.getElementById('board');
      if (!I || !I.view || !c) return false;
      return (c.width / I.view().k) < 1598;
    })()
  };
})()`;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* v1.38：单指拖动必须能平移地图 —— 真机触摸实测。
   旧实现「只有双指才能平移」，而 check-mobile 此前只开了触摸模拟、从未真正派发过触摸事件，
   所以「手机上拖不动」一直没被测出来。这里补上端到端闸门：裁切态下单指拖必须挪动视野。 */
async function panTest(send){
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return (r.result && r.result.result) ? r.result.result.value : null;
  };
  const touch = (type, pts) => send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  /* 新手引导遮罩 .tutwall 会盖住整块棋盘（此时任何触摸都到不了 canvas）——先跳过引导再测。
     这正是此前「手机上不能拖动」一直没被测出来的原因之一。 */
  await ev('window.__ink && window.__ink.tutSkip && window.__ink.tutSkip()');
  await sleep(250);
  const B = await ev('(function(){var c=document.getElementById("board"); if(!c) return null; var r=c.getBoundingClientRect(); return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};})()');
  if (!B || B.w < 40) return { err: '无画布' };
  let pt = null;
  for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.25], [0.8, 0.25], [0.2, 0.75], [0.8, 0.75], [0.5, 0.12], [0.5, 0.88]]){
    const x = Math.round(B.x + B.w * fx), y = Math.round(B.y + B.h * fy);
    await touch('touchStart', [{ x, y, id: 1 }]);
    await sleep(60);
    const st = await ev('window.__ink.ptrState ? JSON.stringify(window.__ink.ptrState()) : "none"');
    await touch('touchEnd', []);
    await sleep(60);
    await ev('window.__ink && window.__ink.sel && window.__ink.sel().splice(0)');
    if (st && /"from":null/.test(st)){ pt = { x, y }; break; }
  }
  if (!pt) return { err: '找不到空白落点' };
  await ev('window.__ink.viewReset()');
  await sleep(80);
  const before = await ev('JSON.stringify(window.__ink.view())');
  /* 朝「还有空间」的一侧拖：viewReset 居中主城后视野常已贴到 clamp 边界，反方向拖会被钳住（Δ=0 的假失败） */
  const b0 = JSON.parse(before || '{}');
  const step = ((b0.px || 0) < -1) ? -18 : 18;
  await touch('touchStart', [{ x: pt.x, y: pt.y, id: 1 }]);
  await sleep(60);
  for (let i = 1; i <= 8; i++){ await touch('touchMove', [{ x: pt.x + i * step, y: pt.y, id: 1 }]); await sleep(45); }
  const during = await ev('JSON.stringify(window.__ink.view())');
  await touch('touchEnd', []);
  await sleep(120);
  return { pt: pt, before: JSON.parse(before || '{}'), during: JSON.parse(during || '{}') };
}

async function main(){
  if (!EDGE){ console.error('FAIL: 未找到本机 Edge / Chrome，请把路径加进 EDGE_CANDIDATES'); process.exit(1); }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwar-mob-'));   // 截图存临时目录，跑完自行清理
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgemob'));
  const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
                            '--user-data-dir=' + tmp, '--no-first-run', '--no-default-browser-check',
                            '--disable-gpu', '--hide-scrollbars', FILE], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60; i++){
    await sleep(300);
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      list = await res.json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) { list = p; break; }
    } catch (e){}
  }
  if (!list || !list.webSocketDebuggerUrl){ console.error('FAIL: 拿不到 page target'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(list.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const ready = new Promise(res => ws.addEventListener('open', res));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)){ pend.get(m.id)(m); pend.delete(m.id); }
  });
  await ready;
  const send = (method, params) => new Promise(res => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Page.enable'); await send('Runtime.enable'); await send('Emulation.enable'); await sleep(500);

  const rows = [];
  for (const d of DEVICES){
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setDeviceMetricsOverride', {
      width: d.w, height: d.h, deviceScaleFactor: d.dsf, mobile: d.mobile,
      screenOrientation: d.land ? { type: 'landscapePrimary', angle: 90 }
                                : { type: 'portraitPrimary', angle: 0 }
    });
    await sleep(700);
    /* v1.37：菜单在页面加载时（默认视口）就渲染好了，设备模拟改了视口后必须重排一次，
       否则量到的是旧视口下排出来的菜单（联机入口位置不随断点变化）。 */
    await send('Runtime.evaluate', { expression:
      "(function(){if(window.__ink&&window.__ink.menu){window.__ink.menu();return 1;} return 0;})()" });
    await sleep(400);
    /* 菜单态量一遍，再点「开战」进对局态量一遍（对局态才是手机端真正要用的布局） */
    const ev0 = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    const menu = (ev0.result && ev0.result.result && ev0.result.result.value) || {};
    await send('Runtime.evaluate', { expression:
      "(function(){var b=document.getElementById('btnQuick'); if(b&&b.onclick){b.onclick();return 1;} if(b){b.click();return 2;} return 0;})()" });
    await sleep(900);
    const ev = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    const m = ev.result && ev.result.result && ev.result.result.value;
    if (!m) { rows.push({ name: d.name, err: 'eval 失败' }); continue; }
    m.menu = menu;
    m.pan = await panTest(send);          /* v1.38：单指平移真机实测 */
    rows.push(Object.assign({ name: d.name }, m));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data)
      fs.writeFileSync(path.join(outDir, d.name + '.png'), Buffer.from(shot.result.data, 'base64'));
    /* 回菜单，供下一档机型从头量 */
    await send('Runtime.evaluate', { expression:
      "(function(){var b=document.getElementById('btnMenu1'); if(b&&b.onclick){b.onclick();return 1;} if(window.__ink&&window.__ink.menu){window.__ink.menu();return 2;} return 0;})()" });
    await sleep(400);
  }
  fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify(rows, null, 1));
  /* 逐项判定：溢出 / 贴底 / 提示可见 / 棋盘占比 / 卡面可点 */
  const bad = [];
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('机型', 14) + pad('视口', 10) + pad('横向溢出', 9) + pad('纵向溢出', 9) +
              pad('棋盘(w×h)', 12) + pad('棋盘占高', 9) + pad('卡栏底', 8) + pad('提示h', 7) + '判定');
  for (const m of rows){
    if (m.err){ console.log(pad(m.name, 14) + m.err); bad.push(m.name + ':' + m.err); continue; }
    const issues = [];
    if (m.bodyOverflowX > 1) issues.push('横向溢出' + m.bodyOverflowX);
    if (m.bodyOverflowY > 1) issues.push('纵向溢出' + m.bodyOverflowY);
    if (!m.hint || m.hint.h < 10 || m.hint.disp === 'none') issues.push('提示不可见');
    if (!m.cardbar || m.cardbar.b > m.vh + 1) issues.push('卡栏出屏' + (m.cardbar ? m.cardbar.b - m.vh : 0));
    if (!m.stage || m.stage.w < 120) issues.push('棋盘过窄' + (m.stage ? m.stage.w : 0));
    if (!m.cards || m.cards.h < 40) issues.push('卡面过矮' + (m.cards ? m.cards.h : 0));
    if (!m.board || !m.stage) issues.push('缺画布/舞台');
    else if (Math.abs(m.board.w - m.stage.w) > 2) issues.push('画布与舞台不等宽');
    /* v1.37 竖屏：画布由 flex 撑满舞台，比例不再等于 --board-ar（那是 JS 未就绪时的兜底值） */
    const isNarrowPortrait = m.vw <= 700 && m.vh > m.vw;
    const isPhone = isNarrowPortrait || (m.vw <= 950 && m.vw > m.vh);   // 手机竖屏 or 手机横屏（平板不算）
    if (isNarrowPortrait){
      if (Math.abs(m.board.h - m.stage.h) > 2) issues.push('竖屏画布未铺满舞台(' + m.board.h + ' vs ' + m.stage.h + ')');
    } else if (m.board && Math.abs(m.board.w / m.board.h - (m.boardAr || 16 / 9)) > 0.03)
      issues.push('画布比例≠--board-ar(' + (m.board.w / m.board.h).toFixed(2) + ' vs ' + (m.boardAr || 16 / 9) + ')');
    /* v1.27 → v1.37：手机竖屏棋盘必须吃下足够屏高（改版前 iPhone13 实测仅 33%，现在要求 ≥45%）。
       平板竖屏（>700px 宽）走桌面 16:9 分支，443px 的绝对高度已够用，仍按 ≥30% 判。 */
    if (m.board && isNarrowPortrait && m.board.h / m.vh < 0.55)
      issues.push('手机竖屏棋盘占高不足55%(' + (m.board.h / m.vh * 100).toFixed(0) + '%)');
    else if (m.board && m.vh > m.vw * 1.3 && m.board.h / m.vh < 0.3)
      issues.push('竖屏棋盘占高不足30%(' + (m.board.h / m.vh * 100).toFixed(0) + '%)');
    /* v1.37 竖屏死白复查：舞台上下各自的多余间隙不得超过 90px（改版前 iPhone13 竖屏合计 300px） */
    if (m.board && m.stage && m.topbar && m.cardbar){
      const gapTop = m.stage.t - m.topbar.b, gapBot = m.cardbar.t - m.stage.b;
      if (isNarrowPortrait && (gapTop > 90 || gapBot > 90))
        issues.push('竖屏纵向死白过大(上' + gapTop + ' 下' + gapBot + ')');
    }
    /* v1.38 单指平移闸门：画布被裁切（地图有部分在屏外）时，一根手指必须能拖动地图 */
    if (m.cropped){
      if (!m.pan || m.pan.err) issues.push('单指平移无法实测(' + ((m.pan && m.pan.err) || '?') + ')');
      else {
        const d = Math.abs((m.pan.during.px || 0) - (m.pan.before.px || 0));
        if (d < 5) issues.push('单指拖不动地图(Δpx=' + d.toFixed(1) + ')');
      }
    }
    /* v1.38 开局视野内至少看得见一座己方城（居中主城，别把家裁到屏外） */
    if (isPhone && m.homeInView === 0) issues.push('开局视野内看不到己方城');
    if (m.mode !== 'playing') issues.push('未进入对局态(' + m.mode + ')');
    if (!m.pointerCoarse) issues.push('pointer:coarse 未命中(触摸模拟没生效)');
    /* 顶栏必须装得下按钮（按钮 44 高、顶栏不能比它矮，否则溢出到棋盘上方） */
    const pb = (m.taps||[]).filter(t=>t.s==='#btnPause')[0];
    if (pb && m.topbar && pb.h > m.topbar.h + 1) issues.push('暂停按钮高于顶栏('+pb.h+'>'+m.topbar.h+')');
    if (m.handCount !== 5) issues.push('手牌非5张(' + m.handCount + ')');
    /* 触控热区 <40px 记一条（手牌另按高度判，见下） */
    const small = (m.taps || []).filter(t => t.s !== '#cards .card' && t.w > 0 && (t.h < 40 || t.w < 40));
    if (small.length) issues.push('热区偏小:' + small.map(t => t.s + '(' + t.w + '×' + t.h + ')').join(','));
    /* v1.37：手牌高度另判 —— `@media (pointer:coarse)` 的 44px 曾覆盖断点里的 76px（触屏比桌面还矮） */
    const card = (m.taps || []).filter(t => t.s === '#cards .card')[0];
    /* 横屏侧栏纵向预算只有 ~326px（5 张卡 + 比例 + 牌堆 + 提示），卡片只能保 44px 触控下限 */
    const cardMin = isNarrowPortrait ? 64 : 44;
    if (card && card.h < cardMin) issues.push('手牌过矮(' + card.h + '，要求 ≥' + cardMin + ')');
    /* v1.37 屏内缩放条：触屏必须出现且热区 44×44 */
    if (m.zbarOn !== true) issues.push('触屏未出现屏内缩放条');
    if (m.zbar && (m.zbar.w < 40 || m.zbar.h < 40)) issues.push('缩放按钮热区偏小(' + m.zbar.w + '×' + m.zbar.h + ')');
    /* v1.37：联机入口不能被埋在两三屏之外（菜单面板可滚，但手机上滚这么远基本等于找不到） */
    const hostTop = (m.menu && m.menu.pvpHostTop != null) ? m.menu.pvpHostTop : -1;
    if (hostTop < 0) issues.push('菜单态量不到联机入口');
    else if (isPhone && hostTop > m.vh) issues.push('联机入口需滚动才可见(top=' + hostTop + ' 视口=' + m.vh + ')');
    /* 菜单态：面板必须能滚（内容高于面板时 overflow 应为 auto/scroll） */
    if (m.menu && m.menu.panel && m.menu.panelScrollH > m.menu.panel.h + 2 &&
        !/auto|scroll/.test(m.menu.panelOverflowY || '')) issues.push('菜单面板不可滚动');
    if (m.menu && (m.menu.bodyOverflowX > 1)) issues.push('菜单横向溢出' + m.menu.bodyOverflowX);
    if (issues.length) bad.push(m.name + ' → ' + issues.join(' / '));
    console.log(pad(m.name, 14) + pad(m.vw + '×' + m.vh, 10) + pad(m.bodyOverflowX, 9) + pad(m.bodyOverflowY, 9) +
                pad((m.board ? m.board.w + '×' + m.board.h : '-'), 12) +
                pad((m.board ? (m.board.h / m.vh * 100).toFixed(0) + '%' : '-'), 9) +
                pad((m.cardbar ? m.cardbar.b : '-'), 8) + pad((m.hint ? m.hint.h : '-'), 7) +
                pad(m.cardbarPos, 8) +
                (issues.length ? '✗ ' + issues.join(' / ') : '✓'));
  }
  console.log('\n截图与原始数据：' + outDir);
  console.log(bad.length ? '问题 ' + bad.length + ' 项：\n - ' + bad.join('\n - ') : '全部通过 ✓');
  ws.close(); proc.kill();
  if (bad.length) process.exit(1);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch(e){}
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
