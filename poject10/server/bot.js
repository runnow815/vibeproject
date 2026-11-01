'use strict';

/**
 * AI 玩家控制器
 * ------------------------------------------------------------------
 * 关键设计：AI 不做任何"特权操作"，它和真人一样只能向 Game.setInput()
 * 提交「我想往哪走 / 想放泡泡」的意图，是否合法、能不能走、水柱打到谁，
 * 全部由服务端同一套规则判定。这样 AI 不会穿墙、不会瞬移，也不会因为
 * 规则改动而和真人产生两套逻辑。
 *
 * 决策流程（每次思考）：
 *   1. 危险图：所有泡泡的爆炸范围 + 剩余引信 → 哪些格子在什么时刻会挨炸
 *   2. 已在危险格 → 立刻找最近的、爆炸结束后仍安全的格子逃（带时间预算 BFS）
 *   3. 安全 → 评估脚下放泡的价值（能炸到人 / 能炸开箱子），并先验证"放完逃得掉"
 *   4. 没事做 → 去捡道具 / 追最近的对手
 *
 * 难度只影响"反应速度、失误率、思考深度"，不改变规则，也不给 AI 加数值。
 */

const DIRS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};
const DIR_LIST = ['up', 'down', 'left', 'right'];

const BOMB_FUSE = 2400; // 与 game.js 保持一致
const SAFETY = 130; // 穿过危险格时要求的余量（毫秒）
const SAFE_AFTER = 260; // 放泡后至少要留出的逃生余量

