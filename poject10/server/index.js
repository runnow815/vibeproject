'use strict';

/**
 * 泡泡对战 · 网络层
 * ------------------------------------------------------------------
 * HTTP: 只负责静态资源（单页客户端）
 * WS  : 房间匹配 + 输入转发 + 状态广播
 *
 * 同步模型：
 *   客户端 --(输入意图 50Hz/变更即发)--> 服务端 --(权威快照 20Hz)--> 所有客户端
 *   - 服务端按 50Hz 推进模拟，20Hz 广播快照（带宽与流畅度的平衡点）
 *   - 快照里带 lastSeq（已处理的最后一条输入序号），客户端据此做预测重放/校正
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game, MATCH_TIME } = require('./game');
const {
  BOT_NAMES,
  TEAM_NAMES,
  normalizeConfig,
  humanCapacity,
  planLineup,
} = require('./lineup');
const {
  MAX_PAYLOAD,
  DEFAULT_MAX_ROOMS,
  normalizeChat,
  sanitizeName,
  normalizeCode,
  normalizeId,
  normalizeSeq,
  isValidDir,
  createBucket,
} = require('./validate');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const TICK_MS = 20; // 模拟步长 50Hz
const BROADCAST_EVERY = 3; // 每 3 个 tick 广播一次 → 约 16.7Hz
const COLORS = ['#4aa8ff', '#ff7b9c', '#ffbe4a', '#57d38c'];
const MAX_ROOMS = Math.max(1, Number.parseInt(process.env.MAX_ROOMS, 10) || DEFAULT_MAX_ROOMS);
const MESSAGE_BUCKET = { capacity: 120, refillPerSec: 120 };
const CHAT_BUCKET = { capacity: 4, refillPerSec: 0.75 };
const RECONNECT_GRACE = 12000;
const QUICK_AUTO_START = 12000; // 快速匹配房等不到更多真人时，12 秒后带 AI 开局

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let url;
  try {
    url = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        rooms: rooms.size,
        sessions: sessions.size,
        uptime: process.uptime(),
      })
    );
    return;
  }
  const file = url === '/' ? '/index.html' : url;
  const abs = path.join(PUBLIC_DIR, file);
  const rel = path.relative(PUBLIC_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// 房间
// ---------------------------------------------------------------------------
/** @type {Map<string, Room>} */
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    if (!rooms.has(code)) return code;
  }
  // 兜底也必须落在同一字符集里，否则客户端 / 校验层会认为房号非法
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    if (!rooms.has(code)) return code;
  }
  return null;
}

class Room {
  constructor(code, config) {
    this.code = code;
    this.config = config; // {mode, bots, difficulty, teamMode}
    this.hostId = null;
    this.players = new Map(); // id -> {id,name,color,ready,online,joinSeq}
    this.game = null;
    this.state = 'waiting'; // waiting | playing
    this.tickCount = 0;
    this.timer = null;
    this.finishTimer = null;
    this.autoTimer = null;
    this.autoStartAt = 0;
    this.joinSeq = 0;
    this.disconnectTimers = new Map();

    this.humanCapacity = humanCapacity(config);
    // AI 席位在开局时按配置生成；这里先分配固定 id / 名字，方便等待界面展示
    this.botRoster = [];
    for (let i = 0; i < config.bots; i++) {
      this.botRoster.push({
        id: `ai-${code}-${i + 1}`,
        name: BOT_NAMES[i % BOT_NAMES.length],
      });
    }
  }

  get size() {
    return this.players.size;
  }

  get totalSeats() {
    return this.players.size + this.botRoster.length;
  }

  add(player) {
    if (this.players.size >= this.humanCapacity) return false;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
    this.players.set(player.id, {
      id: player.id,
      name: player.name,
      color,
      ready: false,
      online: true,
      joinSeq: this.joinSeq++,
    });
    if (!this.hostId) this.hostId = player.id;
    return true;
  }

