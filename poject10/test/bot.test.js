'use strict';
/**
 * AI 行为测试（真实计时，跑服务端同一套 tick）
 *   1) AI 会真的动起来、会放泡泡、会炸开箱子
 *   2) AI 站在爆炸范围内时会逃走（不自杀）
 *   3) AI 不会走到墙/箱子上（说明它确实受同一套碰撞规则约束）
 *   4) AI 被泡封时会挣扎
 */

const assert = require('node:assert');
const { Game } = require('../server/game');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (p) => `${p.cellX},${p.cellY}`;
const results = [];

async function test(name, fn) {
  try {
    await fn();
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

async function run(g, ms, onTick) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    g.tick();
    if (onTick) onTick(g);
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------
(async () => {
  await test('3 个 AI 会移动、放泡泡并炸开箱子', async () => {
    const g = new Game({
      players: [
        { id: 'h', name: '人类', slot: 0 },
        { id: 'b1', name: 'AI1', isBot: true, difficulty: 3, slot: 1 },
        { id: 'b2', name: 'AI2', isBot: true, difficulty: 2, slot: 2 },
        { id: 'b3', name: 'AI3', isBot: true, difficulty: 1, slot: 3 },
      ],
      seed: 12345,
    });
    g.startAt = 0;
    for (const p of g.players.values()) p.guardUntil = 0;

    const spawn = new Map([...g.players.values()].map((p) => [p.id, key(p)]));
    let placed = 0;
    let boom = 0;
    let boxBreak = 0;

    await run(g, 4200, (gg) => {
      for (const ev of gg.events) {
        if (ev.type === 'place') placed++;
        if (ev.type === 'boom') boom++;
        if (ev.type === 'box') boxBreak++;
      }
      gg.events.length = 0;
      // AI 不能出现在墙/箱子上
      for (const p of gg.players.values()) {
        if (!p.isBot || !p.alive) continue;
        assert.strictEqual(gg.tileAt(p.cellX, p.cellY), 0, `AI 走进了障碍格 (${p.cellX},${p.cellY})`);
      }
    });

    assert.ok(placed >= 1, 'AI 应该至少放了一个泡泡');
    console.log(`    → 放置 ${placed} 次 / 爆炸 ${boom} 次 / 炸箱 ${boxBreak} 次`);

    const moved = [...g.players.values()].filter((p) => p.isBot && key(p) !== spawn.get(p.id)).length;
    assert.ok(moved >= 2, `至少 2 个 AI 离开出生点（实际 ${moved}）`);
  });

  await test('AI 站在爆炸范围内会主动逃走', async () => {
    const g = new Game({
      players: [
        { id: 'h', name: '人类', slot: 0 },
        { id: 'b', name: 'AI', isBot: true, difficulty: 3, slot: 1 },
      ],
      seed: 999,
    });
    clearMap(g);
    const bot = g.players.get('b');
    bot.cellX = 7;
    bot.cellY = 7;
    bot.px = 7;
    bot.py = 7;
    bot.fromX = 7;
    bot.fromY = 7;
    bot.toX = 7;
    bot.toY = 7;

    const now = Date.now();
    // 正上方 2 格放一颗威力 2 的泡泡 → (7,7) 在 1.3 秒后会被水柱扫到
    g.bombs.push({
      id: 99,
      x: 7,
      y: 5,
      ownerId: 'h',
      power: 2,
      placedAt: now,
      fuseAt: now + 1300,
      exploded: false,
    });

    await run(g, 800);

    assert.ok(!bot.trapped, 'AI 不应该站在原地被炸成水泡');
    assert.notStrictEqual(key(bot), '7,7', 'AI 应该已经离开危险格');
    assert.ok(
      Math.abs(bot.cellX - 7) + Math.abs(bot.cellY - 7) <= 3,
      `AI 应该是就近规避（实际到 ${key(bot)}）`
    );
  });

  await test('AI 被泡封后会挣扎缩短时间', async () => {
    const g = new Game({
      players: [
        { id: 'h', name: '人类', slot: 0 },
        { id: 'b', name: 'AI', isBot: true, difficulty: 3, slot: 1 },
      ],
      seed: 42,
    });
    clearMap(g);
    const bot = g.players.get('b');
    bot.cellX = 3;
    bot.cellY = 3;
    bot.px = 3;
    bot.py = 3;
    g.trapPlayer(bot, 'h');

    const startLeft = bot.trappedDur;
    await run(g, 700);
    const left = bot.trappedDur - (Date.now() - bot.trappedAt);
    assert.ok(left < startLeft - 200, `挣扎应缩短泡封时间（剩 ${Math.round(left)}ms）`);
  });

  // -------------------------------------------------------------------------
  let fail = 0;
  for (const [st, name] of results) {
    console.log(`${st === 'PASS' ? '✓' : '✗'} ${name}`);
    if (st === 'FAIL') fail++;
  }
  console.log(`\n${results.length - fail}/${results.length} 通过`);
  process.exit(fail ? 1 : 0);
})();
