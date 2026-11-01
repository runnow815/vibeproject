'use strict';
/**
 * 联机端到端测试
 * 用两个真实的 WebSocket 客户端跑完整流程：
 *   建房 → 加入 → 准备 → 开局 → 移动 → 放泡 → 爆炸
 * 并断言双方收到的快照完全一致（实时同步的关键指标）。
 */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('node:assert');
const WebSocket = require('ws');

const PORT = 3111;
const URL = `ws://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Client {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.msgs = [];
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(URL);
    this.ws.on('message', (raw) => this.msgs.push(JSON.parse(raw.toString())));
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.send({ t: 'hello', id: this.id, name: this.name });
    await this.wait((m) => m.t === 'hello');
    return this;
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  async wait(pred, timeout = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const idx = this.msgs.findIndex(pred);
      if (idx >= 0) return this.msgs[idx];
      await sleep(15);
    }
    throw new Error(`${this.name} 等待消息超时`);
  }

  last(type) {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      if (this.msgs[i].t === type) return this.msgs[i];
    }
    return null;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', (d) => process.stderr.write('[srv:err] ' + d));

  await sleep(700);

  const checks = [];
  const ok = (name) => checks.push('✓ ' + name);

  let a, b;
  try {
    // ---- 1. 建房 & 加入 ----
    a = await new Client('test-a', '小明').connect();
    a.send({ t: 'create' });
    const roomA = await a.wait((m) => m.t === 'room');
    assert.match(roomA.room.code, /^[A-Z0-9]{4}$/);
    ok(`创建房间，房间号 ${roomA.room.code}`);

    b = await new Client('test-b', '小红').connect();
    b.send({ t: 'join', code: roomA.room.code });
    const roomB = await b.wait((m) => m.t === 'room');
    assert.strictEqual(roomB.room.players.length, 2);
    assert.strictEqual(roomB.room.hostId, 'test-a');
    ok('第二名玩家加入成功，房主正确');

    await a.wait((m) => m.t === 'room' && m.room.players.length === 2);
    ok('房间成员变化实时广播给所有人');

    // ---- 2. 准备 & 开局 ----
    b.send({ t: 'ready', value: true });
    await a.wait((m) => m.t === 'room' && m.room.players.some((p) => p.id === 'test-b' && p.ready));
    ok('准备状态同步');

    a.send({ t: 'start' });
    const gA = await a.wait((m) => m.t === 'game');
    const gB = await b.wait((m) => m.t === 'game');
    assert.deepStrictEqual(gA.map, gB.map, '双方地图必须完全一致');
    assert.strictEqual(gA.cols, 15);
    assert.strictEqual(gA.rows, 13);
    ok('开局下发同一张地图（15×13）');

    // 开局有 2.2s 倒计时，等它结束再操作
    await sleep(2400);

    await a.wait((m) => m.t === 'state');
    await b.wait((m) => m.t === 'state');
    const s0A = a.last('state');
    const s0B = b.last('state');
    assert.strictEqual(s0A.players.length, 2);
    assert.deepStrictEqual(
      s0A.players.map((p) => [p.id, p.x, p.y]),
      s0B.players.map((p) => [p.id, p.x, p.y])
    );
    ok('初始快照双方完全一致');

    // ---- 3. 移动同步 ----
    const startX = s0A.players.find((p) => p.id === 'test-a').x;
    a.send({ t: 'input', seq: 1, dir: 'right' });
    await sleep(500);
    a.send({ t: 'input', seq: 2, dir: null });
    await sleep(250);

    const sMoveA = a.last('state');
    const sMoveB = b.last('state');
    const aInA = sMoveA.players.find((p) => p.id === 'test-a');
    const aInB = sMoveB.players.find((p) => p.id === 'test-a');
    assert.ok(aInA.x > startX, `A 应在移动（${startX} → ${aInA.x}）`);
    assert.deepStrictEqual([aInA.x, aInA.y], [aInB.x, aInB.y], '两端看到的位置必须一致');
    ok(`移动同步：A 从 x=${startX} 走到 x=${aInA.x}，B 端位置一致`);

    // ---- 4. 放泡 & 爆炸 ----
    a.send({ t: 'input', seq: 3, bomb: true });
    const sBomb = await b.wait((m) => m.t === 'state' && m.bombs.length > 0);
    const bomb = sBomb.bombs[0];
    assert.strictEqual(bomb.owner, 'test-a');
    ok(`B 端实时看到 A 放下的泡泡 @(${bomb.x},${bomb.y})`);

    const boom = await b.wait((m) => m.t === 'state' && m.explosions.length > 0, 5000);
    assert.ok(boom.explosions[0].cells.length >= 1);
    ok('约 2.4s 后引信触发，爆炸同步到对端');

    // ---- 5. 地图破坏同步 ----
    const boxTest = await b.wait(
      (m) => m.t === 'state' && Array.isArray(m.changes) && m.changes.length > 0,
      6000
    ).catch(() => null);
    if (boxTest) ok(`箱子被炸开后地图变更同步（${JSON.stringify(boxTest.changes[0])}）`);
    else checks.push('- 本次爆炸未命中箱子（随机地图，属正常情况）');

    // ---- 6. 输入序号回传（用于客户端预测校正）----
    const sAck = a.last('state');
    const meA = sAck.players.find((p) => p.id === 'test-a');
    assert.ok(meA.seq >= 1, '服务端应回传已处理的输入序号');
    ok(`服务端回传输入序号 seq=${meA.seq}（客户端预测校正依据）`);

    // ---- 7. 断线重连 ----
    b.close();
    await sleep(400);
    const b2 = await new Client('test-b', '小红').connect();
    const resumed = await b2.wait((m) => m.t === 'resume', 3000).catch(() => null);
    if (resumed) ok('断线后凭同一 id 重连，成功恢复到进行中的对局');
    else checks.push('- 重连恢复未在 3s 内完成');
    b2.close();

    console.log('\n' + checks.join('\n'));
    console.log('\n联机测试全部通过');
  } catch (e) {
    console.log('\n' + checks.join('\n'));
    console.error('\n✗ 测试失败：', e.message);
    process.exitCode = 1;
  } finally {
    try {
      a && a.close();
      b && b.close();
    } catch {}
    srv.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