  remove(id) {
    this.players.delete(id);
    const t = this.disconnectTimers.get(id);
    if (t) clearTimeout(t);
    this.disconnectTimers.delete(id);
    if (this.hostId === id) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    if (this.players.size === 0) this.destroy();
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.finishTimer) clearTimeout(this.finishTimer);
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.timer = null;
    this.finishTimer = null;
    this.autoTimer = null;
    this.autoStartAt = 0;
    this.game = null;
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.disconnectTimers.clear();
    rooms.delete(this.code);
  }

  /** 快速匹配房：等不到更多真人就带 AI 开局，避免无限空等 */
  scheduleAutoStart(ms) {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoStartAt = Date.now() + ms;
    // 先广播一次，让等待界面立刻显示倒计时
    this.broadcast({ t: 'room', room: this.publicState() });
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      this.autoStartAt = 0;
      if (this.state === 'waiting') {
        const res = this.start();
        if (!res.ok) console.warn('[bubble-battle] 自动开局失败:', res.error);
      }
    }, ms);
  }

  publicState() {
    return {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      mode: this.config.mode,
      bots: this.botRoster.map((b) => ({ id: b.id, name: b.name })),
      botCount: this.botRoster.length,
      difficulty: this.config.difficulty,
      teamMode: this.config.teamMode,
      humanCapacity: this.humanCapacity,
      totalSeats: this.totalSeats,
      autoStartAt: this.autoStartAt,
      autoStartIn: this.autoStartAt ? Math.max(0, this.autoStartAt - Date.now()) : 0,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        ready: p.ready,
        online: p.online,
        host: p.id === this.hostId,
      })),
    };
  }

  broadcast(obj) {
    const raw = JSON.stringify(obj);
    for (const p of this.players.values()) {
      const ws = clients.get(p.id);
      if (!ws || ws.readyState !== 1) continue;
      try {
        ws.send(raw);
      } catch {
        // 单个坏连接不应中断整房间广播
      }
    }
  }

  sendTo(id, obj) {
    const ws = clients.get(id);
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // 同上
    }
  }

  /**
   * 开局：
   *  1. 取当前在线真人为真人阵容
   *  2. 按房间配置补入 AI
   *  3. 校验「真人 + AI ≤ 4」并做队伍 / 出生角分配
   *  4. 建立服务端权威对局
   */
  start() {
    if (this.state === 'playing') return { ok: false, error: '对局已经在进行中' };
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
      this.autoStartAt = 0;
    }

    const humans = [...this.players.values()]
      .filter((p) => p.online)
      .sort((a, b) => a.joinSeq - b.joinSeq)
      .map((p) => ({ id: p.id, name: p.name, color: p.color }));

    const plan = planLineup({
      mode: this.config.mode,
      humans,
      bots: this.botRoster,
      teamMode: this.config.teamMode,
      difficulty: this.config.difficulty,
    });
    if (plan.error) return { ok: false, error: plan.error };

    this.game = new Game({
      players: plan.players,
      teamMode: plan.teamMode,
      seed: (Math.random() * 0xffffffff) >>> 0,
    });
    this.state = 'playing';
    this.tickCount = 0;

    this.broadcast({ t: 'room', room: this.publicState() });
    this.broadcast({
      t: 'game',
      ...this.game.mapPayload(),
      lineup: {
        humans: humans.length,
        bots: this.botRoster.length,
        total: plan.total,
        teamMode: plan.teamMode,
      },
    });

    this.timer = setInterval(() => this.step(), TICK_MS);
    return { ok: true, total: plan.total, teamMode: plan.teamMode };
  }

  step() {
    if (!this.game) return;
    this.game.tick();
    this.tickCount++;

    const snap = this.game.snapshot();
    const shouldSend = snap.events.length > 0 || this.tickCount % BROADCAST_EVERY === 0;
    if (shouldSend) this.broadcast(snap);

    if (snap.ended) {
      clearInterval(this.timer);
      this.timer = null;
      if (this.finishTimer) clearTimeout(this.finishTimer);
      this.finishTimer = setTimeout(() => {
        this.finishTimer = null;
        this.finish();
      }, 900);
    }
  }

  finish() {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (!this.game) return;
    const g = this.game;
    const results = [...g.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        team: p.team,
        isBot: p.isBot,
        alive: p.alive,
        kills: p.kills,
        power: p.power,
        capacity: p.capacity,
        speed: p.speed,
        winner: g.teamMode ? g.winnerTeam !== null && p.team === g.winnerTeam : p.id === g.winnerId,
      }))
      .sort(
        (a, b) =>
          Number(b.winner) - Number(a.winner) ||
          Number(b.alive) - Number(a.alive) ||
          b.kills - a.kills
      );

    this.broadcast({
      t: 'over',
      winner: g.winnerId,
      winnerTeam: g.winnerTeam,
      teamMode: g.teamMode,
      teamNames: TEAM_NAMES,
      reason: 'end',
      results,
      // 纯加法字段：供客户端写本地战绩，不参与胜负判定
      startedAt: g.startAt,
      durationMs: Math.min(MATCH_TIME, Math.max(0, Date.now() - g.startAt)),
      mode: this.config.mode,
      humans: results.filter((r) => !r.isBot).length,
      bots: results.filter((r) => r.isBot).length,
    });
    this.game = null;
    this.state = 'waiting';
    for (const p of this.players.values()) p.ready = false;
    this.broadcast({ t: 'room', room: this.publicState() });
  }
}

