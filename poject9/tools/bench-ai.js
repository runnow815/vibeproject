#!/usr/bin/env node
/**
 * 海盗军团抢宝藏 · AI 智能水平基准测试（无头）
 *
 * 用法:
 *   node tools/bench-ai.js                       # 全量基线（15 关 × 3 档 × 3 种子）
 *   node tools/bench-ai.js --levels=0,5,10       # 只跑指定关卡
 *   node tools/bench-ai.js --seeds=1 --verbose   # 逐场明细
 *   node tools/bench-ai.js --patch=unit-hp       # 加载实验补丁后重测（A/B）
 *   node tools/bench-ai.js --json=out.json       # 同时落 JSON
 *
 * 设计要点:
 *   1. 与 verify-mutiny.js 相同的文本抽取 + 注入 + mock 环境，零依赖。
 *   2. 伤害统计不靠"血条前后差"，而是在 hurt() 里插入一行日志——
 *      精确到每一次伤害事件的归属队伍与数值，避免把火焰/岩浆/落水误算成命中。
 *   3. 两套实验：
 *        Set A（signal）对手站桩：只测 E 队自身的命中率/伤害效率/空回合率/误伤，
 *                            排除对手强度对指标的干扰。
 *        Set B（duel）  对手为网格参照策略（同一套弹道搜索、零瞄准误差、优先残血）：
 *                            测 E 队胜率与对局长度，反映决策质量。
 *   4. 只读 mutiny.html，任何实验性改动都只作用在内存中的源码字符串上。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const flag = k => argv.includes('--' + k);
const SEEDS = parseInt(arg('seeds', '3'), 10);
const VERBOSE = flag('verbose');
const JSONOUT = arg('json', null);
const PATCH = arg('patch', null);
const LEVELS_ARG = arg('levels', null);
const ONLY = arg('only', 'ABC'); // 只跑某几组实验，例如 --only=A（消融实验用）

const html = fs.readFileSync(path.join(__dirname, '..', 'mutiny.html'), 'utf8');
const mm = html.match(/<script>([\s\S]*)<\/script>/);
if (!mm) { console.error('FATAL: 未找到 <script> 块'); process.exit(1); }
let src = mm[1];

/* ---------- 实验补丁（只改内存源码，不动磁盘文件） ---------- */
const PATCHES = require('./bench-patches.js');
if (PATCH) {
  if (!PATCHES[PATCH]) {
    console.error('FATAL: 未知补丁 ' + PATCH + '；可用: ' + Object.keys(PATCHES).join(', '));
    process.exit(1);
  }
  const before = src;
  src = PATCHES[PATCH](src);
  if (src === before) { console.error('FATAL: 补丁 ' + PATCH + ' 未命中任何代码片段'); process.exit(1); }
  console.log('已加载实验补丁: ' + PATCH);
}

/* ---------- 伤害事件埋点（在护盾吸收之后，记录实际扣血） ---------- */
const HOOK_FROM = `  if(dmg<=0){ u.flash=Math.max(u.flash||0,.5); return; }
  u.hp-=dmg; u.flash=1;`;
const HOOK_TO = `  if(dmg<=0){ u.flash=Math.max(u.flash||0,.5); return; }
  if(globalThis.__HIT)globalThis.__HIT.push({team:u.t,dmg:dmg});
  u.hp-=dmg; u.flash=1;`;
if (src.indexOf(HOOK_FROM) < 0) { console.error('FATAL: hurt() 埋点锚点未找到'); process.exit(1); }
src = src.replace(HOOK_FROM, HOOK_TO);

/* ---------- 死亡事件埋点（区分落水/被击杀） ---------- */
const DEATH_FROM = `  u.alive=false; u.hp=0;
  if(drown){ splashFx(u.x); float(u.x,u.y-40,'落水!','#7fd0ff'); }`;
