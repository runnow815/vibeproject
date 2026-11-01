'use strict';
/**
 * 核心规则单元测试（不依赖网络）
 * 直接构造 Game，手动把引信/计时拨快，验证：
 *   1) 十字水柱长度与穿墙规则
 *   2) 炸掉箱子并掉落道具
 *   3) 玩家被水柱命中 → 泡封
 *   4) 泡封超时 → 出局；踩到泡泡 → 立即出局
 *   5) 移动碰撞（不能穿墙/穿泡）
 */

const assert = require('node:assert');
const { Game } = require('../server/game');

const EMPTY = 0;
const WALL = 1;
const BOX = 2;

function clearMap(g) {
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      g.setTile(x, y, EMPTY);
    }
  }
  // 保留外墙，避免玩家走出去
  for (let x = 0; x < g.cols; x++) {
    g.setTile(x, 0, WALL);
    g.setTile(x, g.rows - 1, WALL);
  }
  for (let y = 0; y < g.rows; y++) {
    g.setTile(0, y, WALL);
    g.setTile(g.cols - 1, y, WALL);
  }
  g.items.clear();
  g.startAt = 0; // 跳过开局倒计时
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name + ' → ' + e.message]);
  }
}

// ---------------------------------------------------------------------------
test('十字水柱按威力延伸并挡住于墙体', () => {
  const g = new Game({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 7 });
  clearMap(g);
  g.setTile(6, 5, WALL); // 右侧 4 格处放一堵墙
  const a = g.players.get('a');
  a.cellX = 2; a.cellY = 5; a.px = 2; a.py = 5;
  a.power = 4;

  assert.ok(g.tryPlaceBomb(a));
  g.bombs[0].fuseAt = Date.now() - 1;
  g.tick();

  const ex = g.explosions[0];
  assert.ok(ex, '应有爆炸');
  const xs = ex.cells.filter((c) => c.y === 5 && c.dir === 'right').map((c) => c.x);
  // (3,5) (4,5) (5,5) 被打到，(6,5) 是墙 → 停止
  assert.deepStrictEqual(xs, [3, 4, 5]);
});

test('炸掉箱子后可以通行，并且会掉落道具', () => {
  const g = new Game({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 3 });
  clearMap(g);
  g.setTile(4, 5, BOX);
  const a = g.players.get('a');
  a.cellX = 2; a.cellY = 5; a.px = 2; a.py = 5;
  a.power = 3;

  // 强制本次掉落道具
  g.rng = () => 0.1;

  g.tryPlaceBomb(a);
  g.bombs[0].fuseAt = Date.now() - 1;
  g.tick();

  assert.strictEqual(g.tileAt(4, 5), EMPTY, '箱子应被摧毁');
  assert.ok(g.items.size >= 1, '应掉落道具');
  assert.ok(g.canEnter(4, 5), '炸开后应可进入');
});

test('水柱命中玩家 → 泡封而非直接死亡', () => {
  const g = new Game({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 11 });
  clearMap(g);
  const a = g.players.get('a');
  const b = g.players.get('b');
  a.cellX = 2; a.cellY = 5; a.px = 2; a.py = 5; a.guardUntil = 0;
  b.cellX = 4; b.cellY = 5; b.px = 4; b.py = 5; b.guardUntil = 0;
  a.power = 3;

  g.tryPlaceBomb(a);
  g.bombs[0].fuseAt = Date.now() - 1;
  g.tick();

  assert.strictEqual(b.alive, true, '被命中不应直接死亡');
  assert.strictEqual(b.trapped, true, '应进入泡封状态');
  assert.strictEqual(g.players.get('a').kills, 0, '此时还不算击杀');
});

test('泡封超时 → 出局，且击杀数记给放泡的人', () => {
  const g = new Game({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 12 });
  clearMap(g);
  const a = g.players.get('a');
  const b = g.players.get('b');
  a.cellX = 2; a.cellY = 5; a.px = 2; a.py = 5; a.guardUntil = 0;
  b.cellX = 4; b.cellY = 5; b.px = 4; b.py = 5; b.guardUntil = 0;
  a.power = 3;

  g.tryPlaceBomb(a);
  g.bombs[0].fuseAt = Date.now() - 1;
  g.tick();
  assert.strictEqual(b.trapped, true);

  b.trappedAt -= 99999;
  g.tick();

  assert.strictEqual(b.alive, false, '超时应出局');
  assert.strictEqual(a.kills, 1, '击杀应归属放泡者');
  assert.strictEqual(g.ended, true, '只剩一人 → 对局结束');
  assert.strictEqual(g.winnerId, 'a');
});

test('踩到被泡封的对手 → 立即淘汰（补刀）', () => {
  const g = new Game({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 13 });
  clearMap(g);
  const a = g.players.get('a');
  const b = g.players.get('b');
  a.cellX = 3; a.cellY = 5; a.px = 3; a.py = 5; a.guardUntil = 0;
  b.cellX = 4; b.cellY = 5; b.px = 4; b.py = 5; b.guardUntil = 0;

  b.trapped = true;
  b.trappedAt = Date.now();
  b.trappedDur = 4200;

  g.setInput('a', { dir: 'right', seq: 1 });
  // 拨快时间让移动立刻完成
  a.moveStart -= 9999;
  g.tick();

  assert.strictEqual(b.alive, false, '被踩到应直接出局');
  assert.strictEqual(a.kills, 1);
});

test('不能穿墙 / 不能穿过泡泡', () => {
  const g = new Game({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 14 });
  clearMap(g);
  const a = g.players.get('a');
  a.cellX = 2; a.cellY = 5; a.px = 2; a.py = 5;
  g.setTile(3, 5, WALL);
  assert.strictEqual(g.canEnter(3, 5), false, '墙不可进入');

  g.setTile(3, 5, EMPTY);
  g.tryPlaceBomb(a); // 在 (2,5) 放泡
  assert.strictEqual(g.canEnter(2, 5), false, '泡泡所在格不可进入');
});

test('泡泡数量受容量限制，拾取道具后上限提升', () => {
  const g = new Game({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 15 });
  clearMap(g);
  const a = g.players.get('a');
  a.cellX = 5; a.cellY = 5; a.px = 5; a.py = 5;

  assert.strictEqual(g.tryPlaceBomb(a), true);
  assert.strictEqual(g.tryPlaceBomb(a), false, '容量 1 时不能再放');

  a.cellX = 6; a.px = 6;
  a.capacity = 2;
  assert.strictEqual(g.tryPlaceBomb(a), true);
  assert.strictEqual(g.ownBombCount('a'), 2);
});

test('连锁爆炸：水柱引燃相邻泡泡', () => {
  const g = new Game({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 16 });
  clearMap(g);
  const a = g.players.get('a');
  a.cellX = 2; a.cellY = 5; a.px = 2; a.py = 5;
  a.capacity = 3;
  a.power = 2; // 水柱刚好够到 (4,5) 的第二颗泡泡
  g.tryPlaceBomb(a);
  a.cellX = 4; a.px = 4;
  g.tryPlaceBomb(a);
  assert.strictEqual(g.bombs.length, 2);

  g.bombs[0].fuseAt = Date.now() - 1;
  g.tick();
  assert.strictEqual(g.bombs.length, 0, '两个泡泡都应被引爆');
});

// ---------------------------------------------------------------------------
let failed = 0;
for (const [st, name] of results) {
  if (st === 'FAIL') failed++;
  console.log(`${st === 'PASS' ? '✓' : '✗'} ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
