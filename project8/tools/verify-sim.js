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
    if (c.tower && (Sim.TOWERS.every(t => t.kind !== c.tower.kind) || !(c.tower.lv >= 1 && c.tower.lv <= Sim.CFG.TOWER_MAX_LV) || !(c.tower.cd >= 0)))
      return 'tower 非法: ' + JSON.stringify(c.tower);
    if (c.owner >= 0 && c.owner <= 4 && c.garrison > Math.round(Sim.LEVELS[c.level - 1].cap * 1.2) + 1e-9) return 'garrison 超容量上限: ' + JSON.stringify(c);
  }
  for (const a of sim.armies) if (!(a.count >= 1)) return 'army.count < 1';
  for (const p of sim.camps) if (!(p.count >= 1)) return 'camp.count < 1';
  for (let o = 1; o <= 4; o++) if (!(sim.ink[o] >= 0 && sim.ink[o] <= sim.inkMax)) return 'ink 越界';
  return null;
}
function addCastle(sim, owner, x, y, level, garrison){
  const c = { id: sim.castles.length, owner, x, y, level, garrison, tower: null, shieldT: 0, weakT: 0, flashT: 0, buffT: 0, hitT: 0 };
  sim.castles.push(c); return c;
}
function unitSim(seed, castles){   // 无 AI 干扰的单元测试局
  return Sim.createGame({ opponents: 1, castles: castles || 8, diff: 'easy', seed, noAI: true });
}
/* v1.23 隔离：新规则「过城开战」会让途经敌/中立城的部队掉兵。给这些城上护盾（护盾对过城开战免疫）
   即可把新规则排除在本段断言之外，让老断言继续只测它原本要测的那件事。 */
function shieldAll(sim, keepIds){
  for (const c of sim.castles){
    if (keepIds && keepIds.indexOf(c.id) >= 0) continue;
    c.shieldT = 1e6;
  }
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
const mkArmy = (id, owner, n, x, y, tx, ty, tid) =>
  ({ id, owner, count: n, x, y, tx, ty, tKind: tid == null ? 'pt' : 'c', tid: tid == null ? -1 : tid, srcId: -1, hx: x, hy: y, atkT: 0 });
{
  const sim = unitSim(32);
  // 同阵营两支重叠部队互不攻击（航程 400px > 2s，途中不会被抵达结算干扰）
  shieldAll(sim);                       // v1.23 隔离：途经的敌/中立城不再消耗这两支队伍
  sim.armies.push(mkArmy(1, 1, 10, 800, 450, 1200, 450));
  sim.armies.push(mkArmy(2, 1, 10, 802, 450, 1200, 450));
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
  ok(sim.ink[1] === 5 && sim.hands[1].length === 2, '扣墨 5 · 手牌 -1（v1.14：不再立即补牌）');
  ok(sim.piles[1].discard.length === 1 && sim.piles[1].discard[0] === 'fire', '打出的牌进弃牌堆');
  /* v1.20：card 事件带目标城池 id —— UI 靠它把提示落在「被打的那座城」上 */
  {
    const ev = sim.events.filter(e => e.type === 'card').pop();
    ok(!!ev && ev.target === foe.id, 'card 事件带目标城池 id（v1.20 敌方出牌提示）', JSON.stringify(ev));
    sim.hands[1] = ['levy']; sim.ink[1] = 10;
    Sim.cardPlay(sim, 0, undefined, 1);
    const evG = sim.events.filter(e => e.type === 'card').pop();
    ok(!!evG && evG.target === -1, '无目标的全局牌 target = -1', JSON.stringify(evG));
  }
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
  run(sim, 30);   // v1.22：散逸机制已移除，屯兵永久驻守
  ok(camp.count === 20, '阵列不再散逸：30 秒后兵力不变（v1.22）', '20→' + camp.count);
  Sim.command(sim, { owner: 1, from: [{ k: 'p', id: camp.id }], to: { k: 'c', id: 0 }, ratio: 0.5 });
  run(sim, 4);
  ok(camp.count === 10, '阵列可再次派遣（50% 出兵，无散逸抖动）', '实际 ' + camp.count);
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

/* over 语义钉死：避免再出现「把败方当胜方统计」这类方向性 bug（v1.16 教训） */
{
  const s = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 25, noAI: true });
  s.castles.forEach(c => { if (c.owner === 2) c.owner = 1; });
  Sim.step(s, DT);
  ok(s.over === 1, 'sim.over = 胜者阵营（清空 2 号城池 → over=1）', 'over=' + s.over);
}

/* ============================================================
 * 7. AI 强度分层：困难 显著强于 容易
 * ============================================================ */
section('AI 强度分层（互打采样）');
{
  /* v1.32：N 由 40 提到 160 —— 40 局的胜率标准误约 ±8pp，会把「塔开始打阵列」带来的
     1~5pp 真实差异（n=160 配对实测）淹没在噪声里（曾误报成 5pp 回归）。160 局下才稳定。 */
  const N = 160, TMAX = 15 * 60;
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
      /* sim.over = 胜者阵营（清空 2 号城池 → over=1，见 step 第 8 段）。
         v1.16 修正：原判据把「容易的胜率」当成困难胜率（方向写反），
         掩盖了「不开牌时困难真胜率仅 ~35%」这一事实。 */
      if (sim.over === (hardIsP2 ? 2 : 1)) hardWin++;
    } else stale++;
  }
  const rate = decided ? hardWin / decided : 0;
  const avgLen = Math.round(gameLens.reduce((a, b) => a + b, 0) / N);
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  ok(stale === 0, '全部 ' + N + ' 局在 15 分钟内分出胜负（无僵局）', '僵局 ' + stale + ' 局');
  /* v1.32：阈值 0.6 → 0.55，并把 N 由 40 提到 160。
     原因：塔修复为「射程内的阵列也打」（此前敌军在塔下扎营塔一枪不放）。同批种子配对实测
     （n=160×2 种子族）困难 AI 胜率 63.1%→58.1%（-5.0pp）、72.5%→71.3%（-1.2pp）——
     困难 AI 更爱把兵屯到敌城边上，塔不再无视屯兵后这部分便宜没了。属修复的合理代价，
     55% 仍是「困难显著强于容易」（>50% 且样本 160 局，标准误 ±4pp）。
     另：N=40 时标准误 ±8pp，曾把 -2pp 的真实差异误报成 5pp 回归，样本量必须够。 */
  ok(rate >= 0.55, '困难 AI 胜率 ≥ 55%（实测 ' + (rate * 100).toFixed(0) + '%，耗时 ' + secs + 's）', '胜 ' + hardWin + '/' + decided);
  ok(clashTotal > 0, '采样对局累计发生在途遭遇战 ' + clashTotal + ' 次');
  ok(avgLen >= 45, 'AI 互打平均时长 ≥ 45s（实测均值 ' + avgLen + 's，玩家实际对局因操作防守更长）', '防止秒局回归');
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
  ok(neutralT.garrison === 30 && sim.ink[2] === 5 && sim.hands[2].length === 2, '2 号效果与资源结算正确（v1.14：打出后进弃牌堆，不再立即补牌）');
  ok(JSON.stringify(sim.hands[1]) === JSON.stringify(h1), '1 号手牌不受影响');
  // PvP 胜负语义：1 号城池尽失 → over=2（2 号胜）
  sim.castles.forEach(c => { if (c.owner === 1) c.owner = 2; });
  Sim.step(sim, DT);
  ok(sim.over === 2, 'PvP 语义：1 号灭 → over=2（2 号胜）', 'over=' + sim.over);
}

/* ============================================================
 * 9. 军令改向：在途部队可变更目标
 * ============================================================ */
section('军令改向');
{
  const sim = unitSim(41);
  const me = sim.castles[0];
  me.garrison = 60;
  const tgtA = addCastle(sim, 0, me.x + 240, me.y, 1, 40);      // 原目标（中立）
  const tgtB = addCastle(sim, 2, me.x + 600, me.y + 300, 1, 5); // 新目标（弱守敌城）
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'c', id: tgtA.id }, ratio: 1 });
  Sim.step(sim, DT);
  ok(sim.armies.length === 1 && sim.armies[0].tid === tgtA.id, '部队出发，初始指向 tgtA');
  const a = sim.armies[0];
  Sim.command(sim, { type: 'retarget', owner: 1, ids: [a.id], to: { k: 'c', id: tgtB.id } });
  Sim.step(sim, DT);
  ok(a.tx === tgtB.x && a.tid === tgtB.id, '军令改向生效（目标切到 tgtB）');
  run(sim, 12);
  ok(tgtA.owner === 0, '原目标未被攻击', 'owner=' + tgtA.owner);
  ok(tgtB.owner === 1, '部队沿新方向抵达并占领 tgtB', 'owner=' + tgtB.owner);
  // 越权改向拒绝
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'pt', x: me.x + 100, y: me.y }, ratio: 1 });
  Sim.step(sim, DT);
  const a2 = sim.armies[sim.armies.length - 1];
  Sim.command(sim, { type: 'retarget', owner: 2, ids: [a2.id], to: { k: 'pt', x: 100, y: 100 } });
  Sim.step(sim, DT);
  ok(a2.tx !== 100, '越权改向被拒绝（非本方部队）');
  // 体积随兵力缩放
  const big = { count: 60 }, small = { count: 5 };
  ok(Sim.armyR(big) > Sim.armyR(small) && Sim.armyR(small) >= 9, '碰撞体积随兵力单调缩放');
}

section('城池等级与阵列清场（v1.3）');
{
  const sim = unitSim(51);
  const r1 = Sim.createGame === undefined ? 0 : 0; // 占位无操作
  const c1 = { level: 1 }, c2 = { level: 2 }, c3 = { level: 3 };
  const R1 = 24 + (c1.level - 1) * 10, R2 = 24 + (c2.level - 1) * 10, R3 = 24 + (c3.level - 1) * 10;
  ok(R2 > R1 && R3 > R2 && R3 === 44, '城池大小随等级递增（24/34/44）');
  // 阵列派空 → 「屯」消失
  const sim2 = unitSim(52);
  const me = sim2.castles[0];
  me.garrison = 40;
  Sim.command(sim2, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'pt', x: me.x + 260, y: me.y }, ratio: 1 });
  run(sim2, 4);
  ok(sim2.camps.length === 1, '阵列已创建');
  Sim.command(sim2, { owner: 1, from: [{ k: 'p', id: sim2.camps[0].id }], to: { k: 'c', id: 0 }, ratio: 1 });
  run(sim2, 6);
  ok(sim2.camps.length === 0, '阵列部队派空后「屯」图消失', '剩余 ' + sim2.camps.length);
  // v1.22：屯兵不再散逸（永久驻守），但仍可被派遣调空 / 被经过的敌军消耗殆尽
  const sim3 = unitSim(53);
  const mine3 = addCastle(sim3, 1, 200, 200, 1, 40);
  const foe3 = addCastle(sim3, 2, 600, 200, 3, 100);   // 敌军兵力远大于屯点，沿途被塔消耗也不影响结论
  shieldAll(sim3);                 // v1.23 隔离：屏蔽「过城开战」，本段只测散逸是否还在
  Sim.command(sim3, { owner: 1, from: [{ k: 'c', id: mine3.id }], to: { k: 'pt', x: 400, y: 200 }, ratio: 1 });
  run(sim3, 4);
  const cp3 = sim3.camps.filter(p => p.owner === 1)[0];
  ok(!!cp3 && cp3.count === 40, '己方阵列建成（40 兵）', cp3 ? '实际 ' + cp3.count : '无阵列');
  run(sim3, 60);                                   // 旧规则下 60 秒足够散逸 12 兵
  ok(sim3.camps.indexOf(cp3) >= 0 && cp3.count === 40, '屯兵 60 秒后兵力不变（v1.22 不再散逸）', '实际 ' + (cp3 ? cp3.count : '阵列已消失'));
  Sim.command(sim3, { owner: 2, from: [{ k: 'c', id: foe3.id }], to: { k: 'pt', x: 400, y: 200 }, ratio: 1 });
  run(sim3, 10);
  ok(sim3.camps.indexOf(cp3) < 0, '敌军经过屯点 → 阵列被消耗殆尽后消失', '剩余己方阵列 ' + sim3.camps.filter(p => p.owner === 1).length);
}

section('中立不产兵与新增卡牌（v1.4）');
{
  // 中立城驻军固定不增长
  const sim = unitSim(61);
  const neu = sim.castles.find(c => c.owner === 0);
  const g0 = neu.garrison;
  run(sim, 10);
  ok(Math.abs(neu.garrison - g0) < 1e-9, '没人占领的城池不增加人口（10s 驻军不变）',
     g0.toFixed(2) + '→' + neu.garrison.toFixed(2));
  const mine = sim.castles[0];
  const g1 = mine.garrison;
  run(sim, 2);
  ok(mine.garrison > g1, '被占领的城池正常产兵');
  // 固守：产速 ×3
  const sim2 = unitSim(62);
  const me2 = sim2.castles[0]; me2.garrison = 0;
  sim2.hands[1] = ['holdfast', 'fire', 'rush']; sim2.ink[1] = 10;
  Sim.cardPlay(sim2, 0, 0);
  ok(me2.buffT === Sim.CFG.HOLDFAST_T, '固守挂载 8 秒');
  run(sim2, 4);
  const buffGain = me2.garrison;
  const sim3 = unitSim(62);
  sim3.castles[0].garrison = 0;
  run(sim3, 4);
  ok(Math.abs(buffGain - sim3.castles[0].garrison * 3) < 0.01,
     '固守期产速×3（4s: ' + buffGain.toFixed(2) + ' vs 正常 ' + sim3.castles[0].garrison.toFixed(2) + '）');
  // 策反：敌城三成驻军倒戈为攻城部队
  const sim4 = unitSim(63);
  const foe4 = sim4.castles.find(c => c.owner === 2);
  foe4.garrison = 50;
  sim4.hands[1] = ['defect', 'fire', 'rush']; sim4.ink[1] = 10;
  ok(Sim.cardPlay(sim4, 0, foe4.id), '策反发动成功');
  ok(foe4.garrison === 35, '敌城失去三成驻军 50→35', '实际 ' + foe4.garrison);
  const def = sim4.armies.find(a => a.owner === 1);
  ok(def && def.count === 15 && def.tid === foe4.id, '倒戈部队 15 兵就地攻向该城');
  run(sim4, 4);
  ok(foe4.garrison < 35 && foe4.owner === 2, '倒戈部队持续攻城消耗守军（未破城）',
     'g=' + foe4.garrison.toFixed(1));
  // 卡池：25 张基础 + 25 张「+」升级版（v1.18 新增征兵/疾驰/箭雨/屯田/勤王；v1.24 新增伏击/瘟疫/连弩/摧塔/墨锭/粮道/断粮）
  const baseCards = Sim.CARDS.filter(c => !c.up), upCards = Sim.CARDS.filter(c => c.up);
  ok(baseCards.length === 25 && upCards.length === 25, '卡池 25 基础 + 25 升级版',
     '实际 ' + baseCards.length + ' / ' + upCards.length);
  ok(upCards.every(c => !!c.base), '升级版均标记 base（指向原版）');
  ok(baseCards.every(c => c.cd > 0 && c.cd <= 40), '每张卡都带冷却秒数（8~40s）');
}

