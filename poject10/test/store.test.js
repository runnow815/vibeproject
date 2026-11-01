'use strict';
/* 本地存储单测：注入 fake storage，覆盖默认值/迁移/异常/裁剪/汇总/导出 */

const assert = require('assert');
const Store = require('../public/js/store.js');

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + e.message);
    process.exitCode = 1;
  }
}

function fakeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  let writes = 0;
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      writes++;
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    get writeCount() {
      return writes;
    },
    get data() {
      return data;
    },
  };
}

function match(i, extra) {
  return {
    id: 'm' + i,
    at: 1700000000000 + i,
    startedAt: 1700000000000 + i - 1000,
    mode: 'pvp',
    teamMode: false,
    team: null,
    result: 'win',
    kills: i % 5,
    durationMs: 60000,
    humans: 2,
    bots: 0,
    ...extra,
  };
}

ok('空存储返回默认设置与空战绩', () => {
  const store = Store.createStore(fakeStorage());
  const s = store.getSettings();
  assert.strictEqual(s.sfx, true);
  assert.strictEqual(s.volume, 0.7);
  assert.strictEqual(s.motion, 'system');
  assert.strictEqual(s.tips, true);
  assert.deepStrictEqual(store.getStats().matches, []);
});

ok('损坏 JSON 回默认且不抛', () => {
  const store = Store.createStore(fakeStorage({ 'bubble.settings': '{bad', 'bubble.stats': '[]' }));
  assert.strictEqual(store.getSettings().sfx, true);
  assert.deepStrictEqual(store.getStats().matches, []);
});

ok('未来版本只读：使用默认值且不回写', () => {
  const fake = fakeStorage({
    'bubble.settings': JSON.stringify({ v: 2, sfx: false, volume: 0.1 }),
  });
  const store = Store.createStore(fake);
  assert.strictEqual(store.getSettings().sfx, true);
  store.saveSettings({ sfx: false });
  assert.strictEqual(store.getSettings().sfx, false); // 内存态生效
  assert.strictEqual(fake.writeCount, 0); // 但不覆盖未来版本
});

ok('音量 clamp、未知动效回 system', () => {
  const store = Store.createStore(fakeStorage());
  assert.strictEqual(store.saveSettings({ volume: -1 }).volume, 0);
  assert.strictEqual(store.saveSettings({ volume: 2 }).volume, 1);
  assert.strictEqual(store.saveSettings({ volume: 'x' }).volume, 0.7);
  assert.strictEqual(store.saveSettings({ motion: 'off' }).motion, 'system');
  assert.strictEqual(store.saveSettings({ motion: 'reduce' }).motion, 'reduce');
});

ok('保存设置只合并指定字段', () => {
  const store = Store.createStore(fakeStorage());
  store.saveSettings({ volume: 0.3 });
  const s = store.saveSettings({ sfx: false });
  assert.strictEqual(s.sfx, false);
  assert.strictEqual(s.volume, 0.3);
  assert.strictEqual(store.getSettings().volume, 0.3);
});

ok('25 局裁剪为最新 20 局，顺序新→旧', () => {
  const store = Store.createStore(fakeStorage());
  for (let i = 0; i < 25; i++) store.addMatch(match(i));
  const list = store.getStats().matches;
  assert.strictEqual(list.length, 20);
  assert.strictEqual(list[0].id, 'm24');
  assert.strictEqual(list[19].id, 'm5');
});

ok('相同 id 不重复记录', () => {
  const store = Store.createStore(fakeStorage());
  store.addMatch(match(1));
  store.addMatch(match(1));
  assert.strictEqual(store.getStats().matches.length, 1);
});

ok('汇总：3 胜 1 负 1 平，胜率 60%', () => {
  const list = [
    match(1, { result: 'win', kills: 2 }),
    match(2, { result: 'win', kills: 5 }),
    match(3, { result: 'win', kills: 1 }),
    match(4, { result: 'lose', kills: 0 }),
    match(5, { result: 'draw', kills: 3 }),
  ];
  const s = Store.summarize(list);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.wins, 3);
  assert.strictEqual(s.losses, 1);
  assert.strictEqual(s.draws, 1);
  assert.strictEqual(s.winRate, 60);
  assert.strictEqual(s.bestKills, 5);
  assert.strictEqual(Store.summarize([]).winRate, 0);
});

ok('matchFromOver：混战胜/平/非参与者', () => {
  const results = [
    { id: 'me', team: 0, kills: 4, isBot: false },
    { id: 'b', team: 1, kills: 1, isBot: false },
  ];
  const win = Store.matchFromOver(
    { results, winner: 'me', teamMode: false, startedAt: 1000, durationMs: 5000, mode: 'pvp', humans: 2, bots: 0 },
    'me'
  );
  assert.strictEqual(win.result, 'win');
  assert.strictEqual(win.kills, 4);
  assert.strictEqual(win.durationMs, 5000);
  const draw = Store.matchFromOver({ results, winner: null, teamMode: false }, 'me');
  assert.strictEqual(draw.result, 'draw');
  assert.strictEqual(Store.matchFromOver({ results }, 'nobody'), null);
});

ok('matchFromOver：分队胜/平与人数回退', () => {
  const results = [
    { id: 'me', team: 0, kills: 2, isBot: false },
    { id: 'ai', team: 1, kills: 0, isBot: true },
  ];
  const win = Store.matchFromOver(
    { results, teamMode: true, winnerTeam: 0, mode: 'hybrid', durationMs: 9000 },
    'me'
  );
  assert.strictEqual(win.result, 'win');
  assert.strictEqual(win.team, 0);
  assert.strictEqual(win.humans, 1);
  assert.strictEqual(win.bots, 1);
  const draw = Store.matchFromOver({ results, teamMode: true, winnerTeam: null }, 'me');
  assert.strictEqual(draw.result, 'draw');
});

ok('配额异常降级为内存态，不抛', () => {
  const fake = fakeStorage();
  fake.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const store = Store.createStore(fake);
  assert.doesNotThrow(() => store.addMatch(match(1)));
  assert.strictEqual(store.getStats().matches.length, 1);
  assert.strictEqual(store.available, false);
});

ok('cleaStats / clearAll 清空且同步内存', () => {
  const fake = fakeStorage();
  const store = Store.createStore(fake);
  store.saveSettings({ sfx: false });
  store.addMatch(match(1));
  store.clearStats();
  assert.strictEqual(store.getStats().matches.length, 0);
  assert.strictEqual(store.getSettings().sfx, false);
  store.clearAll();
  assert.strictEqual(store.getSettings().sfx, true);
  assert.strictEqual(fake.data.has('bubble.settings'), false);
  assert.strictEqual(fake.data.has('bubble.stats'), false);
});

ok('导出结构完整且不含姓名/房号', () => {
  const store = Store.createStore(fakeStorage());
  store.addMatch(match(1, { name: '张三', room: 'ABCD' }));
  const payload = store.exportPayload();
  assert.strictEqual(payload.app, 'bubble-battle');
  assert.strictEqual(payload.schema, 1);
  assert.ok(payload.summary);
  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes('张三'));
  assert.ok(!raw.includes('ABCD'));
});

console.log(`\n通过 ${pass} 项`);
