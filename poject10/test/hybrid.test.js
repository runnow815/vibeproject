'use strict';
/**
 * 混合模式端到端测试
 *   1) 混合模式建房：AI 席位预占，真人席位 = 4 - AI
 *   2) 快速匹配把同配置的真人并到同一间房
 *   3) 真人席位满后拒绝第 3 人（3 真人 + 2 AI 会超过 4 人）
 *   4) 开局：真人 + AI 总数 = 4，且每个 AI 都在服务端跑动
 *   5) 两个客户端看到的 AI 位置完全一致（同步正确性）
 *   6) 人机对战：1 真人 + 3 AI 立即开局
 *   7) 2v2：两队各 2 人，同队同侧出生
 */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('node:assert');
const WebSocket = require('ws');

const PORT = 3112;
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  async wait(pred, timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const idx = this.msgs.findIndex(pred);
      if (idx >= 0) return this.msgs[idx];
      await sleep(15);
    }
    throw new Error(`${this.name} 等待消息超时`);
  }
  last(type) {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === type) return this.msgs[i];
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
  const ok = (n) => {
    checks.push('✓ ' + n);
    console.log('✓ ' + n);
  };
  const clients = [];

  try {
    // ---- 1) 混合模式建房：2 真人席位 + 2 AI ----
    const a = await new Client('hy-a', '真人A').connect();
    clients.push(a);
    a.send({ t: 'quick', mode: 'hybrid', bots: 2, difficulty: 2, teamMode: false });
    const roomA = await a.wait((m) => m.t === 'room' && m.room.autoStartIn > 0);
    assert.strictEqual(roomA.room.mode, 'hybrid');
    assert.strictEqual(roomA.room.botCount, 2);
    assert.strictEqual(roomA.room.bots.length, 2);
    assert.strictEqual(roomA.room.humanCapacity, 2);
    assert.strictEqual(roomA.room.totalSeats, 3);
    assert.ok(roomA.room.autoStartIn > 0, '快速匹配房应有自动开局倒计时');
    ok(`混合模式建房：2 AI 占位，真人席位 ${roomA.room.humanCapacity}，${Math.round(roomA.room.autoStartIn / 1000)}s 后自动开局`);

    // ---- 2) 同配置真人被并进同一间房 ----
    const b = await new Client('hy-b', '真人B').connect();
    clients.push(b);
    b.send({ t: 'quick', mode: 'hybrid', bots: 2, difficulty: 2, teamMode: false });
    const roomB = await b.wait((m) => m.t === 'room');
    assert.strictEqual(roomB.room.code, roomA.room.code, '同配置应匹配到同一间房');
    assert.strictEqual(roomB.room.players.length, 2);
    assert.strictEqual(roomB.room.totalSeats, 4);
    ok(`快速匹配把 2 名真人并入同一间房 ${roomB.room.code}（2 真人 + 2 AI = 4）`);

    // ---- 3) 真人席位已满，第三人被拒绝 ----
    const c = await new Client('hy-c', '真人C').connect();
    clients.push(c);
    c.send({ t: 'join', code: roomA.room.code });
    const err = await c.wait((m) => m.t === 'err');
    assert.match(err.msg, /真人席位已满/);
    ok(`第 3 名真人被拒绝：${err.msg}`);
    c.close();

    // ---- 4) 开局 ----
    b.send({ t: 'ready', value: true });
    await a.wait((m) => m.t === 'room' && m.room.players.some((p) => p.id === 'hy-b' && p.ready));
    a.send({ t: 'start' });
    const gA = await a.wait((m) => m.t === 'game');
    const gB = await b.wait((m) => m.t === 'game');
    assert.deepStrictEqual(gA.map, gB.map);
    assert.strictEqual(gA.players.length, 4);
    assert.strictEqual(gA.players.filter((p) => p.isBot).length, 2);
    assert.strictEqual(gA.players.filter((p) => !p.isBot).length, 2);
    assert.strictEqual(gA.teamMode, false);
    assert.strictEqual(gA.lineup.humans, 2);
    assert.strictEqual(gA.lineup.bots, 2);
    ok('开局：2 真人 + 2 AI = 4 人，AI 以服务端玩家的身份入场');

    await sleep(2500); // 等开局倒计时

    const s0A = await a.wait((m) => m.t === 'state' && m.players.length === 4);
    const bots0 = s0A.players
      .filter((p) => p.isBot)
      .map((p) => `${p.id}:${p.x},${p.y}`)
      .join('|');

    // ---- 5) AI 真的在动，且两端一致 ----
    await sleep(1800);
    const s1A = a.last('state');
    const s1B = b.last('state');
    const bots1 = s1A.players
      .filter((p) => p.isBot)
      .map((p) => `${p.id}:${p.x},${p.y}`)
      .join('|');
    assert.notStrictEqual(bots0, bots1, 'AI 应该在移动');
    assert.deepStrictEqual(
      s1A.players.map((p) => [p.id, p.x, p.y]),
      s1B.players.map((p) => [p.id, p.x, p.y]),
      '两个客户端看到的 AI 位置必须一致'
    );
    ok('AI 在服务端自主行动，且两名真人的快照完全一致');

    // ---- 6) 人机对战：1 真人 + 3 AI 立即开局 ----
    const d = await new Client('pve-d', '单机玩家').connect();
    clients.push(d);
    d.send({ t: 'quick', mode: 'pve', bots: 3, difficulty: 3, teamMode: false });
    const gD = await d.wait((m) => m.t === 'game');
    assert.strictEqual(gD.players.length, 4);
    assert.strictEqual(gD.players.filter((p) => p.isBot).length, 3);
    assert.strictEqual(gD.lineup.humans, 1);
    ok('人机对战：1 真人 + 3 AI 直接开局，无需等待');

    // ---- 7) 2v2 分队 ----
    const e = await new Client('team-e', '队伍玩家').connect();
    clients.push(e);
    e.send({ t: 'quick', mode: 'pve', bots: 3, difficulty: 2, teamMode: true });
    const gE = await e.wait((m) => m.t === 'game');
    assert.strictEqual(gE.teamMode, true);
    const team0 = gE.players.filter((p) => p.team === 0);
    const team1 = gE.players.filter((p) => p.team === 1);
    assert.strictEqual(team0.length, 2);
    assert.strictEqual(team1.length, 2);
    const slots0 = team0.map((p) => p.slot).sort();
    assert.deepStrictEqual(slots0, [0, 3], '蓝队同侧出生');
    ok('2v2：两队各 2 人，同队同侧出生（出生角 0/3 vs 1/2）');

    console.log('\n混合模式测试全部通过');
  } catch (e) {
    console.error('\n✗ 测试失败：', e.message);
    process.exitCode = 1;
  } finally {
    for (const c of clients) c.close();
    srv.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
