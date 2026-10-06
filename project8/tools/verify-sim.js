#!/usr/bin/env node
/* 墨战 · 模拟核心无头验证
 * 用法：node tools/verify-sim.js
 * 从 inkwar.html 提取第一个 <script>（纯逻辑块）执行，对模拟内核做不变量与行为断言。
 * 单元测试一律 noAI:true 隔离 AI 干扰；完整对局测试开启 AI。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- 提取逻辑块 ---------- */
const html = fs.readFileSync(path.join(__dirname, '..', 'inkwar.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('FATAL: 未找到逻辑 script 块'); process.exit(1); }
const Sim = new Function('module', m[1] + '\nreturn module.exports;')({ exports: {} });

/* ---------- 断言器 ---------- */
let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, detail){
  if (cond){ passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name); console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }
}
function section(title){ console.log('\n■ ' + title); }
const DT = 1 / 30;
function run(sim, seconds, onStep){
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++){ Sim.step(sim, DT); if (onStep) onStep(sim, i); if (sim.over) break; }
}
function invariants(sim){
  for (const c of sim.castles){
    const cap = Sim.LEVELS[c.level - 1].cap;
    if (!(c.garrison >= 0 && c.garrison <= cap + 1e-9)) return 'garrison 越界: ' + JSON.stringify(c);
    if (!(c.owner >= 0 && c.owner <= 4)) return 'owner 非法';
  }
  for (const a of sim.armies) if (!(a.count >= 1)) return 'army.count < 1';
  for (const p of sim.camps) if (!(p.count >= 1)) return 'camp.count < 1';
  for (let o = 1; o <= 4; o++) if (!(sim.ink[o] >= 0 && sim.ink[o] <= Sim.CFG.INK_MAX)) return 'ink 越界';
  return null;
}
function addCastle(sim, owner, x, y, level, garrison){
  const c = { id: sim.castles.length, owner, x, y, level, garrison, shieldT: 0, weakT: 0, flashT: 0 };
  sim.castles.push(c); return c;
}
function unitSim(seed, castles){   // 无 AI 干扰的单元测试局
  return Sim.createGame({ opponents: 1, castles: castles || 8, diff: 'easy', seed, noAI: true });
}

/* ============================================================
 * 1. 地图生成
 * ============================================================ */
section('地图生成约束');
{
  const sim = Sim.createGame({ opponents: 2, castles: 11, diff: 'normal', seed: 42 });
  ok(sim.castles.length === 11, '城池数量 = 配置值', '实际 ' + sim.castles.length);
  ok(sim.castles[0].owner === 1, '玩家主城存在（owner=1）');
  const ais = new Set(sim.castles.filter(c => c.owner >= 2).map(c => c.owner));
  ok(ais.size === 2, 'AI 阵营数量 = 2', '实际 ' + ais.size);
  ok(sim.castles.filter(c => c.owner === 0).length === 8, '中立城 = 8');
  let minD = Infinity;
  for (let i = 0; i < sim.castles.length; i++)
    for (let j = i + 1; j < sim.castles.length; j++){
      const a = sim.castles[i], b = sim.castles[j];
      minD = Math.min(minD, Math.hypot(a.x - b.x, a.y - b.y));
    }
  ok(minD >= Sim.CFG.MIN_DIST - 1e-6, '城池最小间距 ≥ ' + Sim.CFG.MIN_DIST, '实际 ' + minD.toFixed(1));
  ok(sim.hands[1].length === 3 && sim.hands[1].every(k => Sim.CARDS.some(c => c.key === k)), '开局手牌 3 张且均属卡库');
  const a2 = Sim.createGame({ opponents: 2, castles: 11, diff: 'normal', seed: 42 });
  ok(JSON.stringify(a2.castles) === JSON.stringify(sim.castles) && JSON.stringify(a2.hands[1]) === JSON.stringify(sim.hands[1]),
     '同种子确定性：两次建局地图/手牌完全一致');
  ok(sim.castles[0].x < Sim.CFG.MAP_W / 2 && sim.castles[0].y > Sim.CFG.MAP_H / 2, '玩家主城靠左下角出生');
}

/* ============================================================
 * 2. 派兵 · 占领 · 增援升级 · 容量
 * ============================================================ */
