'use strict';

/**
 * 阵容规划：人数配置规则 + 队伍/出生角分配
 * ------------------------------------------------------------------
 * 纯函数模块，不依赖网络与游戏循环，便于单测。
 *
 * 人数配置规则（硬约束）：
 *   1 <= 真人 <= 4
 *   1 <= AI   <= 4
 *   真人 + AI <= 4
 * 由此可得混合模式的 6 种合法组合（见 VALID_LINEUPS）。
 */

const MAX_TOTAL = 4;
const MAX_HUMANS = 4;
const MAX_BOTS = 4;

const COLORS = ['#4aa8ff', '#ff7b9c', '#ffbe4a', '#57d38c'];
const BOT_NAMES = ['小泡', '阿水', '泡泡喵', '水枪兵'];

/** 出生角：0 左上 / 1 右下 / 2 右上 / 3 左下（与 game.js 的 SPAWNS 对应） */
const FFA_SLOTS = {
  2: [0, 1],
  3: [0, 1, 2],
  4: [0, 1, 2, 3],
};
// 队伍模式：同队站同一侧，两队隔图相望
const TEAM_SLOTS = {
  0: [0, 3],
  1: [2, 1],
};

const TEAM_NAMES = ['蓝队', '红队'];
const TEAM_COLORS = ['#3f8efc', '#ff6b8a'];

/** 混合模式全部合法组合，用于 UI 提示与文档 */
const VALID_LINEUPS = [
  { humans: 1, bots: 1, total: 2 },
  { humans: 1, bots: 2, total: 3 },
  { humans: 1, bots: 3, total: 4 },
  { humans: 2, bots: 1, total: 3 },
  { humans: 2, bots: 2, total: 4 },
  { humans: 3, bots: 1, total: 4 },
];

/**
 * 归一化客户端传来的模式参数。
 * bots 在服务端是"配置值"，pvp 强制 0；pve/hybrid 限定 1..3
 * （因为 hybrid 要求至少 1 名真人，4 个 AI 会突破总人数上限）。
 */
function normalizeConfig(msg = {}) {
  const mode = ['pvp', 'pve', 'hybrid'].includes(msg.mode) ? msg.mode : 'pvp';
  const difficulty = [1, 2, 3].includes(Number(msg.difficulty)) ? Number(msg.difficulty) : 2;
  const raw = Number(msg.bots);
  let bots = Number.isFinite(raw) ? Math.round(raw) : 3;
  bots = Math.max(1, Math.min(3, bots));

  return {
    mode,
    bots: mode === 'pvp' ? 0 : bots,
    difficulty,
    teamMode: !!msg.teamMode,
  };
}

/** 该配置下还能坐进多少真人 */
function humanCapacity(config) {
  if (config.mode === 'pvp') return MAX_HUMANS;
  if (config.mode === 'pve') return 1;
  return MAX_TOTAL - config.bots;
}

/** 返回错误文案，null 表示合法 */
function validateLineup(humans, bots, mode) {
  if (humans < 1) return '至少需要 1 名真人玩家';
  if (humans > MAX_HUMANS) return `真人玩家最多 ${MAX_HUMANS} 名`;
  if (mode === 'pvp' && bots > 0) return '玩家对战不能携带 AI';
  if (mode !== 'pvp' && bots < 1) return 'AI 数量至少为 1';
  if (bots > MAX_BOTS) return `AI 最多 ${MAX_BOTS} 名`;
  if (mode === 'pve' && humans > 1) return '人机对战只能 1 名真人';
  const total = humans + bots;
  if (total > MAX_TOTAL) return `真人 + AI 总数不能超过 ${MAX_TOTAL} 人（当前 ${humans} + ${bots}）`;
  if (total < 2) return '至少需要 2 名参战者';
  return null;
}

/**
 * 生成最终阵容。
 * @param {object}   opt
 * @param {'pvp'|'pve'|'hybrid'} opt.mode
 * @param {Array}    opt.humans      按加入顺序排列：[{id,name,color}]
 * @param {Array}    opt.bots        [{id,name}]
 * @param {boolean}  opt.teamMode    期望分队（不足 4 人自动降级为混战）
 * @param {number}   opt.difficulty  1/2/3
 * @returns {{error?:string, players?:Array, teamMode?:boolean, total?:number, teamNames?:string[]}}
 */
function planLineup({ mode, humans = [], bots = [], teamMode = false, difficulty = 2 }) {
  const err = validateLineup(humans.length, bots.length, mode || (bots.length ? 'hybrid' : 'pvp'));
  if (err) return { error: err };

  const total = humans.length + bots.length;
  const useTeams = !!teamMode && total === MAX_TOTAL;

  // 真人沿用房间里的颜色；AI 取剩下的颜色
  const usedColors = new Set(humans.map((h) => h.color).filter(Boolean));
  const pickColor = (i) => COLORS.find((c) => !usedColors.has(c)) || COLORS[i % COLORS.length];

  const makeHuman = (h) => ({ id: h.id, name: h.name, color: h.color || pickColor(0), isBot: false });
  const makeBot = (b, i) => ({
    id: b.id,
    name: b.name,
    color: (() => {
      const c = pickColor(i);
      usedColors.add(c);
      return c;
    })(),
    isBot: true,
    difficulty,
  });

  if (!useTeams) {
    const slots = FFA_SLOTS[total] || [0, 1, 2, 3];
    const order = [...humans.map(makeHuman), ...bots.map(makeBot)];
    return {
      teamMode: false,
      total,
      players: order.map((p, i) => ({ ...p, team: i, slot: slots[i] })),
    };
  }

  // ---- 队伍分配 ----
  // 1) 真人蛇形轮转：0→A, 1→B, 2→A…，保证两队真人数量差 ≤1
  const teams = [[], []];
  humans.forEach((h, i) => teams[i % 2].push(makeHuman(h)));
  // 2) AI 补到人数少的一队（相等时补蓝队），保证两队总人数差 ≤1
  bots.forEach((b, i) => {
    const t = teams[0].length <= teams[1].length ? 0 : 1;
    teams[t].push(makeBot(b, i));
  });

  const players = [];
  for (const t of [0, 1]) {
    teams[t].forEach((p, j) => {
      players.push({ ...p, team: t, slot: TEAM_SLOTS[t][j] });
    });
  }

  return { teamMode: true, total, players, teamNames: TEAM_NAMES };
}

module.exports = {
  MAX_TOTAL,
  MAX_HUMANS,
  MAX_BOTS,
  COLORS,
  BOT_NAMES,
  TEAM_NAMES,
  TEAM_COLORS,
  VALID_LINEUPS,
  normalizeConfig,
  humanCapacity,
  validateLineup,
  planLineup,
};
