'use strict';

/**
 * 泡泡对战 · 服务端权威游戏逻辑
 * ------------------------------------------------------------------
 * 设计原则：
 *  1. 所有规则判定（移动、放泡、爆炸、泡封、道具、胜负）只在服务端执行，
 *     客户端没有"发号施令"的能力，只能发送输入意图（方向 / 是否放泡）。
 *  2. 逻辑与网络完全解耦：本文件不依赖 ws / http，可单独单元测试。
 *  3. 位置用「格 + 连续坐标」双表示：格子用于碰撞与判定，连续坐标用于广播，
 *     让客户端能做平滑插值而不必知道服务端的移动细节。
 */

const { Bot } = require('./bot');

const EMPTY = 0;
const WALL = 1; // 永久墙体，炸不掉
const BOX = 2; // 箱子，可炸开

const DIRS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};
const DIR_LIST = ['up', 'down', 'left', 'right'];

// ---- 手感参数：集中在这里调数值 ----
const BOMB_FUSE = 2400; // 泡泡从放下到爆炸的时间
const EXPLOSION_LIFE = 620; // 水柱视觉残留时长
const TRAP_DURATION = 4200; // 被泡封后自然破裂（出局）时间
const TRAP_MIN = 1500; // 挣扎最多能缩短到的时间
const STRUGGLE_STEP = 140; // 每次挣扎缩短的时间
const STRUGGLE_COOLDOWN = 110; // 挣扎最小间隔
const MOVE_BASE = 150; // 走一格的基础耗时（毫秒）
const MOVE_SPEED_STEP = 0.82; // 每级速度的耗时系数
const MOVE_MIN = 78; // 最快单格耗时
const SPAWN_GUARD = 1600; // 出生保护
const START_DELAY = 2200; // 开局倒计时（这段时间双方都动不了）
const MATCH_TIME = 180000; // 单局时长
const ITEM_DROP_CHANCE = 0.36; // 箱子掉道具概率
const MAX_POWER = 7;
const MAX_CAPACITY = 6;
const MAX_SPEED = 3;

/** 可复现的伪随机数（地图 / 道具掉落都由种子驱动） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 15 x 13 的经典十字迷宫：四角出生，中央有足够的周旋空间 */
const SPAWNS = [
  { x: 1, y: 1 },
  { x: 13, y: 11 },
  { x: 13, y: 1 },
  { x: 1, y: 11 },
];

class Game {
  constructor({ players, seed = 1, teamMode = false }) {
    this.cols = 15;
    this.rows = 13;
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);

    this.map = new Uint8Array(this.cols * this.rows);
    this.items = new Map(); // "x,y" -> 'bomb' | 'power' | 'speed'
    this.bombs = []; // 活跃泡泡
    this.explosions = []; // 水柱（含时间戳，用于客户端渲染）
    this.players = new Map();
    this.bots = new Map(); // id -> Bot 控制器（AI 也是普通玩家，只是输入来源不同）

    this.changes = []; // 本帧内的地图变化，供广播增量同步
    this.events = []; // 本帧内的音效/特效事件
    this.nextBombId = 1;

    this.ended = false;
    this.winnerId = null;
    this.winnerTeam = null;
    this.teamMode = !!teamMode;
    this.startAt = Date.now() + START_DELAY;
    this.endAt = this.startAt + MATCH_TIME;

    this.buildMap();