const DEATH_TO = `  u.alive=false; u.hp=0;
  if(globalThis.__DEATH)globalThis.__DEATH.push({team:u.t,drown:!!drown});
  if(drown){ splashFx(u.x); float(u.x,u.y-40,'落水!','#7fd0ff'); }`;
if (src.indexOf(DEATH_FROM) < 0) { console.error('FATAL: killUnit() 埋点锚点未找到'); process.exit(1); }
src = src.replace(DEATH_FROM, DEATH_TO);

/* ---------- 爆炸点埋点（用于"预测落点 vs 实际落点"的模型保真度实验） ---------- */
const BOOM_FROM = `function explode(x,y,r,dmg,team,mul){
  mul=mul||1;`;
const BOOM_TO = `function explode(x,y,r,dmg,team,mul){
  mul=mul||1;
  if(globalThis.__BOOM)globalThis.__BOOM.push({x:x,y:y});`;
if (src.indexOf(BOOM_FROM) < 0) { console.error('FATAL: explode() 埋点锚点未找到'); process.exit(1); }
src = src.replace(BOOM_FROM, BOOM_TO);

/* ---------- 调试导出 ---------- */
src = src.replace('/* ---------- 启动 ---------- */',
`globalThis.__DBG={G,LEVELS,WP,ITEM_DEF,DIFF,alive,startLevel,endTurn,fireDrag,fireClick,
fireVoodoo,throwSelf,update,simShot,slingDir,surfaceY,solidAt,canMove,setRng,resetRng,
waterY,aiAct,aiChoose,aiMove,hurt,collectItem,recordWin,save,loadSave,stepProj,stepFlying,explode,
MAXPOW,POW2V,UNIT_R,GRAV,WATER,clamp,dist,rnd,rndi};
/* ---------- 启动 ---------- */`);

/* ---------- 浏览器环境 mock（与 verify-mutiny.js 同源） ---------- */
function makeCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return {};
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      return typeof t[k] !== 'undefined' ? t[k] : (() => {});
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function fakeCanvas() {
  const c = {
    width: 0, height: 0, style: {},
    getContext: () => makeCtx(),
    addEventListener: () => {},
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect() {
      const w = parseFloat(c.style.width) || 960, h = parseFloat(c.style.height) || 560;
      return { left: 0, top: 0, width: w, height: h, right: w, bottom: h };
    },
  };
  return c;
}
const ELS = {};
global.window = { addEventListener() {}, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, AudioContext: undefined };
global.document = { getElementById: id => (ELS[id] || (ELS[id] = fakeCanvas())), createElement: () => fakeCanvas() };
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => {};
global.localStorage = (() => {
  const mem = new Map();
  return {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
    clear: () => mem.clear(), key: i => Array.from(mem.keys())[i] || null,
    get length() { return mem.size; },
  };
})();
global.__HIT = null;

try { eval(src); } catch (e) { console.error('FATAL: 脚本加载失败:', e.message); process.exit(1); }
const D = globalThis.__DBG;
if (!D) { console.error('FATAL: 调试导出失败'); process.exit(1); }

/* ---------- 确定性随机 ---------- */
function seedRng(seed) {
  let s = seed >>> 0;
  D.setRng(() => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; });
}

/* ---------- 参照策略：网格弹道搜索 + 优先残血，零瞄准误差 ----------
   与游戏内 AI 的区别刻意只在"决策"层面：同一套 simShot、同一套发射 API。
   它不用随机数，因此同一局面每次决策一致。 */