// ---------------------------------------------------------------------------
// 连接 / 身份
// ---------------------------------------------------------------------------
/** @type {Map<string, import('ws').WebSocket>} */
const clients = new Map();
/** @type {Map<string, {id:string,name:string,ws:any,room:string|null}>} */
const sessions = new Map();

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

wss.on('error', (err) => {
  console.error('[bubble-battle] WebSocket 服务异常:', err && err.message);
});

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // 连接已断开时发送失败属于常态，不向上抛
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  // 超大包（1009）等连接级错误由 close 处理，这里必须消费掉，
  // 否则 ws 会把 'error' 抛成进程级未捕获异常。
  ws.on('error', () => {});

  let session = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    // 每连接总限流：正常客户端远低于 120 条/秒；超限丢弃，连续超限断开
    if (!ws.bucket) ws.bucket = createBucket(MESSAGE_BUCKET);
    if (!ws.bucket.take()) {
      ws.floodStrikes = (ws.floodStrikes || 0) + 1;
      if (ws.floodStrikes > 500) {
        try {
          ws.close(1008, 'flood');
        } catch {}
      }
      return;
    }
    ws.floodStrikes = 0;

    // ---- 握手 ----
    if (msg.t === 'hello') {
      let id = normalizeId(msg.id);
      if (!id) id = 'p' + Math.random().toString(36).slice(2, 9);
      const name = sanitizeName(msg.name);

      // 同一 id 重连：踢掉旧连接，接管房间
      const old = clients.get(id);
      if (old && old !== ws) {
        try {
          old.close(4000, 'replaced');
        } catch {}
      }
      clients.set(id, ws);

      session = sessions.get(id) || { id, name, ws, room: null };
      session.name = name;
      session.ws = ws;
      sessions.set(id, session);
      ws.session = session;

      send(ws, { t: 'hello', id, name });

      // 断线重连：还在房间里 → 直接恢复
      const room = session.room ? rooms.get(session.room) : null;
      if (room && room.players.has(id)) {
        const rp = room.players.get(id);
        rp.online = true;
        rp.name = name;
        const timer = room.disconnectTimers.get(id);
        if (timer) clearTimeout(timer);
        room.disconnectTimers.delete(id);
        if (room.game) room.game.setOnline(id, true);

        room.broadcast({ t: 'room', room: room.publicState() });
        if (room.game) {
          send(ws, { t: 'game', ...room.game.mapPayload(), resumed: true });
          send(ws, { t: 'resume' });
        }
      }
      return;
    }

    if (!ws.session) return;
    const me = ws.session;
    const room = me.room ? rooms.get(me.room) : null;

    // 玩家可以在点按钮时才填名字，这里同步一次
    const adoptName = () => {
      const n = String(msg.name || '').trim();
      if (!n) return;
      me.name = sanitizeName(n);
      const r = me.room ? rooms.get(me.room) : null;
      const p = r && r.players.get(me.id);
      if (p) p.name = me.name;
    };

    // ---- 房间操作 ----
    if (msg.t === 'create') {
      adoptName();
      leaveRoom(me);
      createRoom(me, normalizeConfig(msg), ws);
      return;
    }

    if (msg.t === 'quick') {
      adoptName();
      const config = normalizeConfig(msg);

      // 人机对战：1 真人 + N AI，直接开局（不需要等其他人）
      if (config.mode === 'pve') {
        leaveRoom(me);
        const r = createRoom(me, config, ws);
        if (!r) return;
        const res = r.start();
        if (!res.ok) send(ws, { t: 'err', msg: res.error });
        return;
      }

      // 其余模式：优先并入同配置、还有真人席位的等待中房间
      let target = null;
      for (const r of rooms.values()) {
        if (r.state !== 'waiting') continue;
        if (!sameConfig(r.config, config)) continue;
        if (r.players.size >= r.humanCapacity) continue;
        target = r;
        break;
      }
      if (target) {
        joinRoom(me, target);
        return;
      }

      leaveRoom(me);
      const r = createRoom(me, config, ws);
      // 混合模式：等不到更多真人时自动带 AI 开局，不至于无限空等
      if (r && config.mode === 'hybrid') r.scheduleAutoStart(QUICK_AUTO_START);
      return;
    }

    if (msg.t === 'join') {
      adoptName();
      const code = normalizeCode(msg.code);
      if (!code) {
        return send(ws, {
          t: 'err',
          msg: '房间号格式不正确（4 位字母数字，不含 I/O/0/1）',
          code: 'BAD_CODE',
        });
      }
      const r = rooms.get(code);
      if (!r) return send(ws, { t: 'err', msg: '房间不存在或已关闭', code: 'NO_ROOM' });
      if (r.state === 'playing') return send(ws, { t: 'err', msg: '这局已经开始了，等下一局吧' });
      if (r.players.size >= r.humanCapacity) {
        return send(ws, {
          t: 'err',
          msg: r.config.mode === 'pvp' ? '房间已满（最多 4 人）' : `真人席位已满（已配置 ${r.config.bots} 个 AI）`,
        });
      }
      joinRoom(me, r);
      return;
    }

    if (msg.t === 'leave') {
      leaveRoom(me);
      send(ws, { t: 'left' });
      return;
    }

    if (!room) return;

    // ---- 房间聊天（仅等待期，纯文本广播）----
    if (msg.t === 'chat') {
      if (room.state !== 'waiting') return;
      const p = room.players.get(me.id);
      if (!p) return;
      const text = normalizeChat(msg.text);
      if (!text) return;
      if (!me.chatBucket) me.chatBucket = createBucket(CHAT_BUCKET);
      if (!me.chatBucket.take()) return; // 刷屏静默丢弃，避免错误包放大
      room.broadcast({
        t: 'chat',
        id: p.id,
        name: p.name,
        color: p.color,
        text,
        at: Date.now(),
      });
      return;
    }

    if (msg.t === 'ready') {
      const p = room.players.get(me.id);
      if (p && room.state === 'waiting') {
        const value = !!msg.value;
        if (p.ready === value) return; // 重复准备不重复广播
        p.ready = value;
        room.broadcast({ t: 'room', room: room.publicState() });
      }
      return;
    }

    if (msg.t === 'start') {
      if (room.hostId !== me.id) return send(ws, { t: 'err', msg: '只有房主可以开始游戏' });
      const online = [...room.players.values()].filter((p) => p.online);
      const notReady = online.filter((p) => p.id !== room.hostId && !p.ready);
      if (notReady.length) return send(ws, { t: 'err', msg: '还有玩家没准备' });
      const res = room.start();
      if (!res.ok) send(ws, { t: 'err', msg: res.error });
      return;
    }

    // ---- 游戏输入 ----
    if (msg.t === 'input') {
      const seq = normalizeSeq(msg.seq);
      if (seq === null || !isValidDir(msg.dir)) return;
      if (room.game && room.state === 'playing') {
        room.game.setInput(me.id, {
          seq,
          dir: msg.dir === undefined ? undefined : msg.dir,
          bomb: msg.bomb === true,
        });
      }
      return;
    }

    if (msg.t === 'ping') {
      send(ws, { t: 'pong', c: msg.c });
      return;
    }
  });

  ws.on('close', () => {
    const me = ws.session;
    if (!me) return;
    if (clients.get(me.id) !== ws) return; // 已被新连接接管
    clients.delete(me.id);

    const room = me.room ? rooms.get(me.room) : null;
    if (!room) {
      if (sessions.get(me.id) === me) sessions.delete(me.id);
      return;
    }
    const p = room.players.get(me.id);
    if (!p) {
      if (sessions.get(me.id) === me) sessions.delete(me.id);
      return;
    }

    p.online = false;
    p.ready = false;
    if (room.game) room.game.setOnline(me.id, false);
    room.broadcast({ t: 'room', room: room.publicState() });

    // 宽限期后仍然没回来 → 移出房间 / 判负
    const t = setTimeout(() => {
      const r = rooms.get(me.room);
      if (!r) return;
      const still = r.players.get(me.id);
      if (still && !still.online) {
        if (r.game) {
          r.game.forceEliminate(me.id, 'left');
          r.broadcast({ t: 'notice', msg: `${still.name} 掉线离开了` });
        }
        r.remove(me.id);
        if (r.players.size) r.broadcast({ t: 'room', room: r.publicState() });
        me.room = null;
        if (sessions.get(me.id) === me) sessions.delete(me.id);
      }
    }, RECONNECT_GRACE);
    room.disconnectTimers.set(me.id, t);
  });
});

