/* ============================================================
   本地存储层：设置 + 战绩
   ------------------------------------------------------------
   职责：
   1. settings / stats 的 schema 校验与版本迁移；
   2. localStorage 不可用（隐私模式 / 配额满 / 损坏 JSON）时
      自动降级为内存态，保证页面不崩、对局不受影响；
   3. 战绩只保留最近 20 局，不记录姓名、房号、对手 id、聊天内容；
   4. 通过 createStore(storage) 注入存储，浏览器与 Node 单测共用。

   浏览器：window.Store；Node：module.exports
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Store = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEYS = {
    settings: 'bubble.settings',
    stats: 'bubble.stats',
  };
  const SCHEMA = 1;
  const MAX_MATCHES = 20;
  const DEFAULTS = Object.freeze({
    v: SCHEMA,
    sfx: true,
    volume: 0.7,
    motion: 'system',
    tips: true,
    updatedAt: 0,
  });
  const MODES = new Set(['pvp', 'pve', 'hybrid']);
  const RESULTS = new Set(['win', 'lose', 'draw']);

  function createMemoryStorage() {
    const data = new Map();
    return {
      getItem(key) {
        return data.has(key) ? data.get(key) : null;
      },
      setItem(key, value) {
        data.set(key, String(value));
      },
      removeItem(key) {
        data.delete(key);
      },
    };
  }

  function defaultStorage() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) {
      // Safari 隐私模式访问 localStorage 也可能抛错
    }
    return createMemoryStorage();
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function normalizeSettings(raw, now) {
    if (!raw || typeof raw !== 'object') {
      return { ...DEFAULTS, updatedAt: now || 0 };
    }
    return {
      v: SCHEMA,
      sfx: typeof raw.sfx === 'boolean' ? raw.sfx : DEFAULTS.sfx,
      volume: clampNumber(raw.volume, 0, 1, DEFAULTS.volume),
      motion: raw.motion === 'reduce' ? 'reduce' : 'system',
      tips: typeof raw.tips === 'boolean' ? raw.tips : DEFAULTS.tips,
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now || 0,
    };
  }

  function sanitizeMatch(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const at = Number(raw.at);
    if (!Number.isFinite(at) || at <= 0) return null;

    const startedAtNum = Number(raw.startedAt);
    const startedAt = Number.isFinite(startedAtNum) && startedAtNum > 0 ? startedAtNum : null;
    const teamMode = !!raw.teamMode;
    const team = teamMode && (raw.team === 0 || raw.team === 1) ? raw.team : null;

    return {
      id:
        typeof raw.id === 'string' && raw.id
          ? raw.id.slice(0, 80)
          : `${startedAt || at}-${at}`,
      at,
      startedAt,
      mode: MODES.has(raw.mode) ? raw.mode : 'pvp',
      teamMode,
      team,
      result: RESULTS.has(raw.result) ? raw.result : 'lose',
      kills: clampInt(raw.kills, 0, 99, 0),
      durationMs: clampInt(raw.durationMs, 0, 180000, 0),
      humans: clampInt(raw.humans, 1, 4, 1),
      bots: clampInt(raw.bots, 0, 3, 0),
    };
  }

  function normalizeStats(raw) {
    const list = raw && Array.isArray(raw.matches) ? raw.matches : [];
    const matches = list
      .map(sanitizeMatch)
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_MATCHES);
    return {
      v: SCHEMA,
      matches,
      updatedAt: raw && Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
    };
  }

  function summarize(matches) {
    const list = Array.isArray(matches) ? matches : [];
    let wins = 0;
    let losses = 0;
    let draws = 0;
    let bestKills = 0;
    for (const m of list) {
      if (!m) continue;
      if (m.result === 'win') wins++;
      else if (m.result === 'lose') losses++;
      else draws++;
      const k = Number(m.kills);
      if (Number.isFinite(k) && k > bestKills) bestKills = k;
    }
    const total = list.length;
    return {
      total,
      wins,
      losses,
      draws,
      winRate: total ? Math.round((wins / total) * 1000) / 10 : 0,
      bestKills,
    };
  }

  /**
   * 从服务端 over 消息构造一条战绩。非参与者返回 null。
   * @param {object} msg  over 消息
   * @param {string} myId 本地玩家 id
   * @param {{mode?:string,durationMs?:number}} fallback
   */
  function matchFromOver(msg, myId, fallback) {
    const fb = fallback || {};
    if (!msg || !Array.isArray(msg.results) || !myId) return null;
    const mine = msg.results.find((r) => r && r.id === myId);
    if (!mine) return null;

    const teamMode = !!msg.teamMode;
    let result;
    if (teamMode) {
      if (msg.winnerTeam === null || msg.winnerTeam === undefined) result = 'draw';
      else result = mine.team === msg.winnerTeam ? 'win' : 'lose';
    } else if (!msg.winner) {
      result = 'draw';
    } else {
      result = msg.winner === myId ? 'win' : 'lose';
    }

    const at = Date.now();
    const startedAtNum = Number(msg.startedAt);
    const startedAt = Number.isFinite(startedAtNum) && startedAtNum > 0 ? startedAtNum : null;
    const humans = Number.isFinite(Number(msg.humans))
      ? clampInt(msg.humans, 1, 4, 1)
      : Math.max(1, msg.results.filter((r) => r && !r.isBot).length);
    const bots = Number.isFinite(Number(msg.bots))
      ? clampInt(msg.bots, 0, 3, 0)
      : msg.results.filter((r) => r && r.isBot).length;

    return {
      id: `${startedAt || at}-${at}`,
      at,
      startedAt,
      mode: MODES.has(msg.mode) ? msg.mode : MODES.has(fb.mode) ? fb.mode : 'pvp',
      teamMode,
      team: teamMode ? mine.team : null,
      result,
      kills: clampInt(mine.kills, 0, 99, 0),
      durationMs: clampInt(
        msg.durationMs === undefined ? fb.durationMs : msg.durationMs,
        0,
        180000,
        0
      ),
      humans,
      bots,
    };
  }

  function createStore(storage) {
    const target = storage || defaultStorage();
    let writable = true;
    let settingsCache = null;
    let statsCache = null;
    let settingsLocked = false;
    let statsLocked = false;

    function readRaw(key) {
      try {
        return target.getItem(key);
      } catch (e) {
        return null;
      }
    }

    function writeRaw(key, value) {
      try {
        target.setItem(key, JSON.stringify(value));
        writable = true;
        return true;
      } catch (e) {
        writable = false;
        return false;
      }
    }

    function removeRaw(key) {
      try {
        target.removeItem(key);
      } catch (e) {
        writable = false;
      }
    }

    function parse(raw) {
      if (!raw) return null;
      try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? value : null;
      } catch (e) {
        return null;
      }
    }

    function getSettings() {
      if (settingsCache) return { ...settingsCache };
      const raw = parse(readRaw(KEYS.settings));
      if (raw && Number(raw.v) > SCHEMA) settingsLocked = true;
      settingsCache = normalizeSettings(settingsLocked ? null : raw);
      return { ...settingsCache };
    }

    function saveSettings(patch) {
      const next = normalizeSettings(
        { ...getSettings(), ...(patch || {}) },
        Date.now()
      );
      settingsCache = next;
      if (!settingsLocked) writeRaw(KEYS.settings, next);
      return { ...next };
    }

    function getStats() {
      if (statsCache) {
        return { ...statsCache, matches: statsCache.matches.map((m) => ({ ...m })) };
      }
      const raw = parse(readRaw(KEYS.stats));
      if (raw && Number(raw.v) > SCHEMA) statsLocked = true;
      statsCache = normalizeStats(statsLocked ? null : raw);
      return { ...statsCache, matches: statsCache.matches.map((m) => ({ ...m })) };
    }

    function addMatch(record) {
      const clean = sanitizeMatch(record);
      if (!clean) return null;
      const cur = getStats();
      const matches = [clean, ...cur.matches.filter((m) => m.id !== clean.id)].slice(0, MAX_MATCHES);
      statsCache = { v: SCHEMA, matches, updatedAt: Date.now() };
      if (!statsLocked) writeRaw(KEYS.stats, statsCache);
      return { ...clean };
    }

    function clearStats() {
      statsCache = { v: SCHEMA, matches: [], updatedAt: Date.now() };
      if (!statsLocked) removeRaw(KEYS.stats);
    }

    function clearAll() {
      settingsCache = normalizeSettings(null);
      statsCache = { v: SCHEMA, matches: [], updatedAt: Date.now() };
      removeRaw(KEYS.settings);
      removeRaw(KEYS.stats);
    }

    function getSummary() {
      return summarize(getStats().matches);
    }

    function exportPayload() {
      const stats = getStats();
      return {
        app: 'bubble-battle',
        schema: SCHEMA,
        exportedAt: new Date().toISOString(),
        stats: { v: SCHEMA, matches: stats.matches },
        summary: summarize(stats.matches),
      };
    }

    return {
      getSettings,
      saveSettings,
      getStats,
      addMatch,
      clearStats,
      clearAll,
      getSummary,
      exportPayload,
      get available() {
        return writable;
      },
    };
  }

  return {
    KEYS,
    SCHEMA,
    MAX_MATCHES,
    DEFAULTS,
    createMemoryStorage,
    createStore,
    summarize,
    normalizeSettings,
    sanitizeMatch,
    normalizeStats,
    matchFromOver,
  };
});
