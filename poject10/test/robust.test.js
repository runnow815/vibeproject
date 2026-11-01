'use strict';
/**
 * 健壮性端到端测试
 * 覆盖：房号格式、合法但不存在、房间上限、非法 seq/dir、
 *       总消息限流不误伤、超大包断开、/health 会话清理。
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const assert = require('node:assert');
const WebSocket = require('ws');

const PORT = 3114;
const URL = `ws://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

class Client {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.msgs = [];
    this.ws = null;
    this.closed = null;
  }

  async connect() {
    this.ws = new WebSocket(URL);
    this.ws.on('message', (raw) => this.msgs.push(JSON.parse(raw.toString())));
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
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

  pos() {
    const state = this.last('state');
    if (!state) return null;
    const me = state.players.find((p) => p.id === this.id);
    return me ? { x: me.x, y: me.y } : null;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MAX_ROOMS: '1' },
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

    A.send({ t: 'create', name: '甲', mode: 'pvp', bots: 0, difficulty: 2, teamMode: false });
    const created = await A.wait((m) => m.t === 'room' && m.room.code);
    const code = created.room.code;

    // ---- 房号格式 ----
    for (const bad of ['abc', 'AB0D', 'ABCI', 'ABCDE']) {
      B.send({ t: 'join', code: bad, name: '乙' });
      const err = await B.wait((m) => m.t === 'err' && m.code === 'BAD_CODE');
      assert.ok(err.msg.includes('4 位'));
    }
    ok('非法房号（长度/易混淆字符）被拒绝并带 BAD_CODE');

    B.send({ t: 'join', code: 'ZZZZ', name: '乙' });
    const noRoom = await B.wait((m) => m.t === 'err' && m.code === 'NO_ROOM');
    assert.ok(noRoom.msg.includes('房间不存在'));
    ok('合法但不存在的房号返回 NO_ROOM');

    // ---- 房间上限 ----
    B.send({ t: 'create', name: '乙', mode: 'pvp', bots: 0, difficulty: 2, teamMode: false });
    const limit = await B.wait((m) => m.t === 'err' && m.code === 'ROOM_LIMIT');
    assert.ok(limit.msg.includes('房间已满'));
    ok('超过 MAX_ROOMS 时拒绝建房');

    // ---- 换成 PVE 对局，验证输入校验 ----
    A.send({ t: 'leave' });
    await A.wait((m) => m.t === 'left');
    A.send({ t: 'quick', name: '甲', mode: 'pve', bots: 3, difficulty: 2, teamMode: false });
    await A.wait((m) => m.t === 'game', 6000);
    await sleep(2400); // 跳过 2.2s 开局倒计时
    await A.wait((m) => m.t === 'state');

    const before = A.pos();
    A.send({ t: 'input', seq: '1', dir: 'down' });
    A.send({ t: 'input', seq: 2, dir: 'hack' });
    await sleep(300);
    const after = A.pos();
    assert.deepStrictEqual(after, before);
    ok('非法 seq（字符串）与非法 dir 整条丢弃，位置不变');

    // ---- 总限流不误伤：瞬时 300 条后等待补充仍可用 ----
    for (let i = 0; i < 300; i++) A.send({ t: 'ping', c: i });
    await sleep(200);
    assert.strictEqual(A.closed, null);
    await sleep(1300);
    A.send({ t: 'ping', c: 999 });
    const pong = await A.wait((m) => m.t === 'pong' && m.c === 999);
    assert.strictEqual(pong.c, 999);
    ok('瞬时 300 条后连接未被断开，补充令牌后 ping 正常');

    // ---- 会话清理 ----
    B.close();
    await sleep(350);
    const health = await getJson('/health');
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.rooms, 1);
    assert.strictEqual(health.sessions, 1);
    ok('/health 显示 rooms/sessions，未入房连接关闭后 session 归零');

    // ---- 超大消息 ----
    const C = await new Client('p3', '丙').connect();
    C.ws.send('x'.repeat(20000));
    const t0 = Date.now();
    while (!C.closed && Date.now() - t0 < 2500) await sleep(20);
    assert.ok(C.closed, '超大消息应触发连接关闭');
    assert.strictEqual(C.closed.code, 1009);
    const health2 = await getJson('/health');
    assert.strictEqual(health2.ok, true);
    ok('20KB 超大包触发 1009，服务端仍存活');

    A.close();
    C.close();
  } catch (e) {
    console.error('健壮性测试失败:', e && e.message);
    process.exitCode = 1;
  } finally {
    await sleep(200);
    srv.kill();
    await sleep(200);
    console.log(`\n健壮性测试通过 ${checks.length} 项`);
  }
})();