section('日卡被动（v1.5）· 牌组带入（v1.14）');
{
  // 屯田（产速+15%）+ 铁壁（容量+20%）被动生效
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 71, noAI: true,
                               dailies: ['farming', 'wall'] });
  ok(sim.mods.prod === 1.15 && sim.mods.cap === 1.2, '日卡被动折算为全局修正');
  const me = sim.castles[0]; me.garrison = 0;
  run(sim, 4);
  ok(Math.abs(me.garrison - 0.7 * 1.15 * 4) < 0.01, '产速 ×1.15（4s: ' + me.garrison.toFixed(2) + '）');
  // v1.14 牌组带入：卡组洗入抽牌堆，开局手牌 = 卡组前三张（洗牌后顺序）
  const deck1 = ['fire', 'shield', 'rush', 'weak', 'surge', 'star1', 'reinforce', 'dagger'];
  const sim2 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 72, noAI: true,
                                decks: { 1: deck1.slice() } });
  ok(sim2.piles[1].list.length === 8, '卡组原样记录（list = 8 张）', '实际 ' + sim2.piles[1].list.length);
  ok(sim2.hands[1].length === 3 && sim2.piles[1].draw.length === 5,
     '开局抽 3 张，余 5 张留在抽牌堆', '手牌 ' + sim2.hands[1].length + ' 抽 ' + sim2.piles[1].draw.length);
  ok(sim2.hands[1].every(k => deck1.indexOf(k) >= 0), '手牌全部来自卡组');
  ok(sim2.hands[2].length === 3 && sim2.hands[2][0] !== 'fire', '对手用默认卡组，不受玩家卡组影响');
  // 联机双端各自带入卡组
  const sim3 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 73, noAI: true,
                                decks: { 1: ['rush', 'rush', 'rush', 'rush', 'rush', 'rush'],
                                         2: ['defect', 'defect', 'defect', 'defect', 'defect', 'defect'] } });
  ok(sim3.hands[1].every(k => k === 'rush') && sim3.hands[2].every(k => k === 'defect'),
     '联机双方各自带入卡组');
  // 日卡不进普通摸牌池
  ok(Sim.CARDS.every(c => !Sim.DAILIES.some(d => d.key === c.key)), '日卡与次卡池隔离（摸牌不出日卡）');
}

section('神速行军 / 全军出击 / 阵列迎敌（v1.6）');
{
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 81, noAI: true });
  const me = sim.castles[0], foe = sim.castles.find(c => c.owner === 2);
  me.level = 3; me.garrison = 0; foe.x = me.x + 600; foe.y = me.y;
  // 神速行军星级：同 key 不同 mul，重复发动取最高
  sim.hands[1] = ['star1', 'star3', 'rush']; sim.ink[1] = 10;
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'c', id: foe.id }, ratio: 1 });
  me.garrison = 60;
  Sim.step(sim, DT);
  const a = sim.armies[0];
  ok(sim.effects.starT[1] === 0, '未发动时无加成');
  Sim.cardPlay(sim, 1, undefined, 1);            // ★★★
  ok(sim.effects.starT[1] === 8 && sim.effects.starMul[1] === 2.0, '三星神速：行军 +100% · 8秒', 'mul=' + sim.effects.starMul[1]);
  Sim.cardPlay(sim, 0, undefined, 1);            // ★ 不可覆盖更高
  ok(sim.effects.starMul[1] === 2.0, '低星不覆盖高星加成', 'mul=' + sim.effects.starMul[1]);
  ok(true, '—— 星级公式查表 +30/+60/+100 ——');
  const speed = Sim.armySpeed(sim, a);
  ok(speed === Sim.CFG.SPEED * 2.0, '速度合成：基础×神速(未发动疾行) = ' + speed);
  // 全军出击：敌方仅剩一城
  sim.castles.forEach(c => { if (c.owner === 2 && c.id !== foe.id) c.owner = 0; });
  const other = addCastle(sim, 1, 300, 700, 1, 10);
  other.garrison = 20;
  Sim.command(sim, { type: 'allout', owner: 1, targetId: foe.id });
  Sim.step(sim, DT);
  ok(sim.effects.rushT[1] >= 7.9, '全军出击附加行军加速 8 秒（含一步衰减）');
  ok(sim.armies.filter(x => x.owner === 1).length >= 2, '全军出兵（主城+第二城+在途改向）');
  run(sim, 30);
  ok(sim.over === 1, '全军出击攻克最后一城获胜', 'over=' + sim.over);
  // 阵列迎敌：强阵列全歼路过的弱敌
  const sim2 = unitSim(82);
  const me2 = sim2.castles[0];
  /* v1.23 隔离：① 拆掉塔，敌军途中不该被塔火削；② 全程上护盾，屏蔽「过城开战」对出城/来袭双方的消耗。
     本段只测「阵列迎敌」本身，驻军取 30（低于 Lv1 容量 35，避免产兵封顶带来的取整差）。 */
  sim2.castles.forEach(c => { c.tower = null; });
  shieldAll(sim2);
  me2.garrison = 30;
  Sim.command(sim2, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'pt', x: me2.x + 260, y: me2.y }, ratio: 1 });
  run(sim2, 4);
  ok(sim2.camps.length === 1 && sim2.camps[0].count === 30, '扎营成立（30 兵）', '实际 ' + (sim2.camps[0] ? sim2.camps[0].count : 0));
  const campPos = { x: sim2.camps[0].x, y: sim2.camps[0].y };
  sim2.armies.push({ id: 9002, owner: 2, count: 10, x: campPos.x + 200, y: campPos.y, tx: me2.x, ty: me2.y, tKind: 'c', tid: 0, srcId: 1, hx: campPos.x + 200, hy: campPos.y, atkT: 0 });
  run(sim2, 4);
  ok(sim2.camps.length === 1 && sim2.camps[0].count === 20, '强阵列迎敌：全歼 10 兵敌军（30-10=20）', '剩 ' + (sim2.camps[0] ? sim2.camps[0].count : 0));
  // 弱阵列耗尽：敌军大部队突破（阵列战至最后一兵）
  const sim3 = unitSim(83);
  const me3 = sim3.castles[0];
  me3.garrison = 12;
  Sim.command(sim3, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'pt', x: me3.x + 260, y: me3.y }, ratio: 1 });
  run(sim3, 4);
  const c3 = sim3.camps[0];
  sim3.armies.push({ id: 9003, owner: 2, count: 30, x: c3.x + 200, y: c3.y, tx: me3.x, ty: me3.y, tKind: 'c', tid: 0, srcId: 1, hx: c3.x + 200, hy: c3.y, atkT: 0 });
  run(sim3, 6);
  ok(sim3.camps.length === 0, '弱阵列战至最后一兵后消失', '剩余 ' + sim3.camps.length);
  ok(me3.owner === 2 || me3.garrison < 12, '突破阵列的敌军带着折损继续行动');
}

/* ============================================================
 * 10. v1.10：增益归属 / 统计口径 / 阵列 id 稳定 / AI 目标选择
 * ============================================================ */
section('增益归属（v1.10 · PVP 公平性）');
{
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 91, noAI: true });
  const a1 = { id: 1, owner: 1, count: 10 }, a2 = { id: 2, owner: 2, count: 10 };
  ok(Math.abs(Sim.armySpeed(sim, a1) - Sim.CFG.SPEED) < 1e-9 && Math.abs(Sim.armySpeed(sim, a2) - Sim.CFG.SPEED) < 1e-9,
     '初始双方行军速度均为基础值 ' + Sim.CFG.SPEED);
  sim.hands[2] = ['rush', 'fire', 'shield']; sim.ink[2] = 10;
  Sim.cardPlay(sim, 0, undefined, 2);
  ok(sim.effects.rushT[2] === Sim.CFG.RUSH_T && sim.effects.rushT[1] === 0, '2 号发动疾行只挂载在 2 号名下');
  ok(Math.abs(Sim.armySpeed(sim, a2) - Sim.CFG.SPEED * 2) < 1e-9, '疾行加速 2 号部队 ×2');
  ok(Math.abs(Sim.armySpeed(sim, a1) - Sim.CFG.SPEED) < 1e-9, '1 号部队不受 2 号疾行影响');
  sim.hands[1] = ['star3', 'fire', 'shield']; sim.ink[1] = 10;
  Sim.cardPlay(sim, 0, undefined, 1);
  ok(Math.abs(Sim.armySpeed(sim, a1) - Sim.CFG.SPEED * 2) < 1e-9 && sim.effects.starT[2] === 0,
     '神速只增益发动方（1 号 ×2，2 号不受影响）');
  run(sim, 9);
  ok(sim.effects.starT[1] === 0 && sim.effects.starMul[1] === 1 && Math.abs(Sim.armySpeed(sim, a1) - Sim.CFG.SPEED) < 1e-9,
     '神速到期复位：残留加成清零（疾行仍在 2 号名下）');
}

section('统计口径与墨量上限（v1.10）');
{
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 92, noAI: true, dailies: ['well'] });
  ok(sim.inkMax === Sim.CFG.INK_MAX + 2, '墨海日卡：墨量上限 +2 = ' + sim.inkMax);
  const me = sim.castles[0], neu = sim.castles.find(c => c.owner === 0);
  neu.x = me.x + 240; neu.y = me.y; neu.garrison = 5; me.garrison = 100; sim.ink[1] = sim.inkMax;
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'c', id: neu.id }, ratio: 1 });
  run(sim, 5);
  ok(neu.owner === 1 && sim.ink[1] <= sim.inkMax + 1e-9, '占领得墨按当日上限封顶（不再写死 10）',
     'ink=' + sim.ink[1].toFixed(2) + ' / max=' + sim.inkMax);
  const sim2 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 93, noAI: true });
  const foe = sim2.castles.find(c => c.owner === 2), neu2 = sim2.castles.find(c => c.owner === 0);
  neu2.x = foe.x + 240; neu2.y = foe.y; neu2.garrison = 5; foe.garrison = 100;
  Sim.command(sim2, { owner: 2, from: [{ k: 'c', id: foe.id }], to: { k: 'c', id: neu2.id }, ratio: 1 });
  run(sim2, 5);
  ok(neu2.owner === 2 && sim2.stats.capturedBy[2] === 1, 'PVP 客机（2 号）占领同样计入其战绩',
     'capturedBy=' + JSON.stringify(sim2.stats.capturedBy));
}

section('canPlay 目标合法性补全（v1.10）');
{
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 94, noAI: true });
  sim.hands[1] = ['defect', 'holdfast', 'fire']; sim.ink[1] = 10;
  sim.castles.forEach(c => { if (c.owner >= 2) c.owner = 0; });          // 抹掉敌方城池
  ok(!Sim.canPlay(sim, 0, 1).ok && Sim.canPlay(sim, 0, 1).reason === '无敌方城池', '策反：无敌方城池时拒绝并给出原因');
  sim.castles.forEach(c => { c.owner = 2; });                            // 抹掉己方城池
  ok(!Sim.canPlay(sim, 1, 1).ok && Sim.canPlay(sim, 1, 1).reason === '无己方城池', '固守：无己方城池时拒绝并给出原因');
}

section('阵列 id 稳定（v1.10）');
{
  const sim = unitSim(95);
  const me = sim.castles[0]; me.garrison = 80;
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'pt', x: me.x + 200, y: me.y - 130 }, ratio: 0.25 });
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'pt', x: me.x + 200, y: me.y + 150 }, ratio: 0.25 });
  run(sim, 4);
  ok(sim.camps.length === 2, '两个阵列同时在场');
  const c1 = sim.camps[0], c2 = sim.camps[1];
  const id2 = c2.id, cnt2 = c2.count;
  Sim.command(sim, { owner: 1, from: [{ k: 'p', id: c1.id }], to: { k: 'c', id: 0 }, ratio: 1 });
  run(sim, 6);
  ok(sim.camps.length === 1, '第一个阵列派空后清场');
  const left = Sim.campById(sim, id2);
  ok(!!left && Math.abs(left.count - cnt2) <= 2, '第二个阵列 id 稳定：仍可按 id 命中同一阵列',
     'id=' + id2 + ' 兵 ' + (left ? left.count : 'null') + '（原 ' + cnt2 + '）');
}

section('AI 火攻点杀最强敌对阵营（v1.10）');
{
  const sim = Sim.createGame({ opponents: 2, castles: 9, diff: 'hard', seed: 96, noAI: true });
  const setup = () => sim.castles.forEach(c => {
    c.garrison = c.owner === 1 ? 39 : c.owner === 2 ? 30 : c.owner === 3 ? 90 : c.garrison;   // 3 号最厚，1 号次厚
  });
  sim.t = 30;
  let fired = 0, hitP1 = 0, hitP3 = 0;
  for (let i = 0; i < 80 && fired < 6; i++){
    setup();                                     // 每轮复位驻军，保证「3 号最厚」这一前提恒定
    sim.ink[2] = 10; sim.aiCardCd[2] = 0;
    sim.piles[2].hand = ['fire']; sim.hands[2] = sim.piles[2].hand;   // v1.16：AI 只打手牌里的牌，直接备好火攻
    const before = sim.castles.map(c => c.garrison);
    Sim.aiTick(sim, 2);
    sim.castles.forEach((c, idx) => {
      if (c.garrison < before[idx] - 0.5){ fired++; if (c.owner === 1) hitP1++; if (c.owner === 3) hitP3++; }
    });
  }
  ok(fired > 0, '困难 AI 会发动火攻（采样 ' + fired + ' 次）');
  ok(hitP1 === 0 && hitP3 > 0, '火攻点杀最强敌对阵营（3 号 90 兵）而非固定打 1 号',
     '打1号 ' + hitP1 + ' 次 · 打3号 ' + hitP3 + ' 次');
}

section('单兵身份出队（v1.11 · 点哪个兵就哪个兵走）');
{
  const sim = unitSim(101);
  const me = sim.castles[0]; me.garrison = 30;
  const pt = { x: me.x + 40, y: me.y - 25 };
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: 0, pt: pt, ph: 1.234 }],
                     to: { k: 'pt', x: me.x + 300, y: me.y }, n: 1 });
  Sim.step(sim, DT);
  const a = sim.armies[0];
  ok(!!a && Sim.dist(a.x, a.y, pt.x, pt.y) < 4, '驻城单兵从被点中的那个兵的位置出发（非城池中心）',
     a ? '距点击点 ' + Sim.dist(a.x, a.y, pt.x, pt.y).toFixed(2) + ' · 距城心 ' + Sim.dist(a.x, a.y, me.x, me.y).toFixed(1) : 'null');
  ok(!!a && a.solo === true && a.ph0 === 1.234, '单兵携带 solo 标记并沿用该兵的运动相位');
  ok(!!a && Sim.dist(a.x, a.y, me.x, me.y) > 30, '出发点明显不在城池中心', '距城心 ' + Sim.dist(a.x, a.y, me.x, me.y).toFixed(1));
  ok(Math.abs(me.garrison - 29) < 0.2, '出兵后驻军 -1', 'g=' + me.garrison.toFixed(2));
}
{
  const sim2 = unitSim(102);
  const me2 = sim2.castles[0]; me2.garrison = 30;
  Sim.command(sim2, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'pt', x: me2.x + 300, y: me2.y }, ratio: 0.5 });
  Sim.step(sim2, DT);
  const a2 = sim2.armies[0];
  ok(a2.count === 15 && !a2.solo && Sim.dist(a2.x, a2.y, me2.x, me2.y) < 4, '整队派遣仍从城池中心出发且无 solo 标记');
}
{
  const sim3 = unitSim(103);
  const me3 = sim3.castles[0]; me3.garrison = 20;
  Sim.command(sim3, { owner: 1, from: [{ k: 'c', id: 0 }], to: { k: 'pt', x: me3.x + 400, y: me3.y }, ratio: 1 });
  Sim.step(sim3, DT);
  const army = sim3.armies[0];
  const sp = { x: army.x + 6, y: army.y - 4 };
  Sim.command(sim3, { type: 'split', owner: 1, armyId: army.id, n: 1, pt: sp, ph: 2.5,
                      to: { k: 'pt', x: me3.x, y: me3.y + 200 } });
  Sim.step(sim3, DT);
  const lone = sim3.armies.filter(x => x.solo)[0];
  ok(!!lone && Sim.dist(lone.x, lone.y, sp.x, sp.y) < 4 && lone.ph0 === 2.5,
     '在途单兵从被点中的位置离队并沿用相位',
     lone ? '距点击点 ' + Sim.dist(lone.x, lone.y, sp.x, sp.y).toFixed(2) : 'null');
  ok(army.count === 19 && !army.solo, '原队减 1 兵后继续原任务', 'count=' + army.count);
}

