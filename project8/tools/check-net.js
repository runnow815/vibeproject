/* 墨战 · 联机端到端实测（两个独立无头 Edge 实例，零依赖）
 * 用法：node tools/check-net.js            （自动起本地静态服务）
 *       node tools/check-net.js --keep     （跑完保留临时目录）
 *       node tools/check-net.js --desktop  （桌面视口，不模拟移动端）
 *       node tools/check-net.js --room     （v1.39 房间码模式：线上域名 + CDP 注入本地代码，需联网）
 *
 * smoke-ui 的联机断言是「假 DataChannel + 打桩」，验证不了真实的
 * ICE 收集 / STUN 取地址 / DataChannel 建立 / 断线后续连。本工具真开两个浏览器，
 * 走完一条完整链路并逐环节断言：
 *   ① 房主建房间出码   ② 客机凭码应答   ③ 房主完成连接 → 双方进等待室
 *   ④ 双方准备 → 倒计时发车 → 双方进对局
 *   ⑤ 主机出兵 → 客机快照同步（同一支部队出现在客机侧）
 *   ⑥ 掐断 DataChannel → 双方出「断连」遮罩 → 点「重新连接」互换一次码 → 续上同一局
 * 退出码非 0 = 有环节失败。 */
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p => fs.existsSync(p));
const ROOT = path.join(__dirname, '..');
const PORT_HTTP = 8899;
const BASE = 'http://127.0.0.1:' + PORT_HTTP + '/inkwar.html';

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra){
  if (cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* 移动端模拟：视口按 iPhone13 竖屏，并开 touch 模拟（只设 setDeviceMetricsOverride 不命中 pointer:coarse） */
async function emulateMobile(send){
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
}

async function openBrowser(port, url, mobile){
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inknet' + port));
  const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + port,
    '--user-data-dir=' + tmp, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--no-proxy-server', url], { stdio: 'ignore' });
  let pg = null;
  for (let i = 0; i < 60; i++){
    await sleep(300);
    try {
      const arr = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const p = arr.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p){ pg = p; break; }
    } catch (e){}
  }
  if (!pg) throw new Error('拿不到 page target（端口 ' + port + '）');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const errs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)){ pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown')
      errs.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text || '');
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (m, p) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  await send('Page.enable'); await send('Runtime.enable');
  if (mobile) await emulateMobile(send);
  await sleep(1200);
  return {
    errs, tmp, proc,
    eval: async (expr) => {
      const e = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (e && e.exceptionDetails) return { __err: (e.exceptionDetails.exception && e.exceptionDetails.exception.description) || e.exceptionDetails.text };
      return (e.result && e.result.result && e.result.result.value);
    },
    goto: async (u) => { await send('Page.navigate', { url: u }); await sleep(2200); },
    close: () => { try { ws.close(); } catch (e){} try { proc.kill(); } catch (e){} }
  };
}
/* 轮询等待：fn 返回真即通过 */
async function until(b, expr, ms, step){
  const n = Math.max(1, Math.ceil(ms / (step || 400)));
  for (let i = 0; i < n; i++){
    const v = await b.eval(expr);
    if (v && (typeof v !== 'object' || Object.keys(v).length)) return v;
    await sleep(step || 400);
  }
  return null;
}

/* ===== v1.39 房间码模式（node tools/check-net.js --room） =====
 * 云服务端做 exact-Origin 校验，本地 http / file:// 都会被拒 —— 所以这里导航到**线上域名**，
 * 再用 CDP Fetch 域把文档响应替换成本地 inkwar.html：Origin 是线上的、跑的是本地代码，
 * 不必先发布就能端到端验证房间码（也因此默认不跑，只有 --room 才联网）。 */
