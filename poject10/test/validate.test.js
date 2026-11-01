'use strict';
/* 输入校验与限流单测：纯函数、可注入时间，不依赖网络 */

const assert = require('assert');
const V = require('../server/validate.js');

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

ok('聊天 trim 与空白折叠', () => {
  assert.strictEqual(V.normalizeChat('  你  好  '), '你 好');
});

ok('空串 / 纯空格 / null 返回空', () => {
  assert.strictEqual(V.normalizeChat(''), '');
  assert.strictEqual(V.normalizeChat('   \n\t '), '');
  assert.strictEqual(V.normalizeChat(null), '');
});

ok('控制字符被替换为空格', () => {
  assert.strictEqual(V.normalizeChat('a\u0000b\u001fc'), 'a b c');
});

ok('40 个中文保留，41 个截断', () => {
  const forty = '字'.repeat(40);
  assert.strictEqual(V.countChars(V.normalizeChat(forty)), 40);
  assert.strictEqual(V.countChars(V.normalizeChat(forty + '多')), 40);
});

ok('emoji 按码点截断到 40', () => {
  const text = '😀'.repeat(45);
  const out = V.normalizeChat(text);
  assert.strictEqual(V.countChars(out), 40);
});

ok('房号只接受 4 位易辨识字符', () => {
  assert.strictEqual(V.normalizeCode('abcd'), 'ABCD');
  assert.strictEqual(V.normalizeCode(' 2345 '), '2345');
  assert.strictEqual(V.normalizeCode('ABC'), null);
  assert.strictEqual(V.normalizeCode('ABCDE'), null);
  assert.strictEqual(V.normalizeCode('ABCI'), null);
  assert.strictEqual(V.normalizeCode('AB0D'), null);
});

ok('名字清洗与长度上限', () => {
  assert.strictEqual(V.sanitizeName('   '), '玩家');
  assert.strictEqual(V.sanitizeName('a\u0000b'), 'a b');
  assert.strictEqual(V.countChars(V.sanitizeName('名'.repeat(20))), 12);
});

ok('seq 只接受 0..2^31-1 的整数', () => {
  assert.strictEqual(V.normalizeSeq(undefined), 0);
  assert.strictEqual(V.normalizeSeq(12), 12);
  assert.strictEqual(V.normalizeSeq('12'), null);
  assert.strictEqual(V.normalizeSeq(1.5), null);
  assert.strictEqual(V.normalizeSeq(-1), null);
  assert.strictEqual(V.normalizeSeq(V.MAX_SEQ + 1), null);
});

ok('方向白名单', () => {
  assert.ok(V.isValidDir(undefined));
  assert.ok(V.isValidDir(null));
  for (const d of ['up', 'down', 'left', 'right']) assert.ok(V.isValidDir(d));
  assert.ok(!V.isValidDir('UP'));
  assert.ok(!V.isValidDir(0));
  assert.ok(!V.isValidDir('hack'));
});

ok('总消息桶：瞬时 300 条只放行 120 条', () => {
  const b = V.createBucket({ capacity: 120, refillPerSec: 120 });
  let passed = 0;
  for (let i = 0; i < 300; i++) if (b.take(1000)) passed++;
  assert.strictEqual(passed, 120);
});

ok('聊天桶：连续 4 条，1.4 秒后恢复 1 条', () => {
  const b = V.createBucket({ capacity: 4, refillPerSec: 0.75 });
  let passed = 0;
  for (let i = 0; i < 5; i++) if (b.take(2000)) passed++;
  assert.strictEqual(passed, 4);
  assert.ok(!b.take(2001));
  assert.ok(b.take(3400));
});

ok('令牌桶时间跳跃最多补 5 秒', () => {
  const b = V.createBucket({ capacity: 2, refillPerSec: 1 });
  assert.ok(b.take(1000)); // tokens 1
  assert.ok(b.take(101000)); // 上限 5 秒 → tokens 2，消费后 1
  assert.ok(b.tokens <= 1.0001);
});

console.log(`\n通过 ${pass} 项`);