section('城池容量硬上限（v1.11）');
{
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 104, noAI: true });
  const me = sim.castles[0]; me.garrison = Sim.LEVELS[0].cap - 1;
  run(sim, 12);
  ok(me.garrison <= Sim.LEVELS[0].cap + 1e-9 && me.garrison > Sim.LEVELS[0].cap - 0.5,
     'Lv1 容量封顶：产兵到 ' + Sim.LEVELS[0].cap + ' 即停', 'g=' + me.garrison.toFixed(2));
  const sim2 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 105, noAI: true, dailies: ['wall'] });
  const me2 = sim2.castles[0]; me2.garrison = 200;
  run(sim2, 5);
  const capW = Math.round(Sim.LEVELS[0].cap * 1.2);
  ok(Math.abs(me2.garrison - capW) < 1e-9, '铁壁日卡下容量按 ×1.2 封顶（' + capW + '）', 'g=' + me2.garrison);
  // 增援类卡牌同样受容量封顶
  const sim3 = unitSim(106);
  const me3 = sim3.castles[0]; me3.garrison = 30;
  sim3.hands[1] = ['reinforce', 'fire', 'rush']; sim3.ink[1] = 10;
  Sim.cardPlay(sim3, 0, 0);
  ok(me3.garrison === Sim.LEVELS[0].cap, '增援 +25 溢出后按容量封顶（30→' + Sim.LEVELS[0].cap + '）', 'g=' + me3.garrison);
}

/* ============================================================
 * 11. v1.12：城池防御塔
 * ============================================================ */
section('城池防御塔（v1.12）');
{
  const s1 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 201, noAI: true, towerChance: 1 });
  ok(s1.castles.every(c => !!c.tower && Sim.TOWERS.some(t => t.kind === c.tower.kind)),
     'towerChance=1：每座城都有塔且种类合法');
  ok(s1.castles.every(c => c.tower.lv === 1 && c.tower.cd === 0), '开局塔等级 1 · 冷却就绪');
  const s0 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 201, noAI: true, towerChance: 0 });
  ok(s0.castles.every(c => c.tower === null), 'towerChance=0：全图无塔');
  const mapKey = s => JSON.stringify({ p: s.castles.map(c => [c.owner, c.x, c.y, c.garrison]), h: s.hands[1] });
  ok(mapKey(s0) === mapKey(s1),
     '塔掷点走独立随机源：开关塔不改变地图点位/归属/驻军/手牌（既有断言不受污染）');
  ok(Sim.TOWERS.map(t => t.kind).join(',') === 'cannon,arrow,mage,claw', '四种塔：炮(溅射)/箭(速射)/法(高伤)/爪(抓兵)');
  ok(Sim.TOWERS.every((t, i) => i === 0 || t.cd !== Sim.TOWERS[0].cd), '各塔冷却/伤害参数互不相同');
}

/* 塔火单元测试：把敌军钉在距城 d 处，避免抵达结算干扰 */
function towerFire(kind, seconds, d, armyOwner, castleOwner, castleLevel){
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 202, noAI: true, towerChance: 0 });
  const c = sim.castles[0];
  if (castleOwner != null) c.owner = castleOwner;
  if (castleLevel != null) c.level = castleLevel;
  c.tower = { kind: kind, lv: 1, cd: 0 };
  c.garrison = 0;
  const a = { id: 9001, owner: armyOwner == null ? 2 : armyOwner, count: 200,
              x: c.x + d, y: c.y, tx: c.x + d + 5000, ty: c.y, tKind: 'pt', tid: -1, srcId: -1,
              hx: c.x + d, hy: c.y, atkT: 0 };
  sim.armies.push(a);
  const n = Math.round(seconds / DT);
  let shots = 0;
  for (let i = 0; i < n; i++){
    a.x = c.x + d; a.y = c.y;                      // 钉住：让部队稳定停在射程内
    Sim.step(sim, DT);
    shots += sim.events.filter(e => e.type === 'tower').length;
    sim.events.length = 0;
  }
  return { sim: sim, c: c, a: a, shots: shots, lost: 200 - a.count };
}
{
  const arrow = towerFire('arrow', 3, 100);
  const mage = towerFire('mage', 3, 100);
  ok(arrow.shots > mage.shots,
     '箭塔射速更快：3s 内开火 ' + arrow.shots + ' 次 > 法师塔 ' + mage.shots + ' 次');
  ok(mage.lost / Math.max(1, mage.shots) > arrow.lost / Math.max(1, arrow.shots),
     '法师塔单次减员更高：' + (mage.lost / Math.max(1, mage.shots)) + ' > ' + (arrow.lost / Math.max(1, arrow.shots)));
  ok(arrow.lost === arrow.shots * 1 && mage.lost === mage.shots * 6,
     '伤害数值与配置一致（箭 1/发 · 法 6/发）', '箭 ' + arrow.lost + ' · 法 ' + mage.lost);
  const far = towerFire('arrow', 2, 260);          // 箭塔射程 150
  ok(far.shots === 0 && far.a.count === 200, '射程外不受塔火影响', '开火 ' + far.shots + ' 次');
  const own = towerFire('arrow', 2, 100, 1);       // 己方部队
  ok(own.shots === 0 && own.a.count === 200, '塔不攻击己方部队', '开火 ' + own.shots + ' 次');
}
{
  // 炮塔溅射：两支相邻敌军同时减员
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 203, noAI: true, towerChance: 0 });
  const c = sim.castles[0];
  c.tower = { kind: 'cannon', lv: 1, cd: 0 };
  const mkA = (id, dx) => ({ id: id, owner: 2, count: 200, x: c.x + dx, y: c.y, tx: c.x + dx + 5000, ty: c.y, tKind: 'pt', tid: -1, srcId: -1, hx: c.x + dx, hy: c.y, atkT: 0 });
  const a1 = mkA(9101, 100), a2 = mkA(9102, 140);   // 相距 40 < 溅射半径 70
  sim.armies.push(a1, a2);
  for (let i = 0; i < 2; i++){ a1.x = c.x + 100; a1.y = c.y; a2.x = c.x + 140; a2.y = c.y; Sim.step(sim, DT); }
  ok(a1.count === 197 && a2.count === 197, '炮塔溅射：主目标与相邻敌军同时 -3',
     '主 ' + a1.count + ' · 邻 ' + a2.count);
}
{
  // 爪子：抓 30% 转为己方驻军（大容量城满额转化）
  const grab = towerFire('claw', 1 / 30 + DT, 100, null, null, 3);
  ok(grab.a.count === 200 - 60, '爪子抓走三成敌军（200→140）', '剩 ' + grab.a.count);
  ok(grab.c.garrison >= 60 && grab.c.garrison < 61, '抓来的兵转化为己方驻军（+60）',
     '驻军 ' + grab.c.garrison.toFixed(2));
  // 容量封顶：小城抓兵不撑爆上限
  const grabCap = towerFire('claw', 1 / 30 + DT, 100, null, null, 1);
  ok(grabCap.c.garrison === Sim.LEVELS[0].cap, '抓兵转化受城池容量封顶（Lv1 → ' + Sim.LEVELS[0].cap + '）',
     '驻军 ' + grabCap.c.garrison.toFixed(2));
  // 中立城爪子：只扣兵不加驻军
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 208, noAI: true, towerChance: 0 });
  const nc = sim.castles.find(x => x.owner === 0);
  nc.tower = { kind: 'claw', lv: 1, cd: 0 };
  const g0 = nc.garrison;
  const a = { id: 9201, owner: 2, count: 100, x: nc.x + 60, y: nc.y, tx: nc.x + 5000, ty: nc.y, tKind: 'pt', tid: -1, srcId: -1, hx: nc.x + 60, hy: nc.y, atkT: 0 };
  sim.armies.push(a);
  for (let i = 0; i < 2; i++){ a.x = nc.x + 60; a.y = nc.y; Sim.step(sim, DT); }
  ok(a.count === 70, '中立城爪子照常扣兵（100→70）', '剩 ' + a.count);
  ok(Math.abs(nc.garrison - g0) < 1e-9, '中立城不产兵：爪子只消耗，不转化驻军', g0 + '→' + nc.garrison);
}
{
  // 占领带塔的中立城 → 塔随城保留并为新城主开火
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 205, noAI: true, towerChance: 1 });
  const me = sim.castles[0], neu = sim.castles.find(c => c.owner === 0);
  const kindBefore = neu.tower.kind;
  neu.x = me.x + 240; neu.y = me.y; neu.garrison = 5; me.garrison = 100;
  Sim.command(sim, { owner: 1, from: [{ k: 'c', id: me.id }], to: { k: 'c', id: neu.id }, ratio: 1 });
  run(sim, 6);
  ok(neu.owner === 1, '占领中立城成功');
  ok(neu.tower && neu.tower.kind === kindBefore, '开局随机 · 占领后保留：塔随城易主而保留',
     '占领前 ' + kindBefore + ' → 占领后 ' + (neu.tower ? neu.tower.kind : 'null'));
  const a = { id: 9301, owner: 2, count: 200, x: neu.x + 60, y: neu.y, tx: neu.x + 5000, ty: neu.y, tKind: 'pt', tid: -1, srcId: -1, hx: neu.x + 60, hy: neu.y, atkT: 0 };
  sim.armies.push(a);
  let fired = 0;
  for (let i = 0; i < 30; i++){
    a.x = neu.x + 60; a.y = neu.y;
    Sim.step(sim, DT);
    fired += sim.events.filter(e => e.type === 'tower' && e.x === neu.x && e.y === neu.y).length;
    sim.events.length = 0;
  }
  ok(fired > 0, '易主后的塔为新城主开火（1s 内 ' + fired + ' 次）');
  ok(a.count < 200 || neu.garrison > 0, '塔火作用于原主（2 号）部队', '兵 ' + a.count);
}

/* v1.32：塔索敌目标集由「只打在途部队」扩到「在途部队 + 阵列」
   —— 此前敌军在塔射程内扎营，塔一枪不放（围城屯兵成了绝对盲区，观感即「这座塔坏了」） */
function campFire(kind, seconds, d, campOwner, castleOwner, castleLevel){
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 206, noAI: true, towerChance: 0 });
  const c = sim.castles[0];
  if (castleOwner != null) c.owner = castleOwner;
  if (castleLevel != null) c.level = castleLevel;
  c.garrison = 0;
  c.tower = { kind: kind, lv: 1, cd: 0 };
  const p = { id: 9401, owner: campOwner == null ? 2 : campOwner, x: c.x + d, y: c.y, count: 200, atkT: 0 };
  sim.camps.push(p);
  const n = Math.round(seconds / DT);
  let shots = 0;
  for (let i = 0; i < n; i++){
    Sim.step(sim, DT);
    shots += sim.events.filter(e => e.type === 'tower').length;
    sim.events.length = 0;
  }
  return { sim: sim, c: c, p: p, shots: shots, left: sim.camps.indexOf(p) >= 0 ? p.count : 0 };
}
{
  for (const t of Sim.TOWERS){
    const r = Sim.towerStat({ kind: t.kind, lv: 1 }, 'range');
    const f = campFire(t.kind, 6, r * 0.6);
    if (t.kind === 'claw'){
      ok(f.shots > 0 && f.left < 200, '★ ' + t.name + ' 会攻击射程内敌方阵列（抓兵）',
         '开火 ' + f.shots + ' · 阵列 200→' + f.left.toFixed(0));
    } else {
      ok(f.shots > 0 && f.left < 200, '★ ' + t.name + ' 会攻击射程内敌方阵列',
         '开火 ' + f.shots + ' · 阵列 200→' + f.left.toFixed(0));
    }
  }
  const out = campFire('arrow', 2, 260);                 // 箭塔射程 150
  ok(out.shots === 0 && out.left === 200, '射程外的阵列不受塔火影响', '开火 ' + out.shots + ' 次');
  const own2 = campFire('arrow', 2, 100, 1);             // 己方阵列
  ok(own2.shots === 0 && own2.left === 200, '塔不攻击己方阵列', '开火 ' + own2.shots + ' 次');
}
{
  /* 索敌优先级：阵列比在途部队更近时先打阵列（统一按距离取最近） */
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 207, noAI: true, towerChance: 0 });
  const c = sim.castles[0];
  c.tower = { kind: 'arrow', lv: 1, cd: 0 };             // 射程 150
  sim.camps.push({ id: 9501, owner: 2, x: c.x + 60, y: c.y, count: 200, atkT: 0 });
  const farArmy = { id: 9502, owner: 2, count: 200, x: c.x + 140, y: c.y, tx: c.x + 5000, ty: c.y,
                    tKind: 'pt', tid: -1, srcId: -1, hx: c.x + 140, hy: c.y, atkT: 0 };
  sim.armies.push(farArmy);
  for (let i = 0; i < 30 * 2; i++){ farArmy.x = c.x + 140; farArmy.y = c.y; Sim.step(sim, DT); sim.events.length = 0; }
  const camp = sim.camps.find(x => x.id === 9501);
  ok(camp && camp.count < 200 && farArmy.count === 200, '★ 索敌取最近：先打更近的阵列，在途部队不受影响',
     '阵列 ' + (camp ? camp.count.toFixed(0) : 'null') + ' · 部队 ' + farArmy.count);
}
{
  /* 炮塔溅射波及阵列：主目标是阵列时，落点 70 内的另一支阵列同样减员 */
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 209, noAI: true, towerChance: 0 });
  const c = sim.castles[0];
  c.tower = { kind: 'cannon', lv: 1, cd: 0 };
  sim.camps.push({ id: 9601, owner: 2, x: c.x + 100, y: c.y, count: 200, atkT: 0 });
  sim.camps.push({ id: 9602, owner: 2, x: c.x + 140, y: c.y, count: 200, atkT: 0 });   // 相距 40 < 70
  for (let i = 0; i < 2; i++) Sim.step(sim, DT);
  const p1 = sim.camps.find(x => x.id === 9601), p2 = sim.camps.find(x => x.id === 9602);
  ok(p1 && p2 && p1.count === 197 && p2.count === 197, '★ 炮塔溅射由主目标波及相邻阵列（各 -3）',
     '主 ' + (p1 ? p1.count : 'null') + ' · 邻 ' + (p2 ? p2.count : 'null'));
}
{
  /* 爪子抓阵列的兵同样转化为己方驻军 */
  const g = campFire('claw', 1 / 30 + DT, 60, 2, 1, 3);   // Lv3 城容量 110，装得下抓来的 60
  ok(g.p.count === 140, '爪子从阵列抓走三成（200→140）', '剩 ' + g.p.count);
  ok(g.c.garrison >= 60, '抓来的兵同样转化为己方驻军（+60）', '驻军 ' + g.c.garrison.toFixed(1));
  /* 中立城的塔也打阵列（中立不产兵，爪子只消耗） */
  const n2 = campFire('claw', 1 / 30 + DT, 60, 2, 0);
  ok(n2.p.count === 140, '中立城的塔同样攻击阵列', '剩 ' + n2.p.count);
}