function refPolicy() {
  const me = D.alive('P').filter(u => !(u.frozen > 0));
  const foes = D.alive('E');
  if (!me.length || !foes.length) { D.endTurn(); return; }
  const foe = foes.slice().sort((a, b) => a.hp - b.hp)[0];
  let best = null;
  for (const u of me) {
    for (const wx of Object.keys(u.w)) {
      if (!u.w[wx]) continue;
      const def = D.WP[wx];
      if (def.aim === 'unit') {
        const d = D.dist(u.x, u.y, foe.x, foe.y);
        if (!best || d < best.d) best = { u, wx, d, type: 'voodoo' };
        continue;
      }
      if (def.aim === 'click' || def.kind === 'shot') continue; // 参照策略只用抛射类
      for (let a2 = 25; a2 <= 155; a2 += 12) {
        const a = a2 * Math.PI / 180;
        for (let pw = .35; pw <= 1.001; pw += .12) {
          const v = pw * D.MAXPOW * D.POW2V;
          const r = D.simShot(u.x, u.y - 26, Math.cos(a) * v, -Math.sin(a) * v, 'P');
          const d = D.dist(r.x, r.y, foe.x, foe.y - 14);
          if (!best || d < best.d) best = { u, wx, a, pw, d, type: 'lob' };
        }
      }
    }
  }
  if (!best) { D.endTurn(); return; }
  const u = best.u;
  if (best.type === 'voodoo') {
    D.G.voodoo = foe;
    const dx = foe.x - u.x, dy = (foe.y - 14) - (u.y - 30), dd = Math.max(20, Math.hypot(dx, dy));
    D.fireVoodoo('P', u, u.x - dx / dd * 80, (u.y - 30) - dy / dd * 80);
    D.G.voodoo = null;
    return;
  }
  const tx = u.x - Math.cos(best.a) * best.pw * D.MAXPOW;
  const ty = (u.y - 30) + Math.sin(best.a) * best.pw * D.MAXPOW;
  D.fireDrag('P', u, best.wx, tx, ty);
}

/* ---------- 单场对局 ---------- */
function runMatch(opt) {
  const { lv, diff, seed, opponent, maxTurns } = opt;
  D.startLevel(lv);
  D.G.mode = '1p';
  D.G.difficulty = diff;
  D.G.turnTeam = 'P';
  D.G.phase = 'input';
  seedRng(seed);
  global.__HIT = [];
  global.__DEATH = global.__DEATH || [];

  const st = {
    lv, diff, seed, opponent,
    turns: 0, frames: 0,
    eShots: 0, eHits: 0, eDmg: 0, eFriendly: 0, eSkip: 0,
    eMoves: 0, eAttacks: 0, wx: {}, wxHit: {},
    pShots: 0, pHits: 0, pDmg: 0, pFriendly: 0,
    eDeaths: 0, eDrown: 0, pDeaths: 0, pDrown: 0,
    eDecideMs: 0, result: 'timeout',
  };
  const deaths0 = global.__DEATH.length;

  const hpBefore = hitLen => global.__HIT.slice(hitLen).reduce((s, h) => s + h.dmg, 0);

  while (D.G.screen === 'play' && st.frames < 120000 && st.turns < maxTurns) {
    // ---- 玩家方回合 ----
    if (D.G.phase === 'input' && D.G.turnTeam === 'P') {
      st.turns++;
      if (opponent === 'idle') { D.endTurn(); }
      else {
        const n0 = global.__HIT.length;
        const projs0 = D.G.projs.length, fly0 = D.G.units.filter(u => u.t === 'P' && u.fly).length;
        refPolicy();
        const shot = D.G.projs.length > projs0 || D.G.units.some(u => u.t === 'P' && u.fly) && !fly0;
        if (shot) st.pShots++;
        let g = 0;
        while (D.G.phase === 'resolve' && g++ < 1200) { D.update(1 / 60); st.frames++; }
        if (shot) {
          const ev = global.__HIT.slice(n0);
          const dmgToE = ev.filter(h => h.team === 'E').reduce((s, h) => s + h.dmg, 0);
          st.pDmg += dmgToE;
          st.pFriendly += ev.filter(h => h.team === 'P').reduce((s, h) => s + h.dmg, 0);
          if (dmgToE > 0) st.pHits++;
        }
      }
      continue;
    }
    // ---- AI 回合 ----
    if (D.G.phase === 'ai') {
      const n0 = global.__HIT.length;
      const projs0 = D.G.projs.length, mines0 = D.G.mines.length;
      const fly0 = D.G.units.filter(u => u.t === 'E' && u.fly).length;
      D.G.aiTimer = 0;
      const t0 = process.hrtime.bigint();
      D.update(1 / 60);
      st.eDecideMs += Number(process.hrtime.bigint() - t0) / 1e6;
      st.frames++;
      const moved = D.G.resolveKind === 'move';
      const newProj = D.G.projs.length > projs0 ? D.G.projs[D.G.projs.length - 1] : null;
      const newMine = D.G.mines.length > mines0;
      const shot = !!newProj || newMine || (D.G.units.some(u => u.t === 'E' && u.fly) && !fly0);
      let usedWx = null;
      if (shot) {
        st.eShots++;
        usedWx = newMine ? 'mine' : (newProj ? newProj.wx : 'move');
        st.wx[usedWx] = (st.wx[usedWx] || 0) + 1;
        if (moved) st.eMoves++; else st.eAttacks++;
      } else st.eSkip++;
      let g = 0;
      while (D.G.phase === 'resolve' && g++ < 1200) { D.update(1 / 60); st.frames++; }
      if (shot) {
        const ev = global.__HIT.slice(n0);
        const dmgToP = ev.filter(h => h.team === 'P').reduce((s, h) => s + h.dmg, 0);
        st.eDmg += dmgToP;
        st.eFriendly += ev.filter(h => h.team === 'E').reduce((s, h) => s + h.dmg, 0);
        if (dmgToP > 0) {
          st.eHits++;
          st.wxHit[usedWx] = (st.wxHit[usedWx] || 0) + 1;
        }
      }
      continue;
    }
    D.update(1 / 60);
    st.frames++;
  }

  for (const d of global.__DEATH.slice(deaths0)) {
    if (d.team === 'E') { st.eDeaths++; if (d.drown) st.eDrown++; }
    else { st.pDeaths++; if (d.drown) st.pDrown++; }
  }

  // screen==='win' 表示"玩家方获胜"（endTurn 里 ne===0 就走这个分支），即 E 被全歼
  st.result = D.G.screen === 'lose' ? 'E_win' : (D.G.screen === 'win' ? 'P_win' : 'timeout');
  st.eLeft = D.alive('E').length;
  st.pLeft = D.alive('P').length;
  global.__HIT = null;
  return st;
}

