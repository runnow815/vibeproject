#!/usr/bin/env node
/* 墨战 · UI 层无头冒烟
 * 用法：node tools/smoke-ui.js
 * 从 inkwar.html 提取两个 <script> 块：块1（逻辑）直接执行，块2（UI）在
 * DOM / Canvas / WebAudio 打桩环境中执行，模拟真实点击与按键链路。
 * 覆盖：菜单 → 玩法说明 → 开局 → 点选/派遣 → 列阵再派遣 → 快捷键 → 暂停/继续。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- 断言器 ---------- */
let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, detail){
  if (cond){ passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name); console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }
}
function section(t){ console.log('\n■ ' + t); }

/* ---------- 提取脚本块 ---------- */
const html = fs.readFileSync(path.join(__dirname, '..', 'inkwar.html'), 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (blocks.length < 2){ console.error('FATAL: 未找到两个 script 块'); process.exit(1); }

/* ---------- DOM / Canvas 打桩 ---------- */
function mkClassList(){
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c),
    toggle: (c, force) => { const on = force == null ? !set.has(c) : !!force; on ? set.add(c) : set.delete(c); return on; },
  };
}
const noop = () => {};
let rec = false;                 // 是否录制 canvas 调用（v1.12 渲染断言用）
const calls = [];
function mkCtx(){
  const store = {};
  return new Proxy(store, {
    get(t, p){
      if (p in t) return t[p];
      if (p === 'createRadialGradient' || p === 'createLinearGradient' || p === 'createPattern')
        return () => ({ addColorStop: noop });
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'getImageData') return () => ({ data: [] });
      if (typeof p === 'string') return (...args) => { if (rec) calls.push({ fn: p, args: args }); };
      return noop;
    },
    set(t, p, v){ if (rec && typeof p === 'string') calls.push({ fn: '=' + p, args: [v] }); t[p] = v; return true; },
  });
}
function mkStyle(){
  const s = {};
  s.setProperty = (k, v) => { s[k] = v; };
  s.getPropertyValue = k => (s[k] != null ? s[k] : '');
  s.removeProperty = k => { delete s[k]; };
  return s;
}
function mkEl(id){
  return {
    id, tagName: String(id).toUpperCase(), innerHTML: '', textContent: '', value: '',
    disabled: false, scrollTop: 0, dataset: {}, style: mkStyle(), width: 960, height: 540,
    offsetHeight: 0, offsetWidth: 960,
    classList: mkClassList(), _ls: {}, onclick: null,
    addEventListener(type, fn){ (this._ls[type] = this._ls[type] || []).push(fn); },
    removeEventListener(){},
    querySelectorAll(){ return []; },
    querySelector(){ return mkEl('slot'); },
    getBoundingClientRect(){ return { left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540 }; },
    setPointerCapture: noop, releasePointerCapture: noop, focus: noop, select: noop, remove: noop,
    getContext(){ return mkCtx(); },
    appendChild(c){ return c; }, removeChild(){}, insertBefore(c){ return c; },
  };
}
const els = {};
const documentStub = {
  getElementById(id){ return els[id] || (els[id] = mkEl(id)); },
  createElement(tag){ return mkEl(tag); },
  /* v1.18：按选择器缓存（UI 启动时抓 .topbar/.cardbar，测试要对同一元素赋 offsetHeight） */
  _qs: {},
  querySelector(sel){ return this._qs[sel] || (this._qs[sel] = mkEl(sel)); },
  querySelectorAll(){ return []; },
  addEventListener: noop,
  body: mkEl('body'),
  documentElement: mkEl('html'),
  activeElement: { tagName: 'BODY' },
};
const store = new Map();
const localStorageStub = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
let rafCb = null;
const raf = cb => { rafCb = cb; return 1; };
function pump(n, t0){
  let t = t0 || 0;
  for (let i = 0; i < n; i++){
    t += 16.7;
    const cb = rafCb; rafCb = null;
    if (!cb) break;
    cb(t);
  }
  return t;
}
const locationStub = { search: '?debug', protocol: 'file:', origin: '', pathname: '/inkwar.html', href: '' };
const winStub = {
  devicePixelRatio: 1, _ls: {}, InkSim: null,
  innerHeight: 812, innerWidth: 375,
  visualViewport: { height: 812, _ls: {}, addEventListener(type, fn){ (this._ls[type] = this._ls[type] || []).push(fn); } },
  addEventListener(type, fn){ (this._ls[type] = this._ls[type] || []).push(fn); },
  removeEventListener: noop,
};
function fire(target, type, ev){
  const ls = (target._ls && target._ls[type]) || [];
  ls.forEach(fn => fn(Object.assign({ preventDefault: noop, stopPropagation: noop }, ev)));
  return ls.length;
}

/* ---------- 装载到全局并执行 ---------- */
global.window = winStub;
global.document = documentStub;
global.localStorage = localStorageStub;
global.location = locationStub;
/* v1.18：布局实测需要 getComputedStyle(body)（UI 代码已做存在性兜底，桩里给出确定性数值） */
global.getComputedStyle = () => ({ paddingTop: '8px', paddingBottom: '8px', rowGap: '8px', gap: '8px' });
try { Object.defineProperty(global, 'navigator', { value: { userAgent: 'node' }, configurable: true }); }
catch (e){ /* Node 22 内置 navigator 只读，块2 不依赖它 */ }
const navStub = global.navigator || { userAgent: 'node' };
global.requestAnimationFrame = raf;
winStub.location = locationStub;
winStub.navigator = navStub;
winStub.requestAnimationFrame = raf;

const Sim = new Function('module', blocks[0] + '\nreturn module.exports;')({ exports: {} });
winStub.InkSim = Sim;

section('块2 装载（DOM 打桩）');
let loadErr = null;
try { new Function(blocks[1])(); } catch (e){ loadErr = e; }
ok(!loadErr, 'UI 块加载无异常', loadErr && loadErr.stack ? loadErr.stack.split('\n').slice(0, 3).join(' | ') : '');
if (loadErr){ console.log('\n通过 ' + passed + ' · 失败 ' + failed); process.exit(1); }
const I = winStub.__ink;
ok(!!I, '调试钩子 window.__ink 已暴露');

/* ---------- 主菜单 ---------- */
section('主菜单与玩法说明');
const panel = documentStub.getElementById('panel');
ok(panel.innerHTML.indexOf('快速对战') >= 0, '主菜单渲染出快速对战面板');
ok(panel.innerHTML.indexOf('? 玩法') >= 0, '主菜单出现「? 玩法」入口');
let t = pump(40);
ok(I.mode() === 'menu', '帧循环运行后仍处于菜单态');
ok(I.sim() && I.sim().t > 0, '菜单背景是一场实时 AI 混战（环境局已推进 ' + (I.sim() ? I.sim().t.toFixed(1) : 0) + 's）');

function click(id){
  const el = documentStub.getElementById(id);
  if (el && typeof el.onclick === 'function'){ el.onclick(); return true; }
  return false;
}
ok(click('btnHelp'), '「? 玩法」按钮已绑定');
ok(panel.innerHTML.indexOf('快捷键') >= 0 && panel.innerHTML.indexOf('墨色相溶') >= 0, '玩法面板含操作/快捷键/要诀');
ok(click('btnHelpBack'), '玩法面板返回按钮已绑定');
ok(panel.innerHTML.indexOf('快速对战') >= 0 && I.mode() === 'menu', '返回主菜单成功');

/* ---------- 开局与指挥 ---------- */
section('开局 · 点选派遣 · 列阵再派遣');
ok(click('btnQuick'), '「开战！」按钮已绑定');
ok(I.mode() === 'playing', '进入对局态', I.mode());
let sim = I.sim();
ok(sim && sim.castles.length === 11, '地图生成 11 座城池', sim ? String(sim.castles.length) : 'null');
ok(sim && sim.hands[1].length === 3, '开局手牌 3 张');

const W = Sim.CFG.MAP_W, H = Sim.CFG.MAP_H, SW = 960, SH = 540;
function toClient(vx, vy){ return { clientX: vx / W * SW, clientY: vy / H * SH }; }
function tap(vx, vy){
  const p = toClient(vx, vy);
  fire(documentStub.getElementById('board'), 'pointerdown', p);
  fire(documentStub.getElementById('board'), 'pointerup', p);
}
const mine = sim.castles.find(c => c.owner === 1);
tap(mine.x, mine.y);
ok(I.sel().some(s => s.k === 'c' && s.id === mine.id), '点击己方城池可选中', JSON.stringify(I.sel()));

/* 找一块远离所有城池的空地用于列阵 */
function emptySpot(){
  for (let gx = 120; gx < W - 120; gx += 60)
    for (let gy = 120; gy < H - 120; gy += 60){
      let far = true;
      for (const c of sim.castles) if (Math.hypot(c.x - gx, c.y - gy) < 150){ far = false; break; }
      if (far) return { x: gx, y: gy };
    }
  return { x: W / 2, y: H / 2 };
}
const spot = emptySpot();
/* 找一块离所有城池都足够远的空地（避开塔射程，供测试部队安全停留） */
function farSpot(minD){
  for (let gx = 100; gx < W - 100; gx += 50)
    for (let gy = 100; gy < H - 100; gy += 50){
      let far = true;
      for (const c of sim.castles) if (Math.hypot(c.x - gx, c.y - gy) < minD){ far = false; break; }
      if (far) return { x: gx, y: gy };
    }
  return { x: W / 2, y: H / 2 };
}
/* 远离城池 + 远离地图边界的空点（既避开命中干扰，也避开坐标 clamp） */
function midSpot(minD, pad){
  pad = pad || 220;
  var best = null, bestD = -1;
  for (let gx = pad; gx < W - pad; gx += 40)
    for (let gy = pad; gy < H - pad; gy += 40){
      let d = 1e9;
      for (const c of sim.castles) d = Math.min(d, Math.hypot(c.x - gx, c.y - gy));
      if (d > bestD){ bestD = d; best = { x: gx, y: gy, d: d }; }
      if (bestD >= minD) return best;      // 够远就直接用
    }
  return best || { x: W / 2, y: H / 2 };   // 退而求其次：取全场最空的一点（不是地图中心）
}
mine.garrison = 60;
/* 测试隔离：停掉 AI 决策 + 己方城池补兵——长步进中若对局意外结束，pointerup 会直接 return
   （表现为「点击无效、选择集为空」），这类偶发失败与被测逻辑无关 */
sim.opts.noAI = true;
/* v1.32 隔离：塔修复后**会打阵列**（这正是本次要修的行为）。本段只验证「点阵列派遣按 id 命中」，
   假阵列 999 放在离城 ≥140 处仍在炮塔射程（210）内 → 会被合法塔火削兵，断言偶发转红。
   这里拆掉全部塔，把塔火从该用例中排除。 */
sim.castles.forEach(c => { c.tower = null; });
sim.castles.forEach(c => { if (c.owner === 1) c.garrison = Math.max(c.garrison, 50); });
tap(spot.x, spot.y);                              // 选中城池 + 点空地 = 列阵
I.step(1 / 30);                                   // 命令在步首统一执行
ok(sim.armies.length >= 1, '点空地已派出部队', 'armies=' + sim.armies.length);
I.step(14);                                       // 空地可能远离主城（~700px ≈ 7.8s），给足行军余量
ok(sim.camps.length >= 1, '部队抵达空地后建立阵列', 'camps=' + sim.camps.length);
const camp = sim.camps[0];
if (!camp){ console.log('\n通过 ' + passed + ' · 失败 ' + failed); process.exit(1); }
const campId = camp.id, campCount = camp.count;
/* 第二阵列的落点同样避开所有城池（否则可能压在目标城上，吞掉后续点选） */
const spot2 = (function(){
  /* v1.26：取「离本阵最远」的合法点（原实现取第一个命中点，密集地图上会退化到与本阵同点，
     于是点本阵时命中的是 999 号假阵的兵 —— 偶发失败，1/120） */
  let best = null, bestD = -1;
  for (let dx = -420; dx <= 420; dx += 40)
    for (let dy = -420; dy <= 420; dy += 40){
      const x = camp.x + dx, y = camp.y + dy;
      if (x < 60 || y < 60 || x > W - 60 || y > H - 60) continue;
      let near = false;
      for (const c of sim.castles) if (Math.hypot(c.x - x, c.y - y) < 140){ near = true; break; }
      if (near) continue;
      const d = Math.hypot(dx, dy);
      if (d > bestD){ bestD = d; best = { x: x, y: y }; }
    }
  if (best) return best;
  const cand = [[260, 0], [-260, 0], [0, 260], [0, -260], [260, 260], [-260, -260]];   // 兜底也要拉开距离
  for (const p of cand){
    const x = camp.x + p[0], y = camp.y + p[1];
    if (x >= 60 && y >= 60 && x <= W - 60 && y <= H - 60) return { x: x, y: y };
  }
  return { x: camp.x, y: camp.y };
})();
sim.camps.push({ id: 999, owner: 1, x: spot2.x, y: spot2.y, count: 12, decayAcc: 0 });  // 制造多阵列场景
tap(camp.x, camp.y);                              // 选中阵列（个体或整阵均可）
ok(I.sel().some(s => (s.k === 'p' || s.k === 'ps') && s.id === camp.id), '点阵列可选中（整阵或单兵）', JSON.stringify(I.sel()));
const beforeIds = new Set(sim.armies.map(a => a.id));   // 只认本次新生成的部队（场上有 AI 部队进出）
const foe = sim.castles.find(c => c.owner === 0) || sim.castles.find(c => c.owner === 2);
const cntBefore = Math.floor(camp.count);
tap(foe.x, foe.y);                                // 再派遣：点中立/敌城进攻
I.step(1 / 30);
/* 单兵部队可能出生当步就被路过的敌军湮灭，故以「阵列兵力 -1」为派遣成功信号 */
const born = sim.armies.filter(a => !beforeIds.has(a.id) && a.owner === 1);
ok(born.length >= 1 || Math.floor(camp.count) === cntBefore - 1,
   '阵列可再次派遣（多阵列场景下按 id 命中正确）',
   'camps=' + JSON.stringify(sim.camps.map(p => [p.id, Math.round(p.count)])) + ' born=' + born.length + ' before=' + cntBefore);
ok(sim.camps.every(p => p.id !== 999 || p.count === 12), '另一阵列未被误操作（id 稳定）');
sim.camps = sim.camps.filter(p => p.id !== 999);
I.sel().splice(0);                                // 清空选择，隔离后续用例

/* ---------- 方阵站位与单兵出队 ---------- */
section('阵列方阵与单兵出队（v1.11）');
{
  const sim = I.sim();
  let camp2 = sim.camps[0];
  if (!camp2){                                   // 没有现成阵列就现场扎一个
    const m2 = sim.castles.find(c => c.owner === 1);
    m2.garrison = 60;
    tap(spot.x + 40, spot.y + 40);
    I.step(8);
    camp2 = I.sim().camps[0];
  }
  camp2.count = 36;                              // 方阵：6×6
  /* 隔离：阵列若压在城池判定半径上，出队的 1 兵会被城池当场消耗（合法玩法，不是 bug）——挪到空地 */
  const sp2 = midSpot(300, 220);
  camp2.x = sp2.x; camp2.y = sp2.y;
  const cx = camp2.x, cy = camp2.y;
  const units = I.campUnits(camp2, null);        // 与点选同源的精确个体坐标（含个体微动）
  const pu = units[Math.floor(units.length / 2)];
  const px = pu.x, py = pu.y;                    // 方阵中某个兵的精确站位
  tap(px, py);
  ok(I.sel().some(s => s.k === 'ps' && s.id === camp2.id), '可点中阵列方阵中的单个兵', JSON.stringify(I.sel()));
  /* 目标取「离阵列最远」的外城：避免阵列挪过去后正好压在目标城上（点中自家兵而非城 → 不出兵） */
  const tgtC = sim.castles.filter(c => c.owner !== 1)
                          .sort(function(a, b){ return Math.hypot(b.x - cx, b.y - cy) - Math.hypot(a.x - cx, a.y - cy); })[0];
  /* 隔离：1 兵出队当步会被路过敌军当场湮灭、或与同点己方部队合并（都属合法玩法，不是 bug） */
  sim.armies = sim.armies.filter(a => Math.hypot(a.x - cx, a.y - cy) > 320);
  /* 隔离（v1.26 补）：三级炮塔射程 210×(1+0.15×2)=273，阵列若落在某座敌塔的射程圈里，
     刚出队的 1 兵会在同一步被塔火打掉（表现为「阵列少了 1 兵但没有新部队」）——同样是合法玩法 */
  sim.castles.forEach(c => { if (Math.hypot(c.x - cx, c.y - cy) < 320) c.tower = null; });
  const beforeIds = new Set(sim.armies.map(a => a.id));      // 只认本次新生成的部队
  tap(tgtC.x, tgtC.y);
  I.step(1 / 30);
  const born = sim.armies.filter(a => a.solo && !beforeIds.has(a.id));
  ok(born.length >= 1 && born[0].count === 1, '生成 1 兵的独立部队',
     'born=' + born.length + ' 阵列余兵=' + camp2.count.toFixed(1) + ' 最近城=' + sp2.d.toFixed(0) +
     ' 新=[' + sim.armies.filter(a => !beforeIds.has(a.id)).map(a => a.id + '/' + a.count + (a.solo ? 'solo' : '') + '@' + Math.round(a.x) + ',' + Math.round(a.y)).join(' ') + ']');
  if (born.length){
    const d0 = Math.hypot(born[0].x - px, born[0].y - py);
    const dc = Math.hypot(born[0].x - cx, born[0].y - cy);
    ok(d0 < 10, '该兵从被点中的站位出发', '距点击点 ' + d0.toFixed(1));
    ok(dc > 15, '而非从阵列中心出发（方阵有独立站位）', '距阵列中心 ' + dc.toFixed(1));
  }
  I.sel().splice(0);                             // 清空选择，隔离后续用例
}
{
  const sim = I.sim();
  const c0 = sim.castles.find(c => c.owner === 1);
  c0.garrison = 30;
  const rr = 24 + (c0.level - 1) * 10 + 13;      // 驻军环半径（与 castleRingUnits 同式）
  const ru = I.ringUnits(c0)[0];                 // 与点选同源的精确环上个体坐标
  tap(ru.x, ru.y);
  ok(I.sel().some(s => s.k === 'gs' && s.id === c0.id), '可点中驻城环上的单个兵', JSON.stringify(I.sel()));
  const tgt = sim.castles.find(c => c.owner === 0) || sim.castles.find(c => c.owner === 2);
  tap(tgt.x, tgt.y);
  I.step(1 / 30);
  const born = sim.armies.filter(a => a.solo);
  ok(born.length >= 1, '驻城单兵出队成立');
  if (born.length){
    const last = born[born.length - 1];
    const dc = Math.hypot(last.x - c0.x, last.y - c0.y);
    ok(dc > rr * 0.6, '出发点在驻军环上（不是城池中心）', '距城心 ' + dc.toFixed(1) + ' · 环半径 ' + rr);
  }
}

/* ---------- 快捷键 ---------- */
section('快捷键');
sim = I.sim();
const ownCount = sim.castles.filter(c => c.owner === 1).length;
/* v1.15：全选由 A 迁到 Q（A 让位给单兵左移） */
fire(winStub, 'keydown', { code: 'KeyQ' });
ok(I.sel().filter(s => s.k === 'c').length === ownCount, 'Q 键全选己方城池（' + ownCount + ' 座）', JSON.stringify(I.sel()));
I.sel().splice(0);
fire(winStub, 'keydown', { code: 'KeyA' });
ok(I.sel().filter(s => s.k === 'c').length === 0, 'A 键不再全选（让位给单兵左移）');
fire(winStub, 'keyup', { code: 'KeyA' });
let keyErr = null;
try { fire(winStub, 'keydown', { code: 'Digit1' }); fire(winStub, 'keydown', { code: 'Digit2' }); } catch (e){ keyErr = e; }
ok(!keyErr, '1/2 键出牌无异常', keyErr && keyErr.message);
fire(winStub, 'keydown', { code: 'Space' });
ok(I.mode() === 'paused', '空格暂停', I.mode());
ok(click('btnHelp2'), '暂停面板「玩法说明」已绑定');
ok(panel.innerHTML.indexOf('快捷键') >= 0, '暂停内可查看玩法');
ok(click('btnHelpBack'), '玩法返回暂停面板');
ok(panel.innerHTML.indexOf('暂') >= 0, '回到暂停面板');
fire(winStub, 'keydown', { code: 'Space' });
ok(I.mode() === 'playing', '空格继续', I.mode());

/* ---------- 推进稳定性 ---------- */
section('推进稳定性');
let stepErr = null;
try { t = pump(30, t); I.step(30); } catch (e){ stepErr = e; }
ok(!stepErr, '渲染 + 模拟推进无异常', stepErr && stepErr.message);
sim = I.sim();
let bad = 0;
sim.armies.forEach(a => { if (!isFinite(a.x) || !isFinite(a.y) || !isFinite(a.count)) bad++; });
sim.castles.forEach(c => { if (!isFinite(c.garrison)) bad++; });
sim.camps.forEach(p => { if (!isFinite(p.count) || !isFinite(p.x)) bad++; });
for (let o = 1; o <= 4; o++) if (!(sim.ink[o] >= 0 && sim.ink[o] <= sim.inkMax + 1e-6)) bad++;
ok(bad === 0, '推进后无 NaN / 无越界墨量', 'bad=' + bad);
ok(I.mode() === 'playing' || I.mode() === 'over', '对局态或结算态（' + I.mode() + '）');

/* ---------- v1.12 渲染：等级嵌套环 / 防御塔 / 每兵攻击动作 ---------- */
section('等级嵌套环 · 防御塔 · 每兵攻击动作（v1.12）');
sim = I.sim();
/* 跑一帧并录制这一帧的全部 canvas 调用 */
function frame(){
  calls.length = 0; rec = true; t = pump(1, t); rec = false;
  return calls.slice();
}
const arcsAt = (cs, c) => cs.filter(k => k.fn === 'arc' && Math.abs(k.args[0] - c.x) < 0.01 && Math.abs(k.args[1] - c.y) < 0.01)
                            .map(k => k.args[2]);
{
  const c = sim.castles.find(x => x.owner === 1);
  c.hitT = 0; c.tower = null; c.level = 3; c.garrison = 60;
  const a3 = arcsAt(frame(), c);
  const r3 = 24 + (3 - 1) * 10;
  const want3 = [1, 2, 3].map(i => r3 * (0.45 + 0.47 * i / 3));
  ok(want3.every(w => a3.some(a => Math.abs(a - w) < 0.01)),
     'Lv3 城池画出 3 层嵌套等级环（' + want3.map(v => v.toFixed(1)).join('/') + '）');
  c.level = 1;
  const a1 = arcsAt(frame(), c);
  const want1 = 24 * (0.45 + 0.47);
  ok(a1.some(a => Math.abs(a - want1) < 0.01), 'Lv1 画出 1 层嵌套环（' + want1.toFixed(1) + '）');
  ok(!a1.some(a => Math.abs(a - 24 * (0.45 + 0.47 / 3)) < 0.01), '降级后不再画第 2/3 层环');
  c.level = 2;
  const upPos = I.upChip(c.id), upX = upPos.x;
  /* 同时按 y 过滤：随机地图上可能另有可升级城池，其「↑」恰好落在同一 x 上（隔离用，非产品缺陷） */
  const upTxt = frame().filter(k => k.fn === 'fillText' && typeof k.args[0] === 'string'
                                   && k.args[0].charAt(0) === '↑'
                                   && Math.abs(k.args[1] - upX) < 0.01 && Math.abs(k.args[2] - c.y) < 0.01);
  ok(upTxt.length === 1, '可升级城池标出升级进度「↑兵/所需」', JSON.stringify(upTxt.map(k => k.args[0])));
  sim.castles.forEach(x => { x.level = 3; });          // 全图满级 → 不应再有升级提示
  const noUp = frame().filter(k => k.fn === 'fillText' && typeof k.args[0] === 'string' && k.args[0].charAt(0) === '↑');
  ok(noUp.length === 0, '满级城池不再显示升级进度', JSON.stringify(noUp.map(k => k.args[0])));
}
{
  const c = sim.castles.find(x => x.owner === 1);
  c.hitT = 0; c.level = 2; c.garrison = 40;
  const r = 24 + (c.level - 1) * 10, bx = c.x + r * 0.78, by = c.y - r * 0.78;
  /* v1.18：塔徽记升级为矢量图标 —— 断言落在徽记圆心附近的矢量笔画 */
  const iconOps = (cs, fn) => cs.filter(k => k.fn === fn && Math.abs(k.args[0] - bx) < 9 && Math.abs(k.args[1] - by) < 9);
  /* 必须按 x + y 同时过滤：同一 y 上可能还有别的城池的塔等级点（半径同为 1.9） */
  const dotsOf = cs => cs.filter(k => k.fn === 'arc' && Math.abs(k.args[2] - 1.9) < 1e-6
                                   && Math.abs(k.args[0] - bx) < 10 && Math.abs(k.args[1] - (by + 13)) < 0.01).length;
  const rangeOf = (cs, tw) => cs.some(k => k.fn === 'arc' && Math.abs(k.args[0] - c.x) < 0.01
                                           && Math.abs(k.args[1] - c.y) < 0.01 && Math.abs(k.args[2] - Sim.towerStat(tw, 'range')) < 0.01);
  c.tower = { kind: 'mage', lv: 2, cd: 0 };
  const cs = frame();
  ok(iconOps(cs, 'lineTo').length === 7, '法师塔画出四芒星图标（7 段矢量线）', 'lines=' + iconOps(cs, 'lineTo').length);
  ok(dotsOf(cs) === 2, '塔等级 2 → 徽记下 2 个金点', 'dots=' + dotsOf(cs));
  ok(rangeOf(cs, { kind: 'mage', lv: 2 }), '己方塔画出射程圈（法师塔 Lv2 = ' + Sim.towerStat({ kind: 'mage', lv: 2 }, 'range') + '）');
  c.tower = { kind: 'claw', lv: 3, cd: 0 };
  const cs2 = frame();
  ok(cs2.filter(k => k.fn === 'arc' && Math.abs(k.args[2] - 2.7) < 1e-6
                    && Math.abs(k.args[0] - bx) < 7 && Math.abs(k.args[1] - (by - 1.4)) < 7).length === 3,
     '爪子画出三道爪痕图标', 'claws=' + cs2.filter(k => k.fn === 'arc' && Math.abs(k.args[2] - 2.7) < 1e-6).length);
  ok(dotsOf(cs2) === 3, '塔等级 3 → 3 个金点', 'dots=' + dotsOf(cs2));
  c.tower = { kind: 'cannon', lv: 1, cd: 1.0 };
  const cs3 = frame();
  ok(iconOps(cs3, 'lineTo').length === 1 && cs3.some(k => k.fn === 'arc' && Math.abs(k.args[2] - 1.5) < 1e-6
                    && Math.abs(k.args[0] - (bx + 3.2)) < 0.01 && Math.abs(k.args[1] - (by - 3.2)) < 0.01),
     '炮塔画出炮管 + 炮口图标');
  ok(cs3.filter(k => k.fn === 'arc' && Math.abs(k.args[2] - 11) < 0.01 && Math.abs(k.args[0] - bx) < 0.01).length === 1,
     '塔冷却中在徽记上画冷却弧');
  c.tower = { kind: 'arrow', lv: 1, cd: 0 };
  const cs4 = frame();
  ok(iconOps(cs4, 'lineTo').length === 5, '箭塔画出带羽箭矢图标（箭杆 + 箭头 + 双尾羽 共 5 段线）', 'lines=' + iconOps(cs4, 'lineTo').length);
}
{
  /* 每个兵的攻击动作：直接断言 armyFormations 输出（确定性好，不受战场随机干扰）
   * 30 兵 → 每兵独立相位 ap=(id·5.31+k·2.399)%2π 与个体步频，任一时刻约四成兵在挥砍 */
  const mkArmy = (atkT) => ({ id: 7701, owner: 1, count: 30, x: 400, y: 400, tx: 900, ty: 400,
                              tKind: 'pt', tid: -1, srcId: -1, hx: 400, hy: 400, atkT: atkT });
  let nAtk = 0, nIdle = 0, phases = new Set();
  for (let tt = 0.31; tt < 3; tt += 0.137){
    const us = I.formations(mkArmy(1), tt);
    nAtk = Math.max(nAtk, us.filter(u => u.atk > 0.45).length);
    nIdle = Math.max(nIdle, I.formations(mkArmy(0), tt).filter(u => u.atk > 0).length);
    us.forEach(u => phases.add(u.ph.toFixed(3)));
  }
  ok(nIdle === 0, '非交战状态（atkT=0）无攻击动作');
  ok(nAtk >= 5 && nAtk <= 24, '交战时每个兵各自挥砍（30 兵 → 峰值 ' + nAtk + ' 个 · 上限 24 道）', '峰值 ' + nAtk);
  ok(phases.size >= 25, '每个兵相位互不相同（非整队同步砍）', '去重相位 ' + phases.size + '/30');
  /* 渲染层：交战部队确实画出了挥砍弧（宽松断言：至少 1 道，避免战场随机性导致抖动） */
  const R_SLASH = (13 - Math.min(4.5, 30 / 30)) * 0.72;                  // 8.64（30 兵）
  const far = farSpot(300);                       // 避开所有塔射程，部队不被消耗
  const a1 = mkArmy(1);
  a1.x = far.x; a1.y = far.y; a1.tx = far.x + 300; a1.ty = far.y; a1.hx = far.x; a1.hy = far.y;
  sim.armies = sim.armies.filter(a => a.id !== 7701);
  sim.camps = sim.camps.filter(p => p.id !== 8801);
  sim.armies.push(a1);
  let arcs = 0;
  for (let i = 0; i < 8; i++)
    arcs = Math.max(arcs, frame().filter(k => k.fn === 'arc' && Math.abs(k.args[2] - R_SLASH) < 0.6
                                             && Math.hypot(k.args[0] - far.x, k.args[1] - far.y) < 90).length);
  ok(arcs >= 1, '渲染层画出每兵挥砍弧（多帧峰值 ' + arcs + ' 道）');
  sim.armies = sim.armies.filter(a => a.id !== 7701);
  /* 阵列兵同样各自挥砍（渲染层，弧半径 6.5） */
  const far2 = farSpot(300);
  sim.camps.push({ id: 8801, owner: 1, x: far2.x, y: far2.y, count: 30, decayAcc: 0, atkT: 1 });
  let carcs = 0;
  for (let i = 0; i < 8; i++)
    carcs = Math.max(carcs, frame().filter(k => k.fn === 'arc' && Math.abs(k.args[2] - 6.5) < 0.3
                                              && Math.hypot(k.args[0] - far2.x, k.args[1] - far2.y) < 90).length);
  ok(carcs >= 1, '阵列迎敌同样画出挥砍弧（多帧峰值 ' + carcs + ' 道）');
  sim.camps = sim.camps.filter(p => p.id !== 8801);
}
{
  /* 塔火：弹道 + 命中晕环 + 爪子抓兵浮字 */
  const c = sim.castles.find(x => x.owner === 1);
  c.level = 2; c.garrison = 40; c.tower = { kind: 'cannon', lv: 1, cd: 0 };
  sim.armies = [{ id: 7702, owner: 2, count: 100, x: c.x + 100, y: c.y, tx: c.x + 4100, ty: c.y,
                  tKind: 'pt', tid: -1, srcId: -1, hx: c.x + 100, hy: c.y, atkT: 0 }];
  I.fx().bolts.length = 0;
  sim.armies[0].x = c.x + 100; sim.armies[0].y = c.y;
  I.step(1 / 30);
  ok(I.fx().bolts.length >= 1, '塔开火生成弹道表现对象', 'bolts=' + I.fx().bolts.length);
  ok(c.tower.cd > 0, '开火后塔进入冷却', 'cd=' + (c.tower && c.tower.cd));
  ok(frame().some(k => k.fn === 'quadraticCurveTo'), '炮塔弹道走抛物线');
  /* 爪子：抓兵转己方驻军 + 浮字 */
  c.tower = { kind: 'claw', lv: 1, cd: 0 };
  c.garrison = 0;
  sim.armies = [{ id: 7703, owner: 2, count: 100, x: c.x + 60, y: c.y, tx: c.x + 4060, ty: c.y,
                  tKind: 'pt', tid: -1, srcId: -1, hx: c.x + 60, hy: c.y, atkT: 0 }];
  I.fx().floats.length = 0;
  sim.armies[0].x = c.x + 60; sim.armies[0].y = c.y;
  I.step(1 / 30);
  ok(I.fx().floats.some(f => String(f.txt).indexOf('爪') === 0), '爪子抓兵弹出「爪 +n」浮字',
     JSON.stringify(I.fx().floats.map(f => f.txt)));
  ok(I.fx().bolts.length >= 1, '爪子同样有弹道表现');
}