{
  /* v1.32 全塔体检矩阵：四种塔 × {在途部队 / 阵列} × {射程内 / 射程外 / 己方} = 24 格。
     一格不达标 = 某种塔存在盲区，即「部分炮塔不攻击」的回归闸门（修复前 4 个「阵内」格全灭）。 */
  const cells = [];
  for (const t of Sim.TOWERS){
    const r = Sim.towerStat({ kind: t.kind, lv: 1 }, 'range');
    const inA = towerFire(t.kind, 4, r * 0.6), inP = campFire(t.kind, 4, r * 0.6);
    const outA = towerFire(t.kind, 2, r * 1.6), outP = campFire(t.kind, 2, r * 1.6);
    const ownA = towerFire(t.kind, 2, r * 0.6, 1), ownP = campFire(t.kind, 2, r * 0.6, 1);
    cells.push([t.kind + '·兵内', inA.shots > 0 && inA.lost > 0],
               [t.kind + '·阵内', inP.shots > 0 && inP.left < 200],
               [t.kind + '·兵外', outA.shots === 0],
               [t.kind + '·阵外', outP.shots === 0],
               [t.kind + '·己兵', ownA.shots === 0],
               [t.kind + '·己阵', ownP.shots === 0]);
  }
  const bad = cells.filter(x => !x[1]).map(x => x[0]);
  ok(bad.length === 0, '★ 全塔体检矩阵 4 塔 × 6 格（兵/阵 × 射程内/外/己方）共 24 格全部达标',
     bad.length ? '不达标：' + bad.join(' ') : '24/24');
  /* 冷却一致性：射程内常驻目标时，开火次数与「时长 / 冷却」相符（冷却不会卡死也不会失效） */
  const cdArrow = towerFire('arrow', 10, 80);
  const want = 10 / Sim.towerStat({ kind: 'arrow', lv: 1 }, 'cd');
  ok(Math.abs(cdArrow.shots - want) <= 1.5, '箭塔冷却链路正常（10s 内 ' + cdArrow.shots + ' 发，理论 ' + want.toFixed(1) + '）');
}

/* ============================================================
 * 12. v1.12：等级嵌套环 · 升级建塔
 * ============================================================ */
section('等级、嵌套与升级建塔（v1.12）');
{
  /* 嵌套环：等级 = 环数，半径 r*(i+1)/(level+1) 由内向外递增 */
  const rings = lv => { const out = []; for (let i = 0; i < lv; i++) out.push(i); return out; };
  ok(rings(1).length === 1 && rings(2).length === 2 && rings(3).length === 3, '嵌套环数量 = 城池等级（Lv1/2/3 → 1/2/3 层）');
  /* 与块2 levelRingR 同式：环数 = 等级，半径 r×(0.45 + 0.47×(i+1)/level)，由内向外等分且不压住中央数字 */
  const rad = (lv, i, r) => r * (0.45 + 0.47 * (i + 1) / lv);
  const R1 = 24, R3 = 24 + 2 * 10;
  const w3 = [0, 1, 2].map(i => rad(3, i, R3));
  ok(w3[0] < w3[1] && w3[1] < w3[2] && Math.abs(w3[0] - 26.69) < 0.01 && Math.abs(w3[2] - 40.48) < 0.01,
     'Lv3 三层环半径递增（' + w3.map(v => v.toFixed(1)).join('/') + '）');
  ok(rad(3, 2, R3) < R3 && rad(3, 0, R3) > R3 * 0.5, '嵌套环落在城池圆内且不侵占中央数字区',
     rad(3, 0, R3).toFixed(1) + '~' + rad(3, 2, R3).toFixed(1) + ' < ' + R3);
  ok(Math.abs(rad(1, 0, R1) - 22.08) < 0.01 && Math.abs(rad(2, 0, R1) - 16.44) < 0.01 && Math.abs(rad(2, 1, R1) - 22.08) < 0.01,
     'Lv1 单层 22.1 · Lv2 两层 16.4/22.1');
  /* 塔属性随塔等级成长 */
  const t1 = { kind: 'mage', lv: 1 }, t3 = { kind: 'mage', lv: 3 };
  ok(Math.abs(Sim.towerStat(t1, 'dmg') - 6) < 1e-9 && Math.abs(Sim.towerStat(t3, 'dmg') - 12) < 1e-9,
     '塔伤害 ×(1+0.5k)：法师塔 Lv1 6 → Lv3 12');
  ok(Math.abs(Sim.towerStat(t3, 'range') - 170 * 1.3) < 1e-6, '塔射程 ×(1+0.15k)：Lv3 = ' + (170 * 1.3).toFixed(0));
  ok(Math.abs(Sim.towerStat(t3, 'cd') - 2.8 * 0.7) < 1e-6, '塔冷却 ×(1-0.15k)：Lv3 = ' + (2.8 * 0.7).toFixed(2) + 's');
  ok(Sim.CFG.TOWER_MAX_LV === 3, '塔等级上限 3');

  /* 升级建塔概率 */
  const mkUp = p => {
    const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 206, noAI: true, towerChance: 0, upTowerChance: p });
    const src = addCastle(sim, 1, 200, 200, 1, 30);
    const dst = addCastle(sim, 1, 500, 200, 1, 0);
    Sim.command(sim, { owner: 1, from: [{ k: 'c', id: src.id }], to: { k: 'c', id: dst.id }, ratio: 1 });
    run(sim, 5);
    return dst;
  };
  const d1 = mkUp(1), d0 = mkUp(0);
  ok(d1.level === 2 && d0.level === 2, '增援 30 兵触发升级 Lv2（消耗 20）');
  ok(!!d1.tower && d1.tower.lv === 1, 'upTowerChance=1：升级后必建塔（Lv1）');
  ok(d0.tower === null, 'upTowerChance=0：升级后不建塔');

  /* 已有塔 → 升级时升塔，封顶 TOWER_MAX_LV */
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 207, noAI: true, towerChance: 0, upTowerChance: 1 });
  const src = addCastle(sim, 1, 200, 200, 3, 60);
  const dst = addCastle(sim, 1, 500, 200, 1, 0);
  dst.tower = { kind: 'arrow', lv: 1, cd: 0 };
  const feed = () => { src.garrison = 60; Sim.command(sim, { owner: 1, from: [{ k: 'c', id: src.id }], to: { k: 'c', id: dst.id }, ratio: 1 }); run(sim, 5); };
  feed();
  ok(dst.level === 2 && dst.tower.lv === 2, '已有塔时升级 → 塔升一级（Lv1→Lv2）', '城 Lv' + dst.level + ' 塔 Lv' + dst.tower.lv);
  feed();
  ok(dst.level === 3 && dst.tower.lv === 3, '再升级 → 塔 Lv3', '城 Lv' + dst.level + ' 塔 Lv' + dst.tower.lv);
  feed();
  ok(dst.tower.lv === Sim.CFG.TOWER_MAX_LV, '塔等级封顶不溢出（仍为 Lv' + Sim.CFG.TOWER_MAX_LV + '）', '塔 Lv' + dst.tower.lv);
}

/* ============================================================
 * 13. v1.32：士兵进城升级（主动消耗驻军）
 * ============================================================ */
section('士兵进城升级（v1.32）');
{
  ok(Sim.upgradeNeed({ level: 1 }) === 20 && Sim.upgradeNeed({ level: 2 }) === 50 && Sim.upgradeNeed({ level: 3 }) === 0,
     '数值规则：Lv1→2 消耗 20 兵，Lv2→3 消耗 50 兵，Lv3 封顶');

  /* 单一升级入口：精确扣兵、等级 +1、事件带消耗量。 */
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 301, noAI: true, towerChance: 0, upTowerChance: 0 });
  const c = sim.castles.find(x => x.owner === 1);
  c.level = 1; c.garrison = 20; c.tower = null;
  const did = Sim.upgradeCastle(sim, c);
  const ev = sim.events.find(e => e.type === 'upgrade');
  ok(did && c.level === 2 && c.garrison === 0, '主动升级：恰好消耗 20 兵并升至 Lv2', 'Lv' + c.level + ' g=' + c.garrison);
  ok(ev && ev.id === c.id && ev.owner === 1 && ev.spent === 20 && ev.level === 2,
     '升级事件携带城池 / 阵营 / 消耗 / 新等级（供界面与联机表现同步）', JSON.stringify(ev));
  ok(c.tower === null, 'upTowerChance=0：主动升级不凭空建塔');

  /* 军令队列：与派兵/改向一样只在 step 步首结算。 */
  const qsim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 302, noAI: true, towerChance: 0, upTowerChance: 0 });
  const qc = qsim.castles.find(x => x.owner === 1);
  qc.level = 1; qc.garrison = 25;
  Sim.command(qsim, { type: 'castleUp', owner: 1, id: qc.id });
  ok(qc.level === 1 && qc.garrison === 25, '升级军令先入队，不在输入回调里直接改状态');
  Sim.step(qsim, DT);
  ok(qc.level === 2 && qc.garrison >= 5 && qc.garrison < 5.1,
     '下一固定步结算升级：等级 +1、扣 20 兵后再按新等级产兵', 'Lv' + qc.level + ' g=' + qc.garrison.toFixed(3));

  /* 失败分支必须原子化：不足、越权、满级、已结束均不扣兵不升级。 */
  const fsim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 303, noAI: true, towerChance: 0, upTowerChance: 0 });
  const fc = fsim.castles.find(x => x.owner === 1);
  fc.level = 2; fc.garrison = 49;
  ok(!Sim.canUpgrade(fsim, fc, 1), '兵力不足：49/50 时不可升级');
  Sim.command(fsim, { type: 'castleUp', owner: 1, id: fc.id }); Sim.step(fsim, DT);
  ok(fc.level === 2 && fc.garrison > 49, '兵力不足不扣兵、不升级（只发生正常产兵）', 'Lv' + fc.level + ' g=' + fc.garrison.toFixed(3));
  fc.garrison = 60;
  Sim.command(fsim, { type: 'castleUp', owner: 2, id: fc.id }); Sim.step(fsim, DT);
  ok(fc.level === 2 && fc.garrison >= 60, '越权阵营不能升级或消耗他方城池');
  fc.level = 3; fc.garrison = 70;
  Sim.command(fsim, { type: 'castleUp', owner: 1, id: fc.id }); Sim.step(fsim, DT);
  ok(fc.level === 3 && fc.garrison >= 70, '已达最高等级：保持 Lv3，不再消耗兵力');
  fsim.over = 1;
  ok(!Sim.canUpgrade(fsim, fc, 1), '对局结束后升级入口关闭');

  /* 第二级数值：50 兵换 Lv3；容量与产速直接切到 LEVELS[2]。 */
  const s3 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 304, noAI: true, towerChance: 0, upTowerChance: 0 });
  const c3 = s3.castles.find(x => x.owner === 1);
  c3.level = 2; c3.garrison = 55;
  ok(Sim.upgradeCastle(s3, c3) && c3.level === 3 && c3.garrison === 5,
     'Lv2→Lv3：消耗 50 兵，剩余 5 兵');
  ok(Sim.LEVELS[c3.level - 1].cap === 110 && Sim.LEVELS[c3.level - 1].rate === 1.8,
     '升至 Lv3 后容量 110、产速 1.8/秒');
}

/* ============================================================
 * 14. 牌库循环（v1.14，杀戮尖塔式）
 * ============================================================ */
section('牌库循环 · 抽牌 / 洗牌 / 消耗（v1.14）');
{
  const C = Sim.CFG;
  ok(C.HAND_MAX === 5 && C.DRAW_T === 6 && C.START_HAND === 3,
     '配置：手牌上限 5 · 抽牌间隔 6s · 开局 3 张');
  ok(Sim.DEFAULT_DECK.length === 12, '默认卡组 12 张（v1.18 收编征兵/疾驰/箭雨）', '实际 ' + Sim.DEFAULT_DECK.length);

  /* 开局：卡组洗入抽牌堆，抽 3 张 */
  const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 401, noAI: true });
  ok(sim.piles[1].list.length === 12 && sim.piles[1].draw.length === 9,
     '开局：卡组 12 张 → 抽牌堆 9 + 手牌 3', 'draw=' + sim.piles[1].draw.length);
  ok(sim.hands[1] === sim.piles[1].hand, 'hands[1] 与 piles[1].hand 为同一数组（兼容别名）');
  ok(sim.piles[1].discard.length === 0 && sim.piles[1].exhaust.length === 0, '开局弃牌堆/消耗堆为空');

  /* 定时抽牌 */
  run(sim, 6.05);
  ok(sim.piles[1].hand.length === 4, '6 秒后抽到 4 张', '实际 ' + sim.piles[1].hand.length);
  run(sim, 6.05);
  ok(sim.piles[1].hand.length === 5 && sim.piles[1].draw.length === 7, '12 秒后满手 5 张（抽牌堆 7）',
     'hand=' + sim.piles[1].hand.length + ' draw=' + sim.piles[1].draw.length);
  run(sim, 30);
  ok(sim.piles[1].hand.length === 5 && sim.piles[1].draw.length === 7,
     '手牌满后不再抽（计时器封顶，不囤积）', 'hand=' + sim.piles[1].hand.length + ' draw=' + sim.piles[1].draw.length);
  ok(sim.drawAcc[1] <= C.DRAW_T + 1e-9, '抽牌计时器封顶在 DRAW_T（最多积压 1 次）', 'acc=' + sim.drawAcc[1].toFixed(2));

  /* 洗牌：抽牌堆空 → 弃牌堆洗回 */
  const s2 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 402, noAI: true });
  s2.piles[1].draw = ['fire']; s2.piles[1].discard = ['rush', 'weak', 'surge']; s2.piles[1].hand = [];
  s2.events.length = 0;
  Sim.drawOne(s2, 1);
  ok(s2.piles[1].hand.length === 1 && s2.piles[1].draw.length === 0, '抽走最后一张后抽牌堆为空');
  Sim.drawOne(s2, 1);
  ok(s2.piles[1].discard.length === 0 && s2.piles[1].draw.length === 2 && s2.piles[1].hand.length === 2,
     '抽牌堆空 → 弃牌堆整堆洗回（3 张洗入、取走 1 张）',
     'draw=' + s2.piles[1].draw.length + ' discard=' + s2.piles[1].discard.length);
  ok(s2.events.some(e => e.type === 'shuffle' && e.owner === 1), '洗牌推送 shuffle 事件');

  /* 两堆皆空 → 不再抽牌 */
  const s3 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 403, noAI: true });
  s3.piles[1].draw = []; s3.piles[1].discard = []; s3.piles[1].hand = [];
  const got = Sim.drawOne(s3, 1);
  ok(got === null && s3.piles[1].hand.length === 0, '抽牌堆与弃牌堆皆空 → 抽不到牌（返回 null）');
  run(s3, 20);
  ok(s3.piles[1].hand.length === 0, '牌打光后不再凭空抽牌');

  /* 出牌：进弃牌堆；消耗牌进消耗堆 */
  const s4 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 404, noAI: true });
  const foe4 = s4.castles.find(c => c.owner === 2); foe4.garrison = 50;
  s4.hands[1] = ['fire', 'dagger', 'shield']; s4.ink[1] = 20;
  Sim.cardPlay(s4, 0, foe4.id);
  ok(s4.piles[1].discard[0] === 'fire' && s4.piles[1].exhaust.length === 0, '普通牌打出进弃牌堆');
  Sim.cardPlay(s4, 0, -1);                                      // 借刀：无目标
  ok(s4.piles[1].exhaust[0] === 'dagger' && s4.piles[1].discard.length === 1,
     '消耗牌（借刀）打出进消耗堆', 'exhaust=' + JSON.stringify(s4.piles[1].exhaust));
  /* 洗牌不会把消耗堆洗回来 */
  s4.piles[1].draw = []; s4.piles[1].hand = [];
  Sim.drawOne(s4, 1);
  ok(s4.piles[1].exhaust.length === 1 && !s4.piles[1].draw.includes('dagger'),
     '洗牌只洗弃牌堆，消耗牌本局不再出现');

  /* 洗牌随机源 drng 与主线 rng 隔离：狂洗牌后对局完全一致
     v1.16 注：AI 会用牌后，「牌面不同」本身会改变战局，故这里用 easy（cardLv 0 = 不用牌）隔离，
     只验证「洗牌不污染地图 / AI 决策」这一随机源命题 */
  const s5 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 405 });
  const s6 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 405 });
  for (let i = 0; i < 200; i++){
    Sim.drawOne(s6, 1); Sim.drawOne(s6, 2);
    s6.piles[1].hand.length = 0; s6.piles[2].hand.length = 0;
  }
  run(s5, 25); run(s6, 25);
  ok(JSON.stringify(s5.castles) === JSON.stringify(s6.castles),
     '洗牌走 drng：洗 200 次后与基线对局逐城一致（地图/AI 不受污染）');

  /* 卡组下限：少于 MIN_DECK 自动补默认牌 */
  const s7 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 406, noAI: true, decks: { 1: ['fire'] } });
  ok(s7.piles[1].list.length === C.MIN_DECK, '卡组不足 6 张 → 自动补足到 ' + C.MIN_DECK,
     '实际 ' + s7.piles[1].list.length);
  ok(Sim.CFG.MIN_DECK === 6, '卡组下限 6');
}