section('派兵与占领结算');
{
  const sim = unitSim(7);
  const me = sim.castles[0];
  const neu = sim.castles.find(c => c.owner === 0);
  neu.x = me.x + 240; neu.y = me.y;              // 挪近：2 秒航程
  me.garrison = 150;
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'c', id: neu.id }, ratio: 1 });
  Sim.step(sim, DT);
  ok(me.garrison < 1, '派兵后出发城驻军即时扣减', '实际 ' + me.garrison.toFixed(2));
  run(sim, 6);
  ok(neu.owner === 1, '来犯兵力 > 驻军 → 中立城易主');
  ok(neu.garrison === Sim.LEVELS[0].cap, '占领溢出按容量封顶（Lv1 容量 40）', '实际 ' + neu.garrison.toFixed(1));
  ok(sim.ink[1] > Sim.CFG.INK_START, '占领中立城墨量 +1');
}
{
  const sim = unitSim(8);
  const me = sim.castles[0];
  const foe = sim.castles.find(c => c.owner === 2);
  me.level = 3; me.garrison = 100; foe.level = 3; foe.garrison = 105;
  foe.x = me.x + 300; foe.y = me.y;
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'c', id: foe.id }, ratio: 1 });
  run(sim, 6);
  ok(foe.owner === 2, '来犯 ≤ 驻军 → 攻城失败城池不失');
  ok(foe.garrison > 5 && foe.garrison < 20, '防守方仅被消耗（105-100+产兵）', '剩余 ' + foe.garrison.toFixed(1));
}
{
  const sim = unitSim(9);
  const a = addCastle(sim, 1, 200, 200, 1, 30);
  const b = addCastle(sim, 1, 500, 200, 1, 0);
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: a.id }], to: { k: 'c', id: b.id }, ratio: 1 });
  run(sim, 5);
  ok(b.level === 2, '增援 30 兵 → 自动升级 Lv2（消耗 25）', '实际 Lv' + b.level);
  ok(b.garrison < 18, '升级扣兵后余量正确', '实际 ' + b.garrison.toFixed(1));
  b.garrison = 60;
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: b.id }], to: { k: 'c', id: b.id }, ratio: 1 });
  run(sim, 4);
  ok(b.level === 3, '再增援 60 兵 → 升级 Lv3 封顶', '实际 Lv' + b.level);
  b.garrison = 119;
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: b.id }], to: { k: 'c', id: b.id }, ratio: 1 });
  run(sim, 3);
  ok(b.garrison <= Sim.LEVELS[2].cap, 'Lv3 容量 120 封顶不溢出', '实际 ' + b.garrison.toFixed(1));
}

/* ============================================================
 * 3. 在途部队互战（墨色相溶）
 * ============================================================ */
section('在途遭遇战');
{
  const sim = unitSim(31);
  // 我方 50 兵向东，敌方 30 兵向西，同航道相向而行
  sim.armies.push({ id: 1, owner: 1, count: 50, x: 700, y: 450, tx: 1200, ty: 450, tKind: 'pt', tid: -1, srcId: -1, hx: 700, hy: 450 });
  sim.armies.push({ id: 2, owner: 2, count: 30, x: 800, y: 450, tx: 400, ty: 450, tKind: 'pt', tid: -1, srcId: -1, hx: 800, hy: 450 });
  let clashN = 0;
  run(sim, 2, s => { clashN = Math.max(clashN, s.events.filter(e => e.type === 'clash').length); s.events.length = 0; });
  const mine = sim.armies.filter(a => a.owner === 1), theirs = sim.armies.filter(a => a.owner === 2);
  ok(clashN >= 1, '异主部队相遇触发湮灭事件');
  ok(theirs.length === 0, '劣势方 30 兵全灭');
  ok(mine.length === 1 && Math.abs(mine[0].count - 20) <= 1, '优势方剩差值 ~20 兵', '实际 ' + (mine[0] ? mine[0].count : 0));
  run(sim, 6);
  ok(sim.camps.length === 1 && sim.camps[0].owner === 1, '胜出部队继续行军并按原目标列阵');
}
{
  const sim = unitSim(32);
  // 同阵营两支重叠部队互不攻击（航程 400px > 2s，途中不会被抵达结算干扰）
  sim.armies.push({ id: 1, owner: 1, count: 10, x: 800, y: 450, tx: 1200, ty: 450, tKind: 'pt', tid: -1, srcId: -1, hx: 800, hy: 450 });
  sim.armies.push({ id: 2, owner: 1, count: 10, x: 802, y: 450, tx: 1200, ty: 450, tKind: 'pt', tid: -1, srcId: -1, hx: 800, hy: 450 });
  run(sim, 2);
  ok(sim.armies.length === 2 && sim.armies.every(a => a.count === 10), '同阵营部队相遇互不攻击');
}

