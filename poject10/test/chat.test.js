'use strict';
/**
 * 房间聊天端到端测试
 * 覆盖：双端广播、清洗、长度、emoji、控制字符、XSS 文本、
 *       刷屏限流、非成员、对局中拒绝、结算附加字段。
 */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('node:assert');
const WebSocket = require('ws');

const PORT = 3113;
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
      const hit = this.msgs.find(pred);
      if (hit) return hit;
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

  chats(id) {
    return this.msgs.filter((m) => m.t === 'chat' && (!id || m.id === id));
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

  const checks = [];
  const ok = (name) => {
    checks.push(name);
    console.log('✓ ' + name);
  };

  await sleep(700);

  try {
    const A = await new Client('p1', '甲').connect();
    const B = await new Client('p2', '乙').connect();
    const C = await new Client('p3', '丙').connect();

    A.send({ t: 'create', name: '甲', mode: 'pvp', bots: 0, difficulty: 2, teamMode: false });
    const created = await A.wait((m) => m.t === 'room' && m.room.code);
    const code = created.room.code;
    B.send({ t: 'join', code, name: '乙' });
    C.send({ t: 'join', code, name: '丙' });
    await B.wait((m) => m.t === 'room' && m.room.players.length === 2);
    await C.wait((m) => m.t === 'room' && m.room.players.length === 3);

    // ---- 基本广播 ----
    A.send({ t: 'chat', text: '  你好  ' });
    const atA = await A.wait((m) => m.t === 'chat' && m.text === '你好');
    const atB = await B.wait((m) => m.t === 'chat' && m.text === '你好');
    assert.strictEqual(atA.id, 'p1');
    assert.strictEqual(atA.name, '甲');
    assert.strictEqual(atA.color, '#4aa8ff');
    assert.ok(Number.isFinite(atA.at));
    assert.strictEqual(atB.text, '你好');
    ok('聊天广播到发送者与房间内其他玩家');

    // ---- 空串 ----
    const beforeEmpty = B.chats().length;
    A.send({ t: 'chat', text: '   ' });
    await sleep(220);
    assert.strictEqual(B.chats().length, beforeEmpty);
    ok('纯空格不广播');

    // ---- 长度 ----
    A.send({ t: 'chat', text: '字'.repeat(50) });
    const cut = await B.wait((m) => m.t === 'chat' && m.text.startsWith('字'));
    assert.strictEqual(cut.text.length, 40);
    ok('50 个中文截断到 40');

    A.send({ t: 'chat', text: '😀'.repeat(45) });
    const emoji = await B.wait(
      (m) => m.t === 'chat' && m.text.startsWith('😀') && Array.from(m.text).length === 40
    );
    assert.strictEqual(Array.from(emoji.text).length, 40);
    ok('45 个 emoji 按码点截断到 40');

    // ---- 控制字符 ----
    A.send({ t: 'chat', text: 'a\u0000b' });
    await B.wait((m) => m.t === 'chat' && m.text === 'a b');
    ok('控制字符被替换为空格');

    // ---- XSS 原样作为文本传输（渲染安全由客户端负责） ----
    const xss = '<img src=x onerror=alert(1)>';
    B.send({ t: 'chat', text: xss });
    const xssMsg = await A.wait((m) => m.t === 'chat' && m.text === xss);
    assert.strictEqual(xssMsg.text, xss);
    ok('HTML 字符串原样传输，不做服务端转义');

    // ---- 刷屏限流：新会话连续 5 条只到 4 条 ----
    for (let i = 0; i < 5; i++) C.send({ t: 'chat', text: '刷' + i });
    await C.wait((m) => m.t === 'chat' && m.text === '刷3');
    await sleep(300);
    assert.strictEqual(C.chats('p3').length, 4);
    await sleep(1400);
    C.send({ t: 'chat', text: '刷4' });
    await C.wait((m) => m.t === 'chat' && m.text === '刷4');
    assert.strictEqual(C.chats('p3').length, 5);
    ok('聊天令牌桶：连续 4 条，约 1.33 秒后恢复 1 条');

    // ---- 非房间成员 ----
    const D = await new Client('p4', '丁').connect();
    const beforeOutsider = B.chats().length;
    D.send({ t: 'chat', text: '我不在房间' });
    await sleep(240);
    assert.strictEqual(B.chats().length, beforeOutsider);
    ok('非房间成员不能广播聊天');

    // ---- 开局后拒绝聊天 ----
    B.send({ t: 'ready', value: true });
    C.send({ t: 'ready', value: true });
    await A.wait((m) => m.t === 'room' && m.room.players.filter((p) => p.id !== 'p1').every((p) => p.ready));
    A.send({ t: 'start' });
    await A.wait((m) => m.t === 'game', 6000);
    await B.wait((m) => m.t === 'state', 6000);

    const beforePlaying = B.chats().length;
    A.send({ t: 'chat', text: '开局了' });
    await sleep(260);
    assert.strictEqual(B.chats().length, beforePlaying);
    ok('对局中聊天被静默丢弃');

    // ---- 结算附加字段 ----
    B.send({ t: 'leave' });
    C.send({ t: 'leave' });
    const over = await A.wait((m) => m.t === 'over', 6000);
    assert.strictEqual(over.mode, 'pvp');
    assert.ok(Number.isFinite(over.startedAt));
    assert.ok(Number.isFinite(over.durationMs) && over.durationMs >= 0);
    assert.strictEqual(over.humans, 3);
    assert.strictEqual(over.bots, 0);
    assert.ok(Array.isArray(over.results));
    ok('结算消息包含 startedAt/durationMs/mode/humans/bots');

    A.close();
    B.close();
    C.close();
    D.close();
  } catch (e) {
    console.error('聊天测试失败:', e && e.message);
    process.exitCode = 1;
  } finally {
    await sleep(200);
    srv.kill();
    await sleep(200);
    console.log(`\n聊天测试通过 ${checks.length} 项`);
  }
})();