section('稀有度 / 消耗 / 升级版数值（v1.14）');
{
  const base = Sim.CARDS.filter(c => !c.up);
  ok(base.length === 25, '基础卡 25 张（v1.24 +7）');
  ok(base.every(c => c.rar === 'c' || c.rar === 'u' || c.rar === 'r'), '每张卡都有稀有度');
  const ex = base.filter(c => c.ex).map(c => c.key).sort();
  ok(ex.length === 3 && ex.join(',') === 'dagger,defect,rally', '消耗牌 3 张：借刀 / 策反 / 勤王', '实际 ' + ex.join(','));
  ok(base.filter(c => c.rar === 'r').length === 5 && base.filter(c => c.rar === 'u').length === 11 &&
     base.filter(c => c.rar === 'c').length === 9,
     '稀有 5 张 · 罕见 11 张 · 普通 9 张',
     '实际 ' + base.filter(c => c.rar === 'r').length + '/' + base.filter(c => c.rar === 'u').length + '/' + base.filter(c => c.rar === 'c').length);

  const ups = Sim.CARDS.filter(c => c.up);
  ok(ups.length === 25 && ups.every(c => c.base && c.v != null), '25 张升级版，均带 base 与数值');

  /* v1.19：卡面插画资产表（块2 的字符串资产，此处只能做静态交叉校验——
     每一张卡都必须有对应的插画 entry，否则卡面会出现空白图区） */
  const a0 = html.indexOf('var ART = {'), a1 = html.indexOf('/* ===== v1.19 卡面插画·结束 ===== */');
  const artBlock = (a0 >= 0 && a1 > a0) ? html.slice(a0, a1) : '';
  ok(artBlock.length > 2000, '插画资产表已就位（哨兵注释可被静态切片命中）', 'len=' + artBlock.length);
  ok(base.every(c => new RegExp('[\'"]' + c.key + '[\'"]\\s*:').test(artBlock)),
     '25 张基础卡在插画表中都有 entry',
     '缺：' + base.filter(c => !new RegExp('[\'"]' + c.key + '[\'"]\\s*:').test(artBlock)).map(c => c.key).join(','));
  ok(Sim.DAILIES.every(d => new RegExp('[\'"]' + d.key + '[\'"]\\s*:').test(artBlock)),
     '5 张日卡在插画表中都有 entry',
     '缺：' + Sim.DAILIES.filter(d => !new RegExp('[\'"]' + d.key + '[\'"]\\s*:').test(artBlock)).map(d => d.key).join(','));

  /* 单卡数值对比：原版 vs 升级版 */
  function playKey(sim, key, targetId){
    sim.hands[1] = [key]; sim.ink[1] = 20;
    return Sim.cardPlay(sim, 0, targetId, 1);
  }
  function mk(){
    const sim = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 407, noAI: true });
    return sim;
  }
  /* 火攻 40% → 60% */
  {
    const a = mk(), b = mk();
    const fa = a.castles.find(c => c.owner === 2), fb = b.castles.find(c => c.owner === 2);
    fa.garrison = 50; fb.garrison = 50;
    playKey(a, 'fire', fa.id); playKey(b, 'fire+', fb.id);
    ok(fa.garrison === 30 && fb.garrison === 20, '火攻 40% → 火攻+ 60%（50→30 / 50→20）',
       fa.garrison + ' / ' + fb.garrison);
  }
  /* 增援 25 → 40（用 Lv3 城避免容量截断） */
  {
    const a = mk(), b = mk();
    const ca = a.castles[0], cb = b.castles[0];
    ca.level = 3; ca.garrison = 0; cb.level = 3; cb.garrison = 0;
    playKey(a, 'reinforce', ca.id); playKey(b, 'reinforce+', cb.id);
    ok(ca.garrison === 25 && cb.garrison === 40, '增援 +25 → 增援+ +40', ca.garrison + ' / ' + cb.garrison);
  }
  /* 护盾 8s → 12s、虚弱 10s → 14s、固守 8s → 12s */
  {
    const a = mk(), b = mk();
    playKey(a, 'shield', a.castles[0].id); playKey(b, 'shield+', b.castles[0].id);
    ok(a.castles[0].shieldT === 8 && b.castles[0].shieldT === 12, '护盾 8s → 护盾+ 12s');
    const c = mk(), d = mk();
    const fc = c.castles.find(x => x.owner === 2), fd = d.castles.find(x => x.owner === 2);
    playKey(c, 'weak', fc.id); playKey(d, 'weak+', fd.id);
    ok(fc.weakT === 10 && fd.weakT === 14, '虚弱 10s → 虚弱+ 14s');
    const e = mk(), f = mk();
    playKey(e, 'holdfast', e.castles[0].id); playKey(f, 'holdfast+', f.castles[0].id);
    ok(e.castles[0].buffT === 8 && f.castles[0].buffT === 12, '固守 8s → 固守+ 12s');
  }
  /* 疾行 10s → 14s、墨涌 +8 → +12 */
  {
    const a = mk(), b = mk();
    playKey(a, 'rush', -1); playKey(b, 'rush+', -1);
    ok(a.effects.rushT[1] === 10 && b.effects.rushT[1] === 14, '疾行 10s → 疾行+ 14s');
    const c = mk(), d = mk();
    c.castles[0].level = 3; c.castles[0].garrison = 0;
    d.castles[0].level = 3; d.castles[0].garrison = 0;
    playKey(c, 'surge', -1); playKey(d, 'surge+', -1);
    ok(c.castles[0].garrison === 8 && d.castles[0].garrison === 12, '墨涌 +8 → 墨涌+ +12',
       c.castles[0].garrison + ' / ' + d.castles[0].garrison);
  }
  /* 策反 30% → 45% */
  {
    const a = mk(), b = mk();
    const fa = a.castles.find(c => c.owner === 2), fb = b.castles.find(c => c.owner === 2);
    fa.garrison = 50; fb.garrison = 50;
    playKey(a, 'defect', fa.id); playKey(b, 'defect+', fb.id);
    ok(fa.garrison === 35 && fb.garrison === 28, '策反 30% → 策反+ 45%（50→35 / 50→28）',
       fa.garrison + ' / ' + fb.garrison);
  }
  /* 借刀 1 座 → 2 座中立城 */
  {
    const a = mk(), b = mk();
    const na = a.castles.filter(c => c.owner === 0).length, nb = b.castles.filter(c => c.owner === 0).length;
    a.ink[1] = 20; b.ink[1] = 20;
    playKey(a, 'dagger', -1); playKey(b, 'dagger+', -1);
    const na2 = a.castles.filter(c => c.owner === 0).length, nb2 = b.castles.filter(c => c.owner === 0).length;
    ok(na - na2 === 1 && nb - nb2 === 2, '借刀倒戈 1 座 → 借刀+ 倒戈 2 座',
       (na - na2) + ' / ' + (nb - nb2));
  }
  /* 围魏救赵：召回 → 召回 + 削两成 */
  {
    const a = mk(), b = mk();
    const mk2 = (sim, key) => {
      sim.armies.push({ id: 77, owner: 2, count: 10, x: 800, y: 450, tx: 200, ty: 450, tKind: 'c', tid: 0, srcId: 1, hx: 800, hy: 450 });
      playKey(sim, key, -1);
      const am = sim.armies.find(x => x.id === 77);
      return am ? am.count : 0;
    };
    ok(mk2(a, 'divert') === 10 && mk2(b, 'divert+') === 8,
       '围魏救赵召回不掉兵 → 围魏救赵+ 削两成（10 / 8）');
  }
  /* 神速三档升级倍数 */
  {
    const a = mk(), b = mk();
    playKey(a, 'star1', -1); playKey(b, 'star1+', -1);
    ok(Math.abs(a.effects.starMul[1] - 1.3) < 1e-9 && Math.abs(b.effects.starMul[1] - 1.45) < 1e-9,
       '神速★ +30% → ★+ +45%', a.effects.starMul[1] + ' / ' + b.effects.starMul[1]);
    const c = mk();
    playKey(c, 'star3+', -1);
    ok(Math.abs(c.effects.starMul[1] - 2.4) < 1e-9, '神速★★★+ +140%', '实际 ' + c.effects.starMul[1]);
  }
  /* 升级版可被 validTarget / canPlay 正常处理（target 字段随基础卡继承） */
  {
    const sim = mk();
    const foe = sim.castles.find(c => c.owner === 2);
    ok(Sim.validTarget(sim, 'fire+', 1, foe.id) && !Sim.validTarget(sim, 'fire+', 1, sim.castles[0].id),
       '升级版沿用基础卡的目标规则');
    sim.hands[1] = ['fire+']; sim.ink[1] = 1;
    ok(!Sim.canPlay(sim, 0, 1).ok, '升级版墨量不足时不可发动');
    sim.ink[1] = 10;
    ok(Sim.canPlay(sim, 0, 1).ok, '升级版墨量充足可发动');
  }
}

/* ============================================================
 * v1.18：卡牌扩充（征兵/疾驰/箭雨/屯田/勤王）+ 同名卡冷却
 * ============================================================ */
section('卡牌扩充与冷却（v1.18）');
{
  function mk18(seed){ return Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: seed || 601, noAI: true }); }
  function hand(s, key, ink){ s.hands[1] = [key]; s.ink[1] = ink == null ? 20 : ink; }
  function mkArmy(id, owner, count, x){
    return { id, owner, count, x, y: 300, tx: 100, ty: 100, tKind: 'pt', tid: -1, srcId: -1, hx: x, hy: 300, atkT: 0 };
  }
  /* 征兵：己方全城 +5，不碰中立/敌城 */
  {
    const s = mk18();
    s.castles.filter(c => c.owner === 1).forEach(c => { c.garrison = 10; });
    hand(s, 'levy');
    ok(Sim.cardPlay(s, 0, undefined, 1), '征兵可打出（无需目标）');
    ok(s.castles.filter(c => c.owner === 1).every(c => c.garrison === 15), '征兵：己方全城 +5');
    ok(s.castles.some(c => c.owner === 0 && c.garrison >= 18), '征兵不影响中立/敌城驻军');
  }
  /* 疾驰：短版疾行，同一增益通道取不缩短者 */
  {
    const s = mk18(); hand(s, 'sprint');
    Sim.cardPlay(s, 0, undefined, 1);
    ok(Math.abs(s.effects.rushT[1] - 5) < 1e-9, '疾驰：行军增益 5 秒', '实际 ' + s.effects.rushT[1]);
    hand(s, 'rush');
    Sim.cardPlay(s, 0, undefined, 1);
    ok(Math.abs(s.effects.rushT[1] - 10) < 1e-9, '疾驰后再疾行 → 取 10 秒（不缩短）', '实际 ' + s.effects.rushT[1]);
  }
  /* 箭雨：所有敌军在途部队按比例折损，己方不伤 */
  {
    const s = mk18();
    const f1 = mkArmy(900, 2, 100, 400), f2 = mkArmy(901, 2, 4, 500), mine = mkArmy(902, 1, 50, 600);
    s.armies.push(f1, f2, mine);
    hand(s, 'arrows');
    ok(Sim.cardPlay(s, 0, undefined, 1), '箭雨可打出');
    ok(f1.count === 70, '箭雨：敌军 100 → 70（折损三成）', '实际 ' + f1.count);
    ok(f2.count === 3, '箭雨按 floor 折损：4 → 3', '实际 ' + f2.count);
    ok(mine.count === 50, '箭雨不伤己方在途部队');
    ok(s.armies.some(a => a.id === 901), '折损后仍在途的部队保留');
  }
  /* 屯田：全城产速 ×2（阵营级增益，2 秒产量 = 无增益对照局的 2 倍） */
  {
    const s = mk18(); const me = s.castles.find(c => c.owner === 1);
    me.garrison = 0; me.level = 1;
    hand(s, 'granary');
    Sim.cardPlay(s, 0, undefined, 1);
    ok(s.effects.prodT[1] === 10, '屯田：产速增益 10 秒');
    const s2 = mk18(); const me2 = s2.castles.find(c => c.owner === 1);
    me2.garrison = 0; me2.level = 1;
    Sim.step(s, 2); Sim.step(s2, 2);
    ok(Math.abs(me.garrison - me2.garrison * 2) < 1e-6, '屯田生效：2 秒产量为无增益的 2 倍',
       me.garrison.toFixed(3) + ' vs ' + (me2.garrison * 2).toFixed(3));
  }
  /* 勤王：目标己城 + 420 内己城同时增兵，远处己城不动 */
  {
    const s = mk18();
    const me = s.castles.find(c => c.owner === 1);
    const near = { id: s.castles.length, owner: 1, x: me.x + 100, y: me.y, level: 1, garrison: 10, tower: null, shieldT: 0, weakT: 0, flashT: 0, buffT: 0, hitT: 0 };
    const farC = { id: s.castles.length + 1, owner: 1, x: me.x > 800 ? me.x - 700 : me.x + 700, y: me.y, level: 1, garrison: 10, tower: null, shieldT: 0, weakT: 0, flashT: 0, buffT: 0, hitT: 0 };
    s.castles.push(near, farC);
    me.garrison = 10;                                  // 主城初始 20，归一化后再验证增量
    hand(s, 'rally');
    ok(Sim.validTarget(s, 'rally', 1, me.id) && Sim.cardPlay(s, 0, me.id, 1), '勤王：以目标己城为圆心发动');
    ok(me.garrison === 28 && near.garrison === 28, '目标城 + 420 内己城各 +18', me.garrison + ' / ' + near.garrison);
    ok(farC.garrison === 10, '420 外的己城不受影响', '实际 ' + farC.garrison);
    ok(s.piles[1].exhaust.indexOf('rally') >= 0, '勤王为消耗牌：打出进消耗堆');
  }
  /* 同名卡冷却：打出 → 冷却中（reason 提示）→ 升级版共享 → 到期解禁 */
  {
    const s = mk18();
    hand(s, 'fire', 20);
    const foe = s.castles.find(c => c.owner === 2); foe.garrison = 50;
    ok(Sim.cardPlay(s, 0, foe.id, 1), '火攻首次可打出');
    s.hands[1] = ['fire'];
    const cp = Sim.canPlay(s, 0, 1);
    ok(!cp.ok && cp.reason.indexOf('冷却') >= 0, '同名卡冷却中不可发动（reason 提示冷却）', cp.reason);
    s.hands[1] = ['fire+']; s.ink[1] = 20;
    ok(!Sim.canPlay(s, 0, 1).ok, '升级版共享基础牌的冷却');
    for (let i = 0; i < 31 * 30; i++) Sim.step(s, 1 / 30);
    s.hands[1] = ['fire'];
    ok(Sim.canPlay(s, 0, 1).ok, '冷却到期后可再次发动');
    ok(s.cardCd[1].fire != null && s.cardCd[1].fire <= s.t, '冷却表按「到期时刻」记账（fire 30s）');
  }
  /* AI 收编新卡：走 cardPlay 统一入口 */
  {
    const s = Sim.createGame({ opponents: 1, castles: 8, diff: 'hard', seed: 602, noAI: true });
    s.piles[2].hand.length = 0; s.piles[2].hand.push('levy'); s.hands[2] = s.piles[2].hand;
    s.ink[2] = 20;
    const sum = () => s.castles.filter(c => c.owner === 2).reduce((n, c) => n + c.garrison, 0);
    const before = sum();
    ok(Sim.aiPlayCard(s, 2, Sim.DIFF.hard, s.castles.filter(c => c.owner === 2), {}), 'AI 会打征兵（难度门槛内）');
    ok(Math.abs(sum() - before - 5) < 1e-6, 'AI 征兵生效（全城 +5）');
    ok(s.cardCd[2].levy != null && s.cardCd[2].levy > s.t, 'AI 出牌同样进入同名卡冷却');
  }
}

