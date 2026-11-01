'use strict';
/**
 * 队伍规则测试（仅 2v2 时生效）
 */

const assert = require('node:assert');
const { Game } = require('../server/game');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name + ' → ' + e.message]);
  }
}

function clearMap(g) {
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) g.setTile(x, y, 0);
  }
  for (let x = 0; x < g.cols; x++) {
    g.setTile(x, 0, 1);
    g.setTile(x, g.rows - 1, 1);
  }
  for (let y = 0; y < g.rows; y++) {
    g.setTile(0, y, 1);
    g.setTile(g.cols - 1, y, 1);
  }
  g.items.clear();
  g.startAt = 0;
  for (const p of g.players.values()) p.guardUntil = 0;
}

function makeTeams() {
  return new Game({
    players: [
      { id: 'a1', name: '蓝1', team: 0, slot: 0 },
      { id: 'a2', name: '蓝2', team: 0, slot: 3 },
      { id: 'b1', name: '红1', team: 1, slot: 2 },
      { id: 'b2', name: '红2', team: 1, slot: 1 },
    ],
    teamMode: true,
    seed: 5,
  });
}

function place(g, id, x, y) {
  const p = g.players.get(id);
  p.cellX = x;
  p.cellY = y;
  p.px = x;
  p.py = y;
  p.fromX = x;
  p.fromY = y;
  p.toX = x;
  p.toY = y;
  p.moving = false;
  return p;
}

// ---------------------------------------------------------------------------
test('队友的水柱不会泡封自己人，敌人的会', () => {
  const g = makeTeams();
  clearMap(g);
  const mate = place(g, 'a1', 5, 5);
  const foe = place(g, 'b1', 8, 5);

  // 队友在 (4,5) 放泡，火力 3 → 能扫到 (5,5)
  mate.power = 3;
  place(g, 'a2', 4, 5);
  const a2 = g.players.get('a2');
  assert.ok(g.tryPlaceBomb(a2));
  g.bombs[0].fuseAt = Date.now() - 1;
  g.tick();
  assert.strictEqual(mate.trapped, false, '队友水柱不应泡封自己人');

  // 敌人（蓝队 a1）放到 (9,5) 放泡，火力 3 → 能扫到红队 b1 站的 (8,5)
  const bomber = place(g, 'a1', 9, 5);
  bomber.power = 3;
  assert.ok(g.tryPlaceBomb(bomber));
  const bomb = g.bombs.find((b) => b.ownerId === 'a1');
  bomb.fuseAt = Date.now() - 1;
  g.tick();
  assert.strictEqual(foe.trapped, true, '敌方水柱应泡封对手');
});

test('队友踩到水泡是救援，不是补刀', () => {
  const g = makeTeams();
  clearMap(g);
  const v = place(g, 'a1', 5, 5);
  g.trapPlayer(v, 'b1');
  assert.strictEqual(v.trapped, true);

  place(g, 'a2', 6, 5);
  const mate = g.players.get('a2');
  mate.desiredDir = 'left';
  g.tryStartMove(mate);
  mate.moveStart = Date.now() - 9999; // 直接到达
  g.tick();

  assert.strictEqual(v.alive, true, '队友碰到泡泡应是救援');
  assert.strictEqual(v.trapped, false);
});

test('敌人踩到水泡 → 直接淘汰', () => {
  const g = makeTeams();
  clearMap(g);
  const v = place(g, 'b1', 5, 5);
  g.trapPlayer(v, 'a1');

  place(g, 'a2', 6, 5);
  const foe = g.players.get('a2');
  foe.desiredDir = 'left';
  g.tryStartMove(foe);
  foe.moveStart = Date.now() - 9999;
  g.tick();

  assert.strictEqual(v.alive, false);
  assert.strictEqual(g.players.get('a2').kills, 1);
});

test('一队全灭即结束，胜方为另一队', () => {
  const g = makeTeams();
  clearMap(g);
  g.eliminate(g.players.get('b1'), 'a1', 'pop');
  assert.strictEqual(g.ended, false, '还有队友存活时不应结束');
  g.eliminate(g.players.get('b2'), 'a1', 'pop');
  assert.strictEqual(g.ended, true);
  assert.strictEqual(g.winnerTeam, 0);
});

test('时间到：按队伍总淘汰数判定', () => {
  const g = makeTeams();
  clearMap(g);
  g.players.get('b1').kills = 3;
  g.players.get('b2').kills = 0;
  g.players.get('a1').kills = 1;
  g.players.get('a2').kills = 1;
  g.timeUp();
  assert.strictEqual(g.winnerTeam, 1);
});

// ---------------------------------------------------------------------------
let fail = 0;
for (const [st, name] of results) {
  console.log(`${st === 'PASS' ? '✓' : '✗'} ${name}`);
  if (st === 'FAIL') fail++;
}
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