/* ============================================================
 * 4. 卡牌（8 张逐一验证）
 * ============================================================ */
section('卡牌效果');
{
  const sim = unitSim(11);
  const foe = sim.castles.find(c => c.owner === 2);
  foe.garrison = 50;
  sim.hands[1] = ['fire', 'shield', 'rush']; sim.ink[1] = 10;
  ok(Sim.canPlay(sim, 0, 1).ok, 'canPlay：墨量充足可发动火攻');
  ok(Sim.cardPlay(sim, 0, foe.id), 'cardPlay（带目标）返回成功');
  ok(foe.garrison === 30, '火攻烧毁四成驻军 50→30', '实际 ' + foe.garrison);
  ok(sim.ink[1] === 5 && sim.hands[1].length === 3, '扣墨 5 · 手牌补 1');
  ok(!Sim.validTarget(sim, 'fire', 1, sim.castles[0].id), '火攻不可指定己方城');
  sim.hands[1] = ['weak', 'shield', 'rush'];
  ok(Sim.validTarget(sim, 'weak', 1, foe.id), '虚弱可选敌方城');
  ok(!Sim.validTarget(sim, 'weak', 1, sim.castles.find(c => c.owner === 0).id), '虚弱不可选中立城');
  const sim2 = unitSim(12);
  const me2 = sim2.castles[0];
  me2.garrison = 20;
  sim2.hands[1] = ['shield', 'fire', 'rush']; sim2.ink[1] = 10;
  Sim.cardPlay(sim2, 0, 0);
  ok(me2.shieldT === Sim.CFG.SHIELD_T, '护盾挂载 8 秒');
  sim2.armies.push({ id: 999, owner: 2, count: 50, x: me2.x + 30, y: me2.y, tx: me2.x, ty: me2.y, tKind: 'c', tid: 0, srcId: 1, hx: me2.x + 30, hy: me2.y });
  run(sim2, 3);
  ok(me2.owner === 1 && me2.garrison > 19 && me2.garrison < 23, '护盾期间来犯部队消散、城池不失（仅自然产兵）',
     '驻军 ' + me2.garrison.toFixed(1));
}
{
  const sim = unitSim(13);
  const me = sim.castles[0]; me.garrison = 10; me.level = 1;
  sim.hands[1] = ['reinforce', 'fire', 'rush']; sim.ink[1] = 10;
  Sim.cardPlay(sim, 0, 0);
  ok(me.garrison === 35 && me.level === 1, '增援 +25 且不触发升级判定', '实际 ' + me.garrison + ' Lv' + me.level);
  const sim2 = unitSim(14);
  const f2 = sim2.castles.find(c => c.owner === 2);
  f2.garrison = 0; f2.level = 1;
  sim2.hands[1] = ['weak', 'fire', 'rush']; sim2.ink[1] = 10;
  Sim.cardPlay(sim2, 0, f2.id);
  run(sim2, 4);
  const weakGain = f2.garrison;
  const sim3 = unitSim(14);
  const f3 = sim3.castles.find(c => c.owner === 2);
  f3.garrison = 0; f3.level = 1;
  run(sim3, 4);
  ok(Math.abs(weakGain - f3.garrison / 2) < 0.3, '虚弱期产速减半（4s: ' + weakGain.toFixed(2) + ' vs 正常 ' + f3.garrison.toFixed(2) + '）');
  const sim4 = unitSim(15);
  const me4 = sim4.castles[0];
  const t4 = addCastle(sim4, 0, me4.x + 240, me4.y, 1, 40);
  me4.garrison = 50;
  sim4.hands[1] = ['rush', 'fire', 'shield']; sim4.ink[1] = 10;
  Sim.cardPlay(sim4, 0);
  Sim.command(sim4, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'c', id: t4.id }, ratio: 1 });
  let arriveT = -1;
  run(sim4, 10, (s) => { if (arriveT < 0 && s.castles[t4.id].owner === 1) arriveT = s.t; });
  ok(arriveT > 0 && arriveT < 1.8, '疾行后 240px 约 1 秒抵达（+战斗耗时）', '实际 ' + arriveT.toFixed(2) + 's');
}
{
  const sim = unitSim(16);
  sim.hands[1] = ['dagger', 'fire', 'rush']; sim.ink[1] = 10;
  ok(Sim.cardPlay(sim, 0), '借刀发动成功');
  ok(sim.castles.filter(c => c.owner === 1).length === 2, '最近中立城倒戈为己方（城池数 1→2）');
  const sim2 = unitSim(17);
  const me2 = sim2.castles[0], foe2 = sim2.castles.find(c => c.owner === 2);
  foe2.x = me2.x + 400; foe2.y = me2.y; foe2.garrison = 30; foe2.level = 3;   // Lv3 无升级消耗，隔离升级干扰
  sim2.armies.push({ id: 1, owner: 2, count: 30, x: me2.x + 200, y: me2.y, tx: me2.x, ty: me2.y, tKind: 'c', tid: 0, srcId: foe2.id, hx: foe2.x, hy: foe2.y });
  sim2.hands[1] = ['divert', 'fire', 'rush']; sim2.ink[1] = 10;
  Sim.cardPlay(sim2, 0);
  const a = sim2.armies[0];
  ok(a.tid === foe2.id && a.tx === foe2.x, '围魏救赵：敌军目标改回出发城');
  run(sim2, 6);
  ok(foe2.owner === 2 && foe2.garrison > 60 && foe2.garrison < 80, '折返部队回到敌城成为其增援（30+30+产兵）',
     '驻军 ' + foe2.garrison.toFixed(0) + ' Lv' + foe2.level);
  const sim3 = unitSim(18);
  const me3 = sim3.castles[0]; me3.garrison = 5;
  sim3.hands[1] = ['surge', 'fire', 'rush']; sim3.ink[1] = 10;
  Sim.cardPlay(sim3, 0);
  ok(me3.garrison === 13, '墨涌：己方城 +8 兵', '实际 ' + me3.garrison);
  const sim4 = unitSim(19);
  sim4.hands[1] = ['dagger', 'fire', 'rush']; sim4.ink[1] = 2;
  ok(!Sim.canPlay(sim4, 0, 1).ok && Sim.canPlay(sim4, 0, 1).reason === '墨量不足', '墨量不足 → canPlay 拒绝并给出原因');
  ok(!Sim.cardPlay(sim4, 0), '墨量不足 → cardPlay 失败不生效');
}