/* ============================================================
 * v1.16：AI 也会用牌（走牌库）+ 就近扩张 / 远征闸门
 * ============================================================ */
section('AI 用牌（v1.16 · 走牌库 + cardPlay 统一入口）');
{
  /* 每个参战阵营各有一副牌堆（多方混战同样成立） */
  const s0 = Sim.createGame({ opponents: 3, castles: 10, diff: 'hard', seed: 901, noAI: true });
  ok([1, 2, 3, 4].every(o => s0.piles[o] && s0.piles[o].draw.length + s0.piles[o].hand.length > 0),
     '四个参战阵营各建一副牌堆', JSON.stringify([1, 2, 3, 4].map(o => !!s0.piles[o])));
  ok(s0.hands[3] === s0.piles[3].hand, 'AI 手牌 hands[o] 与 piles[o].hand 同一引用');

  /* AI 与玩家同规则：定时抽牌 */
  const s1 = Sim.createGame({ opponents: 1, castles: 8, diff: 'hard', seed: 902, noAI: true });
  const h0 = s1.piles[2].hand.length;
  run(s1, Sim.CFG.DRAW_T + 0.5);
  ok(s1.piles[2].hand.length > h0 || s1.piles[2].hand.length >= Sim.CFG.HAND_MAX,
     'AI 阵营同样定时抽牌', '手牌 ' + h0 + '→' + s1.piles[2].hand.length);

  /* AI 出牌：扣墨 + 进弃牌堆 + 广播 card 事件，与玩家完全同一入口 */
  const s2 = Sim.createGame({ opponents: 1, castles: 8, diff: 'hard', seed: 903, noAI: true });
  const mine2 = s2.castles.filter(c => c.owner === 2);
  s2.piles[2].hand = ['fire']; s2.hands[2] = s2.piles[2].hand;
  s2.ink[2] = 10;
  const inkBefore = s2.ink[2];
  const played = Sim.aiPlayCard(s2, 2, Sim.DIFF.hard, mine2, {});
  const evt = s2.events.filter(e => e.type === 'card');
  ok(played, '困难 AI 会打出手里有的牌');
  ok(s2.ink[2] < inkBefore, 'AI 出牌同样扣墨（不作弊）', '墨 ' + inkBefore + '→' + s2.ink[2]);
  ok(s2.piles[2].hand.length === 0 && s2.piles[2].discard.indexOf('fire') >= 0,
     'AI 打出的牌进弃牌堆', JSON.stringify(s2.piles[2].discard));
  ok(evt.length === 1 && evt[0].by === 2, 'AI 出牌广播 card 事件（玩家可见敌方用了什么牌）',
     JSON.stringify(evt));
  ok(s2.stats.cardsUsed === 1, '出牌计入 cardsUsed 统计');

  /* 四堆守恒同样适用于 AI（用未被改动过手牌的局来验，避免测试自身破坏守恒） */
  const pc = s1.piles[2];
  ok(pc.draw.length + pc.hand.length + pc.discard.length + pc.exhaust.length === pc.list.length,
     'AI 牌堆四堆守恒', [pc.draw.length, pc.hand.length, pc.discard.length, pc.exhaust.length].join('+'));

  /* 难度分层：容易不用牌，普通不用高阶牌 */
  const s3 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 904, noAI: true });
  s3.piles[2].hand = ['fire']; s3.hands[2] = s3.piles[2].hand; s3.ink[2] = 10;
  ok(!Sim.aiPlayCard(s3, 2, Sim.DIFF.easy, s3.castles.filter(c => c.owner === 2), {}),
     '容易 AI 不使用卡牌（cardLv 0）');
  const s4 = Sim.createGame({ opponents: 1, castles: 8, diff: 'normal', seed: 905, noAI: true });
  const my4 = s4.castles.filter(c => c.owner === 2);
  const threat4 = {}; my4.forEach(c => { threat4[c.id] = c.garrison * 2; });   // 造一座「真会丢」的城
  s4.piles[2].hand = ['shield']; s4.hands[2] = s4.piles[2].hand; s4.ink[2] = 10;
  ok(!Sim.aiPlayCard(s4, 2, Sim.DIFF.normal, my4, threat4),
     '普通 AI 不会用高阶牌（护盾 cardLv 2）');
  ok(Sim.aiPlayCard(s4, 2, Sim.DIFF.hard, my4, threat4),
     '困难 AI 会用高阶牌（护盾救城）');

  /* 墨量约束：墨不足则不出牌 */
  const s5 = Sim.createGame({ opponents: 1, castles: 8, diff: 'hard', seed: 906, noAI: true });
  s5.piles[2].hand = ['fire']; s5.hands[2] = s5.piles[2].hand; s5.ink[2] = 0;
  ok(!Sim.aiPlayCard(s5, 2, Sim.DIFF.hard, s5.castles.filter(c => c.owner === 2), {}),
     '墨量不足时 AI 不出牌（与玩家同约束）');

  /* 出牌冷却 */
  ok(s2.aiCardCd[2] > 0, 'AI 出牌后进入冷却（防一波甩光手牌）', 'cd=' + s2.aiCardCd[2]);
}

section('AI 就近扩张与远征闸门（v1.16）');
{
  const oldMistake = Sim.DIFF.hard.mistake;
  Sim.DIFF.hard.mistake = 0;                                  // 排除失误注入的随机干扰
  /* 近而厚 vs 远而薄 → 取近的 */
  const sim = Sim.createGame({ opponents: 1, castles: 6, diff: 'hard', seed: 907, noAI: true });
  const mine = sim.castles.find(c => c.owner === 2);
  mine.garrison = 80;
  const neus = sim.castles.filter(c => c.owner === 0);
  const near = neus[0], far = neus[1];
  near.x = Math.max(40, Math.min(Sim.CFG.MAP_W - 40, mine.x + 300)); near.y = mine.y; near.garrison = 30;
  far.x = mine.x > 900 ? mine.x - 900 : mine.x + 900; far.y = mine.y; far.garrison = 20;
  Sim.aiTick(sim, 2);
  Sim.step(sim, DT);                                          // aiTick 只入队命令，步首才执行
  const army = sim.armies.find(a => a.owner === 2);
  ok(army && army.tid === near.id,
     '扩张优先取「近而厚」而非「远而薄」的中立城（v1.16 就近）',
     army ? '目标 id=' + army.tid + '（近=' + near.id + ' 远=' + far.id + '）' : '未出兵');

  /* 远征闸门：atkRange 外的敌城不主动进攻（控制组：范围内会进攻）
     构造：3 座己方城都堆在左侧（x≈120~240），敌城单独放在 foeX —— 保证「最近己方城」距离可控 */
  function mkFoe(foeX){
    const s = Sim.createGame({ opponents: 1, castles: 4, diff: 'hard', seed: 908, noAI: true });
    const foe = s.castles[0], own = s.castles.slice(1);
    foe.owner = 1; foe.garrison = 5; foe.x = foeX; foe.y = 450;         // 薄城：若在射程内必被打
    own.forEach((c, i) => { c.owner = 2; c.garrison = 22;               // ≥minPool 但不到升级线
                            c.x = 120 + i * 60; c.y = 300 + i * 150; });
    return { s: s, foe: foe };
  }
  const farCase = mkFoe(1500);
  Sim.aiTick(farCase.s, 2); Sim.step(farCase.s, DT);
  const farArmy = farCase.s.armies.find(a => a.owner === 2 && a.tKind === 'c' && a.tid === farCase.foe.id);
  ok(!farArmy, 'atkRange 外的敌城不主动远征（闸门生效）',
     farArmy ? '仍然出兵了' : '最近己城 ' + Math.round(Math.min.apply(null,
       farCase.s.castles.filter(c => c.owner === 2).map(c => Sim.dist(c.x, c.y, farCase.foe.x, farCase.foe.y)))) +
       ' > 闸门 ' + Sim.DIFF.hard.atkRange);

  const nearCase = mkFoe(600);
  Sim.aiTick(nearCase.s, 2); Sim.step(nearCase.s, DT);
  const nearArmy = nearCase.s.armies.find(a => a.owner === 2 && a.tKind === 'c' && a.tid === nearCase.foe.id);
  ok(!!nearArmy, 'atkRange 内的敌城照常进攻（闸门不误伤正常打法）',
     nearArmy ? '出兵 ' + nearArmy.count : '未出兵');

  Sim.DIFF.hard.mistake = oldMistake;
}

/* ============================================================
 * 闯关十五关可玩性（v1.24）：配置递增 + 每关实跑一局 + 目标类型结算
 * ============================================================ */
section('闯关十五关可玩性（v1.24）');
{
  const CAM = Sim.CAMPAIGN;
  ok(!!CAM && CAM.length === 15, '闯关配置 15 关', CAM ? '实际 ' + CAM.length : '无 CAMPAIGN');
  const order = { novice: 0, easy: 1, normal: 2, hard: 3 };
  let mono = true;
  for (let i = 1; i < CAM.length; i++){
    if (CAM[i].castles < CAM[i - 1].castles) mono = false;
    if (CAM[i].opponents < CAM[i - 1].opponents) mono = false;
    if (CAM[i].bonus < CAM[i - 1].bonus) mono = false;
    if (order[CAM[i].diff] < order[CAM[i - 1].diff]) mono = false;
  }
  ok(mono, '关卡配置单调不降（城池数 / 敌数 / 难度 / 初始加成）');

  /* 每关实跑一局（玩家侧由同难度 AI 代打）：不变量 + 必须分出胜负 */
  let bad = 0, stalls = 0;
  for (let i = 0; i < CAM.length; i++){
    const c = CAM[i];
    const sim = Sim.createGame({ mode: 'campaign', level: i + 1, castles: c.castles, opponents: c.opponents,
                                 diff: c.diff, bonus: c.bonus, ambient: true, seed: 5000 + i * 41,
                                 goal: c.goal });                       // v1.24：关卡目标带进 opts
    sim.aiDiff = { 1: c.diff };
    let steps = 0;
    while (!sim.over && sim.t < 12 * 60){
      Sim.step(sim, DT); sim.events.length = 0;
      if (++steps % 150 === 0 && invariants(sim)){ bad++; break; }
    }
    if (!sim.over) stalls++;
    if (invariants(sim)) bad++;
  }
  ok(bad === 0, '十五关各跑一局：全程不变量成立', '违规 ' + bad + ' 关');
  ok(stalls === 0, '十五关各跑一局：12 分钟内均分出胜负', '僵局 ' + stalls + ' 关');

  /* v1.24：目标类型必须齐全且合法（hold 守城 / capture 占领 / conquer 限时） */
  const types = {};
  CAM.forEach(c => { if (c.goal) types[c.goal.type] = (types[c.goal.type] || 0) + 1; });
  ok(types.hold >= 2 && types.capture >= 2 && types.conquer >= 1,
     '三种新目标都排进了关卡表（守城 / 占领 / 限时）', JSON.stringify(types));
  ok(CAM.every(c => !c.goal ||
        (c.goal.type === 'hold' && c.goal.sec > 0) ||
        (c.goal.type === 'capture' && c.goal.n > 0) ||
        (c.goal.type === 'conquer')),
     '每个目标的参数都合法（hold/capture 必带时长或座数）');

  /* v1.27 新手梯度：新增入门档，且相邻关卡之间不再「跳崖」（敌数 +1 / 难度 +1 / 加成 +10 视作跳崖） */
  ok(!!Sim.DIFF.novice && Sim.DIFF.novice.interval > Sim.DIFF.easy.interval &&
     Sim.DIFF.novice.cardChance === 0 && Sim.DIFF.novice.intercept === false,
     '新增「入门」难度：比休闲更慢、不用牌、不拦截');
  ok(CAM[0].diff === 'novice' && CAM[1].diff === 'novice', '前两关是入门档（新手关更简单）');
  ok(CAM.slice(2).every(c => c.diff !== 'novice'), '入门档只用于前两关（不稀释中后期难度）');
  let jump = null;
  for (let i = 1; i < CAM.length; i++){
    const a = CAM[i - 1], b = CAM[i];
    if (b.opponents - a.opponents > 1) jump = '第 ' + (i + 1) + ' 关敌数 +' + (b.opponents - a.opponents);
    if (order[b.diff] - order[a.diff] > 1) jump = '第 ' + (i + 1) + ' 关难度跳档';
    if (b.bonus - a.bonus > 5) jump = '第 ' + (i + 1) + ' 关加成 +' + (b.bonus - a.bonus);
  }
  ok(!jump, '相邻关卡无跳崖（敌数 ≤+1 / 难度 ≤+1 档 / 加成 ≤+5）', jump || '全部单步递进');
  ok(CAM[0].opponents === 1 && CAM[0].castles <= 8, '第一关是单敌小图（8 城以内）',
     CAM[0].castles + ' 城 / ' + CAM[0].opponents + ' 敌');
}