/* ---------- 汇总 ---------- */
function agg(rows) {
  const s = { n: rows.length, eShots: 0, eHits: 0, eDmg: 0, eFriendly: 0, eSkip: 0, eDecideMs: 0, turns: 0, eWin: 0, pWin: 0, timeout: 0,
              eMoves: 0, eAttacks: 0, eDeaths: 0, eDrown: 0, pDeaths: 0, pDrown: 0, wx: {}, wxHit: {} };
  for (const r of rows) {
    s.eShots += r.eShots; s.eHits += r.eHits; s.eDmg += r.eDmg;
    s.eFriendly += r.eFriendly; s.eSkip += r.eSkip; s.eDecideMs += r.eDecideMs;
    s.turns += r.turns;
    s.eMoves += r.eMoves; s.eAttacks += r.eAttacks;
    s.eDeaths += r.eDeaths; s.eDrown += r.eDrown; s.pDeaths += r.pDeaths; s.pDrown += r.pDrown;
    for (const k in r.wx) s.wx[k] = (s.wx[k] || 0) + r.wx[k];
    for (const k in r.wxHit) s.wxHit[k] = (s.wxHit[k] || 0) + r.wxHit[k];
    if (r.result === 'E_win') s.eWin++; else if (r.result === 'P_win') s.pWin++; else s.timeout++;
  }
  const pct = (a, b) => b ? (a / b * 100) : 0;
  return {
    n: s.n,
    hitRate: pct(s.eHits, s.eShots),
    attackHitRate: pct(s.eHits, s.eAttacks),
    dmgPerShot: s.eShots ? s.eDmg / s.eShots : 0,
    moveShare: pct(s.eMoves, s.eShots),
    skipRate: pct(s.eSkip, s.eShots + s.eSkip),
    friendlyShare: (s.eDmg + s.eFriendly) ? pct(s.eFriendly, s.eDmg + s.eFriendly) : 0,
    decideMs: s.eShots + s.eSkip ? s.eDecideMs / (s.eShots + s.eSkip) : 0,
    turns: s.n ? s.turns / s.n : 0,
    eWinRate: pct(s.eWin, s.n), pWinRate: pct(s.pWin, s.n), timeoutRate: pct(s.timeout, s.n),
    eDrownShare: pct(s.eDrown, s.eDeaths),
    eDeathsPerMatch: s.n ? s.eDeaths / s.n : 0,
    raw: s,
  };
}
const f2 = v => (Math.round(v * 100) / 100).toFixed(2);
const f1 = v => (Math.round(v * 10) / 10).toFixed(1);
const f0 = v => Math.round(v).toString();
const pad = (s, n) => String(s).padStart(n);