const PRESET = {
  1: { think: 240, jitter: 140, mistake: 0.3, steps: 8, chase: 0.55 },
  2: { think: 150, jitter: 80, mistake: 0.12, steps: 12, chase: 0.85 },
  3: { think: 85, jitter: 45, mistake: 0.03, steps: 16, chase: 1 },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (x, y) => `${x},${y}`;

class Bot {
  constructor({ game, id, difficulty = 2, seed = 1 }) {
    this.game = game;
    this.id = id;
    this.preset = PRESET[difficulty] || PRESET[2];
    this.rng = mulberry32(seed);
    this.nextThink = 0;
    this.nextStruggle = 0;
    this.mood = 0; // 偶尔"走神"，模拟人类玩家的注意力波动
    this.moodUntil = 0;
  }

  get p() {
    return this.game.players.get(this.id);
  }

  /** 到达新格子的回调：立刻重新规划，而不是等下一个思考周期 */
  onArrive() {
    this.nextThink = 0;
  }

  send(msg) {
    this.game.setInput(this.id, msg);
  }

  // ------------------------------------------------------------------
  // 主决策
  // ------------------------------------------------------------------
  think(now) {
    const p = this.p;
    if (!p || !p.alive || this.game.ended) return;
    if (now < this.nextThink) return;
    this.nextThink = now + this.preset.think + this.rng() * this.preset.jitter;
    if (now < this.game.startAt) return;

    if (p.trapped) return this.struggle(now);

    // 走格子途中就按"即将到达的格子"规划，指令会在到格瞬间生效，不抽搐
    const from = p.moving ? { x: p.toX, y: p.toY } : this.game.cellOf(p);
    const startAt = p.moving ? Math.max(now, p.moveStart + p.moveDur) : now;
    const stepMs = this.game.moveDuration(p);

    if (this.rng() < this.preset.mistake * 0.02) {
      // 极低概率的手滑：朝随机方向走一步
      return this.send({ dir: DIR_LIST[(this.rng() * 4) | 0] });
    }

    const danger = this.dangerMap();
    const fromKey = key(from.x, from.y);
    const hereKey = key(Math.round(p.px), Math.round(p.py));

    // 1) 逃命
    if (danger.has(fromKey) || danger.has(hereKey)) {
      const esc = this.findEscape(from, danger, startAt, stepMs);
      if (esc && esc.length) return this.send({ dir: esc[0] });
      return this.send({ dir: this.leastBad(from, danger, now, stepMs) });
    }

    // 2) 放泡泡（只在站定时放，避免落点与视觉位置不一致）
    if (!p.moving) {
      const esc = this.maybeBomb(from, danger, now, stepMs);
      if (esc) {
        this.send({ bomb: true });
        if (esc.length) this.send({ dir: esc[0] });
        this.nextThink = now + this.preset.think; // 放完马上接着跑
        return;
      }
    }

    // 3) 找事做：道具优先，其次追人
    const path = this.pickTarget(from, danger, startAt, stepMs);
    if (path && path.length) this.send({ dir: path[0] });
    else this.send({ dir: null });
  }

  /** 被泡封：疯狂按方向键挣扎（和真人同一个机制） */
  struggle(now) {
    if (now < this.nextStruggle) return;
    this.nextStruggle = now + 110 + this.rng() * 60;
    this.send({ dir: DIR_LIST[(this.rng() * 4) | 0] });
  }

  // ------------------------------------------------------------------
  // 危险图
  // ------------------------------------------------------------------
  /** @returns {Map<string, number>} 格子 -> 最早挨炸的时刻（毫秒时间戳） */
  dangerMap() {
    const map = new Map();
    const bombs = this.game.bombs.filter((b) => !b.exploded);
    const queue = bombs.map((b) => ({ bomb: b, at: b.fuseAt }));
    const seenAt = new Map();

    for (let i = 0; i < queue.length; i++) {
      const { bomb, at } = queue[i];
      const prev = seenAt.get(bomb.id);
      if (prev !== undefined && prev <= at) continue;
      seenAt.set(bomb.id, at);

      const cells = this.game.blastPreview(bomb.x, bomb.y, bomb.power);
      for (const c of cells) {
        const k = key(c.x, c.y);
        const cur = map.get(k);
        if (cur === undefined || cur > at) map.set(k, at);

        // 连锁：被水柱扫到的泡泡会提前引爆
        const other = this.game.bombAt(c.x, c.y);
        if (other && other.id !== bomb.id) queue.push({ bomb: other, at: at + 80 });
      }
    }
    return map;
  }

  // ------------------------------------------------------------------
  // 寻路
  // ------------------------------------------------------------------
  /**
   * 时间感知的 BFS：把"到达时刻"作为代价，杜绝走进即将爆炸的格子。
   */
  bfs(start, danger, startAt, stepMs, maxSteps) {
    const g = this.game;
    const sk = key(start.x, start.y);
    const arrive = new Map([[sk, startAt]]);
    const dist = new Map([[sk, 0]]);
    const prev = new Map([[sk, null]]);
    const queue = [start];

    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const ck = key(cur.x, cur.y);
      const d = dist.get(ck);
      if (d >= maxSteps) continue;
      const t = arrive.get(ck);

      for (const dir of DIR_LIST) {
        const [dx, dy] = DIRS[dir];
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const nk = key(nx, ny);
        if (arrive.has(nk)) continue;
        if (!g.canEnter(nx, ny)) continue;

        const nt = t + stepMs;
        const blastAt = danger.get(nk);
        if (blastAt !== undefined && blastAt < nt + SAFETY) continue;

        arrive.set(nk, nt);
        dist.set(nk, d + 1);
        prev.set(nk, { from: ck, dir });
        queue.push({ x: nx, y: ny });
      }
    }
    return { arrive, dist, prev };
  }

  trace(prev, target, startKey) {
    const dirs = [];
    let k = target;
    let guard = 0;
    while (k && k !== startKey && guard++ < 64) {
      const step = prev.get(k);
      if (!step) break;
      dirs.push(step.dir);
      k = step.from;
    }
    return dirs.reverse();
  }

  openNeighbors(k) {
    const [x, y] = k.split(',').map(Number);
    let n = 0;
    for (const dir of DIR_LIST) {
      const [dx, dy] = DIRS[dir];
      if (this.game.canEnter(x + dx, y + dy)) n++;
    }
    return n;
  }

  /** 寻找"爆炸结束后依然安全"的落脚点，优先不是死胡同的格子 */
  findEscape(start, danger, startAt, stepMs) {
    const budget = Math.max(4, Math.floor((BOMB_FUSE - SAFE_AFTER) / Math.max(70, stepMs)));
    const maxSteps = Math.min(this.preset.steps + 2, budget);
    const { arrive, prev } = this.bfs(start, danger, startAt, stepMs, maxSteps);
    const sk = key(start.x, start.y);

    let open = null;
    let plain = null;
    for (const [k] of arrive) {
      if (k === sk) continue;
      if (danger.has(k)) continue; // 只要真正安全的格子
      if (this.openNeighbors(k) >= 2) {
        if (!open) open = k;
      } else if (!plain) {
        plain = k;
      }
    }
    const target = open || plain;
    if (!target) return null;
    return this.trace(prev, target, sk);
  }

  /** 实在无路可逃时，挑一个炸得最晚的方向 */
  leastBad(from, danger, now, stepMs) {
    let bestDir = null;
    let bestAt = -1;
    for (const dir of DIR_LIST) {
      const [dx, dy] = DIRS[dir];
      const nx = from.x + dx;
      const ny = from.y + dy;
      if (!this.game.canEnter(nx, ny)) continue;
      const at = danger.get(key(nx, ny)) ?? Infinity;
      if (at > bestAt) {
        bestAt = at;
        bestDir = dir;
      }
    }
    return bestDir;
  }

  // ------------------------------------------------------------------
  // 放泡决策
  // ------------------------------------------------------------------
  /** @returns {string[]|null} 放泡后的逃生路线（null = 不放） */
  maybeBomb(cell, danger, now, stepMs) {
    const p = this.p;
    const g = this.game;
    if (g.ownBombCount(p.id) >= p.capacity) return null;
    if (g.bombAt(cell.x, cell.y)) return null;

    const blast = g.blastPreview(cell.x, cell.y, p.power);
    let boxes = 0;
    let enemies = 0;
    let mates = 0;

    for (const c of blast) {
      if (c.x === cell.x && c.y === cell.y) continue;
      if (g.tileAt(c.x, c.y) === 2) boxes++;
      for (const q of g.players.values()) {
        if (!q.alive || q.id === p.id) continue;
        const qc = g.cellOf(q);
        if (qc.x !== c.x || qc.y !== c.y) continue;
        if (g.teamMode && q.team === p.team) mates++;
        else enemies++;
      }
    }

    if (mates > 0) return null; // 别炸队友
    if (!boxes && !enemies) return null;

    // 简单 AI 更"贪"：不炸空箱子，只求打人
    if (this.preset.chase <= 0.6 && enemies === 0 && this.rng() > 0.45) return null;

    // 先验证逃生，再落子
    const after = new Map(danger);
    const boomAt = now + BOMB_FUSE;
    for (const c of blast) {
      const k = key(c.x, c.y);
      const cur = after.get(k);
      if (cur === undefined || cur > boomAt) after.set(k, boomAt);
    }
    const esc = this.findEscape(cell, after, now, stepMs);
    if (!esc || !esc.length) return null;
    return esc;
  }

  // ------------------------------------------------------------------
  // 目标选择
  // ------------------------------------------------------------------
  pickTarget(cell, danger, startAt, stepMs) {
    const g = this.game;
    const p = this.p;
    const { arrive, dist, prev } = this.bfs(cell, danger, startAt, stepMs, this.preset.steps);

    let itemKey = null;
    let itemDist = Infinity;
    for (const k of g.items.keys()) {
      if (!arrive.has(k)) continue;
      const d = dist.get(k);
      if (d < itemDist) {
        itemDist = d;
        itemKey = k;
      }
    }

    let enemyKey = null;
    let enemyDist = Infinity;
    let trappedEnemyKey = null;
    let trappedDist = Infinity;
    for (const q of g.players.values()) {
      if (!q.alive || q.id === p.id) continue;
      if (g.teamMode && q.team === p.team) continue;
      const qc = g.cellOf(q);
      const k = key(qc.x, qc.y);
      if (!arrive.has(k)) continue;
      const d = dist.get(k);
      if (q.trapped && d < trappedDist) {
        trappedDist = d;
        trappedEnemyKey = k;
      }
      if (d < enemyDist) {
        enemyDist = d;
        enemyKey = k;
      }
    }

    // 补刀优先：被泡封的对手走过去就能淘汰
    if (trappedEnemyKey && trappedDist <= this.preset.steps) {
      return this.trace(prev, trappedEnemyKey, key(cell.x, cell.y));
    }

    // 道具 vs 追人：道具更近就先拿道具；追人积极性由难度控制
    const wantChase = enemyKey && this.rng() < this.preset.chase;
    let targetKey = null;
    if (itemKey && (itemDist <= enemyDist || !wantChase)) targetKey = itemKey;
    else if (wantChase) targetKey = enemyKey;

    // 既没道具也没人可追 → 去最近的"可炸箱位置"开图
    // 如果脚下就是可炸箱位置，就停住（path 为空 → 下发停步），下一拍再落子；
    // 否则会出现"走到箱前又折返"的左右横跳。
    if (!targetKey) {
      const selfKey = key(cell.x, cell.y);
      const canBombHere = this.hasBoxNeighbor(selfKey) && this.game.ownBombCount(p.id) < p.capacity;
      targetKey = canBombHere ? selfKey : this.nearestFrontier(arrive, dist);
    }
    if (!targetKey) return null;
    return this.trace(prev, targetKey, key(cell.x, cell.y));
  }

  /** 最近的、四邻有箱子的可站立格（站在那里放泡就能开图） */
  nearestFrontier(arrive, dist) {
    let best = null;
    let bestDist = Infinity;
    for (const k of arrive.keys()) {
      if (!this.hasBoxNeighbor(k)) continue;
      const d = dist.get(k);
      if (d > 0 && d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    return best;
  }

  hasBoxNeighbor(k) {
    const [x, y] = k.split(',').map(Number);
    for (const dir of DIR_LIST) {
      const [dx, dy] = DIRS[dir];
      if (this.game.tileAt(x + dx, y + dy) === 2) return true;
    }
    return false;
  }
}

module.exports = { Bot, PRESET };