/* ---------- 汇总 ---------- */

/* ============================================================
 * v1.23 过城开战：在途部队经过敌方 / 中立城池即开战
 * ============================================================ */
section('过城开战（v1.23）');
/* v1.23 过城开战用的「干净航道」：只留己方出发点 + 远处一座敌城（保住胜负判定，否则一开局就 over），
   并关闭产兵——驻军不再随时间漂移，兵力差值可以被精确断言。 */
function laneSim(seed){
  const s = unitSim(seed);
  s.castles.length = 0;
  s.mods.prod = 0;
  addCastle(s, 1, 200, 450, 1, 30);
  addCastle(s, 2, 1500, 880, 1, 10);
  return s;
}
{
  /* 1 经过敌城：按兵力互耗，部队继续行军，城池**不**易主 */
  const sim = laneSim(91);
  const foe = addCastle(sim, 2, 800, 450, 1, 12);          // 航道正中的敌城
  sim.armies.push(mkArmy(9101, 1, 20, 300, 450, 1300, 450));
  run(sim, 13);                                            // 1000px @90 ≈ 11.1s
  const camp = sim.camps.filter(p => p.owner === 1)[0];
  ok(!!camp && camp.count === 8, '过敌城：20 兵被 12 驻军消耗成 8 兵后继续行军到目标点',
     camp ? '实际 ' + camp.count : '未列阵');
  /* v1.36：守军被清空 → 顺手接管（与抵达同一套 occupyCastle），部队带着剩下的兵继续行军 */
  ok(foe.owner === 1, '守军打光即接管：过城的城池易主（v1.36 前「打光了仍挂敌旗」）', 'owner=' + foe.owner);
  ok(Math.abs(foe.garrison - 8) < 0.6, '接管后驻军 = 剩余兵力 8（与抵达结算同口径）', '驻军 ' + foe.garrison.toFixed(1));

  /* 2 经过中立城同样开战 */
  const sim2 = laneSim(92);
  const neu = addCastle(sim2, 0, 800, 450, 1, 9);          // 中立城：驻军固定
  sim2.armies.push(mkArmy(9201, 1, 20, 300, 450, 1300, 450));
  run(sim2, 13);
  const camp2 = sim2.camps.filter(p => p.owner === 1)[0];
  ok(!!camp2 && camp2.count === 11, '过中立城：20 兵被 9 驻军消耗成 11 兵', camp2 ? '实际 ' + camp2.count : '未列阵');
  ok(neu.owner === 1 && Math.abs(neu.garrison - 11) < 0.6,
     '中立城守军打光 → 同样接管（驻军 = 剩余 11）', 'owner=' + neu.owner + ' 驻军 ' + neu.garrison.toFixed(1));

  /* 3 己方城不拦截：走位不被自己人卡住 */
  const sim3 = laneSim(93);
  const own = addCastle(sim3, 1, 800, 450, 1, 30);         // 己方城挡在航道正中
  sim3.armies.push(mkArmy(9301, 1, 20, 300, 450, 1300, 450));
  run(sim3, 13);
  const camp3 = sim3.camps.filter(p => p.owner === 1)[0];
  ok(!!camp3 && camp3.count === 20, '己方城不响应：20 兵无损通过', camp3 ? '实际 ' + camp3.count : '未列阵');
  ok(own.garrison >= 30, '己方城驻军未被动过', '剩 ' + own.garrison.toFixed(1));

  /* 4 护盾中的城免疫过城开战 */
  const sim4 = laneSim(94);
  const sh = addCastle(sim4, 2, 800, 450, 1, 12);
  sh.shieldT = 1e6;
  sim4.armies.push(mkArmy(9401, 1, 20, 300, 450, 1300, 450));
  run(sim4, 13);
  const camp4 = sim4.camps.filter(p => p.owner === 1)[0];
  ok(!!camp4 && camp4.count === 20, '护盾城免疫：过城开战被跳过，部队无损通过', camp4 ? '实际 ' + camp4.count : '未列阵');

  /* 5 目标城仍走抵达结算（不被重复结算）：一次占领，驻军 = 差值 */
  const sim5 = laneSim(95);
  const tgt = addCastle(sim5, 2, 800, 450, 1, 12);
  sim5.armies.push(mkArmy(9501, 1, 20, 300, 450, 800, 450, tgt.id));
  run(sim5, 13);
  ok(tgt.owner === 1, '目标城仍按 R3 抵达结算并易主', 'owner=' + tgt.owner);
  ok(tgt.garrison >= 7 && tgt.garrison <= 9, '目标城驻军 = 差值 20-12=8（未被过城开战重复结算）',
     '驻军 ' + tgt.garrison.toFixed(1));

  /* 6 空城（驻军 0）不再触发：不会每帧刷事件 */
  const sim6 = laneSim(96);
  const emptyC = addCastle(sim6, 0, 800, 450, 1, 0);
  sim6.armies.push(mkArmy(9601, 1, 20, 300, 450, 1300, 450));
  let ev6 = 0;
  run(sim6, 13, s => { for (const e of s.events) if (e.type === 'clash') ev6++; s.events.length = 0; });
  ok(ev6 === 0, '空城不触发互耗（驻军 0，不会每帧刷 clash 事件）', '事件 ' + ev6);
  ok(emptyC.owner === 1, 'v1.36：空城（守军 0 = 兵力门槛已满足）路过即接管', 'owner=' + emptyC.owner);

  /* 7 v1.36 兵力不足：过城部队被守军吃光 → 城池不易主，并给明确提示 */
  const sim7 = laneSim(97);
  const foe7 = addCastle(sim7, 2, 800, 450, 1, 30);
  sim7.armies.push(mkArmy(9701, 1, 10, 300, 450, 1300, 450));
  let hint7 = [];
  run(sim7, 13, s => { for (const e of s.events) if (e.type === 'hint') hint7.push(e.txt); s.events.length = 0; });
  ok(foe7.owner === 2 && Math.abs(foe7.garrison - 20) < 0.6,
     '兵力不足：10 兵被 30 驻军吃光，城池仍属敌方', 'owner=' + foe7.owner + ' 驻军 ' + foe7.garrison.toFixed(1));
  ok(hint7.some(t => t.indexOf('兵力不足') >= 0), '给出「兵力不足」的明确提示', JSON.stringify(hint7));
  ok(sim7.camps.filter(p => p.owner === 1).length === 0, '部队全灭，没能抵达目标点列阵');

  /* 8 v1.36 护盾城：免疫 + 明确提示（旧行为是静默通过，玩家不知道为什么没打起来） */
  const sim8 = laneSim(98);
  const sh8 = addCastle(sim8, 2, 800, 450, 1, 12);
  sh8.shieldT = 1e6;
  sim8.armies.push(mkArmy(9801, 1, 20, 300, 450, 1300, 450));
  let hint8 = [];
  run(sim8, 13, s => { for (const e of s.events) if (e.type === 'hint') hint8.push(e.txt); s.events.length = 0; });
  ok(sh8.owner === 2 && hint8.filter(t => t.indexOf('护盾') >= 0).length === 1,
     '护盾城：免疫过路部队，且提示只发一次（不刷屏）', JSON.stringify(hint8));
}

/* ============================================================
 * v1.24 新卡牌与战场机制：伏击 / 瘟疫 / 连弩 / 摧塔 / 墨锭 / 粮道 / 断粮
 * ============================================================ */
section('新卡牌与战场机制（v1.24）');
/* 卡效果夹具：清空随机地图，只留两座对立的城（保住胜负判定），并关掉产兵让兵力差值可精确断言 */
function cardSim(seed){
  const s = unitSim(seed);
  s.castles.length = 0;
  s.mods.prod = 0;
  return s;
}
function pair(seed, garrison){
  const s = cardSim(seed);
  const home = addCastle(s, 1, 300, 450, 1, garrison || 30);
  const foe  = addCastle(s, 2, 1300, 450, 1, garrison || 30);
  return { s, home, foe };
}
function play(sim, key, targetId, ink){          // ink 缺省 20（够付任何牌）；测回墨类要显式给初始墨量
  sim.hands[1] = [key]; sim.ink[1] = ink == null ? 20 : ink;
  return Sim.cardPlay(sim, 0, targetId, 1);
}
const NEW7 = ['ambush', 'plague', 'repeater', 'breach', 'forge', 'supply', 'sabotage'];
{
  /* ---- 伏击：己城埋伏，来犯抵达前先损 N 兵，触发一次即消耗 ---- */
  const A = pair(201);
  ok(play(A.s, 'ambush', A.home.id), '伏击可对己城打出');
  ok(A.home.ambushT === Sim.CFG.AMBUSH_T && A.home.ambushN === 10,
     '伏兵就位：12 秒 / 杀伤 10', 'T=' + A.home.ambushT + ' N=' + A.home.ambushN);
  A.s.armies.push(mkArmy(2011, 2, 20, 500, 450, 300, 450, A.home.id));   // 200px @90 ≈ 2.2s
  run(A.s, 3);
  ok(Math.abs(A.home.garrison - 20) < 0.01, '伏兵先吃掉 10 兵：30 驻军 → 20', '驻军 ' + A.home.garrison.toFixed(2));
  ok(A.home.ambushT === 0 && A.home.ambushN === 0, '伏兵一次性，触发即消耗');
  A.s.armies.push(mkArmy(2012, 2, 10, 500, 450, 300, 450, A.home.id));
  run(A.s, 3);
  ok(Math.abs(A.home.garrison - 10) < 0.01, '第二波不再吃伏兵（20 - 10 = 10）', '驻军 ' + A.home.garrison.toFixed(2));

  const AU = pair(202);
  play(AU.s, 'ambush+', AU.home.id);
  ok(AU.home.ambushN === 16, '伏击+ 杀伤 16', '实际 ' + AU.home.ambushN);

  const AS = pair(203);
  play(AS.s, 'ambush', AS.home.id);
  AS.home.shieldT = 1e6;                                   // 护盾先于伏兵结算：伏兵整段保留
  AS.s.armies.push(mkArmy(2031, 2, 20, 500, 450, 300, 450, AS.home.id));
  run(AS.s, 3);
  ok(AS.home.ambushT > 0 && Math.abs(AS.home.garrison - 30) < 0.01,
     '护盾城：伏兵不触发（护盾分支先返回）', 'T=' + AS.home.ambushT.toFixed(1) + ' 驻军 ' + AS.home.garrison.toFixed(1));

  /* ---- 瘟疫：敌城停产 + 每秒 -2 兵 ---- */
  const P = pair(204, 40);
  ok(play(P.s, 'plague', P.foe.id), '瘟疫可对敌城打出');
  ok(P.foe.plagueT === 8, '瘟疫 8 秒', '实际 ' + P.foe.plagueT);
  run(P.s, 5);
  ok(Math.abs(P.foe.garrison - 30) < 0.01, '瘟疫中停产且每秒 -2：5 秒 40 → 30', '驻军 ' + P.foe.garrison.toFixed(2));
  run(P.s, 4);
  ok(P.foe.plagueT === 0, '瘟疫到期');
  P.s.mods.prod = 1;                                       // 放开产兵，验证「到期后恢复正常」
  const pBefore = P.foe.garrison;
  run(P.s, 4);
  ok(P.foe.garrison > pBefore + 1, '瘟疫结束后恢复产兵', pBefore.toFixed(2) + ' → ' + P.foe.garrison.toFixed(2));
  const PU = pair(205, 40);
  play(PU.s, 'plague+', PU.foe.id);
  ok(PU.foe.plagueT === 12, '瘟疫+ 12 秒', '实际 ' + PU.foe.plagueT);

  /* ---- 连弩：己城架临时箭塔，到期自动拆除 ---- */
  const R = pair(206);
  ok(play(R.s, 'repeater', R.home.id), '连弩可对己城打出');
  ok(!!R.home.tower && R.home.tower.temp === true && R.home.tower.tempT === 12,
     '临时箭塔就位（temp + 12 秒）', JSON.stringify(R.home.tower));
  ok(R.home.tower.kind === Sim.CFG.TEMP_TOWER_KIND && R.home.tower.lv === Sim.CFG.TEMP_TOWER_LV,
     '临时塔 = 2 级箭塔', R.home.tower.kind + ' lv' + R.home.tower.lv);
  R.s.armies.push(mkArmy(2061, 2, 40, 460, 450, 300, 450, R.home.id));   // 160px，落在 172.5 射程内
  let shots = 0;
  run(R.s, 1.5, s => { for (const e of s.events) if (e.type === 'tower') shots++; s.events.length = 0; });
  ok(shots >= 2, '临时塔会开火打在途敌军', '开火 ' + shots + ' 次');
  const R2 = pair(207);
  play(R2.s, 'repeater', R2.home.id);
  run(R2.s, 13);
  ok(R2.home.tower === null, '临时塔到期自动拆除（不会白嫖一座永久塔）', JSON.stringify(R2.home.tower));
  const R3 = pair(208);
  R3.home.tower = { kind: 'cannon', lv: 2, cd: 0 };
  play(R3.s, 'repeater', R3.home.id);
  ok(R3.home.tower.kind === 'cannon' && R3.home.tower.lv === 2, '已有塔的城不再架连弩', JSON.stringify(R3.home.tower));

  /* ---- 摧塔：敌城塔降 v 级，降到 0 即摧毁 ---- */
  const B = pair(209);
  B.foe.tower = { kind: 'cannon', lv: 3, cd: 0 };
  play(B.s, 'breach', B.foe.id);
  ok(B.foe.tower && B.foe.tower.lv === 2, '摧塔：3 级 → 2 级', JSON.stringify(B.foe.tower));
  const B2 = pair(210);
  B2.foe.tower = { kind: 'cannon', lv: 3, cd: 0 };
  play(B2.s, 'breach+', B2.foe.id);
  ok(B2.foe.tower && B2.foe.tower.lv === 1, '摧塔+：3 级 → 1 级', JSON.stringify(B2.foe.tower));
  const B3 = pair(211);
  B3.foe.tower = { kind: 'arrow', lv: 1, cd: 0 };
  play(B3.s, 'breach', B3.foe.id);
  ok(B3.foe.tower === null, '1 级塔被摧毁（降到 0 即拆除）', JSON.stringify(B3.foe.tower));

  /* ---- 墨锭：直接回墨，不超上限 ---- */
  const F = pair(212);
  play(F.s, 'forge', undefined, 3);                        // 起始 3 墨
  ok(F.s.ink[1] === 6, '墨锭：3 墨 → 6 墨（+4 回墨，-1 成本）', '实际 ' + F.s.ink[1]);
  F.s.hands[1] = ['forge'];
  const fc = Sim.canPlay(F.s, 0, 1);
  ok(!fc.ok && /冷却/.test(fc.reason), '墨锭受同名卡冷却约束', fc.reason);
  const F2 = pair(213);
  play(F2.s, 'forge+', undefined, F2.s.inkMax);            // 满墨时打出
  ok(F2.s.ink[1] === F2.s.inkMax - 1, '墨锭不超墨量上限（满墨时只扣成本）', F2.s.ink[1] + '/' + F2.s.inkMax);

  /* ---- 粮道：己方「在途」部队各 +N 兵（与增援「守城」互补） ---- */
  const S = pair(214);
  const s1 = mkArmy(2141, 1, 10, 400, 450, 1300, 450);
  const s2 = mkArmy(2142, 1, 20, 400, 470, 1300, 450);
  const s3 = mkArmy(2143, 2, 15, 600, 450, 300, 450);
  S.s.armies.push(s1, s2, s3);
  play(S.s, 'supply');
  ok(s1.count === 16 && s2.count === 26, '粮道：己方在途部队各 +6', s1.count + ' / ' + s2.count);
  ok(s3.count === 15, '粮道不影响敌方部队', '敌方 ' + s3.count);
  ok(Math.abs(S.home.garrison - 30) < 0.01, '粮道不补给城池（只补在途）', '驻军 ' + S.home.garrison.toFixed(1));

  /* ---- 断粮：敌方行军 ×0.5 ---- */
  const D = pair(215);
  const mine = mkArmy(2151, 1, 10, 400, 450, 1300, 450);
  const theirs = mkArmy(2152, 2, 10, 900, 450, 300, 450);
  D.s.armies.push(mine, theirs);
  const base = Sim.armySpeed(D.s, mine);
  play(D.s, 'sabotage');
  ok(Math.abs(Sim.armySpeed(D.s, mine) - base) < 1e-9, '断粮不减速己方', Sim.armySpeed(D.s, mine).toFixed(2));
  ok(Math.abs(Sim.armySpeed(D.s, theirs) - base * Sim.CFG.SLOW_MUL) < 1e-9,
     '断粮：敌方行军 ×0.5', Sim.armySpeed(D.s, theirs).toFixed(2) + ' / ' + base.toFixed(2));
  run(D.s, 9);
  ok(Math.abs(Sim.armySpeed(D.s, theirs) - base) < 1e-9, '断粮到期后恢复原速', Sim.armySpeed(D.s, theirs).toFixed(2));

  /* ---- 前置条件与目标合法性 ---- */
  const V = pair(216);
  V.s.hands[1] = ['supply']; V.s.ink[1] = 20;
  ok(!Sim.canPlay(V.s, 0, 1).ok, '粮道：无己方在途部队时不可打', Sim.canPlay(V.s, 0, 1).reason);
  V.s.hands[1] = ['forge'];
  ok(Sim.canPlay(V.s, 0, 1).ok, '墨锭：无条件可打（靠冷却限制）');
  ok(Sim.validTarget(V.s, 'ambush', 1, V.home.id) === true && Sim.validTarget(V.s, 'ambush', 1, V.foe.id) === false,
     '伏击只能对己城');
  ok(Sim.validTarget(V.s, 'plague', 1, V.foe.id) === true && Sim.validTarget(V.s, 'plague', 1, V.home.id) === false,
     '瘟疫只能对敌方城');

  /* ---- AI 配置完整性 + 公平性 ---- */
  ok(NEW7.every(k => Sim.AI_CARD_LV[k] != null && Sim.AI_CARD_PRI[k] != null && Sim.AI_CARD_CD[k] != null),
     '七张新卡都配好了 AI 等级 / 优先级 / 冷却',
     '缺：' + NEW7.filter(k => !(Sim.AI_CARD_LV[k] != null && Sim.AI_CARD_PRI[k] != null && Sim.AI_CARD_CD[k] != null)).join(','));
  const dd = html.match(/var DEFAULT_DECK = \[([^\]]*)\]/);
  ok(dd && NEW7.every(k => dd[1].indexOf("'" + k + "'") < 0),
     '七张新卡不进默认卡组（只从战利品产出，AI 与玩家同规则）');
  ok(NEW7.every(k => Sim.CARDS.some(c => c.key === k) && Sim.CARDS.some(c => c.base === k)),
     '七张新卡都生成了「+」升级版');
}