/* ---------- Set C：弹道模型保真度（simShot 预测落点 vs 实际落点） ----------
   这是"理解准确性"的隔离测量：不掺瞄准误差、不掺决策，只问
   "AI 脑内那套物理模型与真实物理差多少"。 */
function modelFidelity(lvIndex) {
  const WEAPONS = ['cherry', 'dyn', 'boulder', 'coin', 'rum', 'banana', 'chute', 'cannon'];
  const res = {};
  for (const wx of WEAPONS) {
    const errs = [];
    for (let a2 = 35; a2 <= 145; a2 += 18) {
      for (let pw = .45; pw <= 1.001; pw += .27) {
        D.startLevel(lvIndex);
        D.G.mode = '1p';
        D.G.difficulty = 'normal';
        const u = D.alive('E')[0];
        if (!u) continue;
        u.w[wx] = Infinity;
        const a = a2 * Math.PI / 180;
        const v = pw * D.MAXPOW * D.POW2V;
        // 预测：AI 用的正是这一句
        const pred = D.simShot(u.x, u.y - 26, Math.cos(a) * v, -Math.sin(a) * v, 'E');
        // 实际：走真实 stepProj
        global.__BOOM = [];
        const tx = u.x - Math.cos(a) * pw * D.MAXPOW;
        const ty = (u.y - 30) + Math.sin(a) * pw * D.MAXPOW;
        D.fireDrag('E', u, wx, tx, ty);
        let guard = 0;
        let last = { x: pred.x, y: pred.y };
        while (D.G.projs.some(p => p.alive) && guard++ < 4000) {
          for (const p of D.G.projs) if (p.alive) { D.stepProj(p, 1 / 60); last = { x: p.x, y: p.y }; if (!p.alive) break; }
          D.G.projs = D.G.projs.filter(p => p.alive);
        }
        const act = global.__BOOM.length ? global.__BOOM[0] : last;
        errs.push(D.dist(pred.x, pred.y, act.x, act.y));
      }
    }
    const mean = errs.reduce((a, b) => a + b, 0) / (errs.length || 1);
    const sorted = errs.slice().sort((a, b) => a - b);
    res[wx] = { n: errs.length, mean, p90: sorted[Math.floor(sorted.length * .9)] || 0, max: sorted[sorted.length - 1] || 0 };
  }
  return res;
}

/* ---------- 主流程 ---------- */
const LEVELS = LEVELS_ARG ? LEVELS_ARG.split(',').map(Number) : D.LEVELS.map((_, i) => i);
const DIFFS = ['easy', 'normal', 'hard'];
const MAXTURNS = 200;
const out = { patch: PATCH, seeds: SEEDS, signal: {}, duel: {}, perLevel: {} };

