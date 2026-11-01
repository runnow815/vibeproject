'use strict';

/**
 * 输入校验与限流（纯函数，不依赖网络 / DOM）
 * ------------------------------------------------------------------
 * 设计原则：
 *  1. 只做"能不能进入业务层"的判断，不改写 game.js 的任何判定语义；
 *  2. 所有函数对 null/undefined/异常类型返回安全值，不抛异常；
 *  3. 令牌桶支持注入时间戳，便于单测，不依赖真实时钟。
 */

const MAX_PAYLOAD = 16 * 1024; // 单条 WebSocket 消息上限（字节）
const DEFAULT_MAX_ROOMS = 500; // 进程内房间总数上限
const MAX_CHAT_CHARS = 40; // 聊天按 Unicode 码点计
const MAX_NAME_CHARS = 12;
const MAX_SEQ = 0x7fffffff;

// 与 index.js 的 CODE_CHARS 一致：去掉易混淆的 I / O / 0 / 1
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DIR_SET = new Set(['up', 'down', 'left', 'right']);

function toText(value) {
  return value === undefined || value === null ? '' : String(value);
}

/** 按 Unicode 码点计数（中文 1 字 = 1，emoji 通常 1 个码点） */
function countChars(value) {
  return Array.from(toText(value)).length;
}

/** 去控制字符、折叠空白、trim，并按码点截断 */
function cleanText(value, max) {
  const text = toText(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!Number.isFinite(max) || max <= 0) return text;
  return Array.from(text).slice(0, max).join('');
}

function normalizeChat(text) {
  return cleanText(text, MAX_CHAT_CHARS);
}

function sanitizeName(name) {
  return cleanText(name, MAX_NAME_CHARS) || '玩家';
}

/** 合法房号返回大写形式，否则 null */
function normalizeCode(code) {
  const value = toText(code).trim().toUpperCase();
  return CODE_RE.test(value) ? value : null;
}

/** 合法客户端 id 返回原值，否则 null */
function normalizeId(id) {
  const value = toText(id).trim();
  return ID_RE.test(value) ? value : null;
}

/** 缺省视为 0；非法（字符串/浮点/负数/超上限）返回 null */
function normalizeSeq(seq) {
  if (seq === undefined) return 0;
  if (!Number.isInteger(seq)) return null;
  if (seq < 0 || seq > MAX_SEQ) return null;
  return seq;
}

function isValidDir(dir) {
  return dir === undefined || dir === null || DIR_SET.has(dir);
}

/**
 * 令牌桶。
 * @param {{capacity:number, refillPerSec:number}} opt
 * @returns {{take:Function, tokens:number, capacity:number, reset:Function}}
 */
function createBucket(opt = {}) {
  const capacity = Math.max(1, Number(opt.capacity) || 1);
  const refillPerSec = Math.max(0, Number(opt.refillPerSec) || 0);
  let tokens = capacity;
  let last = null;

  return {
    take(at) {
      const now = Number.isFinite(at) ? at : Date.now();
      if (last === null) last = now;
      // 上限 5 秒：长时间挂起后不会凭一次跳跃补出大量令牌
      const dt = Math.min(5, Math.max(0, now - last) / 1000);
      last = now;
      tokens = Math.min(capacity, tokens + dt * refillPerSec);
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    get tokens() {
      return tokens;
    },
    get capacity() {
      return capacity;
    },
    reset() {
      tokens = capacity;
      last = null;
    },
  };
}

module.exports = {
  MAX_PAYLOAD,
  DEFAULT_MAX_ROOMS,
  MAX_CHAT_CHARS,
  MAX_NAME_CHARS,
  MAX_SEQ,
  CODE_RE,
  ID_RE,
  countChars,
  cleanText,
  normalizeChat,
  sanitizeName,
  normalizeCode,
  normalizeId,
  normalizeSeq,
  isValidDir,
  createBucket,
};