/* ============================================================
 * v1.24 关卡目标：hold 守城 / capture 占领 / conquer 限时
 * ============================================================ */
section('关卡目标结算（v1.24）');
{
  const g1 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 9001, noAI: true, goal: { type: 'hold', sec: 20 } });
  run(g1, 21);
  ok(g1.over === 1, '守城目标：撑满 20 秒即胜（over=1）', 'over=' + g1.over + ' t=' + g1.t.toFixed(1));

  const g2 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 9002, noAI: true, goal: { type: 'hold', sec: 300 } });
  g2.castles.forEach(c => { if (c.owner === 1) c.owner = 2; });
  Sim.step(g2, DT);
  ok(g2.over === 2, '守城中途被清空 → 仍判负（清空优先于守城目标）', 'over=' + g2.over);

  const g3 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 9003, noAI: true, goal: { type: 'capture', n: 2, sec: 600 } });
  g3.stats.capturedBy[1] = 2;
  Sim.step(g3, DT);
  ok(g3.over === 1, '占领目标：占满 2 座即胜', 'over=' + g3.over);

  const g4 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 9004, noAI: true, goal: { type: 'capture', n: 99, sec: 30 } });
  g4.t = 31;
  Sim.step(g4, DT);
  ok(g4.over === 2, '占领目标超时未达成 → 判负', 'over=' + g4.over);

  const g5 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 9005, noAI: true, goal: { type: 'conquer', sec: 40 } });
  g5.t = 41;
  Sim.step(g5, DT);
  ok(g5.over === 2, '限时攻占：超时未清场 → 判负', 'over=' + g5.over);

  const g6 = Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed: 9006, noAI: true });
  g6.t = 999;
  Sim.step(g6, DT);
  ok(g6.over === 0, '不带目标时不受限时影响（与 v1.23 同构）', 'over=' + g6.over);
}

/* ============================================================
 * v1.25 块1 增量：伤亡记账 / 难度细分 / 自定义参数 / 限时结算
 * 记账与限时都是「纯观察 / 纯读取」，不改变任何判定，也不消耗随机源。
 * ============================================================ */
section('伤亡记账（v1.25 · 纯累加）');
{
  const s0 = unitSim(9601);
  ok(s0.stats.loss && s0.stats.loss[1] === 0 && s0.stats.loss[2] === 0, 'loss 表按阵营初始化为 0');

  /* 抵达互耗：攻方 20 打驻军 10 的敌城 → 双方各记 10 */
  const A = pair(9602, 10);
  A.s.armies.push(mkArmy(9611, 1, 20, 500, 450, 1300, 450, A.foe.id));
  run(A.s, 12);
  ok(A.s.stats.loss[1] >= 10 && A.s.stats.loss[2] >= 10,
     '抵达互耗：攻守双方各记一份伤亡', 'p1=' + A.s.stats.loss[1] + ' p2=' + A.s.stats.loss[2]);

  /* 在途遭遇：两支异主部队对撞 → 各记 min(兵力)
     （用 pair 而不是 cardSim：清空城池会导致「敌方不存在 → 第一步就 over」，step 直接 return） */
  const B = pair(9603, 10);
  B.s.armies.push(mkArmy(9621, 1, 12, 600, 450, 1300, 450));
  B.s.armies.push(mkArmy(9622, 2, 8, 700, 450, 300, 450));
  run(B.s, 1);
  ok(B.s.stats.loss[1] >= 8 && B.s.stats.loss[2] >= 8,
     '在途遭遇：两边各记 min(兵力)', 'p1=' + B.s.stats.loss[1] + ' p2=' + B.s.stats.loss[2]);

  /* 火攻：烧掉的那部分驻军计入守方伤亡 */
  const C = pair(9604, 50);
  const before = C.foe.garrison;
  play(C.s, 'fire', C.foe.id);
  ok(C.s.stats.loss[2] === before - C.foe.garrison,
     '火攻：烧毁的驻军计入敌方伤亡', 'loss=' + C.s.stats.loss[2] + ' g=' + C.foe.garrison);

  /* 箭雨：在途敌军折损三成 */
  const D = pair(9605, 10);
  D.s.armies.push(mkArmy(9631, 2, 20, 600, 450, 1300, 450));
  play(D.s, 'arrows');
  ok(D.s.stats.loss[2] === 6, '箭雨：折损三成计入敌方伤亡', 'loss=' + D.s.stats.loss[2]);

  /* 瘟疫：每秒流失计入守方伤亡 */
  const E = pair(9606, 30);
  play(E.s, 'plague', E.foe.id);
  run(E.s, 3);
  ok(E.s.stats.loss[2] >= 5, '瘟疫：每秒流失计入敌方伤亡', 'loss=' + E.s.stats.loss[2].toFixed(1));

  /* 记账是纯观察：同种子跑两遍，胜负与时长逐位一致 */
  const F1 = Sim.createGame({ opponents: 2, castles: 11, diff: 'hard', seed: 9907 });
  const F2 = Sim.createGame({ opponents: 2, castles: 11, diff: 'hard', seed: 9907 });
  run(F1, 60); run(F2, 60);
  ok(F1.over === F2.over && F1.t === F2.t && F1.castles.length === F2.castles.length,
     '记账是纯观察：同种子两遍逐位一致', 'o=' + F1.over + '/' + F2.over + ' t=' + F1.t + '/' + F2.t);
}

section('难度细分（v1.25）');
{
  const Dm = Sim.DIFF;
  ok(!!Dm.master, '新增 master（宗师）档位');
  ok(Dm.master.interval < Dm.hard.interval && Dm.master.cardLv > Dm.hard.cardLv && Dm.master.cardChance > Dm.hard.cardChance,
     '宗师比困难更激进：决策更快 / 卡池更宽 / 出牌更频');
  ok(Dm.easy.interval === 2.2 && Dm.normal.interval === 1.2 && Dm.hard.interval === 0.7, '既有三档决策间隔一字未动');
  ok(Dm.easy.cardLv === 0 && Dm.normal.cardLv === 1 && Dm.hard.cardLv === 2, '既有三档卡池等级一字未动');
  ok(Dm.hard.minPool === 8 && Dm.hard.buffer === 0.85 && Dm.hard.nearW === 0.08 && Dm.hard.mistake === 0.03,
     '困难档其它参数一字未动');
  const order = ['easy', 'normal', 'hard', 'master'];
  let mono = true;
  for (let i = 1; i < order.length; i++){
    const a = Dm[order[i - 1]], b = Dm[order[i]];
    if (!(b.interval < a.interval && b.mistake <= a.mistake && b.minPool <= a.minPool &&
          b.cardChance >= a.cardChance && b.cardLv >= a.cardLv && b.nearW >= a.nearW)) mono = false;
  }
  ok(mono, '四档参数单调：越快 / 越少失误 / 越敢出牌 / 越会选近目标');
  ok(Dm.master.cardLv >= 2, '宗师放开全卡池（AI_CARD_LV 最高只到 2）');
}

section('自定义对局参数（v1.25）');
{
  const base = Sim.createGame({ opponents: 1, castles: 8, diff: 'normal', seed: 9701, noAI: true });
  ok(base.ink[1] === Sim.CFG.INK_START && base.mods.cap === 1 && base.mods.prod === 1,
     '不传 custom 时与 v1.24 逐位等价（初始墨 / 兵上限 / 产速）');

  const c1 = Sim.createGame({ opponents: 1, castles: 8, diff: 'normal', seed: 9701, noAI: true, custom: { inkStart: 8 } });
  ok(c1.ink[1] === 8 && c1.ink[2] === 8 && c1.ink[3] === 8, '自定义初始墨量生效（各阵营同起，公平）');

  const c2 = Sim.createGame({ opponents: 1, castles: 8, diff: 'normal', seed: 9701, noAI: true, custom: { capMul: 2 } });
  ok(c2.mods.cap === 2, '自定义兵力上限倍率写进 mods.cap');
  c2.castles[0].owner = 1; c2.castles[0].level = 1; c2.castles[0].garrison = 500;
  Sim.step(c2, DT);
  ok(Math.round(c2.castles[0].garrison) === Math.round(Sim.LEVELS[0].cap * 2),
     'capMul 真的作用到城池容量上限', 'g=' + c2.castles[0].garrison);

  const c3 = Sim.createGame({ opponents: 1, castles: 8, diff: 'normal', seed: 9701, noAI: true, custom: { prodMul: 0.5 } });
  ok(c3.mods.prod === 0.5, '自定义产速倍率写进 mods.prod');
  c3.castles[0].owner = 1; c3.castles[0].level = 1; c3.castles[0].garrison = 0;
  const c0 = Sim.createGame({ opponents: 1, castles: 8, diff: 'normal', seed: 9701, noAI: true });
  c0.castles[0].owner = 1; c0.castles[0].level = 1; c0.castles[0].garrison = 0;
  run(c3, 10); run(c0, 10);
  ok(Math.abs(c3.castles[0].garrison - c0.castles[0].garrison * 0.5) < 0.6,
     'prodMul 真的把产速减半', 'x=' + c3.castles[0].garrison.toFixed(2) + ' vs ' + c0.castles[0].garrison.toFixed(2));

  /* 自定义难度也走同一条 opts.diff 通道 */
  const c4 = Sim.createGame({ opponents: 1, castles: 8, diff: 'master', seed: 9702, noAI: true });
  ok(c4.opts.diff === 'master', '宗师难度走既有 opts.diff 通道，不新增字段');
}

section('自定义限时结算（v1.25）');
{
  const mk = (seed) => Sim.createGame({ opponents: 1, castles: 8, diff: 'easy', seed, noAI: true, goal: { type: 'time', sec: 30 } });

  const g6 = mk(9806); g6.t = 10; Sim.step(g6, DT);
  ok(g6.over === 0, '限时未到点不结算', 'over=' + g6.over);

  const g2 = mk(9802);
  g2.castles.forEach(c => { c.owner = 1; });
  g2.castles[g2.castles.length - 1].owner = 2;
  g2.t = 31; Sim.step(g2, DT);
  ok(g2.over === 1, '限时到点：玩家城多 → 胜', 'over=' + g2.over);

  const g3 = mk(9803);
  g3.castles.forEach(c => { c.owner = 2; });
  g3.castles[0].owner = 1;
  g3.t = 31; Sim.step(g3, DT);
  ok(g3.over === 2, '限时到点：敌方城多 → 负', 'over=' + g3.over);

  const g4 = mk(9804);
  g4.castles.forEach((c, i) => { c.owner = i < 4 ? 1 : 2; c.garrison = i < 4 ? 100 : 1; });
  g4.t = 31; Sim.step(g4, DT);
  ok(g4.over === 1, '限时到点：城数相同则比总兵力', 'over=' + g4.over);

  const g5 = mk(9805);
  g5.castles.forEach((c, i) => { c.owner = i < 4 ? 1 : 2; c.garrison = i < 4 ? 1 : 100; });
  g5.t = 31; Sim.step(g5, DT);
  ok(g5.over === 2, '限时到点：兵力少的一方判负', 'over=' + g5.over);

  ok(Sim.timeWinner(g4) === 1 && Sim.timeWinner(g5) === 2, 'timeWinner 导出可用（占城 → 兵力）');
}

/* ---------- 汇总 ---------- */
console.log('\n──────────────────────────────');
console.log('通过 ' + passed + ' · 失败 ' + failed);
if (failed){ console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('ALL GREEN ✓');