console.log('\n===== Set A 信号实验：对手站桩，测 E 队自身效率 =====');
console.log('难度    发射  攻击  移动  攻击命中率  伤害/发  空回合率  误伤占比  落水死亡  决策ms  回合  E胜');
for (const diff of DIFFS) {
  let all = [];
  for (const lv of LEVELS) {
    const rows = [];
    for (let s = 1; s <= SEEDS; s++) rows.push(runMatch({ lv, diff, seed: s * 7919 + lv * 31, opponent: 'idle', maxTurns: MAXTURNS }));
    const a = agg(rows);
    all = all.concat(rows);
    out.perLevel[`${lv}/${diff}`] = a;
    if (VERBOSE) console.log(`  L${lv + 1} ${diff}: 发${a.raw.eShots} 攻${a.raw.eAttacks} 移${a.raw.eMoves} 命中${f1(a.attackHitRate)}% 伤害${f2(a.dmgPerShot)} 空${f1(a.skipRate)}% 误伤${f1(a.friendlyShare)}% 溺${a.raw.eDrown}/${a.raw.eDeaths} ${f1(a.decideMs)}ms ${f0(a.turns)}回合 E胜${a.raw.eWin} 残${rows.map(r => r.pLeft + ':' + r.eLeft).join(',')}`);
  }
  const a = agg(all);
  out.signal[diff] = a;
  console.log(`${diff.padEnd(7)} ${pad(a.raw.eShots, 5)} ${pad(a.raw.eAttacks, 5)} ${pad(a.raw.eMoves, 5)} ${pad(f1(a.attackHitRate) + '%', 10)} ${pad(f2(a.dmgPerShot), 8)} ${pad(f1(a.skipRate) + '%', 9)} ${pad(f1(a.friendlyShare) + '%', 9)} ${pad(a.raw.eDrown + '/' + a.raw.eDeaths, 9)} ${pad(f1(a.decideMs), 7)} ${pad(f0(a.turns), 5)} ${pad(a.raw.eWin + '/' + a.n, 6)}`);
}