const ROOM_URL = 'https://inkwar.app.workbuddy.host/inkwar.html?debug';
async function openOnline(port){
  const body = Buffer.from(fs.readFileSync(path.join(ROOT, 'inkwar.html'), 'utf8'), 'utf8').toString('base64');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkroom' + port));
  const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + port,
    '--user-data-dir=' + tmp, '--no-first-run', '--no-proxy-server'], { stdio: 'ignore' });
  let pg = null;
  for (let i = 0; i < 60; i++){
    await sleep(300);
    try {
      const arr = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const p = arr.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p){ pg = p; break; }
    } catch (e){}
  }
  if (!pg) throw new Error('拿不到 page target（端口 ' + port + '）');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const errs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)){ pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Fetch.requestPaused')
      ws.send(JSON.stringify({ id: 99999, method: 'Fetch.fulfillRequest',
        params: { requestId: m.params.requestId, responseCode: 200,
                  responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: body } }));
    if (m.method === 'Runtime.exceptionThrown')
      errs.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text || '');
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (m, p) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*inkwar.html*', requestStage: 'Request' }] });
  await send('Page.navigate', { url: ROOM_URL });
  await sleep(3000);
  return {
    errs, proc,
    eval: async (expr) => {
      const e = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (e && e.exceptionDetails) return { __err: (e.exceptionDetails.exception && e.exceptionDetails.exception.description) || e.exceptionDetails.text };
      return (e.result && e.result.result && e.result.result.value);
    },
    close: () => { try { ws.close(); } catch (e){} try { proc.kill(); } catch (e){} }
  };
}
async function roomMain(){
  if (!EDGE){ console.error('FAIL: 未找到 Edge / Chrome'); process.exit(1); }
  console.log('【房间码模式】线上域名 + CDP 注入本地代码（Origin 必须与云服务 endpoint 一致）');
  const A = await openOnline(9501), B = await openOnline(9502);
  ok((await A.eval('window.__ink && window.__ink.ver()')) === (await B.eval('window.__ink && window.__ink.ver()')),
     '两端跑的都是本地同一版代码', String(await A.eval('window.__ink.ver()')));

  console.log('【① 房主建房】');
  await A.eval('(function(){document.getElementById("btnHostCode").click(); return 1;})()');
  const got = await until(A, '(function(){var e=document.getElementById("roomCodeBox"); return e && (e.textContent||"").trim().length===6 ? 1 : 0;})()', 40000, 800);
  const code = await A.eval('(function(){var e=document.getElementById("roomCodeBox"); return e ? (e.textContent||"").trim() : "";})()');
  ok(!!got && /^[A-Z2-9]{6}$/.test(code), '房主拿到 6 位房间码',
     JSON.stringify(code) + ' | pvpBox=' + JSON.stringify(await A.eval('(function(){var b=document.getElementById("pvpBox"); return b ? (b.textContent||"").slice(0,200) : "NO BOX";})()')));
  ok(code === (await A.eval('window.__ink.roomCode()')), '房间码记入状态（握手后应被清空）');
  if (!got){ A.close(); B.close(); console.log('\n通过 ' + pass + ' · 失败 ' + fail); process.exit(1); }

  console.log('【② 客机输码加入】');
  await B.eval('(function(){document.getElementById("btnJoinCode").click(); return 1;})()');
  await sleep(600);
  ok(!!(await B.eval('!!document.getElementById("roomIn")')), '客机出现房间码输入框');
  await B.eval('(function(){var e=document.getElementById("roomIn"); e.value=' + JSON.stringify(code) +
               '; document.getElementById("doJoinRoom").click(); return 1;})()');

  console.log('【③ 握手】');
  const aOpen = await until(A, 'window.__ink.netCh() && window.__ink.netCh().readyState === "open"', 45000, 800);
  const bOpen = await until(B, 'window.__ink.netCh() && window.__ink.netCh().readyState === "open"', 45000, 800);
  ok(!!aOpen, '房主侧数据通道已打开');
  ok(!!bOpen, '客机侧数据通道已打开');
  ok((await A.eval('window.__ink.netRole()')) === 'host' && (await B.eval('window.__ink.netRole()')) === 'guest',
     '角色正确 host / guest');
  ok(!!(await until(A, 'window.__ink.netLobby()', 15000, 500)), '进入等待室');
  ok((await A.eval('window.__ink.roomCode()')) === '', '握手后房间码作废（不能二次加入）');

  console.log('\n【控制台异常】');
  const ea = A.errs.filter(Boolean), eb = B.errs.filter(Boolean);
  ok(ea.length === 0, '房主侧无 JS 异常', ea.slice(0, 2).join(' | '));
  ok(eb.length === 0, '客机侧无 JS 异常', eb.slice(0, 2).join(' | '));

  console.log('\n通过 ' + pass + ' · 失败 ' + fail + (fail ? '\n - ' + fails.join('\n - ') : '  全部通过 ✓'));
  A.close(); B.close();
  if (fail) process.exit(1);
}