function createRoom(me, config, ws) {
  if (rooms.size >= MAX_ROOMS) {
    send(ws, { t: 'err', msg: '服务器房间已满，请稍后再试', code: 'ROOM_LIMIT' });
    return null;
  }
  const code = makeCode();
  if (!code) {
    send(ws, { t: 'err', msg: '房间号分配失败，请稍后再试', code: 'NO_CODE' });
    return null;
  }
  const r = new Room(code, config);
  rooms.set(code, r);
  r.add({ id: me.id, name: me.name });
  me.room = code;
  send(ws, { t: 'room', room: r.publicState() });
  return r;
}

function sameConfig(a, b) {
  return (
    a.mode === b.mode &&
    a.bots === b.bots &&
    a.difficulty === b.difficulty &&
    a.teamMode === b.teamMode
  );
}

function joinRoom(me, room) {
  if (me.room && me.room !== room.code) leaveRoom(me);
  if (!room.players.has(me.id)) {
    if (!room.add({ id: me.id, name: me.name })) {
      const ws = clients.get(me.id);
      if (ws) send(ws, { t: 'err', msg: '真人席位已满' });
      return;
    }
  } else {
    const p = room.players.get(me.id);
    p.online = true;
    p.name = me.name;
  }
  me.room = room.code;
  room.broadcast({ t: 'room', room: room.publicState() });
}