/* ---------- 武器使用分布 ---------- */
console.log('\n===== E 队武器使用分布与命中（Set A 合计） =====');
for (const diff of DIFFS) {
  const wx = out.signal[diff].raw.wx;
  const wxh = out.signal[diff].raw.wxHit;
  const tot = Object.values(wx).reduce((a, b) => a + b, 0) || 1;
  const list = Object.entries(wx).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${f1(v / tot * 100)}%(命中${f1((wxh[k] || 0) / v * 100)}%)`).join(' · ');
  console.log(`${diff.padEnd(7)} ${list}`);
}

/* ---------- Set C：弹道模型保真度 ---------- */
if (ONLY.includes('C')) {
console.log('\n===== Set C 弹道模型保真度（simShot 预测落点 vs 实际落点，单位 px） =====');
console.log('武器      样本  平均误差   P90   最大   评价');
const fid = modelFidelity(LEVELS[0]);
out.fidelity = fid;
for (const [k, v] of Object.entries(fid)) {
  const verdict = v.mean < 6 ? '一致（可直接信任）' : (v.mean < 30 ? '偏短/偏长，需修正' : '模型失效（预测无意义）');
  console.log(`${k.padEnd(9)} ${pad(v.n, 4)} ${pad(f2(v.mean), 9)} ${pad(f2(v.p90), 6)} ${pad(f2(v.max), 6)}   ${verdict}`);
}
}

if (ONLY.includes('B')) {
console.log('\n===== Set B 对抗实验：对手为网格参照策略（零瞄准误差） =====');
console.log('难度    E胜率   对手胜率  超时   平均回合  E决策ms');
for (const diff of DIFFS) {
  let all = [];
  for (const lv of LEVELS) {
    const rows = [];
    for (let s = 1; s <= SEEDS; s++) rows.push(runMatch({ lv, diff, seed: s * 104729 + lv * 37, opponent: 'ref', maxTurns: MAXTURNS }));
    all = all.concat(rows);
  }
  const a = agg(all);
  out.duel[diff] = a;
  console.log(`${diff.padEnd(6)} ${pad(f1(a.eWinRate) + '%', 7)} ${pad(f1(a.pWinRate) + '%', 9)} ${pad(f1(a.timeoutRate) + '%', 6)} ${pad(f1(a.turns), 8)} ${pad(f1(a.decideMs), 8)}`);
}
}

/* ---------- 目标检查（--assert）：把方案里的量化目标变成可执行门禁 ----------
   默认只报告，加 --strict 才以非零码退出，便于在改造过程中做"进度表"用。 */
if (flag('assert')) {
  const TARGET = {
    easy:   { hitRate: 15, dmgPerShot: 5,  friendlyShare: 8, cherry: 70, skip: 5,  decideMs: 10 },
    normal: { hitRate: 35, dmgPerShot: 12, friendlyShare: 5, cherry: 60, skip: 3,  decideMs: 10 },
    hard:   { hitRate: 45, dmgPerShot: 14, friendlyShare: 5, cherry: 60, skip: 3,  decideMs: 14 },
  };
  console.log('\n===== 目标检查（docs/AI-IMPROVEMENT.md §3.5） =====');
  let bad = 0;
  for (const diff of DIFFS) {
    const a = out.signal[diff], t = TARGET[diff];
    const wxTot = Object.values(a.raw.wx).reduce((x, y) => x + y, 0) || 1;
    const cherry = (a.raw.wx.cherry || 0) / wxTot * 100;
    const rows = [
      ['攻击命中率 ≥' + t.hitRate + '%', a.attackHitRate, a.attackHitRate >= t.hitRate],
      ['伤害/发 ≥' + t.dmgPerShot, a.dmgPerShot, a.dmgPerShot >= t.dmgPerShot],
      ['误伤占比 ≤' + t.friendlyShare + '%', a.friendlyShare, a.friendlyShare <= t.friendlyShare],
      ['樱桃占比 ≤' + t.cherry + '%', cherry, cherry <= t.cherry],
      ['空回合率 ≤' + t.skip + '%', a.skipRate, a.skipRate <= t.skip],
      ['决策耗时 ≤' + t.decideMs + 'ms', a.decideMs, a.decideMs <= t.decideMs],
    ];
    for (const [name, v, pass] of rows) {
      if (!pass) bad++;
      console.log(`  ${pass ? '达标' : '未达标'}  ${diff.padEnd(6)} ${name.padEnd(22)} 实测 ${f1(v)}`);
    }
  }
  if (out.fidelity) {
    // cannon 不参与此项：AI 对它走 shotAim() 解析解，从不调用 simShot，
    // 它的实测误差仅作"若误用 simShot 会有多离谱"的对照，不作为验收项。
    const LIMIT = { cherry: 8, rum: 8, dyn: 15, banana: 15, boulder: 15, coin: 40, chute: 25 };
    for (const [k, v] of Object.entries(out.fidelity)) {
      const lim = LIMIT[k];
      if (lim == null) continue;
      const pass = v.mean <= lim;
      if (!pass) bad++;
      console.log(`  ${pass ? '达标' : '未达标'}  保真度  ${k.padEnd(8)} 平均误差 ≤${lim}px   实测 ${f2(v.mean)}px`);
    }
  }
  console.log(bad ? `\n合计未达标 ${bad} 项` : '\n全部达标');
  if (bad && flag('strict')) process.exit(1);
}

if (JSONOUT) {
  const strip = o => JSON.parse(JSON.stringify(o, (k, v) => k === 'raw' ? undefined : v));
  fs.writeFileSync(path.join(__dirname, '..', JSONOUT), JSON.stringify({
    patch: out.patch, seeds: out.seeds, levels: LEVELS,
    signal: strip(out.signal), duel: strip(out.duel),
  }, null, 2));
  console.log('\nJSON 已写入 ' + JSONOUT);
}