/* ============================================================
 * 5. 屯兵列阵
 * ============================================================ */
section('屯兵列阵');
{
  const sim = unitSim(21);
  const me = sim.castles[0];
  me.garrison = 40;
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'pt', x: me.x + 260, y: me.y }, ratio: 0.5 });
  run(sim, 4);
  ok(sim.camps.length === 1 && sim.camps[0].owner === 1, '点空地派遣 → 创建阵列');
  const camp = sim.camps[0];
  ok(camp.count === 20, '阵列兵力 = 出城兵力（50%）', '实际 ' + camp.count);
  camp.decayAcc = Sim.CFG.CAMP_DECAY - DT;
  run(sim, 2 * Sim.CFG.CAMP_DECAY);
  ok(camp.count === 18, '阵列散逸：每 ' + Sim.CFG.CAMP_DECAY + ' 秒 -1 兵', '20→' + camp.count);
  Sim.command(sim, { owner: 1, from: [{ k: 'p', id: camp.id }], to: { k: 'c', id: 0 }, ratio: 0.5 });
  run(sim, 4);
  ok(camp.count >= 8 && camp.count <= 9, '阵列可再次派遣（50% 出兵，含 1 次散逸计时抖动）', '实际 ' + camp.count);
  ok(me.level === 2, '阵列回城增援使驻军突破阈值 → 自动升级 Lv2', '实际 Lv' + me.level + ' 驻军 ' + me.garrison.toFixed(0));
  ok(me.garrison > 10, '阵列部队回城增援生效', '驻军 ' + me.garrison.toFixed(0));
}

/* ============================================================
 * 6. 完整对局：胜负可达 + 不变量 + over 冻结
 * ============================================================ */