function leaveRoom(me) {
  const room = me.room ? rooms.get(me.room) : null;
  if (!room) {
    me.room = null;
    return;
  }
  // 主动退出对局 → 直接判负，避免残局因为一个"不动的活人"卡死
  if (room.game && room.players.has(me.id)) {
    room.game.forceEliminate(me.id, 'left');
    room.broadcast({ t: 'notice', msg: `${me.name} 离开了对局` });
  }
  room.remove(me.id);
  if (room.players.size) room.broadcast({ t: 'room', room: room.publicState() });
  me.room = null;
}

// 心跳：清理僵死连接
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30000);

// 会话兜底清理：无连接且已不在任何房间的 session 不应长期累积
const sessionSweep = setInterval(() => {
  for (const [id, s] of sessions) {
    if (clients.has(id)) continue;
    const room = s.room ? rooms.get(s.room) : null;
    if (!room || !room.players.has(id)) {
      if (sessions.get(id) === s) sessions.delete(id);
    }
  }
}, 60000);
if (sessionSweep.unref) sessionSweep.unref();

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(sessionSweep);
});

server.on('error', (err) => {
  console.error('[bubble-battle] HTTP 服务异常:', err && err.message);
  if (err && err.code === 'EADDRINUSE') process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[bubble-battle] http://localhost:${PORT}  (bind ${HOST}:${PORT})`);
});

module.exports = { server, rooms };
