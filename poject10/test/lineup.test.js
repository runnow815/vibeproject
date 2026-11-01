'use strict';
/**
 * 阵容规则单元测试
 *   1) 人数配置的合法组合与非法组合（真人 1-4、AI 1-4、总数 <= 4）
 *   2) 参数归一化（越界钳制、pvp 不带 AI）
 *   3) 真人席位容量
 *   4) 队伍分配：人数平衡、真人均匀分到两队、出生角同队同侧
 *   5) 不足 4 人时队伍模式自动降级为混战
 */

const assert = require('node:assert');
const {
  VALID_LINEUPS,
  normalizeConfig,
  humanCapacity,
  validateLineup,
  planLineup,
} = require('../server/lineup');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name + ' → ' + e.message]);
  }
}

const humans = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: 'h' + i, name: 'H' + i, color: ['#4aa8ff', '#ff7b9c', '#ffbe4a', '#57d38c'][i] }));
const bots = (n) => Array.from({ length: n }, (_, i) => ({ id: 'ai' + i, name: 'AI' + i }));

// ---------------------------------------------------------------------------

test('混合模式的 6 种合法组合全部通过校验', () => {
  assert.strictEqual(VALID_LINEUPS.length, 6);
  for (const l of VALID_LINEUPS) {
    assert.strictEqual(validateLineup(l.humans, l.bots, 'hybrid'), null, `${l.humans}+${l.bots} 应合法`);
    assert.strictEqual(l.humans + l.bots, l.total);
    assert.ok(l.humans >= 1 && l.humans <= 4);
    assert.ok(l.bots >= 1 && l.bots <= 4);
    assert.ok(l.total <= 4);
  }
});

test('非法人数配置被拒绝', () => {
  assert.match(validateLineup(0, 2, 'hybrid'), /至少需要 1 名真人/);
  assert.match(validateLineup(3, 2, 'hybrid'), /不能超过 4 人/);
  assert.match(validateLineup(4, 1, 'hybrid'), /不能超过 4 人/);
  assert.match(validateLineup(2, 0, 'hybrid'), /AI 数量至少为 1/);
  assert.match(validateLineup(2, 1, 'pvp'), /不能携带 AI/);
  assert.match(validateLineup(2, 1, 'pve'), /只能 1 名真人/);
  assert.ok(validateLineup(1, 0, 'pve'), '1 真人 + 0 AI 应被拒绝');
  assert.match(validateLineup(5, 0, 'pvp'), /最多 4 名/);
});

test('模式参数归一化：AI 数量钳制在 1-3，pvp 强制无 AI', () => {
  assert.strictEqual(normalizeConfig({ mode: 'hybrid', bots: 9 }).bots, 3);
  assert.strictEqual(normalizeConfig({ mode: 'hybrid', bots: 0 }).bots, 1);
  assert.strictEqual(normalizeConfig({ mode: 'pvp', bots: 3 }).bots, 0);
  assert.strictEqual(normalizeConfig({ mode: 'pve' }).bots, 3);
  assert.strictEqual(normalizeConfig({ mode: 'hybrid', difficulty: 9 }).difficulty, 2);
  assert.strictEqual(normalizeConfig({ mode: 'unknown' }).mode, 'pvp');
});

test('真人席位 = 4 - AI 数量（人机对战固定 1 人）', () => {
  assert.strictEqual(humanCapacity({ mode: 'pvp', bots: 0 }), 4);
  assert.strictEqual(humanCapacity({ mode: 'pve', bots: 3 }), 1);
  assert.strictEqual(humanCapacity({ mode: 'hybrid', bots: 1 }), 3);
  assert.strictEqual(humanCapacity({ mode: 'hybrid', bots: 2 }), 2);
  assert.strictEqual(humanCapacity({ mode: 'hybrid', bots: 3 }), 1);
});

test('混战：每人一队，2 人用对角出生', () => {
  const plan = planLineup({
    mode: 'hybrid',
    humans: humans(1),
    bots: bots(1),
    teamMode: false,
  });
  assert.strictEqual(plan.error, undefined);
  assert.strictEqual(plan.total, 2);
  assert.strictEqual(plan.teamMode, false);
  const teams = new Set(plan.players.map((p) => p.team));
  assert.strictEqual(teams.size, 2, '混战每人一个独立队伍');
  assert.deepStrictEqual(plan.players.map((p) => p.slot), [0, 1]);
});

test('队伍分配：2v2 时真人均匀分到两队，AI 补足人数', () => {
  for (const [h, b] of [[2, 2], [3, 1]]) {
    const plan = planLineup({
      mode: 'hybrid',
      humans: humans(h),
      bots: bots(b),
      teamMode: true,
    });
    assert.strictEqual(plan.teamMode, true, `${h}+${b} 应为队伍模式`);
    const t0 = plan.players.filter((p) => p.team === 0);
    const t1 = plan.players.filter((p) => p.team === 1);
    assert.strictEqual(t0.length, 2);
    assert.strictEqual(t1.length, 2);
    assert.ok(t0.some((p) => !p.isBot) && t1.some((p) => !p.isBot), '每队至少 1 名真人');
    assert.ok(Math.abs(t0.filter((p) => !p.isBot).length - t1.filter((p) => !p.isBot).length) <= 1, '两队真人数差 ≤1');
  }
});

test('队伍分配：1 真人 + 3 AI 时仍是 2v2，且真人独占一队', () => {
  const plan = planLineup({ mode: 'pve', humans: humans(1), bots: bots(3), teamMode: true });
  assert.strictEqual(plan.teamMode, true);
  const t0 = plan.players.filter((p) => p.team === 0);
  const t1 = plan.players.filter((p) => p.team === 1);
  assert.strictEqual(t0.length, 2);
  assert.strictEqual(t1.length, 2);
  assert.strictEqual(plan.players.filter((p) => !p.isBot).length, 1);
});

test('队伍模式下同队出生点在同侧（蓝=左 0/3，红=右 2/1）', () => {
  const plan = planLineup({ mode: 'pvp', humans: humans(4), bots: [], teamMode: true });
  const slotOf = (team) => plan.players.filter((p) => p.team === team).map((p) => p.slot).sort();
  assert.deepStrictEqual(slotOf(0), [0, 3]);
  assert.deepStrictEqual(slotOf(1), [1, 2]);
});

test('不足 4 人时队伍模式自动降级为混战', () => {
  const plan = planLineup({ mode: 'hybrid', humans: humans(1), bots: bots(2), teamMode: true });
  assert.strictEqual(plan.teamMode, false);
  assert.strictEqual(plan.total, 3);
  assert.strictEqual(new Set(plan.players.map((p) => p.team)).size, 3);
});

test('AI 用剩余颜色，不与真人撞色', () => {
  const plan = planLineup({ mode: 'hybrid', humans: humans(2), bots: bots(2), teamMode: false });
  const colors = plan.players.map((p) => p.color);
  assert.strictEqual(new Set(colors).size, 4, '4 名参战者颜色互不相同');
});

// ---------------------------------------------------------------------------
let fail = 0;
for (const [st, name] of results) {
  console.log(`${st === 'PASS' ? '✓' : '✗'} ${name}`);
  if (st === 'FAIL') fail++;
}
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