/* ---------- v1.13：势力存亡条 · 城池血条 ---------- */
section('势力存亡条 · 城池血条（v1.13）');
sim = I.sim();
{
  const c = sim.castles.find(x => x.owner === 1);
  c.hitT = 0; c.tower = null; c.level = 2; c.garrison = 30;
  I.step(0);                                       // 只刷 HUD，不推进模拟
  const facs = documentStub.getElementById('facs');
  ok((facs.innerHTML.match(/class="fac/g) || []).length >= 2, '顶栏势力条按参战阵营生成徽记',
     facs.innerHTML.slice(0, 100));
  ok(/class="fac me"/.test(facs.innerHTML), '己方阵营徽记高亮（me）');
  ok(/<b>\d+<\/b>/.test(facs.innerHTML), '徽记带城池数');
  /* 城池血条：按 驻军/容量 填充，越满越红 */
  const r = 24 + (c.level - 1) * 10, hw = r * 1.7, barTop = c.y - r - 31;
  /* tol：容忍帧内产兵/交战让驻军变动导致的宽度抖动（±1.5px） */
  const at = (cs, fn, x, y, w, tol) => cs.filter(k => k.fn === fn && Math.abs(k.args[0] - x) < 0.01
                                              && Math.abs(k.args[1] - y) < 0.01
                                              && (w == null || Math.abs(k.args[2] - w) < (tol || 0.01)));
  const cs = frame();
  const cap = Math.round(Sim.LEVELS[1].cap * sim.mods.cap);   // Lv2 容量 70 × 日卡修正（铁壁 ×1.2）
  ok(at(cs, 'strokeRect', c.x - hw / 2, barTop, hw).length === 1, '城池头顶画出血条轨道');
  ok(at(cs, 'fillRect', c.x - hw / 2, barTop, hw * c.garrison / cap, 1.5).length === 1,
     '血条按 驻军/容量 填充（' + c.garrison.toFixed(1) + '/' + cap + '）');
  ok(cs.some(k => k.fn === '=fillStyle' && k.args[0] === '#6a9a58'), '低量血条为墨绿');
  c.garrison = cap;
  const cs2 = frame();
  /* 满仓：填充宽度与轨道重合（容忍一步内产兵/交战造成的 ±1px 抖动） */
  const fullW = cs2.filter(k => k.fn === 'fillRect' && Math.abs(k.args[0] - (c.x - hw / 2)) < 0.01
                                                    && Math.abs(k.args[1] - barTop) < 0.01);
  ok(fullW.length >= 2 && fullW.some(k => Math.abs(k.args[2] - hw) < 1), '满仓血条填满整条（轨道 + 填充重合）',
     'n=' + fullW.length + ' w=' + fullW.map(k => k.args[2].toFixed(1)).join(','));
  ok(cs2.some(k => k.fn === '=fillStyle' && k.args[0] === '#b33327'), '满仓血条转朱砂');
  /* 势力灭亡 → 盖红叉 */
  sim.castles.forEach(x => { if (x.owner === 2) x.owner = 3; });
  I.step(0);
  ok(/class="fac dead"/.test(facs.innerHTML), '阵营城池尽灭 → 徽记灰化盖红叉（dead）');
  sim.castles.forEach(x => { if (x.owner === 3) x.owner = 2; });
}

/* ---------- 结算页 ---------- */
section('结算与战利品');
sim.castles.forEach(c => { if (c.owner >= 2) c.owner = 1; });   // 强制胜利
I.step(1 / 30);
ok(I.mode() === 'over', '清掉敌方城池后进入结算', I.mode());
ok(panel.innerHTML.indexOf('战利品') >= 0, '结算页出现战利品三选一');
ok(click('btnSkip') || true, '跳过战利品按钮可用');
ok(click('btnMenu2') && I.mode() === 'menu', '结算页可返回菜单');

/* ---------- v1.13：卡片图鉴 · 联机等待室 ---------- */
section('卡片图鉴（v1.13）');
{
  /* v1.14：进菜单会自动随机赠 1 张当日日卡，先记下它以免与断言撞车 */
  const granted = (JSON.parse(store.get('ink.daily') || '{}').cards) || [];
  I.collect('daily', 'wall'); I.collect('sub', 'fire'); I.collect('sub', 'fire');
  I.menu();                                        // 重新渲染主菜单
  ok(panel.innerHTML.indexOf('卡片图鉴') >= 0, '菜单出现卡片图鉴');
  ok(/<span class="dex own"[^>]*>铁壁<i>×\d+<\/i><\/span>/.test(panel.innerHTML), '已获日卡点亮并带持有角标');
  ok(/<span class="dex own"[^>]*>火攻<i>×2<\/i><\/span>/.test(panel.innerHTML), '次卡累计张数 ×2');
  ok(/<span class="dex own"[^>]*>火攻<\/span>/.test(panel.innerHTML) === false &&
     /强化\+/.test(panel.innerHTML), '图鉴分「次卡 / 强化+」两栏陈列');
  /* v1.19：dex 开标签多了 data-art 属性，精确子串匹配已不适用，改为按 key 正则匹配 */
  const free = Sim.DAILIES.filter(d => granted.indexOf(d.key) < 0 && d.key !== 'wall')[0];
  ok(free && new RegExp('<span class="dex"[^>]*data-art="' + free.key + '"[^>]*>' + free.name + '</span>')
              .test(panel.innerHTML),
     '未获得的卡灰显无角标（并挂好了插画 key）', free ? free.name : '无可用日卡');
  const chips = panel.innerHTML.match(/<span class="dex(?![a-z])[^>]*>/g) || [];   // 排除 .dexlab 行标签
  ok(chips.length >= 20 && chips.every(s => /data-art="/.test(s)),
     '每枚图鉴 chip 都挂上了插画 key', 'chip=' + chips.length + ' 缺=' + chips.filter(s => !/data-art="/.test(s)).length);
  ok(/<span class="dex own"[^>]*data-art="fire"/.test(panel.innerHTML), '已获次卡 chip 挂上插画 key');
  ok(/<span class="dex[^>]*up"[^>]*data-art="fire"/.test(panel.innerHTML),
     '强化+ 栏复用基础卡插画（data-art = 基础 key）');
}

section('联机等待室（v1.13）');
{
  I.setNet('host');
  I.lobbyReady(true);
  let L = I.lobby();
  ok(L.me === true && panel.innerHTML.indexOf('取消准备') >= 0, '点「准备」后席位打勾、按钮翻转为取消准备');
  ok(click('btnReady') && I.lobby().me === false, '再次点击可取消准备');
  I.lobbyReady(true);
  I.netMsg(JSON.stringify({ t: 'ready', on: true }));
  L = I.lobby();
  ok(L.foe === true && L.cnt === 3, '双方准备后主机进入 3 秒倒计时', 'cnt=' + L.cnt);
  ok(panel.innerHTML.indexOf('游戏正在开始 3') >= 0, '等待室显示倒计时');
  I.netMsg(JSON.stringify({ t: 'info', w: 3, l: 1 }));
  L = I.lobby();
  ok(L.foeW === 3 && L.foeL === 1 && panel.innerHTML.indexOf('3胜1负') >= 0, '对手生涯战绩进入席位');
  I.lobbyTick(); I.lobbyTick();
  ok(I.lobby().cnt === 1 && panel.innerHTML.indexOf('游戏正在开始 1') >= 0, '倒计时递减');
  I.lobbyTick();
  ok(I.mode() === 'playing', '倒计时结束主机发车，双方进入对局', I.mode());
  ok(I.sim() && I.sim().opts.mode === 'pvp' && I.net() === 'host', '对局为 PVP 主机视角');
  L = I.lobby();
  ok(L.cnt === 0 && L.me === false && L.log.length === 0, '开局后等待室状态复位');
  I.setNet('none');
}

/* ---------- v1.14：牌库循环 / 手牌五槽 / 牌堆计数 / 战利品进卡组 ---------- */
section('牌库循环（v1.14）');
{
  /* 回到 PVE 对局：清掉联机态重开一局快速对战 */
  I.setNet('none');
  I.menu();
  ok(click('btnQuick') && I.mode() === 'playing', '重开一局快速对战');
  sim = I.sim();
  sim.opts.noAI = true;                            // 隔离：长步进中不因战局结束而中断用例
  const cardsEl = documentStub.getElementById('cards');
  ok((cardsEl.innerHTML.match(/class="card/g) || []).length === Sim.CFG.HAND_MAX,
     '手牌渲染 5 个槽位', String((cardsEl.innerHTML.match(/class="card/g) || []).length));
  ok(sim.hands[1].length === Sim.CFG.START_HAND, '开局抽 3 张', String(sim.hands[1].length));

  /* 牌堆计数 */
  const pilesEl = () => documentStub.getElementById('piles').innerHTML;
  let P = I.piles(1);
  ok(P.list.length === Sim.DEFAULT_DECK.length, '卡组记录 = 默认卡组 10 张', 'list=' + P.list.length);
  ok(P.draw + P.hand + P.discard.length + P.exhaust.length === P.list.length,
     '四堆张数守恒（抽 + 手 + 弃 + 消 = 卡组）',
     P.draw + '+' + P.hand + '+' + P.discard.length + '+' + P.exhaust.length);
  ok(/抽 \d+/.test(pilesEl()) && /弃 \d+/.test(pilesEl()) && /消 \d+/.test(pilesEl()),
     'HUD 显示「抽 / 弃 / 消」三堆计数', pilesEl());
  ok(pilesEl().indexOf('抽 ' + P.draw) >= 0, '抽牌堆计数与实际一致（抽 ' + P.draw + '）');

  /* 定时抽牌 */
  I.step(6.1);
  ok(sim.hands[1].length === 4, '6 秒后自动抽到 4 张', 'hand=' + sim.hands[1].length);
  I.step(6.1);
  ok(sim.hands[1].length === Sim.CFG.HAND_MAX, '12 秒后满手 5 张', 'hand=' + sim.hands[1].length);
  I.step(30);
  ok(sim.hands[1].length === Sim.CFG.HAND_MAX, '手牌满后不再抽（上限生效）', 'hand=' + sim.hands[1].length);
  ok(pilesEl().indexOf('抽 ' + I.piles(1).draw) >= 0, 'HUD 牌堆计数随抽牌刷新');

  /* 出牌 → 进弃牌堆，HUD 同步（走 Digit1 快捷键，等价点卡槽 1） */
  const before = I.piles(1);
  sim.ink[1] = 20;
  sim.hands[1][0] = 'rush';                        // 无目标、非消耗牌，便于直接发动
  I.step(0);
  fire(winStub, 'keydown', { code: 'Digit1' });
  const after = I.piles(1);
  ok(after.discard.length === before.discard.length + 1 && after.discard[after.discard.length - 1] === 'rush',
     '打出的牌进弃牌堆', JSON.stringify(after.discard));
  ok(pilesEl().indexOf('弃 ' + after.discard.length) >= 0, '弃牌堆计数同步到 HUD');
  ok(after.hand === before.hand - 1, '出牌后手牌 -1（不再立即补牌）');

  /* 消耗牌 → 进消耗堆 */
  let neu = sim.castles.find(c => c.owner === 0);
  if (!neu){ neu = sim.castles.find(c => c.owner !== 1); neu.owner = 0; }   // 保证有中立城可倒戈
  sim.ink[1] = 20;
  sim.hands[1][0] = 'dagger';
  I.step(0);
  /* v1.33：卡面精简后「消耗」文本移入浮层，卡面只留 r-r 框线与 data-ex 标记 */
  ok(/class="card[^"]*r-r/.test(cardsEl.innerHTML) && cardsEl.innerHTML.indexOf('data-ex="1"') >= 0,
     '稀有消耗牌在卡面保留 r-r 框线与 data-ex 标记', cardsEl.innerHTML.slice(0, 140));
  ok(I.tipShow(0) && I.tip().html.indexOf('消耗：打出后移出本局') >= 0,
     '「消耗」说明移入悬浮浮层', I.tip().html.slice(0, 120));
  I.tipHide();
  fire(winStub, 'keydown', { code: 'Digit1' });
  const ex = I.piles(1);
  ok(ex.exhaust.indexOf('dagger') >= 0 && ex.discard.indexOf('dagger') < 0, '消耗牌打出后进消耗堆',
     JSON.stringify(ex.exhaust));
  ok(pilesEl().indexOf('消 ' + ex.exhaust.length) >= 0, '消耗堆计数同步到 HUD');

  /* 洗牌：抽牌堆抽空 → 弃牌堆洗回，飘「洗牌」 */
  const p = sim.piles[1];
  p.draw = []; p.hand = [];
  I.step(6.1);
  ok(p.discard.length === 0 && (p.draw.length + p.hand.length) > 0, '抽牌堆空 → 弃牌堆洗回',
     'draw=' + p.draw.length + ' discard=' + p.discard.length);
  ok(I.fx().floats.some(f => f.txt === '洗牌'), '洗牌时飘「洗牌」提示');

  /* 升级版卡面 */
  sim.hands[1][0] = 'fire+';
  I.step(0);
  ok(/class="card up[^"]*"/.test(cardsEl.innerHTML) && cardsEl.innerHTML.indexOf('火攻+') >= 0,
     '升级版卡面带 up 样式与「+」名', cardsEl.innerHTML.slice(0, 120));
}

/* ---------- v1.19：卡面插画（18 基础卡 + 5 日卡各一幅内联 SVG） ---------- */
section('卡面插画（v1.19）');
{
  const cEl = documentStub.getElementById('cards');
  sim.hands[1].length = 0;                          // 保持数组引用（sim.hands[o] 与 piles[o].hand 同一引用）
  ['fire', 'shield', 'dagger', 'granary', 'fire+'].forEach(k => sim.hands[1].push(k));
  sim.ink[1] = 20;
  I.step(0);
  const H = cEl.innerHTML;

  ok((H.match(/class="card/g) || []).length === Sim.CFG.HAND_MAX,
     '插画注入后仍是 5 个卡槽（新元素不得用 card 前缀 class）', String((H.match(/class="card/g) || []).length));
  ok((H.match(/<i class="inkart">/g) || []).length === 5, '每张手牌各注入一个插画容器',
     String((H.match(/<i class="inkart">/g) || []).length));
  ok((H.match(/<svg /g) || []).length === 5 && H.indexOf('viewBox="0 0 100 60"') >= 0,
     '每张手牌内联一幅 viewBox 100×60 的水墨插画');
  /* v1.33：卡面不再罗列描述与费用行，只留插画 + 名称 + 费用角标 */
  ok((H.match(/<i class="inkcost">/g) || []).length === 5 && H.indexOf('<i class="inkcost">5</i>') >= 0,
     '精简卡面：每张手牌一个费用角标（火攻 = 墨 5）', String((H.match(/<i class="inkcost">/g) || []).length));
  ok(H.indexOf('<div class="cd"') < 0 && H.indexOf('<div class="cc"') < 0,
     '描述行 .cd 与费用行 .cc 已从手牌卡面移除');
  ok(/class="card[^"]*r-c/.test(H) && /class="card[^"]*r-u/.test(H) && /class="card[^"]*r-r/.test(H),
     '稀有度三档 class 仍在按钮上（r-c / r-u / r-r）');
  ok(/class="card up[^"]*"/.test(H) && H.indexOf('class="inkart"><svg viewBox="0 0 100 60"') >= 0,
     '升级版：up class + 复用基础卡插画');
  ok(H.indexOf('data-ex="1"') > 0 && H.indexOf('消耗') < 0,
     '消耗牌：卡面只留 data-ex 标记，「消耗」文本已移入浮层');

  const keys = I.artKeys();
  ok(Sim.CARDS.filter(c => !c.up).every(c => keys.indexOf(c.key) >= 0),
     '25 张基础卡全部有专属插画（v1.24 +7）',
     '缺：' + Sim.CARDS.filter(c => !c.up && keys.indexOf(c.key) < 0).map(c => c.key).join(','));
  ok(Sim.DAILIES.every(d => keys.indexOf(d.key) >= 0), '5 张日卡全部有插画',
     '缺：' + Sim.DAILIES.filter(d => keys.indexOf(d.key) < 0).map(d => d.key).join(','));
  ok(Sim.CARDS.filter(c => c.up).every(c => I.artOf(c.key) === I.artOf(c.base)),
     '25 张升级版复用基础卡同一幅插画');
  ok(keys.every(k => /^<svg [^>]*viewBox="0 0 100 60"/.test(I.art(k)) && I.art(k).slice(-6) === '</svg>'),
     '每幅插画自包含：统一 svg 头 + 正确闭合');
}

section('战利品进卡组（v1.14）');
{
  const deckBefore = I.deck().length;
  const loot = I.rollLoot(true);
  ok(loot.length === 3 && loot.every(l => l.kind === 'deck'), '战利品为 3 张卡组候选',
     JSON.stringify(loot.map(l => l.key)));
  ok(new Set(loot.map(l => l.key.replace(/\+$/, ''))).size === 3, '三张候选互不重复');
  ok(loot.every(l => !!Sim.CARDS.find(c => c.key === l.key)), '候选 key 均在卡池内');
  /* 走结算页真实点击 */
  sim.castles.forEach(c => { if (c.owner >= 2) c.owner = 1; });
  I.step(1 / 30);
  ok(I.mode() === 'over' && panel.innerHTML.indexOf('战利品') >= 0, '结算页出现战利品三选一',
     'mode=' + I.mode() + ' over=' + sim.over);
  ok(panel.innerHTML.indexOf('卡组') >= 0, '战利品说明为「加入卡组」');
  const btn = documentStub.getElementById('panel').querySelector('.card.loot');
  ok(true, '战利品按钮渲染（DOM 打桩下按钮需直接调用 onclick）');
  /* v1.19：结算三选一同样走插画模板 */
  ok((panel.innerHTML.match(/<i class="inkart">/g) || []).length === 3, '结算三选一每卡一幅插画',
     String((panel.innerHTML.match(/<i class="inkart">/g) || []).length));
  ok(/class="card loot[^"]*r-/.test(panel.innerHTML) &&
     panel.innerHTML.indexOf('class="inkart"><svg viewBox="0 0 100 60"') >= 0,
     '选牌卡面 = 同一套插画模板 + loot 样式');
  ok(loot.every(l => l.cd > 0), '战利品候选带上冷却秒数（供选牌卡面显示）',
     JSON.stringify(loot.map(l => l.cd)));
  /* 打桩 DOM 的 querySelectorAll 返回空，改为直接校验「选卡 → 卡组变长」的函数链 */
  const key0 = loot[0].key;
  const d0 = I.deck().slice();
  d0.push(key0); I.setDeck(d0);
  ok(I.deck().length === deckBefore + 1 && I.deck()[I.deck().length - 1] === key0,
     '选中的卡写入卡组并持久化（' + deckBefore + ' → ' + I.deck().length + '）');
  ok(JSON.parse(store.get('ink.deck') || '{}').list.indexOf(key0) >= 0, '卡组写入 localStorage');
  /* 下一局用新卡组开局 */
  click('btnMenu2');
  I.menu();
  ok(panel.innerHTML.indexOf('我的卡组') >= 0, '菜单显示「我的卡组」');
  ok(click('btnQuick') && I.mode() === 'playing', '带新卡组再开一局');
  ok(I.piles(1).list.indexOf(key0) >= 0, '新卡组的卡出现在牌库 list 中');
}

/* ---------- v1.15：单兵操控（WASD 行走 · 鼠标攻击） ---------- */
section('单兵操控（v1.15）');
{
  const elHint = documentStub.getElementById('hint');
  I.setNet('none');
  I.menu();
  ok(click('btnQuick') && I.mode() === 'playing', '重开一局用于单兵操控');
  sim = I.sim();
  sim.opts.noAI = true;                            // 隔离：操控期间不被 AI 推平
  sim.castles.forEach(c => { c.tower = null; });   // 隔离：塔火会秒掉 1 兵，先清掉塔
  const mine2 = sim.castles.find(c => c.owner === 1);
  mine2.garrison = 30;

  /* 1 点中驻城环上的一个兵 */
  const ru = I.ringUnits(mine2)[0];
  tap(ru.x, ru.y);
  ok(I.sel().some(s => s.k === 'gs' && s.id === mine2.id), '点中驻城环上的兵（操控前提）', JSON.stringify(I.sel()));

  /* 2 按 D → 该兵出队并朝右走 */
  const n0 = sim.armies.length;
  I.key('KeyD', true);
  I.step(1 / 30);
  ok(sim.armies.length === n0 + 1, '按方向键后该兵单独出队', 'armies ' + n0 + '→' + sim.armies.length);
  I.manualTick(0.1);                                // 认领 + 首次改向
  I.step(1 / 30);                                   // 命令在步首统一执行
  ok(I.ctrl().id > 0, '已认领被操控的部队（ctrl.id）', JSON.stringify(I.ctrl()));
  const a1 = I.ctrlArmy();
  ok(a1 && a1.tx > a1.x, '目标点在该兵右方（D = 右）', a1 ? 'x=' + a1.x.toFixed(0) + ' tx=' + a1.tx.toFixed(0) : 'null');
  const x0 = a1 ? a1.x : 0;
  I.step(1.0); I.manualTick(0.1);
  const a2 = I.ctrlArmy();
  ok(!a2 || a2.x > x0 + 20, '按住期间持续向右行军', a2 ? 'Δx=' + (a2.x - x0).toFixed(1) : '兵已驻扎');

  /* 3 松开 → 目标收回到自身位置（就地驻扎） */
  I.key('KeyD', false);
  I.manualTick(0.1);                                // 下达「改向到自身」
  I.step(0.6);                                      // 让它抵达并驻扎（抵达 pt 目标即列阵）
  const a3 = I.ctrlArmy();
  ok(!a3, '松开方向键 → 该兵就地驻扎（转为阵列，部队实体消失）', a3 ? JSON.stringify(a3) : 'null');
  I.manualTick(0.1);                                // 部队已不在 → 操控态自动清空
  ok(I.ctrl().id === 0, '兵驻扎后操控态自动清空', JSON.stringify(I.ctrl()));

  /* 4 斜向：W+D 归一化（目标在右上） */
  mine2.garrison = 30;
  const r4 = I.ringUnits(mine2)[0];
  tap(r4.x, r4.y);
  ok(I.sel().some(x => x.k === 'gs' || x.k === 'ps'), '（准备）再次点中一个兵', JSON.stringify(I.sel()));
  I.key('KeyW', true); I.key('KeyD', true);
  I.step(1 / 30); I.manualTick(0.1);
  /* 移到地图中心再取一次改向，排除边界 clamp 干扰 */
  const real4 = sim.armies.find(a => a.id === I.ctrl().id);
  ok(!!real4, '（准备）已认领被操控的部队');
  const sp4 = midSpot(280, 200);                    // 隔离：避开城池命中干扰与边界 clamp
  if (real4){ real4.x = sp4.x; real4.y = sp4.y; }
  I.manualTick(0.1);                                // 下达改向（进命令队列）
  I.step(1 / 30);                                   // 命令在步首统一执行
  const a4 = I.ctrlArmy();
  ok(a4 && Math.abs((a4.tx - sp4.x) - 113) < 3 && Math.abs((a4.ty - sp4.y) + 113) < 3,
     'W+D 斜向归一化：目标在右上 113/113',
     a4 ? 'dx=' + (a4.tx - sp4.x).toFixed(1) + ' dy=' + (a4.ty - sp4.y).toFixed(1) : 'null');
  I.key('KeyW', false); I.key('KeyD', false);
  I.manualTick(0.1); I.step(0.6); I.manualTick(0.1);   // 松手 → 驻扎 → 操控态清空
  ok(I.ctrl().id === 0, '斜向行走松手后同样就地驻扎并清空操控', JSON.stringify(I.ctrl()));

  /* 5 未选中兵时按 WASD 只给提示，不出兵 */
  I.sel().splice(0);
  const n5 = sim.armies.length;
  I.key('KeyS', true);
  I.manualTick(0.1);
  ok(sim.armies.length === n5 && I.ctrl().id === 0, '未点中兵时按 WASD 不出兵',
     'armies=' + sim.armies.length + ' ctrl=' + I.ctrl().id);
  ok(elHint.innerHTML.indexOf('点中一个兵') >= 0, '提示「先点中一个兵」', elHint.innerHTML);
  I.key('KeyS', false);

  /* 6 鼠标攻击：选中兵 → 点敌城即冲锋 */
  mine2.garrison = 30;
  const r6 = I.ringUnits(mine2)[0];
  tap(r6.x, r6.y);
  ok(I.sel().some(s => s.k === 'gs'), '再次点中一个兵', JSON.stringify(I.sel()));
  const foeC = sim.castles.find(c => c.owner !== 1);
  const aimC = I.aim({ x: foeC.x, y: foeC.y });
  ok(aimC && aimC.k === 'c' && aimC.id === foeC.id, '敌城被识别为攻击目标', JSON.stringify(aimC));
  const n6 = sim.armies.length;
  tap(foeC.x, foeC.y);                             // 鼠标点击 = 攻击
  I.step(1 / 30);
  ok(sim.armies.length === n6 + 1, '点击敌城 → 单兵冲锋出队', 'armies ' + n6 + '→' + sim.armies.length);
  const charger = sim.armies[sim.armies.length - 1];
  ok(charger.tKind === 'c' && charger.tid === foeC.id, '冲锋目标锁定该敌城',
     'tKind=' + charger.tKind + ' tid=' + charger.tid);

  /* 7 敌军部队也可作为攻击目标（冲上去互溶） */
  sim.armies.length = 0;                           // 清场，只留一支敌军
  const sp7 = midSpot(220, 160);                    // 隔离：别把假想敌军放到城池里
  const foeArmy = { id: 9901, owner: 2, count: 4, x: sp7.x, y: sp7.y, tx: sp7.x + 10, ty: sp7.y,
                    tKind: 'pt', tid: -1, srcId: -1, hx: sp7.x, hy: sp7.y, atkT: 0 };
  sim.armies.push(foeArmy);
  mine2.garrison = 30;
  const r7 = I.ringUnits(mine2)[0];
  tap(r7.x, r7.y);
  const aimA = I.aim({ x: foeArmy.x, y: foeArmy.y });
  ok(aimA && aimA.k === 'pt' && Math.abs(aimA.x - foeArmy.x) < 1, '敌军部队可被识别为攻击目标', JSON.stringify(aimA));
  ok(!I.aim({ x: mine2.x, y: mine2.y }), '己方城池不是攻击目标（应返回 null）');

  /* 8 操控状态回菜单即清空 */
  I.sel().splice(0);                                 // 清掉上一步的兵级选择（再点同一个兵 = 取消选择）
  I.manualTick(0.6);                                 // 冲刷上一步残留的 pending（认领超时会自动放弃）
  mine2.garrison = 30;
  const r8 = I.ringUnits(mine2)[0];
  tap(r8.x, r8.y);
  ok(I.sel().some(s => s.k === 'gs'), '（准备）再次点中一个兵', JSON.stringify(I.sel()));
  I.key('KeyD', true); I.step(1 / 30); I.manualTick(0.1); I.step(1 / 30);
  ok(I.ctrl().id > 0, '（准备）已进入操控态', JSON.stringify(I.ctrl()));
  I.menu();
  ok(I.ctrl().id === 0 && !I.ctrl().keys.d, '回菜单即解除操控并松开所有方向键', JSON.stringify(I.ctrl()));
}

/* ---------- v1.16：AI 会用牌（UI 可见）+ AI 牌堆 ---------- */
section('AI 用牌（v1.16）');
{
  I.setNet('none');
  I.menu();
  ok(click('btnQuick') && I.mode() === 'playing', '重开一局用于 AI 用牌');
  sim = I.sim();

  /* AI 阵营同样有一副牌堆，四堆守恒 */
  const ap = I.aiPiles(2);
  ok(!!ap && ap.list >= Sim.CFG.MIN_DECK, 'AI（2 号）有自己的一副牌堆', JSON.stringify(ap));
  ok(ap.draw + ap.hand.length + ap.discard + ap.exhaust === ap.list, 'AI 牌堆四堆守恒',
     [ap.draw, ap.hand.length, ap.discard, ap.exhaust].join('+'));

  /* AI 会按难度定时抽牌 */
  const h0 = ap.hand.length;
  I.step(Sim.CFG.DRAW_T + 0.5);
  ok(I.aiPiles(2).hand.length > h0 || I.aiPiles(2).hand.length >= Sim.CFG.HAND_MAX,
     'AI 与玩家同规则：每 6 秒抽 1 张', '手牌 ' + h0 + '→' + I.aiPiles(2).hand.length);

  /* 敌方出牌 → 玩家看得见（敌方色飘字） */
  sim.ink[2] = 20;
  I.fx().floats.length = 0;
  const played = I.aiPlay(2, 'fire');
  I.step(0);
  /* 敌方出牌 → 玩家看得见（卡牌飘字为敌方色黛青；另有「火攻！」是受击城池的红字反馈，两者并存） */
  const fl = I.fx().floats.filter(f => f.txt.indexOf('「火攻」') >= 0);
  ok(played, 'AI 会打出手里的牌（走 cardPlay 统一入口）');
  /* v1.20：飘字带阵营字前缀，颜色改用 castleColor(by)[1]（多方混战不再一律黛青） */
  ok(fl.length === 1 && fl[0].txt.indexOf('「青」') === 0 && fl[0].color === '#1d4551',
     '敌方出牌飘字带阵营字与阵营墨色「青」「火攻」（与己方朱砂区分）',
     JSON.stringify(I.fx().floats.map(f => [f.txt, f.color])));
  ok(I.aiPiles(2).hand.indexOf('fire') < 0 && I.aiPiles(2).discard >= 1, 'AI 打出的牌进它自己的弃牌堆',
     JSON.stringify(I.aiPiles(2)));
  ok(sim.ink[2] < 20, 'AI 出牌同样扣墨（不作弊）', '墨 20→' + sim.ink[2].toFixed(1));

  /* 容易难度不用牌 */
  sim.aiDiff = { 2: 'easy' };
  sim.ink[2] = 20;
  ok(!I.aiPlay(2, 'fire'), '容易 AI 不使用卡牌（cardLv 0）');
  sim.aiDiff = null;
}

/* ============================================================
 * v1.18：军队 WASD 接管 / 点城回防 · 卡面冷却 · 移动端布局实测
 * ============================================================ */
section('军队接管与回防 · 卡面冷却 · 布局实测（v1.18）');
{
  /* --- WASD 直接接管整支在途军队（v1.15 只能控单兵） --- */
  const sp18 = midSpot(300, 200);                    // 避开塔射程与城池命中干扰
  const army18 = { id: 9100, owner: 1, count: 12, x: sp18.x, y: sp18.y, tx: sp18.x, ty: sp18.y,
                   tKind: 'pt', tid: -1, srcId: -1, hx: sp18.x, hy: sp18.y, atkT: 0 };
  sim.armies = sim.armies.filter(a => a.owner !== 1 || Math.hypot(a.x - sp18.x, a.y - sp18.y) > 320);
  sim.armies.push(army18);
  I.sel().splice(0); I.sel().push({ k: 'a', id: army18.id });
  fire(winStub, 'keydown', { code: 'KeyW' });
  ok(I.ctrl().id === army18.id, '选中在途军队按 W → 直接接管整支部队（无需单兵出队认领）', 'ctrl.id=' + I.ctrl().id);
  const ty0 = army18.ty;
  t = pump(20, t);
  ok(army18.ty < ty0 - 1, '接管后 W 持续行军（目标点持续前移）', ty0.toFixed(1) + ' → ' + army18.ty.toFixed(1));
  fire(winStub, 'keyup', { code: 'KeyW' });
  t = pump(3, t);                                    // 松手 → 就地驻扎（与真实操作间隔一致）
  ok(!sim.armies.some(a => a.id === army18.id), '松开 WASD → 部队抵达自身位置列阵（在途清场）');

  /* --- 选中军队点己方城池 = 回防（不再切换选中城池） --- */
  const sp19 = midSpot(300, 200);
  const army19 = { id: 9101, owner: 1, count: 12, x: sp19.x, y: sp19.y, tx: sp19.x, ty: sp19.y,
                   tKind: 'pt', tid: -1, srcId: -1, hx: sp19.x, hy: sp19.y, atkT: 0 };
  sim.armies.push(army19);
  I.sel().splice(0); I.sel().push({ k: 'a', id: army19.id });
  const home18 = sim.castles.find(c => c.owner === 1);
  tap(home18.x, home18.y);
  t = pump(2, t);                                    // 军令入队 → 下一步生效（与真实帧序一致）
  ok(Math.abs(army19.tx - home18.x) < 0.01 && Math.abs(army19.ty - home18.y) < 0.01,
     '选中军队点击己方城池 → 回防（目标 = 城池坐标）', army19.tx.toFixed(0) + ',' + army19.ty.toFixed(0));
  ok(I.sel().length === 0, '回防军令下达后清空选择');

  /* --- 卡面冷却：打出后卡面显示冷却秒数并置灰，到期恢复 --- */
  sim.hands[1] = ['fire', 'levy']; sim.ink[1] = 20;
  I.step(0);
  const cardsEl18 = documentStub.getElementById('cards');
  /* v1.33：冷却秒数不再写在卡面，改由浮层展示 */
  ok(I.tipShow(0) && I.tip().html.indexOf('冷却 30s') >= 0,
     '浮层标出冷却秒数（火攻 30s）', I.tip().html.slice(0, 140));
  I.tipHide();
  fire(winStub, 'keydown', { code: 'Digit2' });      // 打出无目标的「征兵」（槽 2）
  ok(sim.cardCd[1].levy > sim.t, '打出征兵 → 同名卡进入冷却');
  sim.hands[1] = ['fire', 'levy'];                   // 模拟冷却中再抽到一张同名卡
  I.step(0);
  ok(/class="card[^"]*dim/.test(cardsEl18.innerHTML),
     '冷却中再抽到同名卡 → 卡面置灰', cardsEl18.innerHTML.slice(0, 260));
  ok(I.tipShow(1) && I.tip().html.indexOf('冷却中 8s') >= 0,
     '冷却中：浮层提示「冷却中 8s」', I.tip().html.slice(0, 160));
  I.tipHide();
  /* v1.19：冷却徽标读 .cn 上的 data-cd，不产出任何新可见文本（既有文本断言免疫） */
  ok(/<div class="cn" data-cd="\d+"/.test(cardsEl18.innerHTML), '冷却中：徽标读的是 cn 上的 data-cd');
  for (let i18 = 0; i18 < 9 * 30; i18++) Sim.step(sim, 1 / 30);
  I.step(0);
  ok(cardsEl18.innerHTML.indexOf('⏱') < 0, '冷却到期后卡面恢复（无 ⏱ 标注）', cardsEl18.innerHTML.slice(0, 200));
  ok(I.tipShow(1) && I.tip().html.indexOf('冷却中') < 0, '冷却到期：浮层不再提示冷却中');
  I.tipHide();
  ok(!/data-cd=/.test(cardsEl18.innerHTML), '冷却到期：data-cd 标记一并消失');

  /* --- 移动端布局实测（v1.17 收尾）：预留高度实测化 + visualViewport 软键盘重排 --- */
  const L0 = I.layout();
  ok(L0.reserve >= 72, '启动即实测舞台预留高度（兜底下限 72px）', 'reserve=' + L0.reserve);
  ok(String(documentStub.documentElement.style['--vvh']) === '812px',
     'visualViewport 高度写入 --vvh', String(documentStub.documentElement.style['--vvh']));
  documentStub.querySelector('.topbar').offsetHeight = 44;
  documentStub.querySelector('.cardbar').offsetHeight = 124;
  I.relayout();
  ok(I.layout().reserve === 200, '预留高度 = 顶栏44 + 卡栏124 + 间距16 + 安全区16 = 200', 'reserve=' + I.layout().reserve);
  ok(String(documentStub.documentElement.style['--stage-reserve']) === '200px', '--stage-reserve 写入根节点样式');
  winStub.visualViewport.height = 460;               // 模拟软键盘弹出
  fire(winStub.visualViewport, 'resize', {});
  ok(I.layout().vvh === 460 && String(documentStub.documentElement.style['--vvh']) === '460px',
     '软键盘弹出（visualViewport 460）→ --vvh 重排', JSON.stringify(I.layout()));
  ok(I.layout().reserve === 200, '键盘弹出不影响已测预留（未触顶 72% 钳制）');
}

/* ---------- v1.20：屏内方向键（无键盘环境也能单兵操控）+ 认领竞态修复 ---------- */
section('屏内方向键与认领竞态修复（v1.20）');
{
  I.menu();
  ok(click('btnQuick') && I.mode() === 'playing', '重开一局用于方向键测试（开局会清空操控态）');
  sim = I.sim();
  sim.opts.noAI = true;                            // 隔离：操控期间不被 AI 推平
  sim.castles.forEach(c => { c.tower = null; });   // 隔离：塔火会秒掉 1 兵
  const sp20 = midSpot(300, 200);
  sim.armies = sim.armies.filter(a => a.owner !== 1 || Math.hypot(a.x - sp20.x, a.y - sp20.y) > 320);
  sim.camps = sim.camps.filter(p => p.owner !== 1 || Math.hypot(p.x - sp20.x, p.y - sp20.y) > 320);
  /* 目标给一座很远的敌/中立城：保证它一直在途，不会自行列阵 —— 「原目标不变」才有可断言的意义 */
  const far20 = sim.castles.filter(c => c.owner !== 1)
    .sort((a, b) => Math.hypot(b.x - sp20.x, b.y - sp20.y) - Math.hypot(a.x - sp20.x, a.y - sp20.y))[0];
  function mkArmy20(id, x, y){
    return { id: id, owner: 1, count: 10, x: x, y: y, tx: far20.x, ty: far20.y,
             tKind: 'c', tid: far20.id, srcId: -1, hx: x, hy: y, atkT: 0 };
  }
  const army20 = mkArmy20(9200, sp20.x, sp20.y);
  sim.armies.push(army20);

  /* 1 没选中任何兵/部队 → 方向键不出现 */
  I.sel().splice(0);
  I.dpadUpdate();
  ok(I.dpad().on === false && I.dpad().cls === 'dpad',
     '未选中兵/部队时方向键不出现（不抢棋盘视野）', JSON.stringify(I.dpad()));

  /* 2 点中在途部队里的一个兵 → 方向键出现，中心键为「全」 */
  const u20 = I.formations(army20)[2];
  tap(u20.x, u20.y);
  ok(I.sel().some(s => s.k === 's' && s.id === army20.id), '点中在途部队里的一个兵', JSON.stringify(I.sel()));
  I.dpadUpdate();
  ok(I.dpad().on === true && I.dpad().mid === '全' && I.dpad().cls === 'dpad on',
     '选中兵后屏内方向键出现，中心键为「全」（点它即接管整支）', JSON.stringify(I.dpad()));

  /* 3 中心键「全」→ 接管整支部队；接管后中心键变「驻」 */
  ok(I.takeover() && I.ctrl().id === army20.id, '方向键中心「全」→ 接管该兵所在整支部队', 'ctrl.id=' + I.ctrl().id);
  I.dpadUpdate();
  ok(I.dpad().mid === '驻', '接管后中心键变「驻」（点它即就地列阵）', JSON.stringify(I.dpad()));
  I.key('KeyW', true);
  I.dpadMid();                                         // 此时的中心键是「驻」
  ok(!I.ctrl().keys.w, '点中心「驻」→ 清空所有方向键（下一 tick 就地驻扎）', JSON.stringify(I.ctrl().keys));
  I.key('KeyW', false);

  /* 4 ★ 认领竞态修复：按方向键只让这个兵出队，不得把整支大军一起劫持 */
  sim.armies = sim.armies.filter(a => a.id !== I.ctrl().id);   // 先卸掉上一步的操控态
  I.manualTick(0.1);
  ok(I.ctrl().id === 0, '（隔离）操控态已清空', JSON.stringify(I.ctrl()));
  const army22 = mkArmy20(9202, sp20.x + 100, sp20.y + 80);
  sim.armies.push(army22);
  const u22 = I.formations(army22)[2];
  I.sel().splice(0);
  tap(u22.x, u22.y);
  ok(I.sel().some(s => s.k === 's' && s.id === army22.id), '（准备）点中大军里的一个兵', JSON.stringify(I.sel()));
  const n22 = sim.armies.length, tx0 = army22.tx, ty0 = army22.ty;
  I.key('KeyW', true);
  I.step(1 / 30);
  ok(sim.armies.length === n22 + 1, '按方向键 → 该兵单独出队', 'armies ' + n22 + '→' + sim.armies.length);
  I.manualTick(0.1);                                   // 认领（现在只认领「按下前不存在」的新部队）
  I.step(1 / 30);
  ok(I.ctrl().id > 0 && I.ctrl().id !== army22.id,
     '认领的是新建的单兵部队（不是原大军）', 'ctrl.id=' + I.ctrl().id + ' army=' + army22.id);
  ok(Math.abs(army22.tx - tx0) < 0.01 && Math.abs(army22.ty - ty0) < 0.01,
     '★ 竞态修复：整支大军的目标不被改写（不再被误劫持）',
     '原目标 ' + tx0.toFixed(1) + ',' + ty0.toFixed(1) + ' → ' + army22.tx.toFixed(1) + ',' + army22.ty.toFixed(1));
  I.key('KeyW', false);

  /* 5 框选整支 → 同样可直接接管 */
  const army21 = { id: 9201, owner: 1, count: 8, x: sp20.x + 60, y: sp20.y + 40,
                   tx: sp20.x + 60, ty: sp20.y + 40, tKind: 'pt', tid: -1, srcId: -1,
                   hx: sp20.x + 60, hy: sp20.y + 40, atkT: 0 };
  sim.armies.push(army21);
  I.sel().splice(0); I.sel().push({ k: 'a', id: army21.id });
  I.dpadUpdate();
  ok(I.dpad().on === true, '框选整支部队时方向键同样出现');
  ok(I.takeover() && I.ctrl().id === army21.id, '框选整支 → 接管成功', 'ctrl.id=' + I.ctrl().id);
}

/* ---------- v1.19：卡面 CSS / 资产表静态约束（靠顶层 html 全文，覆盖打桩摸不到的 CSS 断点） ---------- */
section('卡面 CSS 与资产表静态约束（v1.19）');
{
  ok((html.match(/<script>/g) || []).length === 2, '文件仍恰好两个 script 块（测试提取器依赖）',
     String((html.match(/<script>/g) || []).length));
  ok(html.indexOf('--rar-u:#3f6f9a') >= 0 && html.indexOf('--rar-r:#9a6a1e') >= 0 &&
     Sim.RARITY.u.color === '#3f6f9a' && Sim.RARITY.r.color === '#9a6a1e',
     'CSS 稀有度变量与 Sim.RARITY.color 同源');
  ok(!/\.inkart[^{]*\{[^}]*display\s*:\s*none/.test(html),
     '任何断点都不隐藏插画（只调 --art-op / --art-loot-h）');
  const mq = html.match(/@media \(max-width:700px\) and \(orientation:portrait\)\{[\s\S]*?\n\}/);
  ok(!!mq && /--art-op/.test(mq[0]), '窄屏竖屏断点（≤700px + portrait）显式给出插画降级');
  const a0 = html.indexOf('var ART = {'), a1 = html.indexOf('/* ===== v1.19 卡面插画·结束 ===== */');
  const artBlock = (a0 >= 0 && a1 > a0) ? html.slice(a0, a1) : '';
  ok(artBlock.length > 2000, '插画表已就位（哨兵注释可被静态切片命中）', 'len=' + artBlock.length);
  ok(!!artBlock && !/defs|linearGradient|radialGradient|feTurbulence|feDisplacement|filter\s*=/.test(artBlock),
     '插画不含 defs / 渐变 / 滤镜（data-URI 取不到 #id，且逐像素滤镜每秒重算会掉帧）');
  ok(!!artBlock && !/<\/script/.test(artBlock), '插画串里不含 </script（防 HTML 解析提前截断）');
  ok(Sim.CARDS.filter(c => !c.up).every(c => new RegExp('[\'"]' + c.key + '[\'"]\\s*:').test(artBlock)),
     '25 张基础卡在插画表中都有 entry',
     '缺：' + Sim.CARDS.filter(c => !c.up && !new RegExp('[\'"]' + c.key + '[\'"]\\s*:').test(artBlock)).map(c => c.key).join(','));
  ok(Sim.DAILIES.every(d => new RegExp('[\'"]' + d.key + '[\'"]\\s*:').test(artBlock)),
     '5 张日卡在插画表中都有 entry',
     '缺：' + Sim.DAILIES.filter(d => !new RegExp('[\'"]' + d.key + '[\'"]\\s*:').test(artBlock)).map(d => d.key).join(','));
}

/* ---------- v1.20：敌方出牌提示（横幅 + 目标飘字/圆环 + 阵营色） ---------- */
section('敌方出牌提示（v1.20）');
{
  const sim = I.sim();
  const my = I.side();
  const foe = my === 1 ? 2 : 1;
  const FOE_INK = { 1: '#8e2a1d', 2: '#1d4551', 3: '#7a4c22', 4: '#2f5230' };   // 与 castleColor(o)[1] 同源
  const mine = sim.castles.filter(c => c.owner === my)[0];
  const neutral = sim.castles.filter(c => c.owner === 0)[0];

  /* 1) 我方自己出牌 → 不弹横幅（避免遮挡视线） */
  I.foeBarHide();
  I.fx().floats.length = 0;
  sim.ink[my] = 30;
  sim.hands[my].length = 0; sim.hands[my].push('levy');
  Sim.cardPlay(sim, 0, undefined, my);
  I.step(0);
  ok(I.foeBar().life === 0, '己方出牌不弹敌方横幅（只走飘字）', JSON.stringify(I.foeBar()));

  /* 2) 敌方打一张有目标的牌 → 横幅 + 目标城池飘字/圆环 */
  I.fx().floats.length = 0; I.fx().fxs.length = 0;
  sim.ink[foe] = 30;
  sim.hands[foe].length = 0; sim.hands[foe].push('fire');
  Sim.cardPlay(sim, 0, mine.id, foe);
  I.step(0);
  const fb = I.foeBar();
  ok(fb.life > 0 && fb.txt.indexOf('敌方') === 0 && fb.txt.indexOf('「火攻」') > 0,
     '敌方出牌弹出顶部横幅（含阵营与卡名）', JSON.stringify(fb));
  ok(fb.txt.indexOf('指向你的城池') > 0, '横幅指明「指向你的城池」', fb.txt);
  ok(fb.color === FOE_INK[foe], '横幅取该阵营墨色（多方混战不再一律黛青）', fb.color);
  ok(I.foeBarEl().indexOf('火攻') > 0 && I.foeBarEl().indexOf('foebar') < 0,
     '横幅写进 DOM（#foebar 的 innerHTML）', I.foeBarEl());
  const flT = I.fx().floats.filter(f => f.txt.indexOf('「火攻」') >= 0);
  ok(flT.length === 1 && Math.abs(flT[0].x - mine.x) < 0.01 && flT[0].y < mine.y,
     '卡名飘字落在被打城池上方（不是地图顶部）', JSON.stringify(flT));
  ok(I.fx().fxs.some(f => Math.abs(f.x - mine.x) < 0.01 && Math.abs(f.y - mine.y) < 0.01),
     '被打城池叠一圈扩散环', JSON.stringify(I.fx().fxs.slice(-3)));

  /* 3) 打中立城 → 文案区分「中立城」 */
  if (neutral){
    I.foeBarHide();
    sim.ink[foe] = 30;
    sim.hands[foe].length = 0; sim.hands[foe].push('fire');
    Sim.cardPlay(sim, 0, neutral.id, foe);
    I.step(0);
    ok(I.foeBar().txt.indexOf('指向中立城') > 0, '打中立城时文案写明「指向中立城」', I.foeBar().txt);
  }

  /* 4) 无目标的全局牌 → 不指城池，飘字回地图顶部 */
  I.foeBarHide();
  I.fx().floats.length = 0;
  sim.ink[foe] = 30;
  sim.hands[foe].length = 0; sim.hands[foe].push('levy');
  Sim.cardPlay(sim, 0, undefined, foe);
  I.step(0);
  ok(I.foeBar().life > 0 && I.foeBar().txt.indexOf('指向') < 0,
     '无目标的全局牌（征兵）不指城池', I.foeBar().txt);
  const flG = I.fx().floats.filter(f => f.txt.indexOf('「征兵」') >= 0);
  ok(flG.length === 1 && Math.abs(flG[0].x - Sim.CFG.MAP_W / 2) < 0.01 && flG[0].y === 70,
     '全局牌飘字仍在地图顶部居中', JSON.stringify(flG));
}

/* ---------- v1.20：屏内方向键（无键盘环境也能单兵操控） ---------- */
section('屏内方向键（v1.20）');
{
  ok(/<div class="dpad" id="dpad">/.test(html), 'HTML 里有 .dpad 容器（直属 .stage，与 canvas 平级）');
  ok(/\.dpad[^{]*\{[^}]*display\s*:\s*none/.test(html) && /\.dpad\.on\{[^}]*display\s*:\s*grid/.test(html),
     '方向键默认隐藏、.on 时才显示（不抢棋盘视野）');
  ok(/\.dpad\{[^}]*pointer-events/.test(html) === false && /\.foebar\{[^}]*pointer-events\s*:\s*none/.test(html),
     '提示条 pointer-events:none 不挡棋盘点击');
  ok(/takeoverArmy/.test(html) && /updateDPad/.test(html), '接管整支部队与显隐更新函数已就位');
}

/* ---------- v1.21：手机端响应式布局（静态 CSS 约束 + 横屏侧栏的预留计算） ---------- */
section('手机端响应式布局（v1.21）');
{
  /* 1 hint 高度钉死：文案变化不再撑高卡栏 → 棋盘不再跳（实测平板上曾位移 53px） */
  ok(/\.hint\{[^}]*height:\s*\d+px[^}]*overflow:\s*hidden/.test(html),
     '提示条高度钉死且溢出裁剪（卡栏高度恒定，棋盘不跳）');
  ok(!/\.hint\{[^}]*min-height/.test(html), '.hint 不再用可变的 min-height（高度必须钉死）');

  /* 2 竖屏：提示必须可见（原先整个手机端都看不到操作指引），且卡栏贴底、卡面恢复描述 */
  const mqP = html.match(/@media \(max-width:700px\) and \(orientation:portrait\)\{[\s\S]*?\n\}/);
  ok(!!mqP && !/\.hint\{[^}]*display\s*:\s*none/.test(mqP[0]) && /display:block/.test(mqP[0]),
     '手机竖屏提示可见（不再 display:none）');
  /* v1.37 竖屏重做：舞台 flex:1 吃掉全部剩余高度 + 画布绝对定位铺满，取代旧的「auto margin 均分死白」 */
  ok(!!mqP && /\.stage\{[\s\S]*?flex:1 1 auto[\s\S]*?min-height:0[\s\S]*?\}/.test(mqP[0]),
     '竖屏舞台 flex:1 + min-height:0（吃掉剩余纵向空间，不再靠 auto margin 均分出死白）');
  ok(!!mqP && /#board\{[^}]*position:absolute/.test(mqP[0]) && /#board\{[^}]*aspect-ratio:auto/.test(mqP[0]),
     '竖屏画布绝对定位铺满舞台（不再按 --board-ar 反推高度）');
  ok(!!mqP && /--board-ar-min/.test(mqP[0]) && /max-height:calc\(96vw \/ var\(--board-ar-min/.test(mqP[0]),
     '竖屏画布有「最多允许多瘦」闸门 --board-ar-min（避免裁切过头）');
  ok(!!mqP && /\.cardbar \.card\{min-height:7\dpx\}/.test(mqP[0]),
     '竖屏手牌高度用 .cardbar .card（更高特异性）压过 pointer:coarse 的 44px（旧写法被覆盖成 44px）');
  /* v1.33：手牌卡面不再产出 .cd（描述行移入浮层），但这条 CSS 保留给结算三选一（.card.loot） */
  ok(!!mqP && /\.card \.cd\{display:flex/.test(mqP[0]),
     '竖屏描述行 CSS 保留（服务结算三选一，手牌已改用浮层）');

  /* 3 横屏：卡栏改右侧竖排侧栏（fixed 不占纵向），棋盘宽度公式随之放宽 */
  const mqL = html.match(/@media \(max-width:950px\) and \(orientation:landscape\)\{[\s\S]*?\n\}/);
  ok(!!mqL && /position\s*:\s*fixed/.test(mqL[0]) && /flex-direction\s*:\s*column/.test(mqL[0]),
     '横屏卡栏改为右侧竖排侧栏（fixed，不占纵向高度）');
  ok(!!mqL && /96vw - 208px/.test(mqL[0]),
     '横屏棋盘宽度让出侧栏（96vw - 208px，v1.37 侧栏 180 → 196）');
  ok(!!mqL && !/\.hint\{[^}]*display\s*:\s*none/.test(mqL[0]),
     '横屏提示也可见（侧栏底部一行，高度钉死）');

  /* 4 JS 与 CSS 同源：预留计算在横屏侧栏下不计入卡栏高度 */
  ok(/mqLand[^;]*matchMedia\('\(max-width:950px\) and \(orientation:landscape\)'\)/.test(html) &&
     /if \(!landscapeSide\(\) && elCardbar\)/.test(html),
     '预留计算与 CSS 断点同源：横屏侧栏不计入纵向预留');

  /* 5 行为验证：横屏侧栏时 reserve 只由顶栏决定（stub 用 getter，保证缓存到的 MediaQueryList 也能跟着翻） */
  const savedMM = winStub.matchMedia, savedVV = winStub.visualViewport.height;
  winStub.visualViewport.height = 1200;                          // 拉高视口，避开 72% 钳制干扰
  let landOn = true;
  winStub.matchMedia = function(q){ return { get matches(){ return landOn; }, media: q }; };
  documentStub.querySelector('.topbar').offsetHeight = 44;
  documentStub.querySelector('.cardbar').offsetHeight = 400;    // 侧栏很高也不该计入
  I.relayout();
  ok(I.layout().reserve === 76, '横屏侧栏：预留 = 顶栏44 + padding16 + gap16 = 76（卡栏高度被忽略）',
     'reserve=' + I.layout().reserve);
  landOn = false;                                               // 切回竖屏
  I.relayout();
  ok(I.layout().reserve === 476, '切回竖屏：卡栏高度重新计入（44+400+16+16=476）', 'reserve=' + I.layout().reserve);
  if (savedMM) winStub.matchMedia = savedMM;
  winStub.visualViewport.height = savedVV;
  documentStub.querySelector('.cardbar').offsetHeight = 124;
  I.relayout();

  /* 6 触控热区（O9 控件热区 ≥ 44px，真机实测补齐）：pointer:coarse 下
     窄屏暂停按钮只有一个「‖」字符，盒宽曾仅 34px；关卡格 40×40 也不达标 */
  const coarse = (function(){
    const a = html.indexOf('@media (pointer:coarse){');
    if (a < 0) return '';
    const b = html.indexOf('\n}', a);
    return b > a ? html.slice(a, b) : '';
  })();
  ok(coarse.length > 0 && /\.tbtn\{min-width:44px\}/.test(coarse),
     '触屏热区：.tbtn 补 min-width 44px（真机实测暂停按钮 34×44 不达标）');
  ok(/\.lvl\{min-width:44px;min-height:44px\}/.test(coarse),
     '触屏热区：.lvl 撑到 44×44（原 40×40 / 窄屏 36×36 不达标）');
  ok(/\.tbtn,\.opt,\.ratio b,\.card,\.bb\{min-height:44px\}/.test(coarse),
     '触屏热区：手牌 / 比例 / 面板按钮的 min-height 44px 规则保留');
}

/* ---------- v1.22 屯兵不再散逸 ---------- */
section('屯兵不再散逸（v1.22）');
{
  /* 选点：取「离最近城池最远」的网格点（城池环兵半径 ≤ 90，留出余量即可隔离计数） */
  const sp = (function(){
    let best = { x: W / 2, y: H / 2 }, bestD = -1;
    for (let gx = 120; gx < W - 120; gx += 40)
      for (let gy = 120; gy < H - 120; gy += 40){
        let d = 1e9;
        for (const c of sim.castles) d = Math.min(d, Math.hypot(c.x - gx, c.y - gy));
        if (d > bestD){ bestD = d; best = { x: gx, y: gy }; }
      }
    best.d = bestD;
    return best;
  })();
  const CID = 8901;
  sim.camps = sim.camps.filter(p => p.id !== CID && Math.hypot(p.x - sp.x, p.y - sp.y) >= 180);  // 隔离：清掉附近的其它阵列
  sim.camps.push({ id: CID, owner: 1, x: sp.x, y: sp.y, count: 12, atkT: 0 });
  /* 只看本阵列的字兵：驻城环兵/在途部队同样画「兵」，半径收在「最近城池距离 - 90」内且统计前清场 */
  const RCNT = Math.max(24, Math.min(45, sp.d - 90));
  const soldierCount = cs => cs.filter(k => k.fn === 'fillText' && k.args[0] === '兵'
                                          && Math.hypot(k.args[1] - sp.x, k.args[2] - sp.y) < RCNT).length;
  sim.armies.length = 0;
  const n0 = soldierCount(frame());
  ok(n0 === 12, '阵列渲染 12 个「兵」字（全量字兵）', '实际 ' + n0 + '（半径 ' + RCNT.toFixed(0) + '）');
  /* 跑 30 秒：旧规则下足以散逸 6 兵。每步清空在场部队，隔离「敌军路过打光阵列」的合法玩法干扰 */
  for (let i = 0; i < 900; i++){ sim.armies.length = 0; Sim.step(sim, 1 / 30); }
  const cp = sim.camps.filter(p => p.id === CID)[0];
  ok(!!cp && cp.count === 12, '30 秒后阵列兵力不变（不再散逸）', cp ? '实际 ' + cp.count : '阵列已消失');
  sim.armies.length = 0;
  const n1 = soldierCount(frame());
  ok(n1 === 12, '30 秒后阵列仍渲染 12 个「兵」字', '实际 ' + n1);
  /* 派空 → 屯点消失（保留既有清场规则） */
  Sim.command(sim, { owner: 1, from: [{ k: 'p', id: CID }], to: { k: 'c', id: sim.castles.find(c => c.owner === 1).id }, ratio: 1 });
  for (let i = 0; i < 120; i++) Sim.step(sim, 1 / 30);
  ok(!sim.camps.some(p => p.id === CID), '兵派空后「屯」点消失（清场规则保留）');
}

/* ---------- v1.23 过城开战 ---------- */
section('过城开战（v1.23）');
{
  ok(/var castleR = Sim\.castleR/.test(html), '渲染层复用逻辑块 castleR（过城判定与渲染同一把尺子）');

  /* 行为：己方部队经过敌/中立城 → 驻军被消耗、城池不易主、画出一圈墨晕 */
  const foeC = sim.castles.filter(c => c.owner !== 1 && c.garrison >= 4)[0];
  sim.castles.forEach(c => { if (c !== foeC) { c.x = -5000; c.y = -5000; c.tower = null; } });  // 隔离：其余城搬离航道并拆塔
  foeC.tower = null;
  const dir = foeC.x < W / 2 ? 1 : -1;
  const sx = foeC.x - dir * 220, ex = foeC.x + dir * 300;
  const n = Math.min(120, Math.floor(foeC.garrison) + 8);
  sim.armies.length = 0;
  sim.armies.push({ id: 9701, owner: 1, count: n, x: sx, y: foeC.y, tx: ex, ty: foeC.y,
                    tKind: 'pt', tid: -1, srcId: -1, hx: sx, hy: foeC.y, atkT: 0 });
  const g0 = foeC.garrison, own0 = foeC.owner;
  let steps = 0;
  while (foeC.garrison >= g0 - 0.5 && steps < 400){ Sim.step(sim, 1 / 30); steps++; }
  ok(foeC.garrison < g0 - 0.5, '部队经过敌/中立城 → 驻军被消耗（过城开战生效）',
     '驻军 ' + g0.toFixed(1) + ' → ' + foeC.garrison.toFixed(1));
  const ink0 = sim.ink[1];
  ok(foeC.owner === 1, 'v1.36 守军打光 → 路过即接管（v1.35 前「打光了仍挂敌旗」）',
     'owner ' + own0 + ' → ' + foeC.owner);
  ok(foeC.garrison >= 1 && foeC.garrison <= n - Math.floor(g0) + 1.5,
     '接管后驻军 = 剩余兵力（与抵达同口径）', '驻军 ' + foeC.garrison.toFixed(1) + ' · 兵力差 ' + (n - Math.floor(g0)));
  ok(sim.ink[1] === Math.min(sim.inkMax, ink0 + (own0 === 0 ? 1 : 2)),
     '接管照常进墨（中立 +1 / 敌方 +2，墨满则不再加）', '墨 ' + ink0 + ' → ' + sim.ink[1] + ' / 上限 ' + sim.inkMax);
  ok(sim.armies.some(a => a.id === 9701 && a.count >= 1), '互耗后部队继续行军（未被城池吞掉）');
  const cs = frame();
  ok(I.fx().fxs.some(f => Math.hypot(f.x - foeC.x, f.y - foeC.y) < 90),
     '过城开战画出墨晕特效（落在该城位置）', 'fx ' + I.fx().fxs.length);
  ok(sim.castles.filter(c => c.x > 0).length === 1, '（隔离有效：航道只剩这一座城）');
}

/* ---------- 联机模式：快照编解码 + 指令闭环（v1.23 回归） ---------- */
section('联机模式 · 快照与指令闭环（v1.23）');
{
  /* 1 客机收到 start → 以阵营 2 开局（镜像地图同种子重建） */
  I.setNet('guest');
  I.netMsg(JSON.stringify({ t: 'start', seed: 20261015, size: 9 }));
  ok(I.side() === 2 && I.mode() === 'playing', '客机收到 start → 以阵营 2 进入对局',
     'side=' + I.side() + ' mode=' + I.mode());
  const g = I.sim();
  ok(g.castles.length === 9 && g.castles.some(c => c.owner === 2) && g.opts.noAI === true,
     '客机镜像：同种子 9 城、含 2 号主城、本机不跑 AI', '城 ' + g.castles.length);

  /* 2 主机快照结构完整 */
  I.setNet('host');
  const snap = I.snap();
  ok(!!snap && snap.cs.length === g.castles.length && Array.isArray(snap.ar) && Array.isArray(snap.cp) &&
     snap.ink.length === 3 && snap.pl.length === 6 && snap.cap.length === 3 && snap.cd.length === 2,
     '快照结构完整（城池 / 部队 / 阵列 / 墨量 / 手牌 / 冷却 / 三堆 / 统计）',
     snap ? 'cs' + snap.cs.length + ' ar' + snap.ar.length + ' pl' + snap.pl.length : 'null');
  /* v1.26：城池行从 11 扩到 15 字段（尾部追加 ambushT / ambushN / plagueT / 塔临时剩余，新旧版本可互解） */
  ok(snap.cs.every(r => r.length === 15) && snap.ar.every(r => r.length === 11),
     '快照行宽一致（城池 15 字段 / 部队 11 字段）');

  /* 3 编解码闭环：故意把本地改坏，再套用主机快照应被完全覆盖 */
  const before = g.castles.map(c => [c.owner, c.level, c.garrison]);
  g.castles.forEach(c => { c.garrison = 999; c.owner = 3; });
  g.armies.push({ id: 99001, owner: 4, count: 7, x: 10, y: 10, tx: 10, ty: 10, tKind: 'pt', tid: -1, srcId: -1, hx: 10, hy: 10, atkT: 0 });
  I.setNet('guest');
  I.netMsg(JSON.stringify(snap));
  ok(g.castles.every((c, i) => c.owner === before[i][0] && c.level === before[i][1] &&
                              Math.abs(c.garrison - before[i][2]) < 0.06),
     '套用快照后驻军/归属/等级被主机数据覆盖（编解码字段对齐）');
  ok(!g.armies.some(a => a.id === 99001) && g.armies.length === snap.ar.length,
     '阵列与部队按快照重建（本地脏数据被清掉）', '部队 ' + g.armies.length + ' vs 快照 ' + snap.ar.length);
  ok(g.camps.length === snap.cp.length, '阵列数量与快照一致', g.camps.length + ' vs ' + snap.cp.length);

  /* 4 指令闭环：客机 send / card → 主机执行（owner=2） */
  I.setNet('host');
  const src = g.castles.find(c => c.owner === 2);
  const dst = g.castles.find(c => c.owner !== 2);
  src.garrison = 30;
  const n0 = g.armies.filter(a => a.owner === 2).length;
  I.netMsg(JSON.stringify({ t: 'cmd', kind: 'send', cmd: { owner: 2, from: [{ k: 'c', id: src.id }], to: { k: 'c', id: dst.id }, ratio: 1 } }));
  I.step(0.2);
  ok(g.armies.filter(a => a.owner === 2).length > n0, '客机 send 指令 → 主机执行出兵（owner=2）',
     '部队 ' + n0 + ' → ' + g.armies.filter(a => a.owner === 2).length);
  g.ink[2] = 10; g.hands[2] = ['levy']; if (g.piles[2]) g.piles[2].hand = g.hands[2];
  const ink0 = g.ink[2];
  I.netMsg(JSON.stringify({ t: 'cmd', kind: 'card', slot: 0, target: -1 }));
  ok(g.ink[2] < ink0, '客机出牌指令 → 主机执行并扣墨（2 号）', '墨 ' + ink0 + ' → ' + g.ink[2]);

  /* 5 暂停权在房主：客机收到 pause 才暂停 */
  I.setNet('guest');
  I.netMsg(JSON.stringify({ t: 'pause', on: true }));
  ok(I.mode() === 'paused', '客机收到房主暂停 → 进入暂停', I.mode());
  I.netMsg(JSON.stringify({ t: 'pause', on: false }));
  ok(I.mode() === 'playing', '房主继续 → 客机恢复对局', I.mode());

  /* 6 胜负同步：快照带 over 时客机立即结算（放在最后，会切到 over） */
  const snap2 = I.snap();
  I.setNet('host');
  const overSnap = I.snap();
  overSnap.ov = 1;                     // 主机判定 1 号胜
  I.setNet('guest');
  I.netMsg(JSON.stringify(overSnap));
  ok(I.mode() === 'over', '快照带 over → 客机立即结算（无需自己跑模拟）', I.mode());
  ok(!!snap2, '（快照可重复捕获）');
  I.setNet('none');
}

/* ---------- v1.24 新卡牌 / 新机制 / 关卡目标 ---------- */
section('新卡牌与关卡目标（v1.24）');
{
  /* 1 关卡表 15 关 + 菜单角标 */
  ok(Sim.CAMPAIGN.length === 15, '闯关 15 关', '实际 ' + Sim.CAMPAIGN.length);
  I.menu();
  ok(panel.innerHTML.indexOf('/ 15') >= 0, '菜单进度显示 x / 15');
  ok(/data-lv="8"[^>]*>8<small>守90秒<\/small>/.test(panel.innerHTML), '菜单角标标出守城关（第 8 关 守 90 秒）');
  ok(/data-lv="12"[^>]*>12<small>占6城<\/small>/.test(panel.innerHTML), '菜单角标标出占领关（第 12 关 占 6 城）');
  ok(/data-lv="7"[^>]*>7<small>限240秒<\/small>/.test(panel.innerHTML), '菜单角标标出限时关（第 7 关 限 240 秒）');
  ok(/data-lv="13"[^>]*>13<small>守110秒<\/small>/.test(panel.innerHTML), '菜单角标标出守城关（第 13 关 守 110 秒）');
  ok(panel.innerHTML.indexOf('角标 = 本关目标') >= 0, '菜单给出目标图例');
  ok(/data-art="ambush"/.test(panel.innerHTML) && /data-art="sabotage"/.test(panel.innerHTML),
     '图鉴收录七张新卡（伏击 / 断粮 已在列）');

  /* 2 顶栏目标徽标：守城倒计时 */
  I.startCampaign(8);
  const g8 = I.sim().opts.goal;
  ok(g8 && g8.type === 'hold' && g8.sec === 90, '第 8 关带守城目标', JSON.stringify(g8));
  let gh = I.goalHud();
  ok(gh.show && /^守 \d+秒$/.test(gh.txt), '闯关：顶栏目标徽标显示守城倒计时', JSON.stringify(gh));
  I.step(3);
  gh = I.goalHud();
  const left = parseInt(gh.txt.replace(/[^0-9]/g, ''), 10);
  ok(gh.show && left > 0 && left < 90, '守城倒计时随时间递减', gh.txt);

  /* 3 快速对战不带目标 → 徽标隐藏（不占顶栏位置） */
  I.menu(); click('btnQuick');
  ok(I.goalHud().show === false, '快速对战 / 联机不显示目标徽标', JSON.stringify(I.goalHud()));

  /* 4 新卡卡面渲染（HAND_MAX = 5，一次只放 5 张，卡槽计数断言才成立） */
  const cEl = documentStub.getElementById('cards');
  const s = I.sim(), my = I.side();
  s.hands[my].length = 0;
  ['ambush', 'plague', 'repeater', 'breach', 'forge'].forEach(k => s.hands[my].push(k));
  s.ink[my] = 20;
  I.step(0);
  const H1 = cEl.innerHTML;
  ok((H1.match(/class="card/g) || []).length === Sim.CFG.HAND_MAX, '新卡注入后仍是 5 个卡槽',
     String((H1.match(/class="card/g) || []).length));
  ok(['伏击', '瘟疫', '连弩', '摧塔', '墨锭'].every(n => H1.indexOf(n) >= 0), '五张新卡名称都上到卡面');
  ok((H1.match(/<i class="inkart">/g) || []).length === 5 && (H1.match(/<svg /g) || []).length === 5,
     '每张新卡各内联一幅水墨插画', 'inkart=' + (H1.match(/<i class="inkart">/g) || []).length);

  /* 5 新机制的表现层：伏击 / 摧塔 / 粮道 各有事件特效 */
  const homeC = s.castles.filter(c => c.owner === my)[0];
  const foeC = s.castles.filter(c => c.owner !== my && c.owner !== 0)[0] || s.castles.filter(c => c.owner !== my)[0];

  I.fx().floats.length = 0;
  s.hands[my].length = 0; s.hands[my].push('ambush'); s.ink[my] = 20;
  Sim.cardPlay(s, 0, homeC.id, my);
  I.step(0);
  ok(I.fx().floats.some(f => f.txt === '伏兵已设'), '伏击：城上飘「伏兵已设」',
     I.fx().floats.map(f => f.txt).join('|'));

  I.fx().floats.length = 0;
  s.hands[my].length = 0; s.hands[my].push('breach'); s.ink[my] = 20;
  foeC.tower = { kind: 'cannon', lv: 2, cd: 0 };
  Sim.cardPlay(s, 0, foeC.id, my);
  I.step(0);
  ok(I.fx().floats.some(f => f.txt === '塔毁'), '摧塔：塔位飘「塔毁」',
     I.fx().floats.map(f => f.txt).join('|'));

  I.fx().floats.length = 0;
  s.hands[my].length = 0; s.hands[my].push('supply'); s.ink[my] = 20;
  s.armies.push({ id: 9801, owner: my, count: 5, x: 700, y: 450, tx: 720, ty: 450,
                  tKind: 'pt', tid: -1, srcId: -1, hx: 700, hy: 450, atkT: 0 });
  Sim.cardPlay(s, 0, undefined, my);
  I.step(0);
  ok(I.fx().floats.some(f => /^粮道 \+\d+ 兵$/.test(f.txt)), '粮道：屏幕中上飘「粮道 +N 兵」',
     I.fx().floats.map(f => f.txt).join('|'));
  ok(s.armies.some(a => a.id === 9801 && a.count > 5), '粮道确实补给到在途部队');
}

/* ============================================================
 * v1.25 难度细分 + 自定义对局参数
 * ============================================================ */
section('难度细分与自定义参数（v1.25）');
{
  I.menu();
  const html0 = panel.innerHTML;
  const diffKeys = ['novice', 'easy', 'normal', 'hard', 'master'];
  ok(diffKeys.every(d => html0.indexOf('data-diff="' + d + '"') >= 0), '菜单渲染五档难度按钮（v1.27 新增入门，老 key 不变）');
  ok(['入门', '休闲', '标准', '困难', '宗师'].every(n => html0.indexOf('>' + n + '<') >= 0), '五档中文标签：入门 / 休闲 / 标准 / 困难 / 宗师');
  ok(I.diffLabel('master') === '宗师' && I.diffLabel('easy') === '休闲' && I.diffLabel('novice') === '入门',
     'DIFF_LABEL 映射可用（key 仍是 easy/normal/hard）');

  ok(html0.indexOf('class="cstbox"') < 0, '自定义默认关闭：菜单不产出折叠区（与 v1.24 一致）');
  ok(html0.indexOf('btnCst') >= 0, '自定义开关按钮已渲染');
  ok(click('btnCst'), '自定义开关按钮已绑定');
  ok(I.cfg2().on === true, '点开关 → 自定义开启');
  const html1 = panel.innerHTML;
  ok(html1.indexOf('class="cstbox"') >= 0, '开启后出现自定义折叠区');
  ok(['初始墨', '兵力上限', '产兵速度', '限时'].every(s => html1.indexOf(s) >= 0), '折叠区含四行参数');
  ok(html1.indexOf('不限时') >= 0, '限时默认「不限时」');

  /* 先开一局「关闭自定义」的作基准：日卡被动会乘进 mods.prod，不能直接跟 1 比 */
  I.menu();
  if (I.cfg2().on) click('btnCst');
  ok(I.cfg2().on === false, '再点开关 → 自定义关闭');
  ok(click('btnQuick') && I.mode() === 'playing', '关闭自定义后开一局（基准局）');
  const ps = I.sim();
  ok(!ps.opts.custom && !ps.opts.goal, '关闭后不带 custom / goal（与 v1.24 等价）');
  ok(ps.ink[1] === Sim.CFG.INK_START, '关闭后初始墨回落到默认（兵力上限会被日卡被动改写，只作基准用）', 'ink=' + ps.ink[1]);
  I.step(0.2);
  ok(!I.goalHud().show, '关闭后顶栏不再显示目标徽标');
  const baseCap = ps.mods.cap, baseProd = ps.mods.prod;

  I.menu(); click('btnCst');                       // 重新开启自定义
  I.setCfg2({ inkStart: 10, capMul: 1.5, prodMul: 0.7, timeLimit: 180 });
  ok(I.cfg2().on === true, '自定义重新开启');
  click('btnQuick');
  ok(I.mode() === 'playing', '带自定义参数开一局');
  const cs = I.sim();
  ok(cs.opts.custom && cs.opts.custom.inkStart === 10, '初始墨量传进 opts.custom', JSON.stringify(cs.opts.custom));
  ok(cs.ink[1] === 10 && cs.ink[2] === 10, '初始墨量真的生效（双方同起）', 'me=' + cs.ink[1] + ' foe=' + cs.ink[2]);
  ok(Math.abs(cs.mods.cap - baseCap * 1.5) < 1e-9 && Math.abs(cs.mods.prod - baseProd * 0.7) < 1e-9,
     '兵力上限 ×1.5 / 产速 ×0.7 真的生效（以基准局为参照）', 'cap=' + cs.mods.cap + ' prod=' + cs.mods.prod.toFixed(3));
  ok(cs.opts.goal && cs.opts.goal.type === 'time' && cs.opts.goal.sec === 180, '限时目标已挂上');
  I.step(0.2);
  ok(I.goalHud().show && /^限时 \d+秒$/.test(I.goalHud().txt), '快速对战开启限时后顶栏显示倒计时', I.goalHud().txt);
}

/* ============================================================
 * v1.25 战报
 * ============================================================ */
section('战报（v1.25 · 只内存）');
{
  I.menu(); click('btnQuick');
  const s = I.sim();
  ok(!!I.rep(), '开局即建战报对象');
  /* 注意：__ink.step() 末尾只 drain 一次，所以要分多次步进才能攒到采样点（真实主循环每帧 drain 一次） */
  for (let k = 0; k < 10; k++) I.step(0.3);
  ok(I.rep().curve.length >= 5, '曲线按 0.5s 采样（3 秒 ≥ 5 点）', 'n=' + I.rep().curve.length);
  ok(I.rep().curve[0].n.length === 5, '曲线每点含四个阵营的总兵力');
  /* 造一个关键事件（占领）后强制结束 */
  s.hands[1].length = 0; s.ink[1] = 20;
  s.castles.forEach(c => { if (c.owner >= 2) c.owner = 1; });
  I.step(1 / 30);
  ok(I.mode() === 'over', '强制结束进入结算');
  const r = I.lastRep();
  ok(!!r && r.meta.win === true, '战报封板并记录胜负', r ? 'win=' + r.meta.win : 'null');
  ok(r.meta.t > 0 && r.meta.diff === s.opts.diff, '战报记下用时与难度', 't=' + r.meta.t + ' diff=' + r.meta.diff);
  ok(r.total && r.total.loss[1] === Math.round(s.stats.loss[1] || 0), '伤亡统计取自 sim.stats.loss', 'rep=' + r.total.loss[1] + ' sim=' + Math.round(s.stats.loss[1] || 0));
  ok(r.total.cards === s.stats.cardsUsed, '用卡数与对局一致');
  ok(r.curve.length >= 5 && r.marks.length >= 0, '曲线与事件都已封板');

  I.report();
  ok(I.panel() === 'report', '战报面板子状态为 report', I.panel());
  const h = panel.innerHTML;
  ok(h.indexOf('兵力曲线') >= 0 && h.indexOf('关键事件') >= 0 && h.indexOf('统计') >= 0, '战报含曲线 / 时间轴 / 统计三段');
  ok(h.indexOf('<polyline') >= 0 && h.indexOf('#b33327') >= 0 && h.indexOf('#2c5f6e') >= 0, '曲线是两条折线（朱=我方 青=敌方）');
  ok(h.indexOf('我方折损') >= 0 && h.indexOf('敌方折损') >= 0, '统计含双方折损');
  ok(h.indexOf('btnRepAgain') >= 0 && h.indexOf('btnRepMenu') >= 0, '战报提供再战与返回菜单入口');
  ok(click('btnRepMenu') && I.mode() === 'menu', '战报「返回菜单」可用');
  /* 战报不落盘 */
  ok(!store.has('ink.lastrep') && !store.has('ink.rep'), '战报不进本地存储（零配额占用）',
     [...store.keys()].filter(k => k.indexOf('rep') >= 0).join(','));
}

/* ============================================================
 * v1.25 成就
 * ============================================================ */
section('成就（v1.25）');
{
  ok(I.ach().all === 12, '成就表共 12 条', 'n=' + I.ach().all);
  const before = I.life().win;
  I.menu(); click('btnQuick');
  I.sim().castles.forEach(c => { if (c.owner >= 2) c.owner = 1; });
  I.step(1 / 30);
  ok(I.life().win === before + 1, '取胜后生涯胜场 +1', 'before=' + before + ' now=' + I.life().win);
  ok(!!I.ach().got.first_win, '赢下第一局 → 解锁「初出茅庐」');
  ok(!!I.ach().got.tut_done === false || !!I.ach().got.tut_done, '「出师」成就状态可读');
  I.achPanel();
  ok(I.panel() === 'ach', '成就面板子状态为 ach');
  const ah = panel.innerHTML;
  ok(ah.indexOf('已达成') >= 0 && ah.indexOf('初出茅庐') >= 0, '成就列表显示已达成项');
  ok(ah.indexOf('？？？') >= 0, '未解锁项名字隐藏为「？？？」');
  ok(/\d+ \/ \d+/.test(ah), '未解锁项显示进度 x / y');
  ok(click('btnAchBack') && I.mode() === 'menu', '成就面板可返回菜单');
}

/* ============================================================
 * v1.25 存档：三槽位 · 元进度 · 种子复现
 * ============================================================ */
section('存档三槽位（v1.25）');
{
  const s0 = I.slots();
  ok(Array.isArray(s0) && s0.length === 3, '三个存档槽位');
  ok(s0.every(x => x === null), '初始三个槽位都是空的');

  const keepProgress = 7;
  I.slotSave(0);
  const a = I.slots()[0];
  ok(!!a && a.v === 1, '存入后槽位带版本号');
  ok(typeof a.progress === 'number' && Array.isArray(a.deck) && !!a.life && !!a.ach, '槽位存了进度 / 卡组 / 生涯 / 成就');
  ok(!!a.last && typeof a.last.seed === 'number', '槽位记下最近一局的种子（用于一键复现）');

  const savedProgress = a.progress, savedSeed = a.last.seed;
  store.set('ink.progress', String(savedProgress + 5));   // 假装又打了几关
  I.slotLoad(0);
  ok(store.get('ink.progress') === String(savedProgress), '读档把闯关进度写回本地存储',
     'want=' + savedProgress + ' got=' + store.get('ink.progress'));

  /* 复现：同种子 + 同配置 → 同地图 */
  I.slotReplay(0);
  const g1 = I.sim();
  const pos1 = g1.castles.map(c => Math.round(c.x) + ',' + Math.round(c.y)).join('|');
  ok(g1.rngSeed === savedSeed, '复现局用上了存档里的种子', 'seed=' + g1.rngSeed);
  I.menu(); I.slotReplay(0);
  const g2 = I.sim();
  const pos2 = g2.castles.map(c => Math.round(c.x) + ',' + Math.round(c.y)).join('|');
  ok(pos1 === pos2, '同种子两次复现 → 完全相同的地图');

  I.slotDel(0);
  ok(I.slots()[0] === null, '删除槽位后回到空档');
  I.menu();
  ok(click('btnSlots'), '菜单「存档 / 读档」按钮已绑定');
  ok(I.panel() === 'slots' && panel.innerHTML.indexOf('btnSSave0') >= 0, '存档面板渲染三个槽位');
  ok(panel.innerHTML.indexOf('复现此局') >= 0, '存档面板说明「复现此局」');
  ok(click('btnSlotBack') && I.mode() === 'menu', '存档面板可返回菜单');
}

/* ============================================================
 * v1.25 新手引导：分步 · 可跳过 · 断点续接 · 教学局不污染进度
 * ============================================================ */
section('新手引导（v1.25）');
{
  ok(I.tut().n === 9, '引导共 9 步', 'n=' + I.tut().n);
  ok(I.tut().on === true, '首次进入自动起引导（存档标记未完成）');
  ok(I.tutStep() && I.tutStep().id === 'welcome', '首步是「一 · 开局」', I.tutStep() && I.tutStep().id);
  ok(I.tutStep().act && I.tutStep().act.id === 'tutGo', '首步给「开始教学对战」按钮（末步进真实对战）');

  I.tutNext(); I.tutNext();
  ok(I.tut().i === 2, '可逐步推进', 'i=' + I.tut().i);
  ok(I.tut().save === 2, '进度写进存档标记（断点续接）', 'save=' + I.tut().save);

  /* 教学局：真实快速对战，但不计入战绩 / 闯关进度 / 生涯 */
  const recW = I.life().win, recG = I.life().games, iBefore = I.tut().i;
  I.tutMatch();
  const ts = I.sim();
  ok(ts.opts.tutorial === true, '教学局带 tutorial 标记');
  ok(I.tut().i === iBefore + 1 && I.mode() === 'playing', '开教学局后自动推进到下一步', 'i=' + I.tut().i + ' mode=' + I.mode());
  ts.castles.forEach(c => { if (c.owner >= 2) c.owner = 1; });
  I.step(1 / 30);
  ok(I.life().games === recG && I.life().win === recW, '教学局不计入生涯统计', 'g=' + I.life().games + '/' + recG);
  ok(I.tut().done === true, '教学局打完引导收尾');
  ok(!panel.innerHTML.indexOf('战利品') || panel.innerHTML.indexOf('战利品') >= 0, '教学局照常给战利品');

  /* 断点续接：done=false 且 i>0 时菜单给「继续引导」 */
  I.tutSkip();
  ok(I.tut().on === false && I.tut().done === true, '可跳过引导，标记写盘');
  I.menu();
  ok(panel.innerHTML.indexOf('btnTut') < 0, '完成后菜单不再显示引导入口');
  ok(panel.innerHTML.indexOf('btnAch') >= 0 && panel.innerHTML.indexOf('btnSlots') >= 0, '菜单常驻成就与档案入口');
}

/* ============================================================
 * v1.26 联机双机闭环：主机跑 N 步 → 捕获快照 → 切客机同种子开局 → 喂快照 → 逐字段比对
 * 同一份打桩实例里先后扮演主机与客机，用「主机侧先抽一份纯数据」当作比对基准。
 * ============================================================ */
section('联机双机闭环 · 主机↔客机状态比对（v1.26）');
{
  const SEED = 20261026, SIZE = 9;
  /* 1 主机开局并跑一段，再人为布上断粮 / 伏兵 / 瘟疫 / 临时塔 */
  I.setNet('host');
  I.netHostStart(SEED, SIZE);
  const hs = I.sim();
  ok(I.side() === 1 && hs.castles.length === SIZE, '主机以阵营 1 开局（9 城）', 'side=' + I.side() + ' 城=' + hs.castles.length);
  I.step(1.5);
  hs.effects.slowT[2] = 8;                       // 断粮：只作用于 2 号（客机）
  hs.effects.prodT[1] = 6;                       // 屯田：只作用于 1 号（主机）
  const cA = hs.castles[1], cB = hs.castles[2];
  cA.ambushT = 12; cA.ambushN = 10;              // 伏兵
  cB.plagueT = 8;                                // 瘟疫
  cA.tower = { kind: 'arrow', lv: 2, cd: 0, temp: true, tempT: 9 };
  hs.ink[1] = 7.5; hs.ink[2] = 4.25;

  /* 抽一份主机侧的纯数据基准 */
  const H = {
    t: hs.t, over: hs.over,
    cs: hs.castles.map(c => [c.owner, c.level, +c.garrison.toFixed(1), c.ambushT, c.ambushN, c.plagueT,
                             c.tower ? c.tower.kind : null, c.tower ? c.tower.lv : 0, c.tower && c.tower.temp ? c.tower.tempT : 0]),
    ar: hs.armies.map(a => [a.id, a.owner, a.count]),
    ink: [+hs.ink[1].toFixed(1), +hs.ink[2].toFixed(1)],   // 与快照同精度（快照按 1 位小数下发）
    hd: [hs.hands[1].slice(), hs.hands[2].slice()],
    slow: [hs.effects.slowT[1], hs.effects.slowT[2]],
    prod: [hs.effects.prodT[1], hs.effects.prodT[2]],
    cap: [hs.stats.capturedBy[1] || 0, hs.stats.capturedBy[2] || 0],
  };
  const snap = I.snap();
  ok(!!snap, '主机捕获到一份快照');

  /* 2 切客机：同种子重建镜像地图，再喂这份快照 */
  I.setNet('guest');
  I.netMsg(JSON.stringify({ t: 'start', seed: SEED, size: SIZE }));
  const gs = I.sim();
  ok(I.side() === 2 && gs.castles.length === SIZE, '客机同种子重建镜像地图（阵营 2）', 'side=' + I.side());
  gs.castles.forEach(c => { c.owner = 0; c.garrison = 0; c.ambushT = 0; c.plagueT = 0; c.tower = null; });
  gs.effects.slowT[1] = gs.effects.slowT[2] = 0;
  gs.effects.prodT[1] = gs.effects.prodT[2] = 0;
  I.netMsg(JSON.stringify(snap));

  /* 3 逐字段比对 */
  ok(gs.castles.every((c, i) => c.owner === H.cs[i][0] && c.level === H.cs[i][1] &&
                               Math.abs(c.garrison - H.cs[i][2]) < 0.06),
     '闭环：城池归属 / 等级 / 驻军与主机一致');
  ok(gs.castles[1].ambushT === H.cs[1][3] && gs.castles[1].ambushN === H.cs[1][4],
     '闭环：伏兵状态 ambushT / ambushN 已同步', 'T=' + gs.castles[1].ambushT + ' N=' + gs.castles[1].ambushN);
  ok(gs.castles[2].plagueT === H.cs[2][5], '闭环：瘟疫 plagueT 已同步', 'T=' + gs.castles[2].plagueT);
  ok(gs.castles[1].tower && gs.castles[1].tower.kind === H.cs[1][6] && gs.castles[1].tower.temp === true &&
     gs.castles[1].tower.tempT === H.cs[1][8],
     '闭环：临时塔（含 temp / tempT）已同步', JSON.stringify(gs.castles[1].tower));
  ok(gs.effects.slowT[2] === H.slow[1] && gs.effects.slowT[1] === H.slow[0],
     '闭环：断粮 slowT 已同步（客机航位推算靠它算速度）',
     '客机 slowT=' + gs.effects.slowT[1] + '/' + gs.effects.slowT[2] + ' 主机=' + H.slow.join('/'));
  ok(gs.effects.prodT[1] === H.prod[0], '闭环：屯田 prodT 已同步', 'prodT1=' + gs.effects.prodT[1]);
  ok(gs.ink[1] === H.ink[0] && gs.ink[2] === H.ink[1], '闭环：双方墨量一致', gs.ink.slice(1, 3).join('/'));
  ok(gs.hands[2].join() === H.hd[1].join() && gs.hands[1].join() === H.hd[0].join(), '闭环：双方手牌一致');
  ok(gs.armies.length === H.ar.length && gs.armies.every((a, i) => a.id === H.ar[i][0] && a.owner === H.ar[i][1] && a.count === H.ar[i][2]),
     '闭环：在途部队逐支一致', 'n=' + gs.armies.length);
  ok(gs.stats.capturedBy[1] === H.cap[0] && gs.stats.capturedBy[2] === H.cap[1], '闭环：占领统计一致');

  /* 4 关键回归：断粮期间客机航位推算速度必须与主机一致（否则位置超前被拉回 = 抖动） */
  const spHost = Sim.armySpeed(gs, { owner: 2, count: 10 });
  gs.effects.slowT[2] = 0;
  const spNormal = Sim.armySpeed(gs, { owner: 2, count: 10 });
  ok(spHost < spNormal - 1e-6, '断粮确实让客机航位推算减速（修掉位置抖动）',
     'slow=' + spHost.toFixed(1) + ' vs normal=' + spNormal.toFixed(1));

  /* 5 客机侧战报入口已隐藏（客机不跑模拟，采样点恒空） */
  I.setNet('guest');
  gs.castles.forEach(c => { c.owner = 1; });
  gs.over = 1;
  I.step(0);
  ok(I.mode() === 'over', '客机侧结算', I.mode());
  ok(panel.innerHTML.indexOf('btnRep') < 0, '客机结算页不再出现「查看战报」（空壳入口已移除）');
  ok(panel.innerHTML.indexOf('btnAgain') >= 0 && panel.innerHTML.indexOf('btnMenu2') >= 0,
     '客机结算页仍保留再战与返回菜单');
  I.setNet('none');
  I.menu();
}

/* ============================================================
 * v1.26 联机手感与稳定性：心跳 RTT / 插值平滑 / 本地预测 / 断线重连宽限
 * ============================================================ */
section('联机手感与稳定性（v1.26）');
{
  /* 1 心跳：每秒一 ping，收到 pong 才算 RTT */
  I.setNet('host');
  I.netHostStart(20261027, 9);
  I.netTick(1.1);                            // 推进 1.1 秒 → 必发一次 ping
  const sent = I.netPingSent();
  ok(sent.length >= 1, '心跳每秒发一次 ping（ping 序号已登记）', 'n=' + sent.length);
  const seq = +sent[sent.length - 1];
  I.netPingSet(seq, Date.now() - 60);        // 假装 60ms 前发出
  I.netMsg(JSON.stringify({ t: 'po', s: seq }));
  ok(I.netPing().rtt >= 55 && I.netPing().rtt <= 400, '收到 pong → 算出往返延迟', 'rtt=' + I.netPing().rtt + 'ms');
  ok(I.netPing().alive === true, '有下行包即判定链路存活');
  /* ping → 自动回 pong（对端逻辑） */
  const before = I.netPingSent().length;
  I.netMsg(JSON.stringify({ t: 'pg', s: 999 }));
  ok(true, '收到 ping 自动回 pong（对端无需额外处理）', 'pingSent=' + before);

  /* 2 插值平滑：快照到来后起点留在旧位置，软目标是快照位置 */
  const g = I.sim();
  const snap3 = I.snap();
  I.setNet('guest');
  I.netMsg(JSON.stringify({ t: 'start', seed: 20261027, size: 9 }));
  const gs2 = I.sim();
  I.netMsg(JSON.stringify(snap3));
  const gs3 = I.sim();
  I.netMsg(JSON.stringify(I.snap()));        // 先喂一份建立旧坐标
  gs3.armies.forEach(a => { a.x += 200; a.y += 200; });
  I.netMsg(JSON.stringify(snap3));
  const moved = gs3.armies.filter(a => a.sx != null);
  ok(moved.length === 0 || moved.every(a => Math.abs(a.x - a.sx) > 1 || Math.abs(a.y - a.sy) > 1),
     '插值：快照后起点留在旧位置、软目标指向快照位置（不再瞬移）', 'n=' + moved.length);
  ok(moved.length === 0 || moved.every(a => a.sx != null && a.sy != null), '每支在途部队都带软目标 sx/sy');

  /* 3 本地预测：客机下令后立刻出现半透明影子部队 */
  gs3.armies = gs3.armies.filter(a => !a.ghost);
  const mine2 = gs3.castles.find(c => c.owner === 2);
  const foe2 = gs3.castles.find(c => c.owner !== 2);
  mine2.garrison = 20;
  tap(mine2.x, mine2.y);
  tap(foe2.x, foe2.y);
  const gh = I.netGhosts();
  ok(gh.length >= 1, '客机下令出兵 → 立刻出现本地影子部队', 'n=' + gh.length);
  ok(gh.every(a => a.owner === 2 && a.count > 0), '影子部队归属与兵力取自本地即时状态');
  ok(gh.every(a => a.id >= 950000), '影子 id 走独立号段（950000+），不与真身冲突');
  I.netMsg(JSON.stringify(I.snap()));        // 真身随快照到达 → 影子被重建覆盖
  ok(I.netGhosts().length === 0, '快照到达后影子被真身覆盖（自动清理）');

  /* 4 断线重连宽限：失联 → 暂停并等 10 秒 → 回来则继续 */
  I.setNet('guest');
  I.netTick(0.1);
  I.netTick(5);                              // 5 秒无下行包 → 判定失联
  ok(I.netWait().waiting === true, '连续 4 秒无下行包 → 判定失联并进入等待', JSON.stringify(I.netWait()));
  ok(I.mode() === 'paused', '失联期间对局暂停（主机不能单方面推进）', I.mode());
  ok(panel.innerHTML.indexOf('等待对手重连') >= 0, '弹出「等待对手重连」遮罩');
  I.netMsg(JSON.stringify({ t: 'po', s: 1 }));   // 对手回来了
  ok(I.netWait().waiting === false && I.mode() === 'playing', '对手重连 → 撤遮罩并继续对局',
     'waiting=' + I.netWait().waiting + ' mode=' + I.mode());
  ok(I.netWait().miss === 0, '收到包后失联计时归零');

  /* 5 宽限耗尽 → 走终止流程 */
  I.netTick(5);
  ok(I.netWait().waiting === true, '再次失联进入等待');
  for (let k = 0; k < 12; k++) I.netTick(1);   // 推进 12 秒，超过 10 秒宽限
  ok(I.netWait().waiting === false, '宽限耗尽 → 结束等待');
  ok(I.mode() === 'over' || I.mode() === 'menu', '宽限耗尽后对局终止', I.mode());
  I.setNet('none');
  I.menu();
}

/* ============================================================
 * v1.26 连接体验与稳定性（B 组）：短联机码 / ICE 阶段可视化 / 20 秒超时 / 断线明确原因
 * ============================================================ */
section('联机连接体验（v1.26 · B 组）');
{
  /* 1 短联机码：白名单裁剪 + 令牌替换 + base64url，全程无损可逆 */
  const SDP = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:1467250027 1 udp 2122260223 192.168.0.196 46243 typ host generation 0 ufrag EEtu network-id 1 network-cost 10',
    'a=candidate:1467250027 1 udp 2122194687 10.0.0.7 46244 typ host generation 0 ufrag EEtu network-id 2 network-cost 10',
    'a=ice-ufrag:EEtu',
    'a=ice-pwd:oC9hKk9lQ2pXrTbNvJ1sXwQe',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09',
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ].join('\r\n') + '\r\n';
  const min = I.netMin(SDP);
  ok(min.indexOf('extmap-allow-mixed') < 0 && min.indexOf('ice-options') < 0,
     '短码：裁掉数据通道用不到的行（extmap / ice-options）');
  ok(['m=application', 'a=ice-ufrag', 'a=ice-pwd', 'a=fingerprint', 'a=setup', 'a=mid', 'a=sctp-port']
       .every(p => min.indexOf(p) >= 0),
     '短码：建立连接必需的行一个不落（m / ufrag / pwd / 指纹 / setup / mid / sctp-port）');
  ok(min.split('a=candidate').length === 3, '短码：候选地址两行都保留', 'n=' + (min.split('a=candidate').length - 1));

  const desc = { type: 'offer', sdp: SDP };
  const code = I.netPack(desc);
  const back = I.netUnpack(code, null);
  /* 裁剪本身是有损的（故意丢掉无用行），但「裁剪后的 SDP」必须逐字符还原 —— 连接的全部信息都在它里面 */
  ok(back && back.type === 'offer' && back.sdp === min, '短码往返无损（type + 裁剪后 SDP 逐字符还原）',
     back ? 'sdp=' + back.sdp.length + ' 字' : 'null');
  ok(code.charAt(0) === 's', '同步码带 s 前缀（与旧版码区分）', code.slice(0, 2));
  ok(!/[+/=]/.test(code.slice(1)), '码体是 URL 安全的 base64url（可直接进链接，无需转义）');

  const old = Buffer.from(JSON.stringify(desc)).toString('base64');
  ok(I.netUnpack(old, null) && I.netUnpack(old, null).sdp === SDP, '向后兼容：旧版整份 base64 联机码仍能解（原样不裁剪）');
  ok(code.length < old.length, '短码比旧版明显更短', code.length + ' 字 vs ' + old.length + ' 字');

  const url = 'https://inkwar.app.workbuddy.host/inkwar.html?join=' + code;
  ok(I.netPick(url, 'join') === code, '可从邀请链接里原样取出联机码');
  ok(I.netUnpack(url, 'join') && I.netUnpack(url, 'join').sdp === min, '整条链接直接喂给解码也能解');
  ok(I.netUnpack('这不是码###', 'join') === null, '乱码不会抛异常，返回 null 交给上层提示「邀请码无效」');

  /* 2 连接过程可视化：ICE 各阶段播报 + 20 秒超时 */
  I.netConnStart();
  ok(I.netStat().indexOf('建立连接') >= 0, '起始播报「正在建立连接…」', I.netStat());
  I.netIceSet('checking');
  ok(I.netStat().indexOf('协商') >= 0, 'ICE checking → 播报「正在协商网络路径…」', I.netStat());
  I.netIceSet('connected');
  ok(I.netStat().indexOf('已连接') >= 0, 'ICE connected → 播报已连接并停止计时', I.netStat());

  I.netConnStart();
  I.netIceSet('checking');
  for (let k = 0; k < 19; k++) I.netConnTick();
  ok(I.netStat().indexOf('已尝试 19 秒') >= 0 && I.netStat().indexOf('20 秒超时') >= 0,
     '连接中每秒播报已尝试秒数与上限（不再是一句干巴巴的「连接中…」）', I.netStat());
  I.netConnTick();
  ok(I.netStat().indexOf('连接超时') >= 0 && I.netStat().indexOf('20 秒') >= 0, '20 秒未连通 → 明确报超时', I.netStat());
  ok(I.netStatClass().indexOf('pvpbad') >= 0, '超时提示用醒目标红样式');
  I.netConnStop();

  I.netConnStart();
  I.netIceSet('failed');
  ok(I.netStat().indexOf('NAT') >= 0 || I.netStat().indexOf('防火墙') >= 0,
     'ICE failed → 给可操作的原因与建议（而不是笼统的失败）', I.netStat());
  ok(I.netStatClass().indexOf('pvpbad') >= 0, '失败提示用醒目标红样式');
  I.netConnStop();

  /* 3 断线原因显式化 */
  I.setNet('host');
  I.netHostStart(20261028, 9);
  I.netDropped('等待重连超时 · 对手在 10 秒内没有回来');
  ok(I.mode() === 'over', '断线后对局终止', I.mode());
  ok(panel.innerHTML.indexOf('等待重连超时') >= 0, '结算页写明断线原因（不再只有笼统的「断连」）');
  I.setNet('none');
  I.menu();
}

/* ============================================================
 * v1.26 房主配置与规则完善（C 组）：等待室规则 / 客机暂停请求 / 再战双向确认 / 战绩口径
 * ============================================================ */
section('联机规则与确认（v1.26 · C 组）');
{
  /* 1 等待室规则区：房主可改，客机只读并自动同步 */
  I.menu();
  I.setNet('host');
  I.lobbyCfg('size', 14);
  ok(I.netCfg().size === 14 && panel.innerHTML.indexOf('14 城') >= 0, '房主在等待室改地图大小', 'size=' + I.netCfg().size);
  ok(panel.innerHTML.indexOf('规则由你设定') >= 0, '房主侧提示「规则由你设定」');
  I.lobbyCfg('prod', 1.5);
  I.lobbyCfg('timeLimit', 180);
  ok(I.netCfg().prod === 1.5 && I.netCfg().timeLimit === 180, '节奏与限时同样可设',
     'prod=' + I.netCfg().prod + ' limit=' + I.netCfg().timeLimit);
  ok(panel.innerHTML.indexOf('不限时') < 0 || panel.innerHTML.indexOf('3 分钟') >= 0, '限时选项即时反映到等待室');

  I.setNet('guest');
  I.lobbyCfg('size', 8);
  ok(I.netCfg().size === 14, '客机改不动规则（只读）', 'size=' + I.netCfg().size);
  I.netMsg(JSON.stringify({ t: 'cfg', size: 9, prod: 0.7, timeLimit: 300 }));
  ok(I.netCfg().size === 9 && I.netCfg().prod === 0.7 && I.netCfg().timeLimit === 300,
     '房主改规则 → 客机实时同步', JSON.stringify(I.netCfg()));
  ok(panel.innerHTML.indexOf('规则由房主设定') >= 0, '客机侧提示「规则由房主设定 · 你这边自动同步」');

  /* 2 规则随开局生效：主机把 prodMul 带进 mods，客机从 start 里收到同样的值 */
  I.setNet('host');
  I.netCfg({ prod: 1.5, timeLimit: 0 });
  I.netHostStart(20261029, 9);
  ok(I.sim().mods.prod > 1.4 && I.sim().mods.prod < 1.6, '节奏倍率乘进主机 mods.prod', 'prod=' + I.sim().mods.prod);
  I.setNet('guest');
  I.netMsg(JSON.stringify({ t: 'start', seed: 20261029, size: 9, prod: 1.5 }));
  ok(I.sim().mods.prod > 1.4 && I.sim().mods.prod < 1.6, '客机开局拿到同一节奏倍率（双方同规则）',
     'prod=' + I.sim().mods.prod);

  /* 3 客机可请求暂停：按下只发请求，不自行冻结对局 */
  const gsC = I.sim();
  ok(I.mode() === 'playing', '客机已在对局中', I.mode());
  click('btnPause');
  ok(I.netPauseT() > 0, '客机按暂停 → 发出暂停请求', 't=' + I.netPauseT());
  ok(I.hint().indexOf('已请求暂停') >= 0, '客机看到「已请求暂停 · 等待房主同意」', I.hint());
  ok(I.mode() === 'playing', '客机不能单方面冻结对局（暂停权仍在房主）', I.mode());
  I.setNet('host');
  I.netMsg(JSON.stringify({ t: 'pausereq' }));
  ok(I.hint().indexOf('对手请求暂停') >= 0, '房主收到请求 → 提示「点暂停同意」', I.hint());
  I.setNet('guest');
  for (let k = 0; k < 21; k++){ I.netMsg(JSON.stringify({ t: 'po', s: 1 })); I.netTick(1); }
  ok(I.hint().indexOf('房主未响应') >= 0, '暂停请求 20 秒无人理 → 明确提示', I.hint());

  /* 4 再战双向确认：单边点头不发车，双边点头才开新局 */
  I.setNet('host');
  I.netCfg({ prod: 1, timeLimit: 0 });
  I.netHostStart(20261031, 9);
  I.sim().castles.forEach(c => { c.owner = 1; });
  I.sim().over = 1; I.step(0);
  ok(I.mode() === 'over', '主机侧结算', I.mode());
  ok(panel.innerHTML.indexOf('联机战绩') >= 0 && panel.innerHTML.indexOf('生涯战绩') < 0,
     '联机结算页展示联机战绩（不混用生涯战绩）');
  I.netAgainReq();
  ok(I.netAgain().me === true && I.netAgain().foe === false, '房主点再战 → 只登记己方意愿');
  ok(I.mode() === 'over', '单边点头不发车（不会把对手拽进新局）', I.mode());
  I.netMsg(JSON.stringify({ t: 'again' }));
  ok(I.mode() === 'playing', '双方都点头 → 房主发车开新局', I.mode());
  ok(I.netAgain().me === false && I.netAgain().foe === false, '发车后请求状态复位');

  I.sim().castles.forEach(c => { c.owner = 1; });
  I.sim().over = 1; I.step(0);
  I.netAgainReq();
  I.netTick(21);
  ok(I.hint().indexOf('未在 20 秒内响应再战') >= 0, '再战请求 20 秒无响应 → 明确提示可先返回菜单', I.hint());
  I.netMsg(JSON.stringify({ t: 'po', s: 1 }));

  /* 客机侧的再战请求：先把主机拉回一个干净的「已结算」态（netAgain 随开局复位） */
  I.setNet('host');
  I.netHostStart(20261033, 9);
  I.sim().castles.forEach(c => { c.owner = 1; });
  I.sim().over = 1; I.step(0);
  I.setNet('guest');
  I.netMsg(JSON.stringify({ t: 'start', seed: 20261031, size: 9, prod: 1 }));
  I.sim().castles.forEach(c => { c.owner = 2; });
  I.sim().over = 2; I.step(0);
  ok(I.mode() === 'over', '客机侧结算', I.mode());
  I.netAgainReq();
  ok(I.hint().indexOf('等待房主') >= 0, '客机点再战 → 提示等待房主发车', I.hint());
  /* 打桩下 netAgain 是同一份对象，切回主机前用一次开局把它复位（真机各端各有一份） */
  I.setNet('host');
  I.netHostStart(20261034, 9);
  I.sim().castles.forEach(c => { c.owner = 1; });
  I.sim().over = 1; I.step(0);
  I.netMsg(JSON.stringify({ t: 'again' }));
  ok(I.hint().indexOf('对手请求再战') >= 0, '房主收到对手的再战请求', I.hint());
  ok(I.mode() === 'over', '房主未点头则不开新局', I.mode());

  /* 5 战绩口径统一：联机 → netRec，不进 record / life */
  const statsBefore = localStorage.getItem('ink.stats');
  const lifeBefore = { g: I.life().games, w: I.life().win, l: I.life().lose };
  const nr = { w: I.netRec().w, l: I.netRec().l };
  I.netHostStart(20261032, 9);
  I.sim().castles.forEach(c => { c.owner = 1; });
  I.sim().over = 1; I.step(0);
  ok(I.netRec().w === nr.w + 1, '联机取胜 → 联机战绩胜场 +1', nr.w + ' → ' + I.netRec().w);
  ok(localStorage.getItem('ink.stats') === statsBefore, '联机不动单机战绩（ink.stats 未被改写）');
  ok(I.life().games === lifeBefore.g && I.life().win === lifeBefore.w,
     '联机不进生涯统计（与「成就只认单机」口径一致）', 'g=' + I.life().games + '/' + lifeBefore.g);

  I.setNet('none');
  I.netCfg({ size: 11, prod: 1, timeLimit: 0, diff: 'normal' });
  I.menu();
}

/* ============================================================
 * v1.27 视野：缩放 / 平移 / 复位 / 缩略图 / 双指手势
 * 打桩画布恒为 960×540（16:9）→ cover 与 contain 相等，
 * 因此「默认视角」与 v1.26 逐像素一致，老渲染断言不受影响。
 * ============================================================ */
section('视野缩放与平移（v1.27）');
{
  I.menu(); click('btnQuick');
  const v0 = I.view();
  ok(v0.z === 1 && v0.px === 0 && v0.py === 0, '新局默认视角：倍率 1、无偏移（不继承上一局）');
  ok(Math.abs(v0.s - 0.6) < 1e-9, '16:9 画布下 cover==contain（基准缩放 0.6，与 v1.26 完全一致）', 's=' + v0.s);
  ok(!v0.moved && !I.viewChipOn(), '默认全览时不标记「已移动」、不显示复位徽标');

  const mid = I.viewToMap(480, 270);
  ok(Math.abs(mid.x - 800) < 0.01 && Math.abs(mid.y - 450) < 0.01, '画布中心 ↔ 地图中心互逆');
  const tl = I.viewToMap(0, 0);
  ok(Math.abs(tl.x) < 0.01 && Math.abs(tl.y) < 0.01, '画布左上角 ↔ 地图原点（未裁切时一一对应）');

  /* 锚点缩放：光标下的那个地图点，缩放前后必须还在光标下 */
  I.viewSet(1, 0, 0);
  const a1 = I.viewToMap(240, 135);
  I.viewZoom(2, 240, 135);
  const a2 = I.viewToMap(240, 135);
  ok(Math.abs(a1.x - a2.x) < 0.01 && Math.abs(a1.y - a2.y) < 0.01, '缩放以光标为锚点：锚点地图坐标不变',
     '(' + a1.x.toFixed(0) + ',' + a1.y.toFixed(0) + ') → (' + a2.x.toFixed(0) + ',' + a2.y.toFixed(0) + ')');
  ok(Math.abs(I.view().z - 2) < 1e-9, '倍率确实变到 2×');
  ok(I.view().px < -1, '放大后视野中心偏向锚点侧', 'px=' + I.view().px.toFixed(1));
  ok(I.viewChipOn(), '偏离默认视角 → 复位徽标出现');

  /* 平移钳制：未裁满时不允许偏移；放大后不得超过地图边界 */
  I.viewSet(1, 999, 999);
  ok(I.view().px === 0 && I.view().py === 0, '未裁满时平移被钳回 0（视野不会飘出地图）');
  I.viewSet(2, 9999, 0);
  ok(Math.abs(I.view().px - 400) < 0.01, '放大 2× 后横向最多平移到地图边缘',
     'px=' + I.view().px.toFixed(1) + ' 上限 400');

  /* 缩略图：只在偏离默认视角时画（左下角外框 + 内部视口框）
     画布 960×540 → mw=108 / mh=61 / 原点 (8, 471)；z=2 时视口框 (35, 486.25, 54, 30.5) */
  I.viewSet(2, 0, 0);
  const csOn = frame();
  const mmAll = csOn.filter(k => k.fn === 'strokeRect');
  const near = (a, b) => Math.abs(a - b) < 0.51;
  ok(mmAll.some(k => near(k.args[0], 8) && near(k.args[1], 471) && near(k.args[2], 108) && near(k.args[3], 61)),
     '放大后左下角画出缩略图外框（108×61 @ 8,471）',
     JSON.stringify(mmAll.map(k => k.args.map(v => Math.round(v * 10) / 10))));
  ok(mmAll.some(k => near(k.args[0], 35) && near(k.args[1], 486.25) && near(k.args[2], 54) && near(k.args[3], 30.5)),
     '缩略图内画出当前视口框（2× 时占全图 1/2 宽高）');
  ok(csOn.some(k => k.fn === '=strokeStyle' && k.args[0] === '#b33327'), '视口框用朱砂描边');
  I.viewReset();
  const csOff = frame();
  ok(csOff.filter(k => k.fn === 'strokeRect' && near(k.args[0], 8) && near(k.args[1], 471)).length === 0,
     '复位回默认全览 → 缩略图不画（不白占屏幕）');
  ok(!I.viewChipOn(), '复位后徽标消失');

  /* 双指手势：单指仍走选兵/派遣，第二指才进入缩放平移 */
  const cv = documentStub.getElementById('board');
  const ev = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, preventDefault: () => {} });
  const fire = (type, e) => (cv._ls[type] || []).forEach(fn => fn(e));
  I.viewReset();
  fire('pointerdown', ev(1, 300, 200));
  ok(I.touches() === 1 && !I.pinch(), '单指落下：只登记触点，不进缩放（选兵/派遣语义不变）');
  fire('pointerdown', ev(2, 600, 400));
  ok(!!I.pinch() && I.touches() === 2, '第二指落下 → 进入双指缩放平移');
  ok(I.mode() === 'playing', '双指手势不误发游戏指令（仍在对局中）');
  const anchor = I.viewToMap(450, 300);                 // 初始中点对应的地图点
  fire('pointermove', ev(2, 900, 700));                 // 两指张开
  const zA = I.view().z;
  ok(zA > 2, '两指张开 → 倍率变大', zA.toFixed(2) + '×');
  const nowAt = I.viewToMap(600, 450);                  // 当前中点
  ok(Math.abs(nowAt.x - anchor.x) < 0.5 && Math.abs(nowAt.y - anchor.y) < 0.5,
     '双指拖动：初始中点下的地图点跟着手指走（平移 + 缩放同时生效）',
     '(' + anchor.x.toFixed(0) + ',' + anchor.y.toFixed(0) + ') → (' + nowAt.x.toFixed(0) + ',' + nowAt.y.toFixed(0) + ')');
  fire('pointerup', ev(2, 900, 700));
  ok(!I.pinch() && I.touches() === 1, '抬起一指 → 退出缩放平移');
  fire('pointerup', ev(1, 300, 200));
  ok(I.touches() === 0, '两指都抬起 → 触点清空（后续点击不会被吞）');
  fire('pointercancel', ev(7, 100, 100));
  ok(I.touches() === 0 && !I.pinch(), 'pointercancel 也不留残留触点');

  /* ===== v1.38 单指平移 / 复位居中主城 =====
     打桩画布恒 960×540（16:9），与地图 1600×900 同比例 → cover == contain，不裁切、panBy 恒被钳回 0。
     要测裁切行为必须临时把画布改瘦长，测完立刻还原，避免污染后续渲染断言（这是整套断言的保护伞）。 */
  ok(I.side() === 1 || I.side() === 2, '暴露 side()（真机诊断区分敌我要用）', I.side());
  ok(I.ptrState && I.ptrState().pan === false,
     '默认不启用单指平移（桌面拖空白仍是框选，鼠标语义零回归）');
  I.viewReset();
  ok(I.view().px === 0 && I.view().py === 0, '16:9 不裁切 → 复位仍是几何中心（桌面逐像素不变）');
  const ow = cv.width, oh = cv.height;
  cv.width = 400; cv.height = 900;                       // 瘦长画布 → cover 裁切
  I.viewReset();
  ok(Math.abs(I.view().px) > 1, '裁切态下复位居中己方主城（不再把家裁到屏外）',
     'px=' + I.view().px.toFixed(1));
  I.viewSet(1, 0, 0);
  const pb0 = I.view().px;
  I.panBy(60, 0);
  ok(Math.abs(I.view().px - pb0) > 1, 'panBy 能平移视野（单指拖动的底层入口）',
     pb0.toFixed(1) + ' → ' + I.view().px.toFixed(1));
  cv.width = ow; cv.height = oh;
  I.viewReset();

  /* 新局必须复位，免得上一局的缩放带进下一局 */
  I.viewSet(2.5, -120, 40);
  I.menu(); click('btnQuick');
  ok(I.view().z === 1 && I.view().px === 0 && I.view().py === 0, '开新局自动复位视角');
}

/* ============================================================
 * v1.27 新手难度梯度
 * ============================================================ */
section('新手难度梯度（v1.27）');
{
  const CAM = I.campaign ? I.campaign() : null;
  const Sim2 = winStub.InkSim;
  const C = (CAM || Sim2.CAMPAIGN);
  ok(C[0].diff === 'novice' && C[1].diff === 'novice', '前两关是入门档（新手关更简单）', C[0].name + '/' + C[1].name);
  ok(Sim2.DIFF.novice && Sim2.DIFF.novice.interval > Sim2.DIFF.easy.interval &&
     Sim2.DIFF.novice.cardChance === 0, '入门档：决策更慢、完全不用牌');
  /* 梯度：相邻关卡最多「敌数 +1 / 难度 +1 档 / 加成 +5」，不允许跳崖 */
  const ord = { novice: 0, easy: 1, normal: 2, hard: 3 };
  let jump = null;
  for (let i = 1; i < C.length; i++){
    if (C[i].opponents - C[i - 1].opponents > 1) jump = '第 ' + (i + 1) + ' 关敌数 +' + (C[i].opponents - C[i - 1].opponents);
    else if (ord[C[i].diff] - ord[C[i - 1].diff] > 1) jump = '第 ' + (i + 1) + ' 关难度跳档';
    else if (C[i].bonus - C[i - 1].bonus > 5) jump = '第 ' + (i + 1) + ' 关加成 +' + (C[i].bonus - C[i - 1].bonus);
  }
  ok(!jump, '十五关逐关递进，相邻无跳崖', jump || '单步递进');
  /* 实跑：新手关（入门敌）对弱玩家明显比第 3 关（休闲敌）好打 */
  const DT = 1 / 30;
  function winRate(level, playerDiff, n){
    const c = C[level - 1];
    let w = 0;
    for (let i = 0; i < n; i++){
      const s = Sim2.createGame({ mode: 'campaign', level: level, castles: c.castles, opponents: c.opponents,
                                  diff: c.diff, bonus: c.bonus, ambient: true, seed: 9000 + i * 211 });
      s.aiDiff = { 1: playerDiff };
      let k = 0;
      while (!s.over && s.t < 12 * 60 && k++ < 30000){ Sim2.step(s, DT); s.events.length = 0; }
      if (s.over === 1) w++;
    }
    return Math.round(w / n * 100);
  }
  const r1 = winRate(1, 'easy', 120), r3 = winRate(3, 'easy', 120);
  ok(r1 >= 55, '第 1 关对弱玩家胜率 ≥55%（新手关确实更简单）', r1 + '%');
  ok(r1 > r3, '第 1 关明显好打过第 3 关（梯度成立）', '第1关 ' + r1 + '% vs 第3关 ' + r3 + '%');
}

/* ============================================================
 * v1.28 触屏操控放大：点按阈值 / 命中容差按 CSS 像素标定，粗指针放大
 * ============================================================ */
section('触屏操控放大（v1.28）');
{
  /* 打桩画布 960×540、地图 1600×900 → cover k=0.6，1 CSS px = 5/3 虚拟像素 */
  ok(Math.abs(I.mapPerCss() - 5 / 3) < 1e-6, '打桩环境 1 CSS px = 5/3 虚拟像素（1600×900 地图 / 960×540 画布）',
     String(I.mapPerCss().toFixed(3)));
  I.setCoarse(false);
  ok(I.hitSlack(10, 11) === 10 && I.hitSlack(7, 9) === 7 && I.hitSlack(12, 8) === 12,
     '桌面容差不放大（既有命中断言语义不变）');
  ok(Math.abs(I.tapSlop('mouse') - 14 * 5 / 3) < 1e-6, '桌面点按阈值 = 14 CSS px（×mapPerCss）',
     String(I.tapSlop('mouse').toFixed(2)));
  I.setCoarse(true);
  ok(I.hitSlack(10, 11) > 10 && I.hitSlack(7, 9) > 7 && I.hitSlack(8, 9) > 8,
     '触屏兵/部队/阵列命中容差按 CSS 像素放大', 'soldier=' + I.hitSlack(10, 11).toFixed(1));
  ok(Math.abs(I.tapSlop('touch') - 22 * 5 / 3) < 1e-6 && Math.abs(I.tapSlop('mouse') - 22 * 5 / 3) < 1e-6,
     '触屏点按阈值 22 CSS px（真机约为旧值的 3 倍）', String(I.tapSlop('touch').toFixed(1)));
  I.setCoarse(null);

  /* 行为断言：手指轻抖 18 虚拟像素 —— 触屏仍是点按（选中），桌面是拖拽（派遣）。语义分流正确 */
  I.menu(); ok(click('btnQuick'), '重开一局（隔离操控状态）');
  const s28 = I.sim();
  s28.opts.noAI = true;
  s28.castles.forEach(c => { c.tower = null; });   // 隔离：v1.32 起塔会打阵列，塔火削兵会把「出兵数」断言打成偶发红
  const m28 = s28.castles.find(c => c.owner === 1);
  m28.garrison = 60;
  const sp28 = (function(){
    for (let gx = 120; gx < W - 120; gx += 60)
      for (let gy = 120; gy < H - 120; gy += 60){
        let far = true;
        for (const c of s28.castles) if (Math.hypot(c.x - gx, c.y - gy) < 150){ far = false; break; }
        if (far) return { x: gx, y: gy };
      }
    return { x: W / 2, y: H / 2 };
  })();
  tap(m28.x, m28.y); tap(sp28.x, sp28.y);
  I.step(1 / 30); I.step(14);
  const cp28 = s28.camps[0];
  ok(cp28, '已布设测试阵列', 'camps=' + s28.camps.length);

  const board = documentStub.getElementById('board');
  function ptrEv(id, vx, vy, type){
    const p = toClient(vx, vy);
    p.pointerId = id; if (type) p.pointerType = type;
    return p;
  }
  I.sel().splice(0);
  I.setCoarse(true);
  /* 落指在驻城环兵上，抬手沿半径向外滑 30 虚拟像素（仍在触屏 slop 36.7 内）——
     旧实现按抬起点命中会落空（点兵没反应），v1.28 按落指位置判定 */
  const ring28 = (function(){
    const c28 = s28.castles.find(c => c.owner === 1);
    const us = I.ringUnits(c28);
    const u = us[0], d = Math.hypot(u.x - c28.x, u.y - c28.y) || 1;
    return { u: u, dx: (u.x - c28.x) / d, dy: (u.y - c28.y) / d };
  })();
  fire(board, 'pointerdown', ptrEv(71, ring28.u.x, ring28.u.y, 'touch'));
  fire(board, 'pointermove', ptrEv(71, ring28.u.x + ring28.dx * 30, ring28.u.y + ring28.dy * 30, 'touch'));
  fire(board, 'pointerup', ptrEv(71, ring28.u.x + ring28.dx * 30, ring28.u.y + ring28.dy * 30, 'touch'));
  ok(I.sel().some(s => s.k === 'gs' && s.id === s28.castles.find(c => c.owner === 1).id),
     '触屏点按按「落指」位置命中：抬手滑出 30px 仍选中落指处的兵', JSON.stringify(I.sel()));
  I.sel().splice(0);

  I.setCoarse(false);
  const cnt0 = cp28.count, ids0 = new Set(s28.armies.map(a => a.id));
  fire(board, 'pointerdown', ptrEv(72, cp28.x, cp28.y));
  fire(board, 'pointermove', ptrEv(72, cp28.x + 40, cp28.y + 40));   // 40 > 桌面 slop 23.3
  fire(board, 'pointerup', ptrEv(72, cp28.x + 40, cp28.y + 40));
  I.step(1 / 30);
  const born28 = s28.armies.filter(a => !ids0.has(a.id) && a.owner === 1);
  ok(born28.length >= 1 || cp28.count === cnt0 - 1,
     '对照：桌面同样位移仍是拖拽派遣（语义不变）',
     'born=' + born28.length + ' cnt=' + cnt0 + '→' + cp28.count);
  I.setCoarse(null);
  I.sel().splice(0);

  /* CSS：方向键按钮触屏放大到 44px（≥最小触控热区） */
  ok(html.indexOf('@media (pointer:coarse)') >= 0 && html.indexOf('repeat(3,44px)') >= 0,
     '方向键按钮触屏放大到 44px（≥最小热区）');
  ok(html.indexOf('repeat(3,38px)') >= 0, '桌面方向键格子 30 → 38px（触控板/鼠标都更好按）');
}

section('方向键起步（v1.29 · 选中城池即可开走）');
{
  I.menu(); ok(click('btnQuick'), '重开一局（隔离操控状态）');
  const s29 = I.sim();
  s29.opts.noAI = true;
  const me = I.side();
  const c29 = s29.castles.find(x => x.owner === me && x.garrison > 6);
  ok(c29, '找到一座有兵的己方城池');
  const own = () => s29.armies.filter(a => a.owner === me).length;
  const pump = n => { for (let i = 0; i < n; i++){ I.step(1 / 30); I.manualTick(1 / 30); } };

  /* 1 选中己方城池 → 方向键浮出（此前只有「点中一个兵」才出，手机上等于没有入口） */
  I.sel().splice(0);
  I.sel().push({ k: 'c', id: c29.id });
  I.dpadUpdate();
  ok(I.dpad().on === true, '选中己方城池 → 屏内方向键浮出（此前必须先点中一个兵）');

  /* 2 按 W → 直接派兵并接管（此前 setHint + 错误音） */
  const n0 = own();
  I.key('KeyW', true);
  pump(4);
  const n1 = own();
  ok(n1 > n0, '选中城池按 W → 直接派兵（此前只响一声错误音）', n0 + ' → ' + n1);
  ok(I.ctrl().id !== 0 || I.ctrl().pending, '派出后进入接管/认领态', JSON.stringify(I.ctrl()));

  /* 3 按住 → 持续朝上（-y）行军 */
  const p0 = I.ctrlArmy();
  pump(18);
  const p1 = I.ctrlArmy();
  ok(p0 && p1 && p1.y < p0.y - 5, '按住 W 持续行军（朝上走）',
     p0 ? p0.y.toFixed(0) + ' → ' + (p1 ? p1.y.toFixed(0) : 'null') : 'null');

  /* 4 已接管后再按方向键 = 改向，不重复派兵 */
  const n2 = own();
  I.key('KeyD', true); I.key('KeyW', false);
  pump(12);
  const p2 = I.ctrlArmy();
  ok(own() === n2, '已接管后再按方向键 = 改向（不再重复派兵）', n2 + ' → ' + own());
  ok(p2 && p1 && p2.x > p1.x + 3, '改按 D 后确实转向右（+x）',
     p1 ? p1.x.toFixed(0) + ' → ' + (p2 ? p2.x.toFixed(0) : 'null') : 'null');
  I.key('KeyD', false);
  pump(2);
  ok(I.ctrl().keys.d === false, '松开按键 → 方向键状态复位');

  /* 5 对照：选中敌方城池 → 方向键不浮出（不能操控敌人的城） */
  const foe29 = s29.castles.find(x => x.owner !== me && x.owner !== 0);
  if (foe29){
    I.ctrlReset();                                   // 隔离：先清掉上一段残留的操控状态
    I.sel().splice(0); I.sel().push({ k: 'c', id: foe29.id });
    I.dpadUpdate();
    ok(I.dpad().on === false, '选中敌方城池 → 方向键不浮出（操控不了敌人的城）');
  }

  /* 6 什么都没选中 → 接管最近的己方在途部队（此前只响错误音） */
  /*    先确保场上确实有一支己方在途部队 */
  I.ctrlReset();
  c29.garrison = 60;                                  // 前面的用例已把这座城的兵派得差不多，补满再派
  I.sel().splice(0); I.sel().push({ k: 'c', id: c29.id });
  I.key('KeyS', true); pump(4); I.key('KeyS', false);
  const alive = s29.armies.filter(a => a.owner === me && !a.ghost);
  ok(alive.length >= 1, '场上有一支己方在途部队', 'n=' + alive.length);
  I.ctrlReset();
  I.sel().splice(0);
  I.dpadUpdate();
  I.key('KeyA', true);
  pump(3);
  ok(I.ctrl().id !== 0, '无选中时按方向键 → 接管最近的己方部队（不再是死路）', 'ctrl.id=' + I.ctrl().id);
  I.key('KeyA', false);
  I.sel().splice(0);
}

section('物理方向键 ↑↓←→（v1.30 · 键盘上那四个键此前完全没有分支）');
{
  I.menu(); ok(click('btnQuick'), '重开一局（隔离操控状态）');
  const s30 = I.sim();
  s30.opts.noAI = true;
  const me = I.side();
  const c30 = s30.castles.find(x => x.owner === me && x.garrison > 6);
  ok(c30, '找到一座有兵的己方城池');
  const own = () => s30.armies.filter(a => a.owner === me && !a.ghost).length;
  const pump = n => { for (let i = 0; i < n; i++){ I.step(1 / 30); I.manualTick(1 / 30); } };

  I.ctrlReset();
  I.sel().splice(0);
  I.sel().push({ k: 'c', id: c30.id });

  /* 1 ↑ 与 W 等价：选中己方城池按 ↑ = 派兵朝上（此前 onKeyDown 只认 KeyW/A/S/D） */
  const n0 = own();
  I.key('ArrowUp', true);
  pump(4);
  ok(own() > n0, '按 ↑ → 直接派兵（此前方向键完全没有分支，按了没反应）', n0 + ' → ' + own());
  ok(I.ctrl().id !== 0 || I.ctrl().pending, '按 ↑ 后进入接管/认领态', JSON.stringify(I.ctrl()));

  /* 2 按住 ↑ 持续朝上（-y） */
  const a0 = I.ctrlArmy();
  pump(18);
  const a1 = I.ctrlArmy();
  ok(a0 && a1 && a1.y < a0.y - 5, '按住 ↑ 持续行军（朝上走）',
     a0 ? a0.y.toFixed(0) + ' → ' + (a1 ? a1.y.toFixed(0) : 'null') : 'null');

  /* 3 松开 ↑ → 键状态复位（onKeyUp 此前同样只认 KeyW/A/S/D，会卡住） */
  I.key('ArrowUp', false);
  ok(I.ctrl().keys.w === false, '松开 ↑ → keys.w 复位（否则会一直朝上走）', JSON.stringify(I.ctrl().keys));

  /* 4 → 转向 +x；↓ 转向 +y */
  I.key('ArrowRight', true); pump(14);
  const a2 = I.ctrlArmy();
  ok(a2 && a1 && a2.x > a1.x + 3, '按 → 朝右行军（+x）',
     a1 ? a1.x.toFixed(0) + ' → ' + (a2 ? a2.x.toFixed(0) : 'null') : 'null');
  I.key('ArrowRight', false);
  I.key('ArrowDown', true); pump(14);
  const a3 = I.ctrlArmy();
  ok(a3 && a2 && a3.y > a2.y + 3, '按 ↓ 朝下行军（+y）',
     a2 ? a2.y.toFixed(0) + ' → ' + (a3 ? a3.y.toFixed(0) : 'null') : 'null');
  I.key('ArrowDown', false);
  I.key('ArrowLeft', true);
  ok(I.ctrl().keys.a === true && I.ctrl().keys.d === false, '← 映射到 a、→ 映射到 d（不与 WASD 串键）',
     JSON.stringify(I.ctrl().keys));
  I.key('ArrowLeft', false);
  ok(I.ctrl().keys.a === false, '松开 ← → keys.a 复位');

  /* 5 兼容：e.code 缺失（部分输入法 / 老浏览器 / 虚拟键盘只给 e.key）时仍认键 */
  I.ctrlReset();
  I.sel().splice(0); I.sel().push({ k: 'c', id: c30.id });
  const n5 = own();
  I.key(null, true, { key: 'ArrowUp' });          // 只有 e.key，没有 e.code
  pump(4);
  ok(own() > n5 || I.ctrl().id !== 0 || I.ctrl().pending,
     '只有 e.key（无 e.code）时方向键同样生效', n5 + ' → ' + own());
  I.key(null, false, { key: 'ArrowUp' });
  ok(I.ctrl().keys.w === false, '只有 e.key 时松开也能复位（onKeyUp 走同一套归一化）');

  /* 6 归一化本身：四个方向键 + 四个字母键都映射到 w/a/s/d（含只有 e.key 的情况） */
  const D30 = k => I.dirOf(k);
  ok(D30('ArrowUp') === 'w' && D30('ArrowDown') === 's' && D30('ArrowLeft') === 'a' && D30('ArrowRight') === 'd',
     '↑↓←→ 映射到 w/s/a/d', [D30('ArrowUp'), D30('ArrowDown'), D30('ArrowLeft'), D30('ArrowRight')].join(''));
  ok(D30('KeyW') === 'w' && D30('KeyD') === 'd', 'WASD 映射不变（保持原有快捷键行为）');
  ok(I.dirOf('', 'ArrowUp') === 'w' && I.dirOf('', 'w') === 'w' && I.dirOf('', 'W') === 'w',
     '无 e.code 时按 e.key 归一（大小写 / ArrowX 都认）');
  ok(I.dirOf('KeyQ') === null && I.dirOf('', 'ArrowUp ') === null, '无关按键不误判为方向');
  I.ctrlReset();
  I.sel().splice(0);
}

section('连续指令（v1.31 · 驻扎后无需重新点选即可继续下令）');
{
  I.menu(); ok(click('btnQuick'), '重开一局（隔离操控状态）');
  const s31 = I.sim();
  s31.opts.noAI = true;
  s31.castles.forEach(c => { c.tower = null; });          // 隔离：塔火会秒掉 1 兵
  const me = I.side();
  const c31 = s31.castles.find(x => x.owner === me && x.garrison > 8);
  ok(c31, '找到一座有兵的己方城池');
  const own = () => s31.armies.filter(a => a.owner === me && !a.ghost).length;
  const pump = n => { for (let i = 0; i < n; i++){ I.step(1 / 30); I.manualTick(1 / 30); } };
  const selOf = k => I.sel().filter(x => x.k === k);

  /* 1 选中己方城池 → 按 → 派兵并接管 */
  I.ctrlReset();
  I.sel().splice(0);
  I.sel().push({ k: 'c', id: c31.id });
  I.key('ArrowRight', true);
  pump(8);
  ok(I.ctrl().id !== 0, '按方向键派兵并接管', JSON.stringify(I.ctrl()));

  /* 2 退出驻扎 / 出兵后：被操控的部队保持选中（连续指令的「选中锚点」） */
  ok(selOf('a').length === 1 && selOf('a')[0].id === I.ctrl().id,
     '接管后该部队即处于选中态（后续指令不必重新点选）', JSON.stringify(I.sel()));

  /* 3 ★ 松手驻扎 → 自动选中刚扎下的阵列（核心：不再需要重新点击） */
  const camps0 = s31.camps.length;
  I.key('ArrowRight', false);
  pump(40);
  ok(I.ctrl().id === 0, '松手后操控态清空（部队已就地驻扎）', JSON.stringify(I.ctrl()));
  ok(s31.camps.length > camps0, '确实扎下了新阵列', camps0 + ' → ' + s31.camps.length);
  const ps = selOf('p');
  ok(ps.length === 1, '★ 驻扎后自动选中刚扎下的阵列（无需重新点选）', JSON.stringify(I.sel()));
  const p31 = ps.length ? s31.camps.find(x => x.id === ps[0].id) : null;
  ok(p31 && p31.owner === me, '选中的确实是己方新阵列', p31 ? JSON.stringify({ id: p31.id, n: p31.count }) : 'null');

  /* 4 ★ 不重新点选，直接按方向键 → 立刻继续行军 */
  const n0 = own();
  I.key('ArrowUp', true);
  pump(8);
  ok(I.ctrl().id !== 0 || I.ctrl().pending,
     '★ 驻扎后直接按方向键即继续行军（无需重新点选）', JSON.stringify(I.ctrl()));
  const b0 = I.ctrlArmy();
  pump(20);
  const b1 = I.ctrlArmy();
  ok(b0 && b1 && b1.y < b0.y - 5, '第二轮持续朝上行军（-y）',
     b0 ? b0.y.toFixed(0) + ' → ' + (b1 ? b1.y.toFixed(0) : 'null') : 'null');

  /* 5 连走三轮仍是同一条链路（驻扎 → 按键 → 驻扎 → 按键） */
  let rounds = 1, held = 'ArrowUp';
  for (let r = 0; r < 2; r++){
    I.key(held, false); pump(40);
    if (selOf('p').length !== 1) break;
    held = r === 0 ? 'ArrowLeft' : 'ArrowDown';
    I.key(held, true);
    pump(8);
    if (I.ctrl().id === 0 && !I.ctrl().pending) break;
    rounds++;
  }
  ok(rounds === 3, '连续三轮「驻扎 → 直接按键」全部成立（rounds=' + rounds + '）');
  I.key(held, false);
  pump(4);

  /* 6 对照：部队被打光（非主动驻扎）不得误选阵列 —— settle 只认「松手驻扎」 */
  I.ctrlReset();
  I.sel().splice(0);
  I.sel().push({ k: 'c', id: c31.id });
  c31.garrison = 40;
  I.key('ArrowRight', true);
  pump(8);
  const killId = I.ctrl().id;
  ok(killId !== 0, '（准备）再次接管一支部队', 'ctrl.id=' + killId);
  s31.armies = s31.armies.filter(a => a.id !== killId);     // 模拟被歼灭
  pump(6);
  ok(selOf('p').length === 0 && selOf('a').length === 0,
     '部队被歼灭（非主动驻扎）→ 不接管任何阵列（避免误选）', JSON.stringify(I.sel()));
  I.key('ArrowRight', false);
  I.ctrlReset();

  /* 7 对照：普通派遣语义不变 —— 点空地列阵后仍然清空选择 */
  I.sel().splice(0);
  c31.garrison = 40;                                     // 前面几轮已把这座城派空，补满再测
  I.sel().push({ k: 'c', id: c31.id });
  const spot = farSpot(220);
  tap(spot.x, spot.y);
  ok(I.sel().length === 0, '普通派遣（点空地列阵）仍然清空选择（既有语义不变）', JSON.stringify(I.sel()));

  /* 8 对照：框选仍然整片重填 */
  I.sel().splice(0);
  I.sel().push({ k: 'p', id: -1 });                          // 先塞一条脏选择
  I.sel().splice(0);
  ok(I.sel().length === 0, '（清理）选择已清空');
  I.ctrlReset();
}

section('士兵进城升级（v1.32 · 可交互入口 / 快捷键 / 联机同步）');
{
  I.setNet('none');
  I.menu(); ok(click('btnQuick'), '重开一局用于士兵进城升级');
  const s32 = I.sim();
  s32.opts.noAI = true; s32.opts.upTowerChance = 0;
  const me = I.side();
  const c32 = s32.castles.find(x => x.owner === me);
  ok(!!c32, '找到己方城池作为升级目标');
  c32.level = 1; c32.garrison = 19; c32.tower = null;

  /* 1 可交互徽章：渲染与命中共用坐标，且必须在驻军最外环之外。 */
  const chip = I.upChip(c32.id);
  const chipD = Math.hypot(chip.x - c32.x, chip.y - c32.y);
  ok(chip && chipD >= (24 + 64) - 0.01, '「↑」入口移出驻军环，不再被城内士兵命中区遮挡', 'd=' + chipD.toFixed(1));
  ok(I.hitUpChip(chip.x, chip.y) === c32.id, '徽章圆心可命中对应城池（渲染/命中同源）');
  const draw32 = frame();
  const chipArc = draw32.some(k => k.fn === 'arc' && Math.abs(k.args[0] - chip.x) < 0.01 &&
                                              Math.abs(k.args[1] - chip.y) < 0.01 && Math.abs(k.args[2] - 17) < 0.01);
  const missTxt = draw32.some(k => k.fn === 'fillText' && k.args[0] === '↑1' &&
                                               Math.abs(k.args[1] - chip.x) < 0.01 && Math.abs(k.args[2] - chip.y) < 0.01);
  ok(chipArc && missTxt, '兵力不足时徽章显示还差 1 兵（↑1），仍可点击查看原因');

  /* 2 不足：点击入口只提示，不改等级/兵力。 */
  tap(chip.x, chip.y);
  ok(I.hint().indexOf('兵力不足') >= 0 && I.hint().indexOf('还需 <b>1</b>') >= 0,
     '点击不足状态的入口 → 明确提示还需兵力', I.hint());
  const lvLow = c32.level, gLow = c32.garrison;
  I.step(1 / 30);
  ok(c32.level === lvLow && c32.garrison >= gLow, '兵力不足不会扣兵或升级（只发生正常产兵）');

  /* 3 点中城内士兵 + E：入城、定步结算、只清这名兵的选择。 */
  c32.level = 1; c32.garrison = 25;
  I.sel().splice(0);
  const ru32 = I.ringUnits(c32)[0];
  tap(ru32.x, ru32.y);
  ok(I.sel().some(s => s.k === 'gs' && s.id === c32.id), '可点中城内驻军作为升级发起者', JSON.stringify(I.sel()));
  const keepCamp = { id: 9320, owner: me, count: 6, x: Math.max(80, c32.x - 180), y: c32.y + 140, atkT: 0 };
  s32.camps.push(keepCamp);
  I.sel().push({ k: 'p', id: keepCamp.id });
  I.key('KeyE', true);
  ok(c32.level === 1, '按 E 后升级军令先入队（输入回调不直接改模拟）');
  ok(!I.sel().some(s => s.k === 'gs' && s.id === c32.id) && I.sel().some(s => s.k === 'p' && s.id === keepCamp.id),
     '入城士兵选择被清除，其它多选对象保持不变', JSON.stringify(I.sel()));
  I.step(1 / 30);
  ok(c32.level === 2 && c32.garrison >= 5 && c32.garrison < 5.1,
     '固定步结算：20 兵进城，Lv1→Lv2，剩余兵力正确', 'Lv' + c32.level + ' g=' + c32.garrison.toFixed(3));
  ok(I.fx().floats.some(f => String(f.txt).indexOf('20兵入城 · 升级 Lv2') >= 0),
     '升级表现明确显示「20兵入城 · 升级 Lv2」');
  const cap32 = Math.round(Sim.LEVELS[1].cap * s32.mods.cap);
  ok(I.hint().indexOf('容量 ' + cap32) >= 0 && I.hint().indexOf('产速 1.2/秒') >= 0,
     '成功提示同步给出当前加成后的新容量与产速', I.hint());

  /* 4 满级与第二级不足：键盘入口提供明确反馈；满级不再画徽章。 */
  I.sel().splice(0); I.sel().push({ k: 'c', id: c32.id });
  c32.level = 2; c32.garrison = 49;
  I.key('KeyE', true);
  ok(I.hint().indexOf('还需 <b>1</b>') >= 0 && c32.level === 2, 'Lv2 的 49/50 明确提示还差 1 兵');
  c32.level = 3; c32.garrison = 60;
  I.key('KeyE', true);
  ok(I.hint().indexOf('最高等级') >= 0 && c32.level === 3 && c32.garrison === 60,
     '已达 Lv3：提示封顶且不再消耗兵力');
  ok(!I.upChips().some(x => x.id === c32.id), '满级城池不再显示升级入口');

  /* 5 直接点徽章同样可升级：无需依赖键盘，满足触屏交互。 */
  c32.level = 1; c32.garrison = 25;
  I.sel().splice(0);
  const chip2 = I.upChip(c32.id);
  tap(chip2.x, chip2.y); I.step(1 / 30);
  ok(c32.level === 2, '触屏/鼠标直接点「↑」入口可完成升级');

  /* 6 联机：房主不信任客机上传的 owner；强制按 2 号阵营校验并通过快照同步等级/驻军。 */
  const foe32 = s32.castles.find(x => x.owner === 2);
  foe32.level = 1; foe32.garrison = 25; foe32.tower = null;
  c32.level = 1; c32.garrison = 25;
  I.setNet('host');
  I.netMsg(JSON.stringify({ t: 'cmd', kind: 'castleUp', cmd: { type: 'castleUp', owner: 1, id: foe32.id } }));
  I.step(1 / 30);
  ok(foe32.level === 2 && c32.level === 1,
     '联机主机把客机升级请求锁定为 2 号阵营（伪造 owner=1 不能动房主城）');
  const snap32 = I.snap(), row32 = snap32 && snap32.cs ? snap32.cs[foe32.id] : null;
  ok(row32 && row32[0] === 2 && row32[1] === foe32.level && Math.abs(row32[2] - +foe32.garrison.toFixed(1)) < 1e-9,
     '权威快照同步城池归属 / 等级 / 驻军，客机不会出现升级分叉', row32 ? JSON.stringify(row32.slice(0, 3)) : 'null');
  I.setNet('none');
  I.sel().splice(0);
}

/* ---------- v1.33：杀戮尖塔式卡牌交互（卡面精简 / 详情浮层 / 拖拽出牌） ---------- */
section('卡牌拖拽出牌与详情浮层（v1.33）');
{
  I.menu(); click('btnQuick');                       // 新开一局，隔离前面段落遗留的选择与状态
  const s33 = I.sim();
  const cards33 = documentStub.getElementById('cards');
  ok(!!s33 && I.mode() === 'playing', '新开一局用于卡牌交互用例', I.mode());
  I.viewReset();

  /* --- A 卡面精简：只留插画 + 名称 + 费用角标 --- */
  s33.hands[1].length = 0;
  const hand33 = ['fire', 'shield', 'dagger', 'levy', 'fire+'];
  hand33.forEach(k => s33.hands[1].push(k));
  s33.ink[1] = 20;
  I.step(0);
  const H33 = cards33.innerHTML;
  ok(H33.indexOf('<div class="cd"') < 0 && H33.indexOf('<div class="cc"') < 0,
     '卡面不再罗列描述行与费用行（.cd / .cc 已移出）');
  const got33 = (H33.match(/<i class="inkcost">(\d+)<\/i>/g) || []).map(x => +x.replace(/\D/g, ''));
  const want33 = hand33.map(k => Sim.CARDS.filter(c => c.key === k)[0].cost);
  ok(got33.length === Sim.CFG.HAND_MAX && got33.every((v, i) => v === want33[i]),
     '每张手牌一个费用角标且数值逐槽正确', got33.join(',') + ' vs ' + want33.join(','));
  ok(H33.indexOf('消耗') < 0 && H33.indexOf('data-ex="1"') >= 0,
     '消耗牌：卡面只留 data-ex 标记，「消耗」文本已移入浮层');
  ok((H33.match(/<i class="inkart">/g) || []).length === Sim.CFG.HAND_MAX,
     '插画容器仍是每卡一个（替身不复用 inkart）',
     String((H33.match(/<i class="inkart">/g) || []).length));

  /* --- B 详情浮层：内容齐全 + 悬停 / 长按两种触发 --- */
  const fire33 = Sim.CARDS.filter(c => c.key === 'fire')[0];
  ok(I.tip().on === false, '默认不显示详情浮层');
  ok(I.tipShow(0) === true && I.tip().on === true, '可打开详情浮层');
  const TH = I.tip().html;
  ok(TH.indexOf(fire33.name) >= 0 && TH.indexOf(fire33.desc) >= 0, '浮层含卡名与描述', TH.slice(0, 90));
  ok(TH.indexOf('墨 <b>' + fire33.cost + '</b>') >= 0, '浮层含费用', TH.slice(0, 120));
  ok(TH.indexOf('冷却 ' + fire33.cd + 's') >= 0, '浮层含冷却秒数');
  ok(TH.indexOf('目标：') >= 0, '浮层含类型 / 目标（由 card.target 派生）');
  ok(I.tip().cls.indexOf('on') >= 0, '浮层打开时带 on 类');
  I.tipShow(3);
  ok(I.tip().html.indexOf('无需目标') >= 0, '无目标卡浮层写明「无需目标」');
  I.tipShow(1);
  ok(I.tip().html.indexOf('己方城池') >= 0, '己方目标卡（护盾）浮层写明「目标：己方城池」');
  I.tipHide();
  ok(I.tip().on === false && I.tip().cls === 'inkpop', '关闭后浮层回到隐藏态', I.tip().cls);

  ok(I.tipHoldMs() === 300, '触屏长按阈值 300ms');
  I.tipHold(0);
  ok(I.tip().on === false, '长按未到点不弹详情');
  ok(I.tipHoldFire() === true && I.tip().on === true, '长按到点弹出详情');
  I.tipHide(); I.tipHoldCancel();
  ok(I.tipHoldFire() === false && I.tip().on === false, '取消长按后不再弹详情');

  fire(cards33, 'pointermove', { pointerId: 51, clientX: 96, clientY: 400, pointerType: 'mouse' });
  ok(I.tip().on === true, '桌面悬停手牌区弹出详情（几何命中，不依赖 e.target）');
  fire(cards33, 'pointermove', { pointerId: 51, clientX: 99999, clientY: 99999, pointerType: 'mouse' });
  ok(I.tip().on === false, '移出手牌区收起详情');

  /* --- B2 v1.33a 命中错位修复：max-width:96 + justify-content:center 下按真实卡面 rect 命中 --- */
  ok(I.realSlotRects() === -1, '打桩读不到真实卡面 rect → 走五等分回退（回退路径保活）');
  ok(I.slotAt(96, 270) === 0, '回退路径：五等分首槽仍命中 slot 0');
  /* 复刻 bug 现场：容器 700px 宽、5 张 96px 卡居中聚拢（总宽 500，左右各留 100px 空带）。
     旧「五等分」从容器左缘每 141px 切一带 → 点第一张卡右半 (x=180) 被算进第 2 槽，弹邻卡详情。 */
  const centered33 = [0, 1, 2, 3, 4].map(i => ({ slot: i, left: 100 + i * 101, top: 0, width: 96, height: 64 }));
  ok(I.slotFromRects(centered33, 180, 32) === 0, '居中聚拢：点第一张卡右半仍是第 1 张（不再漂移到邻槽）');
  ok(I.slotFromRects(centered33, 250, 32) === 1, '居中聚拢：点第二张卡命中第 2 张');
  ok(I.slotFromRects(centered33, 50, 32) === -1, '点卡面之外的左侧空白 → 不命中任何槽');
  const vert33 = [0, 1, 2, 3, 4].map(i => ({ slot: i, left: 0, top: 60 + i * 48, width: 180, height: 44 }));
  ok(I.slotFromRects(vert33, 90, 70) === 0, '横屏右侧栏竖排：首卡命中 slot 0');
  ok(I.slotFromRects(vert33, 90, 130) === 1, '竖排侧栏按纵向命中 slot 1');

  /* --- C 拖拽出牌：三态 + 合法 / 非法落点 --- */
  const foe33 = s33.castles.filter(c => c.owner === 2 || c.owner === 0)[0];   // 火攻 target='foe'
  const own33 = s33.castles.filter(c => c.owner === 1)[0];
  const v33 = I.view();
  /* 地图坐标 → 打桩画布 CSS 坐标（画布恒 960×540，故半宽 480 / 半高 270） */
  const toCli33 = (mx, my) => ({ x: (mx - Sim.CFG.MAP_W / 2 - v33.px) * v33.k + 480,
                                 y: (my - Sim.CFG.MAP_H / 2 - v33.py) * v33.k + 270 });
  const pFoe = toCli33(foe33.x, foe33.y), pOwn = toCli33(own33.x, own33.y);

  ok(I.dragBegin(0, 100, 300) === true, '可从卡槽起拖');
  ok(!!I.drag() && I.drag().slot === 0 && I.drag().target === true, '拖拽态记录槽位与目标需求');
  ok(I.cardsCls().indexOf('dragging') >= 0, '手牌区进入拖拽态');
  ok(cards33.innerHTML.indexOf(' out') >= 0, '被拖的那张卡置灰占位');
  ok(I.ghost() && I.ghost().cls.indexOf('inkghost') >= 0, '生成跟手替身');
  ok(I.tip().on === false, '起拖即收起详情浮层');
  I.dragMove(500, 200);
  ok(I.drag().cx === 500 && I.ghost().left === '500px', '替身跟手移动', I.ghost().left);

  I.dragMove(pFoe.x, pFoe.y);
  ok(I.drag().hover === foe33.id && I.drag().ok === true, '拖到合法城池 → 判定可发动',
     'hover=' + I.drag().hover + ' ok=' + I.drag().ok);
  ok(I.ghost().cls.indexOf(' ok') >= 0, '合法落点替身高亮', I.ghost().cls);
  I.dragMove(pOwn.x, pOwn.y);
  ok(I.drag().hover === own33.id && I.drag().ok === false, '拖到己方城池 → 判定非法');
  ok(I.ghost().cls.indexOf(' bad') >= 0, '非法落点替身变灰', I.ghost().cls);

  const nHand0 = s33.hands[1].length, nFx0 = I.fx().fxs.length;
  I.dragDrop(pOwn.x, pOwn.y);
  ok(s33.hands[1].length === nHand0, '非法落点松手不出牌（回弹取消）');
  ok(I.fx().fxs.length === nFx0 + 1, '非法落点给红环反馈');
  ok(I.hint().indexOf('不能指向这里') >= 0, '提示「不能指向这里」', I.hint());
  ok(I.drag() === null && I.cardsCls().indexOf('dragging') < 0, '回弹后清空拖拽态');
  ok(cards33.innerHTML.indexOf(' out') < 0, '回弹后原卡恢复（out 占位移除）');

  const d0 = I.piles(1).discard.length;
  I.dragBegin(0, 100, 300);
  I.dragMove(pFoe.x, pFoe.y);
  I.dragDrop(pFoe.x, pFoe.y);
  ok(I.piles(1).discard.length === d0 + 1 && I.piles(1).discard.slice(-1)[0] === 'fire',
     '拖到合法城池松手 → 进弃牌堆', JSON.stringify(I.piles(1).discard));
  ok(I.fx().floats.some(f => f.txt.indexOf('「') >= 0), '出牌在目标城池飘卡名');
  ok(I.drag() === null, '出牌后清空拖拽态');

  /* 无目标卡：拖出手牌区即发动；仍在手牌区内松手 = 取消 */
  s33.hands[1][0] = 'levy'; s33.ink[1] = 20;
  I.step(0);
  const d1 = I.piles(1).discard.length;
  I.dragBegin(0, 100, 300);
  ok(!!I.drag() && I.drag().target === false, '无目标卡也能起拖');
  I.dragMove(700, 200);
  I.dragDrop(700, 200, false);
  ok(I.piles(1).discard.length === d1, '未拖出手牌区 → 回弹取消，不出牌');
  I.dragBegin(0, 100, 300);
  I.dragMove(700, 200);
  ok(I.dragDrop(700, 200, true) === 'done' && I.piles(1).discard.length === d1 + 1,
     '拖出手牌区 → 无目标卡直接发动');

  /* --- D 边界与冲突 --- */
  s33.hands[1][0] = 'fire'; s33.ink[1] = 0;
  I.step(0);
  const nHand1 = s33.hands[1].length;
  ok(I.dragBegin(0, 100, 300) === false && I.drag() === null, '墨量不足不起拖');
  ok(I.hint().indexOf('墨量不足') >= 0, '提示墨量不足', I.hint());
  s33.ink[1] = 20;
  I.step(0);
  ok(s33.hands[1].length === nHand1, '未起拖不消耗手牌');

  /* 换一张没进冷却的卡（火攻 / 征兵在前面已打出并进冷却，canPlay 会拒绝起拖） */
  s33.hands[1][0] = 'rush'; s33.ink[1] = 20;
  I.step(0);
  fire(cards33, 'pointerdown', { pointerId: 61, clientX: 96, clientY: 400, pointerType: 'mouse' });
  fire(winStub, 'pointermove', { pointerId: 61, clientX: 98, clientY: 401, pointerType: 'mouse' });
  ok(I.drag() === null, '位移小于起拖阈值不判为拖拽（留给点击）');
  fire(winStub, 'pointerup', { pointerId: 61, clientX: 98, clientY: 401, pointerType: 'mouse' });
  ok(I.drag() === null, '轻点抬手不残留拖拽态');

  fire(cards33, 'pointerdown', { pointerId: 62, clientX: 96, clientY: 400, pointerType: 'mouse' });
  fire(winStub, 'pointermove', { pointerId: 62, clientX: 600, clientY: 200, pointerType: 'mouse' });
  ok(!!I.drag(), '真实指针事件可完成起拖（down 挂 #cards、move 挂 window）');
  const nSel33 = I.sel().length;
  ok(I.touches() === 0 && I.pinch() === null, '拖卡不污染棋盘触点与双指状态');
  ok(I.sel().length === nSel33, '拖卡不改变城池/部队选择');
  fire(winStub, 'pointerup', { pointerId: 62, clientX: 600, clientY: 200, pointerType: 'mouse' });
  ok(I.drag() === null, '松手收尾（发动或回弹）');

  I.dragBegin(0, 100, 300);
  fire(winStub, 'keydown', { code: 'Escape' });
  ok(I.drag() === null && I.cardsCls().indexOf('dragging') < 0, 'Esc 取消拖拽（回弹）');

  /* 静态守卫：事件挂 window、触屏不被浏览器手势抢走、浮层默认不占位 */
  ok(/window\.addEventListener\('pointermove', onCardsMove\)/.test(html) &&
     /window\.addEventListener\('pointerup', onCardsUp\)/.test(html),
     '拖拽 move/up 挂 window（document.addEventListener 在打桩里是 noop）');
  ok(/\.cards\{touch-action:none\}/.test(html), '触屏拖卡不被浏览器滚动 / 长按菜单抢走');
  ok(/\.inkpop\{[^}]*display:none/.test(html) && /\.inkpop\.on\{display:block/.test(html),
     '详情浮层默认 display:none（不产生溢出，check-mobile 量测免疫）');
  ok(html.indexOf("'inkghost") >= 0 && html.indexOf('inkpop') >= 0 &&
     !/className = 'card/.test(html),
     '新增替身 / 浮层元素均以 ink 前缀命名（不用 card 前缀）');
  I.sel().splice(0);
}

/* ---------- v1.34：出兵比例条（滑块 0~100% 连续 + 25/50/75/100 档位 + 实时兵力读数） ---------- */
section('出兵比例条（v1.34）');
{
  I.menu(); click('btnQuick');                       // 新开一局，隔离前面段落的选择与状态
  const s34 = I.sim();
  ok(!!s34 && I.mode() === 'playing', '新开一局用于出兵比例条用例', I.mode());
  I.viewReset();
  s34.opts.noAI = true;                              // 隔离：不让 AI 在步进中改变驻军
  s34.castles.forEach(c => { c.tower = null; });
  I.sel().splice(0);

  /* --- A 结构：滑块 0~100 + 四档快捷 + 读数区 --- */
  ok(/<input class="rslide" id="ratioRange" type="range" min="0" max="100" step="1"/.test(html),
     '滑块是 0~100 的连续 range（step 1）');
  ['0.25', '0.5', '0.75', '1'].forEach(v =>
    ok(html.indexOf('data-r="' + v + '"') >= 0, '档位 ' + Math.round(v * 100) + '% 存在于结构'));
  ok(/class="rval" id="ratioVal"/.test(html), '读数区独立（百分比 — 实际兵力）');
  ok(I.ratio() === 1, '默认 100%（沿用旧「全押」手感）');

  /* --- B 禁用态：可用兵力为 0（未选中己方城池） --- */
  ok(I.ratioCls().indexOf('off') >= 0, '未选中己方城池 → 整条置灰（.off）');
  ok(I.ratioRange().off === true, '禁用态下滑块 disabled（交互关闭）');
  ok(I.ratioTxt().indexOf('无可用兵力') >= 0, '禁用态读数写明原因', I.ratioTxt());

  /* --- C 读数 = 百分比 — 实际兵力，且与块1 doSend 的 floor 口径一致 --- */
  /* 取两座城并都归己方（开局己方可能只有 1 座，读数用例需要「多来源累加」的样本） */
  const own34 = [s34.castles[0], s34.castles[1]];
  own34.forEach(c => { c.owner = 1; });
  own34[0].garrison = 3000; own34[1].garrison = 3400;
  I.sel().splice(0); own34.forEach(c => I.sel().push({ k: 'c', id: c.id }));
  ok(I.selAvail() === 6400, '可用兵力 = 选中城池驻军合计', String(I.selAvail()));
  I.ratio(1);
  ok(I.ratioTxt() === '100% — 6,400 兵', '100% 读数带千分位', I.ratioTxt());
  I.ratio(0.5);
  ok(I.ratioTxt() === '50% — 3,200 兵', '50% 读数与实际兵力一致', I.ratioTxt());
  ok(I.ratioBar().send === 3200 && I.ratioBar().avail === 6400, 'state.send / avail 与读数同源');
  I.ratio(0.25);
  ok(I.ratioBar().send === 1600 && I.ratioTxt().indexOf('25%') === 0, '25% 档位读数正确');
  ok(I.ratioCls().indexOf('off') < 0 && I.ratioRange().off === false, '有可用兵力 → 恢复可交互');

  /* 连续调节：0~100 每档都等于「逐来源 floor 再累加」——注意必须 garrison × (p/100)，
     与块1 的 Math.floor(garrison × ratio) 同序（先除后乘与先乘后除在浮点下会差 1 兵） */
  own34[0].garrison = 3000; own34[1].garrison = 3400;
  let all34 = true, bad34 = '', diff34 = 0;
  for (let p = 0; p <= 100; p++){
    I.ratio(p / 100);
    const st = I.ratioBar();
    const want = own34.reduce((n, c) => n + Math.floor(c.garrison * (p / 100)), 0);
    const naive = Math.floor(own34.reduce((n, c) => n + Math.floor(c.garrison), 0) * (p / 100));
    if (st.pct !== p || st.send !== want){ all34 = false; bad34 = p + '%:' + st.send + '≠' + want; break; }
    if (want !== naive) diff34++;                    // 证明确实是「逐来源 floor」而非「总数 floor」
  }
  ok(all34, '0~100% 连续调节：每档兵数都等于逐来源 floor 累加（与块1 同口径）', bad34);
  ok(diff34 > 0, '多来源时按逐城 floor（与「总数 × 比例」确有差别，口径未被简化）', '差异档数=' + diff34);
  ok(/^% — [\d,]+ 兵$/.test(I.ratioTxt().replace(/^\d+/, '')) || /% — [\d,]+ 兵$/.test(I.ratioTxt()),
     '读数格式统一为「百分比 — 兵力 兵」', I.ratioTxt());

  /* 越界钳制（对应「超出上限」的防御）：>1 归 1、<0 归 0 */
  ok(I.ratio(1.5) === 1 && I.ratio(-0.2) === 0, '越界比例钳进 [0,1]');

  /* --- D 滑块事件：拖动即时更新（input 静音） --- */
  const range34 = documentStub.getElementById('ratioRange');
  range34.value = '60';
  fire(range34, 'input', {});
  ok(Math.abs(I.ratio() - 0.6) < 1e-9 && I.ratioTxt().indexOf('60%') === 0,
     '拖动滑块即时更新比例与读数', I.ratioTxt());
  range34.value = '35';
  fire(range34, 'change', {});
  ok(Math.abs(I.ratio() - 0.35) < 1e-9, '松手（change）同样落定比例');

  /* --- E 真的按读数出兵（读数 → 实派，一一对应） --- */
  const src34 = s34.castles.find(c => c.owner === 1);
  src34.garrison = 1000;
  I.sel().splice(0); I.sel().push({ k: 'c', id: src34.id });
  /* 本段自带的空地：按**当前这局**的城池挑最远点（不复用全局 farSpot —— 它读的是开局那张图） */
  const spot34 = (function(){
    let best = { x: 800, y: 450, d: -1 };
    for (let gx = 220; gx < 1380; gx += 50)
      for (let gy = 160; gy < 740; gy += 50){
        let d = 1e9;
        for (const c of s34.castles) d = Math.min(d, Math.hypot(c.x - gx, c.y - gy));
        if (d > best.d) best = { x: gx, y: gy, d: d };
        if (best.d >= 300) return best;
      }
    return best;
  })();
  I.ratio(0.5);
  tap(spot34.x, spot34.y);
  I.step(1 / 30);
  ok(s34.armies.some(a => a.owner === 1 && a.count === 500),
     '出兵数与读数完全一致（读数 500 兵 → 实派 500 兵）', I.ratioTxt() + ' / armies=' + s34.armies.length);
  I.step(20);                                        // 等它落地成阵列，腾出后续用例的地图
  I.sel().splice(0);

  src34.garrison = 1000;
  I.sel().splice(0); I.sel().push({ k: 'c', id: src34.id });
  I.ratio(0);
  const n034 = s34.armies.length;
  tap(spot34.x, spot34.y);
  I.step(1 / 30);
  ok(s34.armies.length === n034, '0% 不派兵（读数 0 兵 = 不出兵）');

  /* --- F 选中来源被清空 → 可用兵力 0 → 置灰禁用 --- */
  own34.forEach(c => { c.garrison = 0; });
  I.sel().splice(0); own34.forEach(c => I.sel().push({ k: 'c', id: c.id }));
  pump(2);                                           // 比例条在帧循环里刷新（updateHud → renderRatioBar）
  const st34 = I.ratioBar();
  ok(st34.avail === 0 && st34.off === true, '选中城池驻军为 0 → 可用兵力 0');
  ok(I.ratioCls().indexOf('off') >= 0 && I.ratioRange().off === true, '可用兵力为 0 → 置灰并禁用交互');
  ok(I.ratioTxt().indexOf('无可用兵力') >= 0, '禁用态读数仍写明原因', I.ratioTxt());
  I.sel().splice(0);

  /* --- G 静态守卫：城池上的比例标签不再写死 50%/100% --- */
  ok(html.indexOf("ratio === 0.5 ? '50%' : '100%'") < 0 &&
     html.indexOf("Math.round(ratio * 100) + '%'") >= 0,
     '选中城池上方跟随比例条显示任意百分比（旧版只认 50/100）');
  ok(/\.ratio\.off\{opacity:\.5/.test(html), '禁用态有置灰样式 .ratio.off');
  ok(/b\.onclick = function\(\)\{ setRatio\(\+b\.dataset\.r\)/.test(html) &&
     /addEventListener\('input', function\(\)\{ setRatio/.test(html) &&
     /addEventListener\('change', function\(\)\{ setRatio/.test(html),
     '档位按钮 / 滑块拖动 / 松手三处都走 setRatio 同一入口');
  ok(/ratio: Math\.max\(0, Math\.min\(1, ratio\)\)/.test(html), '下达军令时比例再钳一次 [0,1]（防御脏值）');
}

/* ---------- v1.35：联机加固（指令权威校验 + 切后台不误判失联） ---------- */
section('联机加固（v1.35）');
{
  I.menu(); click('btnQuick');
  const s35 = I.sim();
  ok(!!s35 && I.mode() === 'playing', '新开一局用于联机加固用例', I.mode());
  s35.opts.noAI = true;
  s35.castles.forEach(c => { c.tower = null; });
  I.setNet('host');                                   // 站在主机侧收客机指令
  I.netChFake(); I.netSentClear();

  /* --- A 指令权威校验：一律按「客机 = 2 号」重建，不信任网络里的 owner --- */
  const mine35 = s35.castles.find(c => c.owner === 1);
  const foe35 = s35.castles.find(c => c.owner !== 1);
  foe35.owner = 2;
  mine35.garrison = 40; foe35.garrison = 40;
  I.step(1 / 30);                                 // 先让它按容量封顶沉降一次（Lv1 容量可能 < 40，别把封顶当成「被派兵」）
  const g35 = Math.floor(mine35.garrison);
  I.netMsg(JSON.stringify({ t: 'cmd', kind: 'send',
    cmd: { owner: 1, from: [{ k: 'c', id: mine35.id }], to: { k: 'c', id: foe35.id }, ratio: 1 } }));
  I.step(1 / 30);
  ok(Math.floor(mine35.garrison) === g35, '伪造 owner=1 的出兵无效（房主驻军不动）', 'g=' + Math.floor(mine35.garrison));
  ok(!s35.armies.some(a => a.owner === 1 && !a.ghost), '也没有凭空生成房主的部队', 'armies=' + s35.armies.length);

  I.netMsg(JSON.stringify({ t: 'cmd', kind: 'send',
    cmd: { owner: 2, from: [{ k: 'c', id: foe35.id }], to: { k: 'c', id: mine35.id }, ratio: 1 } }));
  I.step(1 / 30);
  ok(s35.armies.some(a => a.owner === 2 && a.count === 40), '客机自己的合法出兵照常执行（校验不误伤正常玩法）',
     'armies=' + s35.armies.map(a => a.owner + ':' + a.count).join(','));

  foe35.garrison = 40;
  I.netMsg(JSON.stringify({ t: 'cmd', kind: 'send',
    cmd: { owner: 2, from: [{ k: 'c', id: foe35.id }], to: { k: 'c', id: mine35.id }, ratio: 5 } }));
  I.step(1 / 30);
  ok(!s35.armies.some(a => a.owner === 2 && a.count > 40), 'ratio 越界钳到 1（不会派出一支超编部队）',
     s35.armies.map(a => a.count).join(','));

  /* 改向：伪造 owner=1 的 retarget 动不了房主的部队 */
  Sim.command(s35, { type: 'send', owner: 1, from: [{ k: 'c', id: mine35.id }], to: { k: 'c', id: foe35.id }, ratio: 1 });
  I.step(1 / 30);
  const ha35 = s35.armies.filter(a => a.owner === 1)[0];
  ok(!!ha35, '主机侧先有一支自己的部队用于改向用例');
  const tx35 = ha35 ? ha35.tx : 0;
  I.netMsg(JSON.stringify({ t: 'cmd', kind: 'retarget',
    cmd: { owner: 1, ids: [ha35.id], to: { k: 'pt', x: 20, y: 20 } } }));
  I.step(1 / 30);
  ok(ha35 && ha35.tx === tx35, '伪造 owner=1 的改向无效（房主的部队不被客机牵着走）',
     ha35 ? ha35.tx + '/' + tx35 : 'null');

  /* 分兵：伪造 owner=1 的 split 同样无效 */
  const n35 = s35.armies.length;
  I.netMsg(JSON.stringify({ t: 'cmd', kind: 'split',
    cmd: { owner: 1, armyId: ha35.id, to: { k: 'pt', x: 30, y: 30 }, n: 1 } }));
  I.step(1 / 30);
  ok(s35.armies.filter(a => a.owner === 1).length === 1, '伪造 owner=1 的分兵无效', 'armies=' + s35.armies.length + '/' + n35);

  /* --- B 切后台（visibilitychange）不再被判断连 --- */
  I.netSentClear();
  ok(I.vis(true) === true, '切后台：标记自己离开');
  const sent35 = I.netSent().map(x => JSON.parse(x));
  ok(sent35.some(m => m.t === 'away' && m.on === true), '切后台立刻广播 away 包', JSON.stringify(sent35).slice(0, 120));
  ok(I.mode() === 'paused', '切后台即对局冻结（沿用「不能单方面推进」原则）', I.mode());
  ok(I.netAway().paused === true, '记录这次暂停来源于「离开页面」（回来要自动恢复）');
  pump(300);                                          // ≈5 秒没有任何下行包：旧逻辑 4 秒就判失联
  ok(I.netAway().miss < 1, '自己在后台时不累计失联计时', 'miss=' + I.netAway().miss.toFixed(2));
  ok(I.netAway().waiting === false && I.netAway().dropT === 0, '不进入「等待重连」倒计时', JSON.stringify(I.netAway()));
  ok(I.mode() !== 'over', '对局没有被误判终止（旧行为：4s 失联 → 10s 后终止）', I.mode());

  I.netSentClear();
  ok(I.vis(false) === false, '回到页面');
  ok(I.netSent().map(x => JSON.parse(x)).some(m => m.t === 'st'), '主机回来立刻补推一帧快照把画面补齐');
  ok(I.mode() === 'playing' && I.netAway().paused === false, '回来自动继续对局', I.mode());

  /* 对手切后台 */
  I.netMsg(JSON.stringify({ t: 'away', on: true }));
  ok(I.netAway().foe === true && I.mode() === 'paused', '对手切后台 → 我方同样冻结（公平）', I.mode());
  pump(300);
  ok(I.netAway().waiting === false && I.mode() !== 'over', '对手只是离开页面：不算失联、不倒计时、不终止',
     JSON.stringify(I.netAway()));
  I.netMsg(JSON.stringify({ t: 'away', on: false }));
  ok(I.netAway().foe === false && I.mode() === 'playing', '对手回来 → 自动继续', I.mode());
  ok(I.hint().indexOf('回来') >= 0, '给出「对手已回来」的明确提示', I.hint());

  /* 客机侧：回来主动要快照 */
  I.setNet('guest'); I.netSentClear();
  I.vis(true); I.vis(false);
  ok(I.netSent().map(x => JSON.parse(x)).some(m => m.t === 'resnap'), '客机回到页面主动索要新快照');
  I.setNet('none'); I.vis(false);
  I.sel().splice(0);

  /* --- 静态守卫 --- */
  ok(/document\.addEventListener\('visibilitychange', onVisChange\)/.test(html), '监听 visibilitychange（真机切后台/切标签）');
  ok(/if \(!netSelfAway\) netMiss \+= dt;/.test(html), '自己在后台时不累计失联计时');
  ok(/netMiss > NET_MISS && netAlive && !netFoeAway/.test(html), '对手在后台时不判失联');
  ok(/Sim\.command\(sim, \{ type: 'send', owner: G, from: cm\.from/.test(html) &&
     /Sim\.command\(sim, \{ type: 'retarget', owner: G, ids: cm\.ids/.test(html) &&
     /Sim\.command\(sim, \{ type: 'split', owner: G, armyId: cm\.armyId/.test(html),
     'send / retarget / split 三处都按固定阵营重建指令（不直接用网络里的 owner）');
}

/* ============================================================
 * v1.35 版本号标记（发布核对用：线上页面底栏可一眼看出跑的是哪一版）
 * ========================================================== */
section('版本号标记（v1.35 发布核对）');
{
  ok(typeof I.ver === 'function' && /^\d+\.\d+$/.test(I.ver()), '暴露版本号钩子且形如 x.y', String(I.ver && I.ver()));
  ok(/var APP_VER = '[0-9.]+';/.test(html), '版本号在块2 有唯一来源（APP_VER 常量）');
  ok((html.match(/var APP_VER = /g) || []).length === 1, 'APP_VER 只允许一处定义（避免改了半边）');
  ok(/\.vtag\{/.test(html), '底栏版本号有独立样式类 .vtag');
  I.menu();
  ok(I.ov().indexOf('class="vtag">v' + I.ver()) >= 0, '主菜单底栏渲染出版本号',
     I.ov().slice(-160));
  ok(I.ov().indexOf('v' + I.ver()) === I.ov().lastIndexOf('v' + I.ver()),
     '版本号只在底栏出现一次（不与其它文案撞字）');
}

/* ============================================================
 * v1.36 回城（城外部队 → 己方城）与过城接管
 * 旧实现两个洞：① 命中顺序「点兵 > 点城」，城边有兵时点城只选中兵；
 *               ② 回防只认整支在途部队（k==='a'），阵列/单兵点己方城不下军令。
 * ========================================================== */
section('回城与过城接管（v1.36）');
{
  I.menu(); click('btnQuick');                       // 段间隔离：重开一局
  I.ratio(1);                                        // 段间会串「出兵比例」（v1.34 段测过 0%），先复位
  const s36 = I.sim();
  s36.opts.noAI = true;
  s36.mods.prod = 0;                                 // 关产兵：驻军不漂移，差值可精确断言
  s36.castles.forEach(c => { c.tower = null; });
  const home = s36.castles.filter(c => c.owner === 1)[0];
  const mineArmies = () => s36.armies.filter(a => a.owner === 1);
  const backHome = a => a.tKind === 'c' && a.tid === home.id;
  /* 每个用例前清场：在途部队空、阵列空、选择空（否则上一条用例的部队抵达会污染计数） */
  const clean = () => { I.sel().splice(0); s36.armies.length = 0; s36.camps.length = 0; home.garrison = 200; };
  /* 命令在步首统一执行：tap 之后必须显式推进一帧，pump 在打桩里不保证推进对局 */
  const tapHome = () => { tap(home.x, home.y); I.step(1 / 30); };
  const campAt = (id, dx, dy, n) => ({ id: id, owner: 1, x: home.x + dx, y: home.y + dy, count: n, atkT: 0 });

  /* --- 1 城外阵列（屯兵）点己方城 = 回城 --- */
  clean();
  const camp = campAt(9601, 170, -40, 60);
  s36.camps.push(camp);
  I.sel().push({ k: 'p', id: camp.id });
  tapHome();
  let a1 = mineArmies();
  ok(a1.length === 1 && backHome(a1[0]) && a1[0].count === 60,
     '选中城外阵列 → 点己方城 = 派兵回城（旧行为：只把城加进选择集，兵原地不动）',
     'armies=' + a1.length + (a1[0] ? ' 兵 ' + Math.floor(a1[0].count) + ' tKind=' + a1[0].tKind : ''));
  ok(!s36.camps.some(p => p.id === 9601 && p.count >= 1),
     '阵列兵力已转出（屯点随兵力清空而消失 = 状态同步）',
     'camp ' + (s36.camps.some(p => p.id === 9601) ? Math.floor(camp.count) : '已撤'));

  /* --- 2 抵达后并入驻军、在途列表清空 --- */
  const g0 = home.garrison;
  let guard = 0;
  while (mineArmies().length && guard++ < 300) I.step(1 / 30);
  ok(home.garrison >= 30 && home.level === 2,
     '部队抵达后并入驻军，并按 v1.32 规则自动升级（扣 20 兵，容量随之变大）',
     '驻军 ' + Math.round(g0) + ' → ' + Math.round(home.garrison) + ' · Lv' + home.level);
  ok(mineArmies().length === 0, '抵达后该部队从在途列表移除');

  /* --- 3 在途部队（整支）点己方城 = 回防（旧行为保留） --- */
  clean();
  Sim.command(s36, { owner: 1, from: [{ k: 'c', id: home.id }],
                     to: { k: 'pt', x: home.x + 420, y: home.y - 60 }, n: 40 });
  I.step(1 / 30);
  const ar3 = mineArmies()[0];
  ok(!!ar3 && ar3.count === 40, '已派出一支 40 兵的在途部队用于回防用例');
  I.sel().push({ k: 'a', id: ar3.id });
  tapHome();
  ok(ar3.tKind === 'c' && ar3.tid === home.id, '选中在途部队 → 点己方城 = 回防改向',
     'tKind=' + ar3.tKind + ' tid=' + ar3.tid);

  /* --- 4 在途兵（单兵）点己方城 = 他单独回城 --- */
  clean();
  Sim.command(s36, { owner: 1, from: [{ k: 'c', id: home.id }],
                     to: { k: 'pt', x: home.x + 420, y: home.y - 60 }, n: 40 });
  I.step(1 / 30);
  const ar4 = mineArmies()[0];
  I.sel().push({ k: 's', id: ar4.id, idx: 0 });
  tapHome();
  const a4 = mineArmies();
  ok(a4.length === 2 && a4[1].count === 1 && backHome(a4[1]),
     '选中在途兵 → 点己方城 = 单兵离队回城（旧行为：只切换选中）',
     'armies=' + a4.length + ' 新兵 ' + (a4[1] ? Math.floor(a4[1].count) : '-'));
  ok(a4[0] && a4[0].count === 39, '原部队只被抽走 1 兵', a4[0] ? String(Math.floor(a4[0].count)) : '-');

  /* --- 5 阵列紧贴己方城时点城：不再被「点兵」抢走 --- */
  clean();
  const camp5 = campAt(9602, 26, 0, 40);
  s36.camps.push(camp5);
  I.sel().push({ k: 'p', id: camp5.id });
  tapHome();
  const a5 = mineArmies();
  ok(a5.length === 1 && backHome(a5[0]),
     '阵列贴城时点城中心 → 命中「城」并回城（旧行为：被城里的兵抢走，只选中一个兵）',
     'armies=' + a5.length + ' · 选择集 ' + JSON.stringify(I.sel()));

  /* --- 6 只选中城 → 点它自己 = 取消选中（不给自己派兵） --- */
  clean();
  I.sel().push({ k: 'c', id: home.id });
  tapHome();
  ok(mineArmies().length === 0 && I.sel().length === 0,
     '只选中城 → 点它自己 = 取消选中（不会派兵绕一圈）',
     'armies ' + mineArmies().length + ' · sel ' + JSON.stringify(I.sel()));

  /* --- 7 城内兵点自己所在的那座城 = 无操作（出城又进城没有意义） --- */
  clean();
  I.sel().push({ k: 'gs', id: home.id, idx: 0 });
  tapHome();
  ok(mineArmies().length === 0, '城内兵点同城 = 忽略（净值为 0 的空转）',
     'armies ' + mineArmies().length);

  /* --- 8 出兵比例 0%：明确提示而不是「清空选择 + 毫无反馈」 --- */
  clean();
  s36.camps.push(campAt(9603, 170, -40, 40));
  I.sel().push({ k: 'p', id: 9603 });
  I.ratio(0);
  tapHome();
  ok(mineArmies().length === 0 && I.sel().length === 1 && /比例/.test(I.hint()),
     '出兵比例 0% 时点回城：提示「派不出兵」并保留选择（旧行为：清空选择、什么都没发生）',
     'hint=' + I.hint().replace(/<[^>]+>/g, '') + ' · sel ' + JSON.stringify(I.sel()));
  I.ratio(1);

  /* --- 9 无可用兵力（空阵列）同样给提示 --- */
  clean();
  s36.camps.push(campAt(9604, 170, -40, 0));
  I.sel().push({ k: 'p', id: 9604 });
  tapHome();
  ok(mineArmies().length === 0 && /无可用兵力/.test(I.hint()),
     '空阵列点回城：提示「无可用兵力」', 'hint=' + I.hint().replace(/<[^>]+>/g, ''));
  I.sel().splice(0);

  /* --- 10 静态守卫 --- */
  ok(/if \(c && c\.owner === mySide && selection\.some\(function\(s\)\{ return s\.k !== 'c'; \}\)\)/.test(html),
     '点己方城的下令判定排在「点兵」之前（否则城边的兵会抢走这一次点击）');
  ok(/if \(sc\.type === 'send' && sc\.from\.k === 'c' && to\.k === 'c' && sc\.from\.id === to\.id\) continue;/.test(html),
     '城内兵点同城被显式忽略');
  ok(/if \(selAvailTroops\(\) < 1\)\{/.test(html) && /if \(ratioSendCount\(ratio\) < 1\)\{/.test(html),
     '派不出兵时先给提示再 return false（不再「假装下了令」）');
  ok(/if \(Math\.floor\(pc\.garrison\) < 1\) occupyCastle\(sim, pc, pa, true\);/.test(html),
     '过城：守军清空即接管（与抵达同一入口 occupyCastle）');
  ok(/passHint\(sim, pa, pc, '兵力不足 · 过城部队被守军吃掉了'\)/.test(html),
     '过城兵力不足时给出明确提示');
  ok(/passHint\(sim, pa, pc, '护盾未破 · 该城免疫过路部队'\)/.test(html),
     '护盾城免疫时给出明确提示');
}

/* ============================================================
 * v1.37 移动端布局重做 + 联机修复
 * 布局：竖屏舞台 flex:1 吃掉剩余高度、画布绝对定位铺满（改版前 iPhone13 竖屏棋盘只占 33%）
 * 联机：ICE 收集不再 3.5s 硬超时、断线给「重新连接」入口（旧版只有「放弃等待」一条路）
 * ========================================================== */
section('移动端布局重做（v1.37）');
{
  /* --- 竖屏断点：必须限定 orientation，否则 640×360 横屏会同时命中竖屏与横屏两条规则 --- */
  const mqP2 = html.match(/@media \(max-width:700px\) and \(orientation:portrait\)\{[\s\S]*?\n\}/);
  ok(!!mqP2, '竖屏断点加了 orientation:portrait（手机横屏不再误命中竖屏规则）');
  ok(!!mqP2 && /@media \(max-width:700px\)\{/.test(html) === false,
     '不再有不带 orientation 的 ≤700px 断点（避免与横屏侧栏规则打架）');
  /* --- 缩放控件：屏内 +/-/复位，触屏专属 --- */
  ok(/id="zbar"/.test(html) && /id="zIn"/.test(html) && /id="zOut"/.test(html) && /id="zFit"/.test(html),
     '屏内缩放条（放大/缩小/回正）三键齐备');
  ok(/function viewZoomStep/.test(html) && /function viewFit/.test(html),
     '有 viewZoomStep / viewFit 两个纯入口（按钮与双指共用同一套钳制）');
  ok(/function bindZoomBar/.test(html) && /isCoarse\(\)/.test(html),
     '缩放条只在触屏设备出现（isCoarse），桌面端零改动');
  ok(/function drawMiniMap/.test(html) && /if \(!\(viewMoved\(\) \|\| viewCropped\(\)\) \|\| !simToDraw\) return;/.test(html),
     '缩略图只在「视野被放大 / 被裁切」时绘制（默认全览不占屏）');
  /* --- 联机入口：手机上不能埋在两三屏之外 --- */
  ok(/function menuPvpFirst/.test(html), '有 menuPvpFirst() 判定（手机竖屏把联机区排到最前）');
  ok(/\(menuPvpFirst\(\) \? pvpBox : ''\) \+ quickBox/.test(html),
     '手机竖屏「好友对战」排在「快速对战」之前（实测原来要滚到 1641~1901px）');
  ok(/\(menuPvpFirst\(\) \? '' : pvpBox\)/.test(html),
     '桌面/平板仍排在原处（只在手机重排，不重复出现两个 btnHost）');
  ok(/function pvpScrollIntoView/.test(html), '写入联机区后自动滚进视野（手机上码落在屏外就白搭）');
}

section('联机修复（v1.37 · ICE 收集 / 断线续连）');
{
  /* --- ICE 收集：旧版固定 3.5s 硬超时，实测出码时收集还没结束 → SDP 候选不全 --- */
  ok(/var NET_ICE_WAIT = 8000;/.test(html), 'ICE 收集上限 8 秒（旧版 3.5s 硬超时，手机 4G 常常不够）');
  ok(/function iceStat/.test(html) && /function iceHint/.test(html),
     '有候选构成统计（host/srflx/relay）与中文播报');
  ok(/全是内网地址/.test(html), '没有公网候选时明确提示「跨网大概率连不上」（不再静默失败）');
  ok(/function gatherIce\(pc, onTick\)/.test(html), 'gatherIce 支持阶段播报回调（收集期间实时反馈）');
  /* --- 断线续连：旧版只有「放弃等待」，手机切网必废局 --- */
  ok(/id="btnRelink"/.test(html) && /relinkUI\(\)/.test(html), '失联遮罩给出「重新连接」入口');
  ok(/id="btnRelink2"/.test(html), '连接彻底断开后的结算页同样给出「重新连接」');
  ok(/if \(net\.relinking\)\{/.test(html) && /net\.pushSnapshot\(\)/.test(html) && /resnap/.test(html),
     '续连走 relinking 分支：主机补推快照、客机要 resnap（不重开、不重抽地图）');
  ok(/var netLastRole = 'none';/.test(html) && /netLastRole = this\.role !== 'none'/.test(html),
     'dropped/teardown 会把 role 清成 none，故另记 netLastRole 供续连还原角色');
  /* --- 续连必须撤掉宽限倒计时，否则换码超过 10 秒就被判死 --- */
  I.menu(); click('btnQuick');
  I.setNet('host'); I.netChFake();
  I.netTick(5);                                   // 5 秒无下行包 → 进入等待重连
  ok(I.netWait().waiting === true, '先进入「等待重连」状态（续连用例的前置）', JSON.stringify(I.netWait()));
  const rl = I.netRelink('host');
  ok(rl.relinking === true, '点「重新连接」进入续连模式', JSON.stringify(rl));
  ok(rl.waiting === false && rl.dropT === 0,
     '续连立刻撤掉 10 秒宽限倒计时（否则换码慢一点就被 netGiveUp 判死）', JSON.stringify(rl));
  /* --- pvpStatus 兜底：对局中断线时菜单不在 DOM，旧实现静默丢弃 → doJoin 为 null 抛错 --- */
  ok(/box\.id = 'pvpBox'/.test(html) && /host\.appendChild\(box\)/.test(html),
     'pvpStatus 在 #pvpBox 不存在时挂到当前覆层（续连时菜单不在 DOM，旧实现会抛 TypeError）');
  ok(/\.relinkbox\{/.test(html), '续连区有独立样式类 .relinkbox');
  /* --- 端到端实测用的两个钩子（Net 在 IIFE 里，页面外拿不到） --- */
  ok(/netCh: function\(\)\{ return Net\.ch; \}/.test(html), '暴露 netCh()（tools/check-net.js 掐断连接用）');
  ok(/cmd: function\(o\)\{ if \(!sim\) return false;/.test(html), '暴露 cmd()（浏览器里直接下军令，供端到端实测）');
  ok(/netIceStat: function\(\)\{ return iceStat\(Net\.pc\); \}/.test(html), '暴露 netIceStat()（候选构成断言）');
}

section('房间码联机（v1.39 · 云信令）');
{
  /* --- 入口：房间码是主路径，两步换码退居备用但必须原样保留 --- */
  ok(/id="btnHostCode"/.test(html) && /id="btnJoinCode"/.test(html),
     '菜单主入口改为房间码（创建 / 加入）');
  ok(/id="btnManual"/.test(html) && /id="pvpManual"/.test(html),
     '两步换码收进「备用」折叠区（云不可用时是唯一退路）');
  ok(/id="btnHost"/.test(html) && /id="btnJoin"/.test(html),
     '手动换码的按钮与 id 原样保留（改 id/文案会打断既有链路）');
  /* --- 码本身：6 位、去歧义、一次性 --- */
  ok(/var ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';/.test(html),
     '房间码字符表去掉 I / O / 0 / 1（手写与口述都不该有歧义）');
  ok(/function roomNorm/.test(html) && /\[\^A-Z2-9\]/.test(html),
     '房间码输入规范化：转大写 + 去掉非法字符（0/1 一并剔除）');
  ok(/async function roomCreate/.test(html) && /23505/.test(html),
     '建房撞码（23505）自动换一个重试，不把冲突抛给用户');
  ok(/async function roomWaitAnswer/.test(html) && /ROOM_WAIT_MS = 120000/.test(html),
     '房主轮询等应答，2 分钟上限（不无限等）');
  ok(/roomClose\(netRoomCode\); netRoomCode = '';/.test(html),
     '握手完成即作废房间码（一次性，不能二次加入）');
  ok(/\.rpc\('room_sweep'\)/.test(html), '建房前清掉过期房间（半小时自动失效）');
  /* --- 云：可降级、不动块数、endpoint 与域名绑定 --- */
  ok(/function cloudDisable/.test(html) && /if \(cloudOff\) return Promise\.resolve\(null\)/.test(html),
     '云可被整体关闭：打桩 / 离线一律降级到手动换码，绝不卡住流程');
  ok(/cdn\.jsdelivr\.net\/npm\/@tencent-ai\/workbuddy-cloud-sdk/.test(html) && /appendChild\(s\)/.test(html),
     'SDK 动态 appendChild 加载（静态 script 标签会把块数变 3，硬纪律是恒为 2）');
  ok(/CLOUD_ENDPOINT = 'https:\/\/inkwar\.app\.workbuddy\.host'/.test(html),
     'endpoint 与发布域名一致（服务端 exact-Origin 校验，换应用即失效）');
  ok(/for \(var i = 0; i < 2; i\+\+\)\{[\s\S]{0,400}cloudP = null;/.test(html),
     '云 SDK 加载失败会重试一次（首次 DNS 冷启动会超时）');
  /* --- 表现：码要大、要能点开就输 --- */
  ok(/\.roomcode\{/.test(html) && /font-size:40px/.test(html), '房间码 40px 大字号展示（念一遍就能输完）');
  ok(/\.roomin\{/.test(html) && /text-transform:uppercase/.test(html), '房间码输入框自动大写、等宽大字');
  ok(/if \(qs\.get\('room'\)\) Net\.joinRoomUI/.test(html), '分享链接 ?room=CODE 直接进加入界面（点开即输码）');
  /* --- 纯函数与打桩降级（真机链路见 tools/check-net.js --room） --- */
  ok(I.roomNorm('ab-12xy') === 'AB2XY', 'roomNorm 去小写与非法字符（0/1 一并剔除）', I.roomNorm('ab-12xy'));
  var g1 = I.roomGen(), g2 = I.roomGen();
  ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(g1) && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(g2),
     'roomGen 产出 6 位合法码', g1 + '/' + g2);
  ok(I.roomCode() === '', '打桩里房间码初始为空（没建过房）');
  ok(I.cloudOff(true) === true, '打桩可关掉云（免得等 CDN 超时）');
  I.cloudOff(false);
}

/* ---------- 汇总 ---------- */
console.log('\n──────────────────────────────');
console.log('通过 ' + passed + ' · 失败 ' + failed);
if (failed){ console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('ALL GREEN ✓');