section('完整对局（AI 互打）');
{
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', ambient: true, seed: 23 });
  let invErr = null;
  const TMAX = 20 * 60;
  while (!sim.over && sim.t < TMAX){
    Sim.step(sim, DT);
    sim.events.length = 0;
    if (Math.round(sim.t / DT) % 100 === 0){ const e = invariants(sim); if (e){ invErr = e; break; } }
  }
  ok(sim.over === 1 || sim.over === 2, 'AI 互打必出胜负（用时 ' + Math.round(sim.t) + 's，over=' + sim.over + '）');
  ok(!invErr, '每 100 步抽样不变量全部成立', invErr || '');
  if (sim.over){
    const snap = JSON.stringify({ c: sim.castles, a: sim.armies, p: sim.camps, k: sim.ink });
    for (let i = 0; i < 10; i++) Sim.step(sim, DT);
    ok(JSON.stringify({ c: sim.castles, a: sim.armies, p: sim.camps, k: sim.ink }) === snap, 'over 后模拟幂等冻结');
  }
}
{
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 24 });
  run(sim, 10 * 60);
  ok(sim.over === 2, '玩家挂机 10 分钟内被 AI 攻陷（判负可达）', 'over=' + sim.over + ' t=' + Math.round(sim.t) + 's');
}

/* ============================================================
 * 7. AI 强度分层：困难 显著强于 容易
 * ============================================================ */
section('AI 强度分层（互打采样）');
{
  const N = 40, TMAX = 15 * 60;
  let hardWin = 0, decided = 0, stale = 0, clashTotal = 0, gameLens = [];
  const t0 = Date.now();
  for (let g = 0; g < N; g++){
    // 偶数局困难执 owner2、奇数局执 owner1，消除出生点位偏差
    const hardIsP2 = g % 2 === 0;
    const sim = Sim.createGame({ opponents: 1, castles: 9, diff: 'easy', ambient: true, seed: 1000 + g });
    sim.aiDiff = hardIsP2 ? { 2: 'hard' } : { 1: 'hard' };
    while (!sim.over && sim.t < TMAX){
      Sim.step(sim, DT);
      if (sim.events.some(e => e.type === 'clash')) clashTotal++;
      sim.events.length = 0;
    }
    gameLens.push(Math.round(sim.t));
    if (sim.over){
      decided++;
      const hardWon = hardIsP2 ? sim.over === 1 : sim.over === 2;
      if (hardWon) hardWin++;
    } else stale++;
  }
  const rate = decided ? hardWin / decided : 0;
  const avgLen = Math.round(gameLens.reduce((a, b) => a + b, 0) / N);
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  ok(stale === 0, '全部 ' + N + ' 局在 15 分钟内分出胜负（无僵局）', '僵局 ' + stale + ' 局');
  ok(rate >= 0.6, '困难 AI 胜率 ≥ 60%（实测 ' + (rate * 100).toFixed(0) + '%，耗时 ' + secs + 's）', '胜 ' + hardWin + '/' + decided);
  ok(clashTotal > 0, '采样对局累计发生在途遭遇战 ' + clashTotal + ' 次');
  ok(avgLen >= 60, '对局平均时长 ≥ 60s（实测均值 ' + avgLen + 's）', '过快结束会影响 3-5 分钟节奏');
}

/* ============================================================
 * 8. 双玩家（联机基础）：独立手牌 / 视角化胜负语义
 * ============================================================ */
section('双玩家支持');
{
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 77, noAI: true });
  ok(sim.hands[1].length === 3 && sim.hands[2].length === 3, '双方各发 3 张手牌');
  ok(sim.hands[1] !== sim.hands[2], '双手牌数组相互独立');
  // 2 号玩家打火攻：扣 ink[2]、补牌到 hands[2]，不影响 1 号
  const neutralT = sim.castles.find(c => c.owner === 0);
  neutralT.garrison = 50;
  sim.hands[2] = ['fire', 'shield', 'rush']; sim.ink[2] = 10;
  const h1 = sim.hands[1].slice();
  ok(Sim.cardPlay(sim, 0, neutralT.id, 2), '2 号玩家 cardPlay 成功');
  ok(neutralT.garrison === 30 && sim.ink[2] === 5 && sim.hands[2].length === 3, '2 号效果与资源结算正确');
  ok(JSON.stringify(sim.hands[1]) === JSON.stringify(h1), '1 号手牌不受影响');
  // PvP 胜负语义：1 号城池尽失 → over=2（2 号胜）
  sim.castles.forEach(c => { if (c.owner === 1) c.owner = 2; });
  Sim.step(sim, DT);
  ok(sim.over === 2, 'PvP 语义：1 号灭 → over=2（2 号胜）', 'over=' + sim.over);
}

/* ---------- 汇总 ---------- */
console.log('\n──────────────────────────────');
console.log('通过 ' + passed + ' · 失败 ' + failed);
if (failed){ console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('ALL GREEN ✓');