    const order = [0, 1, 2, 3];
    // 2 人时用对角，保证距离对称
    const autoSlots = players.length <= 2 ? [0, 1] : players.length === 3 ? [0, 1, 2] : order;
    players.forEach((info, i) => {
      const slot = Number.isInteger(info.slot) ? info.slot : autoSlots[i] || i;
      const sp = SPAWNS[slot % SPAWNS.length];
      const p = this.createPlayer(info, sp, slot);
      this.players.set(info.id, p);
      if (info.isBot) {
        this.bots.set(
          info.id,
          new Bot({
            game: this,
            id: info.id,
            difficulty: info.difficulty || 2,
            seed: (this.seed ^ (i + 1) * 2654435761) >>> 0,
          })
        );
      }
    });
  }

  // ------------------------------------------------------------------
  // 地图
  // ------------------------------------------------------------------
  buildMap() {
    const { cols, rows } = this;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let t = EMPTY;
        if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) t = WALL;
        else if (x % 2 === 0 && y % 2 === 0) t = WALL;
        else if (this.rng() < 0.72) t = BOX;
        this.map[y * cols + x] = t;
      }
    }
    // 出生点十字清空，保证开局不会被闷死（只清内圈，别把外墙打穿）
    for (const sp of SPAWNS) {
      this.setTile(sp.x, sp.y, EMPTY);
      for (const d of DIR_LIST) {
        const [dx, dy] = DIRS[d];
        const nx = sp.x + dx;
        const ny = sp.y + dy;
        if (nx > 0 && ny > 0 && nx < cols - 1 && ny < rows - 1) this.setTile(nx, ny, EMPTY);
      }
    }
    // 中心留一块空地，减少"一开局就无路可走"
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (this.tileAt(x, y) === BOX) this.setTile(x, y, EMPTY);
      }
    }
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  tileAt(x, y) {
    if (!this.inBounds(x, y)) return WALL;
    return this.map[y * this.cols + x];
  }

  setTile(x, y, t) {
    if (this.inBounds(x, y)) this.map[y * this.cols + x] = t;
  }

  // ------------------------------------------------------------------
  // 玩家
  // ------------------------------------------------------------------
  createPlayer(info, spawn, slot) {
    return {
      id: info.id,
      name: info.name || '玩家',
      color: info.color || '#4aa8ff',
      slot,
      team: Number.isInteger(info.team) ? info.team : slot,
      isBot: !!info.isBot,
      difficulty: info.difficulty || 0,
      cellX: spawn.x,
      cellY: spawn.y,
      px: spawn.x,
      py: spawn.y,
      fromX: spawn.x,
      fromY: spawn.y,
      toX: spawn.x,
      toY: spawn.y,
      dir: 'down',
      moving: false,
      moveStart: 0,
      moveDur: MOVE_BASE,

      alive: true,
      trapped: false,
      trappedAt: 0,
      trappedDur: TRAP_DURATION,
      lastStruggle: 0,
      guardUntil: this.startAt + SPAWN_GUARD,

      power: 1,
      capacity: 1,
      speed: 0,
      kills: 0,
      online: true,

      desiredDir: null,
      lastSeq: 0,
      bombPressed: false,
    };
  }

  /** 玩家当前所处（或最接近）的格子 */
  cellOf(p) {
    if (!p.moving) return { x: p.cellX, y: p.cellY };
    const t = (Date.now() - p.moveStart) / p.moveDur;
    return t < 0.5 ? { x: p.fromX, y: p.fromY } : { x: p.toX, y: p.toY };
  }

  bombAt(x, y) {
    return this.bombs.find((b) => !b.exploded && b.x === x && b.y === y) || null;
  }

  ownBombCount(playerId) {
    return this.bombs.filter((b) => !b.exploded && b.ownerId === playerId).length;
  }

  /**
   * 只读的爆炸范围预览：给 AI 评估危险 & 决策用，不破坏地图。
   * 墙挡住水柱，箱子被炸开后水柱停止，泡泡视为可穿透（因为会被连锁引爆）。
   */
  blastPreview(x, y, power) {
    const cells = [{ x, y, dir: 'center' }];
    for (const d of DIR_LIST) {
      const [dx, dy] = DIRS[d];
      for (let i = 1; i <= power; i++) {
        const nx = x + dx * i;
        const ny = y + dy * i;
        const t = this.tileAt(nx, ny);
        if (t === WALL) break;
        cells.push({ x: nx, y: ny, dir: d });
        if (t === BOX) break;
      }
    }
    return cells;
  }

  canEnter(x, y) {
    if (!this.inBounds(x, y)) return false;
    const t = this.tileAt(x, y);
    if (t === WALL || t === BOX) return false;
    if (this.bombAt(x, y)) return false;
    return true;
  }

  moveDuration(p) {
    return Math.max(MOVE_MIN, Math.round(MOVE_BASE * Math.pow(MOVE_SPEED_STEP, p.speed)));
  }

  // ------------------------------------------------------------------
  // 输入（来自网络层的一次意图）
  // ------------------------------------------------------------------
  setInput(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p || this.ended) return;

    if (typeof msg.seq === 'number') p.lastSeq = Math.max(p.lastSeq, msg.seq);
    if (Date.now() < this.startAt) return; // 倒计时阶段不接受操作

    if (!p.alive) return;

    if (p.trapped) {
      // 被泡封时疯狂按方向键可以缩短泡泡破裂时间（对应原作的"挣扎"手感）
      if (msg.dir && Date.now() - p.lastStruggle > STRUGGLE_COOLDOWN) {
        p.lastStruggle = Date.now();
        const left = p.trappedDur - (Date.now() - p.trappedAt);
        if (left > TRAP_MIN + STRUGGLE_STEP) p.trappedAt -= STRUGGLE_STEP;
        else if (left > TRAP_MIN) p.trappedAt = Date.now() - (p.trappedDur - TRAP_MIN);
      }
      return;
    }

    if (msg.dir !== undefined) {
      p.desiredDir = msg.dir && DIRS[msg.dir] ? msg.dir : null;
    }
    if (msg.bomb) this.tryPlaceBomb(p);
    this.tryStartMove(p);
  }

  /**
   * 起步。
   * @param at 起始时刻。连续接格时传「上一格的到达时刻」而不是当前 tick 时刻，
   *           否则每个格子都会丢掉最多一个 tick（20ms）的余量，
   *           人物看起来就是一格一格地顿（远端玩家尤其明显）。
   */
  tryStartMove(p, at) {
    if (p.moving || !p.alive || p.trapped || !p.desiredDir) return;
    const [dx, dy] = DIRS[p.desiredDir];
    p.dir = p.desiredDir;
    const nx = p.cellX + dx;
    const ny = p.cellY + dy;
    if (!this.canEnter(nx, ny)) return;

    const startAt = at || Date.now();
    p.moving = true;
    p.fromX = p.cellX;
    p.fromY = p.cellY;
    p.toX = nx;
    p.toY = ny;
    p.moveStart = startAt;
    p.moveDur = this.moveDuration(p);
  }

  // ------------------------------------------------------------------
  // 放泡
  // ------------------------------------------------------------------
  tryPlaceBomb(p) {
    if (!p.alive || p.trapped) return false;
    if (this.ownBombCount(p.id) >= p.capacity) return false;
    const { x, y } = this.cellOf(p);
    if (this.bombAt(x, y)) return false;

    const bomb = {
      id: this.nextBombId++,
      x,
      y,
      ownerId: p.id,
      power: p.power,
      placedAt: Date.now(),
      fuseAt: Date.now() + BOMB_FUSE,
      exploded: false,
    };
    this.bombs.push(bomb);
    this.events.push({ type: 'place', x, y, owner: p.id });
    return true;
  }

  // ------------------------------------------------------------------
  // 爆炸
  // ------------------------------------------------------------------
  detonate(bomb) {
    if (bomb.exploded) return;
    bomb.exploded = true;

    const now = Date.now();
    const cells = [{ x: bomb.x, y: bomb.y, dir: 'center' }];
    const chain = [];

    for (const d of DIR_LIST) {
      const [dx, dy] = DIRS[d];
      for (let i = 1; i <= bomb.power; i++) {
        const nx = bomb.x + dx * i;
        const ny = bomb.y + dy * i;
        const tile = this.tileAt(nx, ny);
        if (tile === WALL) break;
        if (tile === BOX) {
          this.destroyBox(nx, ny);
          cells.push({ x: nx, y: ny, dir: d });
          break; // 水柱炸开箱子后停止
        }
        cells.push({ x: nx, y: ny, dir: d });
        const other = this.bombAt(nx, ny);
        if (other) {
          chain.push(other);
          break; // 遇到泡泡被挡住，但会引爆它
        }
      }
    }

    this.explosions.push({ cells, born: now, ownerId: bomb.ownerId });
    this.events.push({ type: 'boom', x: bomb.x, y: bomb.y, cells: cells.length });

    for (const c of cells) this.hitPlayerAt(c.x, c.y, bomb);

    for (const b of chain) this.detonate(b);
  }

  destroyBox(x, y) {
    this.setTile(x, y, EMPTY);
    let item = null;
    if (this.rng() < ITEM_DROP_CHANCE) {
      const r = this.rng();
      item = r < 0.4 ? 'bomb' : r < 0.78 ? 'power' : 'speed';
      this.items.set(`${x},${y}`, item);
    }
    this.changes.push([x, y, item]);
    this.events.push({ type: 'box', x, y, item: !!item });
  }

  hitPlayerAt(x, y, bomb) {
    const now = Date.now();
    for (const p of this.players.values()) {
      if (!p.alive || p.trapped) continue;
      const c = this.cellOf(p);
      if (c.x !== x || c.y !== y) continue;
      if (now < p.guardUntil) continue; // 出生保护
      if (this.teamMode && bomb.ownerId) {
        const owner = this.players.get(bomb.ownerId);
        if (owner && owner.team === p.team) continue; // 队友不互相伤害
      }
      this.trapPlayer(p, bomb.ownerId);
    }
  }

  /** 被水柱命中 → 泡封（不是直接死，保留了泡泡堂"困住-补刀"的博弈） */
  trapPlayer(p, ownerId) {
    const c = this.cellOf(p);
    p.trapped = true;
    p.trappedAt = Date.now();
    p.trappedDur = TRAP_DURATION;
    p.moving = false;
    p.cellX = p.px = p.toX = p.fromX = c.x;
    p.cellY = p.py = p.toY = p.fromY = c.y;
    p.desiredDir = null;
    p.lastHitBy = ownerId;
    this.events.push({ type: 'trap', x: p.cellX, y: p.cellY, id: p.id });
  }

  eliminate(p, killerId, reason) {
    if (!p.alive) return;
    p.alive = false;
    p.trapped = false;
    this.events.push({ type: 'die', x: p.cellX, y: p.cellY, id: p.id, reason });
    if (killerId && killerId !== p.id) {
      const killer = this.players.get(killerId);
      if (killer) killer.kills++;
    }
    this.checkEnd();
  }

  // ------------------------------------------------------------------
  // 主循环（服务端固定步长调用）
  // ------------------------------------------------------------------
  tick() {
    if (this.ended) return;
    const now = Date.now();
    if (now < this.startAt) return; // 倒计时

    // AI 先思考：它们提交的同样是"输入意图"，之后和真人一起走同一套判定
    for (const bot of this.bots.values()) bot.think(now);

    for (const p of this.players.values()) {
      if (!p.alive) continue;

      // 1) 推进移动
      let arriveAt = 0;
      if (p.moving) {
        const t = (now - p.moveStart) / p.moveDur;
        if (t >= 1) {
          arriveAt = p.moveStart + p.moveDur; // 精确到达时刻，用于无缝接下一格
          p.moving = false;
          p.cellX = p.toX;
          p.cellY = p.toY;
          p.px = p.cellX;
          p.py = p.cellY;
          this.onCellEnter(p, p.cellX, p.cellY);
        } else {
          p.px = p.fromX + (p.toX - p.fromX) * t;
          p.py = p.fromY + (p.toY - p.fromY) * t;
        }
      }

      // 2) 松开键盘后也应该马上停；按住则用到达时刻无缝接下一格
      if (!p.moving) this.tryStartMove(p, arriveAt || now);

      // 3) 泡封计时：时间到 → 泡泡自行破裂出局
      if (p.trapped && now - p.trappedAt >= p.trappedDur) {
        this.eliminate(p, p.lastHitBy, 'burst');
      }
    }

    // 4) 泡泡引信
    for (const b of this.bombs) {
      if (!b.exploded && now >= b.fuseAt) this.detonate(b);
    }
    this.bombs = this.bombs.filter((b) => !b.exploded);

    // 5) 清理过期水柱
    this.explosions = this.explosions.filter((e) => now - e.born < EXPLOSION_LIFE);

    // 6) 超时
    if (now >= this.endAt && !this.ended) this.timeUp();
  }

  onCellEnter(p, x, y) {
    // 踩到被泡封的人：队友是救援，对手是补刀
    for (const q of this.players.values()) {
      if (q === p || !q.alive || !q.trapped) continue;
      if (q.cellX === x && q.cellY === y) {
        if (this.teamMode && q.team === p.team) {
          q.trapped = false;
          q.trappedAt = 0;
          q.guardUntil = Date.now() + 900; // 救起来给一点无敌帧，避免刚救就再被炸
          q.lastHitBy = null;
          this.events.push({ type: 'save', x, y, id: q.id, by: p.id });
        } else {
          this.eliminate(q, p.id, 'pop');
        }
      }
    }
    // 拾取道具
    const key = `${x},${y}`;
    const item = this.items.get(key);
    if (item) {
      this.items.delete(key);
      this.applyItem(p, item);
      this.events.push({ type: 'pick', x, y, item, id: p.id });
    }

    // AI 到格即重新规划，避免"按固定周期思考"导致的过冲
    const bot = this.bots.get(p.id);
    if (bot) bot.onArrive();
  }

  applyItem(p, item) {
    if (item === 'bomb') p.capacity = Math.min(MAX_CAPACITY, p.capacity + 1);
    else if (item === 'power') p.power = Math.min(MAX_POWER, p.power + 1);
    else if (item === 'speed') p.speed = Math.min(MAX_SPEED, p.speed + 1);
  }

  aliveList() {
    return [...this.players.values()].filter((p) => p.alive);
  }

  checkEnd() {
    if (this.ended) return;
    const alive = this.aliveList();

    if (this.teamMode) {
      const teams = new Set(alive.map((p) => p.team));
      if (teams.size <= 1) {
        this.ended = true;
        this.winnerTeam = teams.size === 1 ? alive[0].team : null;
        this.winnerId = alive.length ? alive[0].id : null;
        this.events.push({ type: 'gameover', winner: this.winnerId, team: this.winnerTeam, reason: 'last' });
      }
      return;
    }

    if (alive.length <= 1) {
      this.ended = true;
      this.winnerId = alive.length === 1 ? alive[0].id : null;
      this.events.push({ type: 'gameover', winner: this.winnerId, reason: 'last' });
    }
  }

  timeUp() {
    this.ended = true;
    const alive = this.aliveList();

    if (this.teamMode) {
      const stat = new Map();
      for (const p of this.players.values()) {
        const s = stat.get(p.team) || { kills: 0, alive: 0 };
        s.kills += p.kills;
        if (p.alive) s.alive += 1;
        stat.set(p.team, s);
      }
      let bestTeam = null;
      let best = null;
      for (const [team, s] of stat) {
        if (!best || s.kills > best.kills || (s.kills === best.kills && s.alive > best.alive)) {
          best = s;
          bestTeam = team;
        }
      }
      this.winnerTeam = bestTeam;
      this.winnerId = alive.length ? alive.find((p) => p.team === bestTeam)?.id ?? null : null;
      this.events.push({ type: 'gameover', winner: this.winnerId, team: this.winnerTeam, reason: 'time' });
      return;
    }

    let best = null;
    for (const p of alive) {
      if (!best || p.kills > best.kills) best = p;
    }
    this.winnerId = best ? best.id : null;
    this.events.push({ type: 'gameover', winner: this.winnerId, reason: 'time' });
  }

  setOnline(playerId, online) {
    const p = this.players.get(playerId);
    if (p) p.online = online;
  }

  /** 断线超过 grace 的玩家直接判负，避免残局卡死 */
  forceEliminate(playerId, reason = 'left') {
    const p = this.players.get(playerId);
    if (p && p.alive) this.eliminate(p, null, reason);
  }

  // ------------------------------------------------------------------
  // 广播
  // ------------------------------------------------------------------
  snapshot() {
    const now = Date.now();
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        color: p.color,
        team: p.team,
        isBot: p.isBot,
        x: +p.px.toFixed(3),
        y: +p.py.toFixed(3),
        dir: p.dir,
        moving: p.moving,
        alive: p.alive,
        trapped: p.trapped,
        trappedLeft: p.trapped ? Math.max(0, p.trappedDur - (now - p.trappedAt)) : 0,
        power: p.power,
        capacity: p.capacity,
        speed: p.speed,
        kills: p.kills,
        online: p.online,
        guard: p.guardUntil > now,
        seq: p.lastSeq,
      });
    }

    const snap = {
      t: 'state',
      players,
      bombs: this.bombs.map((b) => ({
        id: b.id,
        x: b.x,
        y: b.y,
        power: b.power,
        owner: b.ownerId,
        left: Math.max(0, b.fuseAt - now),
      })),
      explosions: this.explosions.map((e) => ({
        cells: e.cells,
        age: now - e.born,
      })),
      items: [...this.items.entries()].map(([k, type]) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y, type: type === 'bomb' ? 1 : type === 'power' ? 2 : 3 };
      }),
      changes: this.changes,
      events: this.events,
      timeLeft: Math.max(0, Math.min(MATCH_TIME, this.endAt - now)),
      ended: this.ended,
      winner: this.winnerId,
      winnerTeam: this.winnerTeam,
      teamMode: this.teamMode,
    };
    this.changes = [];
    this.events = [];
    return snap;
  }

  /** 开局一次性下发的地图数据 */
  mapPayload() {
    return {
      cols: this.cols,
      rows: this.rows,
      seed: this.seed,
      map: Array.from(this.map),
      items: [...this.items.entries()].map(([k, type]) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y, type: type === 'bomb' ? 1 : type === 'power' ? 2 : 3 };
      }),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        team: p.team,
        slot: p.slot,
        isBot: p.isBot,
        x: p.cellX,
        y: p.cellY,
      })),
      teamMode: this.teamMode,
      startIn: Math.max(0, this.startAt - Date.now()),
      startAt: this.startAt,
    };
  }
}

module.exports = {
  Game,
  EMPTY,
  WALL,
  BOX,
  BOMB_FUSE,
  MATCH_TIME,
  MAX_POWER,
  MAX_CAPACITY,
  MAX_SPEED,
};