async function main(){
  if (!EDGE){ console.error('FAIL: 未找到 Edge / Chrome'); process.exit(1); }
  /* 本地静态服务（?join= 自动填码需要 http://） */
  let httpd = null;
  try { await fetch('http://127.0.0.1:' + PORT_HTTP + '/inkwar.html', { }); }
  catch (e){ httpd = spawn(process.platform === 'win32' ? 'python' : 'python3',
      ['-m', 'http.server', String(PORT_HTTP), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
    await sleep(1500); }

  const MOBILE = process.argv.indexOf('--desktop') < 0;
  console.log('【① 房主建房间】' + (MOBILE ? '（移动端模拟 390×844 + 触摸）' : '（桌面视口）'));
  const A = await openBrowser(9444, BASE + '?debug', MOBILE);
  /* 移动端必须能「够得着」联机入口：入口埋在两屏之外等于联机不可用 */
  const hostBox = await A.eval("(function(){var b=document.getElementById('btnHostCode'); if(!b) return null;" +
    "var r=b.getBoundingClientRect(); return {top:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)," +
    "vh:innerHeight,coarse:matchMedia('(pointer:coarse)').matches};})()");
  ok(!!hostBox, '移动端菜单里能拿到「创建房间（房间码）」按钮');
  if (hostBox){
    ok(hostBox.top >= 0 && hostBox.top < hostBox.vh,
       '移动端「创建房间」在首屏可见（不用滚两屏）', 'top=' + hostBox.top + ' 视口=' + hostBox.vh);
    ok(hostBox.h >= 40 && hostBox.w >= 40, '移动端「创建房间」热区达标', hostBox.w + '×' + hostBox.h);
    if (MOBILE) ok(hostBox.coarse === true, '移动端 pointer:coarse 已命中（触摸模拟生效）');
  }
  /* v1.39：手动换码收进了「备用」折叠区 —— 先展开再点，走的就是真实用户路径 */
  await A.eval("(function(){var m=document.getElementById('btnManual'); if(m) m.click(); document.getElementById('btnHost').click();})()");
  const code = await until(A, "(document.getElementById('invUrl')||{}).value || null", 20000);
  ok(!!code, '房主生成邀请码', code ? code.length + ' 字' : 'null');
  if (!code){ A.close(); if (httpd) httpd.kill(); process.exit(1); }
  const ice = await A.eval("(function(){var n=document.querySelectorAll('.pvpcode'); return n.length? n[n.length-1].textContent : '';})()");
  ok(/已收集|正在收集/.test(ice), '给出候选收集情况（跨网能不能连一眼可知）', ice);
  const share = await A.eval("!!document.getElementById('shareInv')");
  ok(true, '分享按钮存在性：' + share + '（http 下有 Web Share 才显示）');

  console.log('【② 客机凭码应答】');
  const joinUrl = /^https?:/.test(code) ? code : (BASE + '?join=' + code);
  const B = await openBrowser(9445, joinUrl + (/^https?:/.test(code) ? '&debug' : ''), MOBILE);
  const pre = await B.eval("(document.getElementById('offIn')||{}).value || ''");
  ok(pre.length > 50, '客机打开邀请链接自动填码', pre.length + ' 字');
  await B.eval("document.getElementById('doJoin').click()");
  const ans = await until(B, "(document.getElementById('ansUrl')||{}).value || null", 20000);
  ok(!!ans, '客机生成应答码', ans ? ans.length + ' 字' : 'null');

  console.log('【③ 房主完成连接】');
  await A.eval("(function(){document.getElementById('ansIn').value=" + JSON.stringify(ans) +
               ";document.getElementById('acceptAns').click();})()");
  const lobby = await until(A, "!!document.getElementById('btnReady') && __ink.mode()", 15000);
  const lobbyB = await until(B, "!!document.getElementById('btnReady') && __ink.mode()", 15000);
  ok(!!lobby, '房主进入等待室'); ok(!!lobbyB, '客机进入等待室');

  console.log('【④ 双方准备 → 开局】');
  await A.eval("document.getElementById('btnReady').click()");
  await B.eval("document.getElementById('btnReady').click()");
  const playA = await until(A, "__ink.mode()==='playing' && 'playing'", 20000);
  const playB = await until(B, "__ink.mode()==='playing' && 'playing'", 20000);
  ok(!!playA, '房主进入对局'); ok(!!playB, '客机进入对局');
  const seedA = await A.eval("__ink.sim().rngSeed");
  const seedB = await B.eval("__ink.sim().rngSeed");
  ok(seedA != null && seedA === seedB, '双方同一张地图（种子一致）', 'A=' + seedA + ' B=' + seedB);

  console.log('【⑤ 状态同步】');
  const sent = await A.eval(`(function(){
    var s = __ink.sim(); var mine = s.castles.filter(function(c){ return c.owner === 1; })[0];
    var far = s.castles.filter(function(c){ return c.owner !== 1; })[0];
    if (!mine || !far) return 0;
    __ink.cmd({ type: 'send', owner: 1, from: [{ k: 'c', id: mine.id }], to: { k: 'c', id: far.id }, ratio: 1 });
    __ink.step(1/30);
    return s.armies.filter(function(a){ return a.owner === 1; }).length;
  })()`);
  ok(sent > 0, '主机下了出兵令并产生在途部队', String(sent));
  const mirrored = await until(B, "(__ink.sim().armies||[]).filter(function(a){return a.owner===1;}).length > 0 && true", 6000);
  ok(!!mirrored, '客机通过快照看到同一支部队（状态同步生效）');

  console.log('【⑥ 断线 → 重新连接】');
  /* 掐断 DataChannel：Net 在 IIFE 里，只能借 __ink.netCh() 拿到真通道再 close */
  const cut = await A.eval("(function(){ var ch = __ink.netCh(); if (ch && ch.close){ try{ ch.close(); }catch(e){} return 1; } return 0; })()");
  ok(cut === 1, '已掐断房主侧数据通道', String(cut));
  const droppedB = await until(B, "(document.getElementById('btnRelink')||document.getElementById('btnRelink2')) ? 'y' : null", 15000);
  ok(!!droppedB, '断线后客机出现「重新连接」入口');
  const droppedA = await until(A, "(document.getElementById('btnRelink')||document.getElementById('btnRelink2')) ? 'y' : null", 15000);
  ok(!!droppedA, '断线后房主出现「重新连接」入口');
  const tBefore = await A.eval("__ink.sim().t");

  await A.eval("(document.getElementById('btnRelink')||document.getElementById('btnRelink2')).click()");
  await B.eval("(document.getElementById('btnRelink')||document.getElementById('btnRelink2')).click()");
  const code2 = await until(A, "(document.getElementById('invUrl')||{}).value || null", 20000);
  ok(!!code2, '房主生成续连码');
  if (code2){
    const offId = await B.eval("!!document.getElementById('offIn')");
    ok(offId, '客机续连面板给出邀请码输入框');
    await B.eval("(function(){document.getElementById('offIn').value=" + JSON.stringify(code2) +
                 ";document.getElementById('doJoin').click();})()");
    const ans2 = await until(B, "(document.getElementById('ansUrl')||{}).value || null", 20000);
    ok(!!ans2, '客机生成续连应答码');
    if (ans2){
      await A.eval("(function(){document.getElementById('ansIn').value=" + JSON.stringify(ans2) +
                   ";document.getElementById('acceptAns').click();})()");
      const backA = await until(A, "__ink.mode()==='playing' && 'playing'", 15000);
      const backB = await until(B, "__ink.mode()==='playing' && 'playing'", 15000);
      ok(!!backA, '房主续连后回到对局（不是重开）');
      ok(!!backB, '客机续连后回到对局');
      const tAfter = await A.eval("__ink.sim().t");
      ok(tAfter >= tBefore - 0.01, '续连保住了同一局的进度（未重开）', '断线前 t=' + Number(tBefore).toFixed(1) + ' 续连后 t=' + Number(tAfter).toFixed(1));
      const seedC = await A.eval("__ink.sim().rngSeed");
      ok(seedC === seedA, '续连后仍是同一张地图', String(seedC));
    }
  }

  console.log('\n【控制台异常】');
  const ea = A.errs.filter(Boolean), eb = B.errs.filter(Boolean);
  ok(ea.length === 0, '房主侧无 JS 异常', ea.slice(0, 2).join(' | '));
  ok(eb.length === 0, '客机侧无 JS 异常', eb.slice(0, 2).join(' | '));

  console.log('\n通过 ' + pass + ' · 失败 ' + fail + (fail ? '\n - ' + fails.join('\n - ') : '  全部通过 ✓'));
  A.close(); B.close();
  if (httpd) httpd.kill();
  if (fail) process.exit(1);
}
if (process.argv.indexOf('--room') >= 0) roomMain().catch(e => { console.error('ERR', e); process.exit(1); });
else main().catch(e => { console.error('ERR', e); process.exit(1); });
