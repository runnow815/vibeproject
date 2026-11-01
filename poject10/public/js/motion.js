/* ============================================================
   移动内核（浏览器 + Node 共用，便于单测）
   ------------------------------------------------------------
   解决的问题：
   1. 「丢帧补时」—— 到达一格时把本帧多出来的时间接着算进下一格。
      旧实现每到一格就重置 moveStart = now，等于每格丢掉半帧（约 8ms），
      格数越多累积越明显，而且丢多少取决于帧落点，走起来会"一顿一顿"。
   2. 帧率无关 —— 位移用时间戳算，30/60/120/144Hz 下走一格都应该是 150ms。
   3. 输入零延迟 —— 按下方向键的那一刻就能开始位移，不用等下一帧。

   本模块不碰 DOM、不碰网络，只做纯数学推进。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Motion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DIRS = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  };

  const DEFAULTS = { base: 150, step: 0.82, min: 78 };

  /** 走一格需要多久（速度等级越高越快，但不超过最快的下限） */
  function moveDur(speed, cfg) {
    const base = (cfg && cfg.base) || DEFAULTS.base;
    const step = (cfg && cfg.step) || DEFAULTS.step;
    const min = (cfg && cfg.min) || DEFAULTS.min;
    return Math.max(min, Math.round(base * Math.pow(step, speed | 0)));
  }

  /** 从当前格朝 dir 起步（不检查可通行性，由调用方先判定） */
  function begin(m, dir, at, dur, dirs) {
    const d = (dirs || DIRS)[dir];
    if (!d) return false;
    m.dir = dir;
    m.fromX = m.cellX;
    m.fromY = m.cellY;
    m.toX = m.cellX + d[0];
    m.toY = m.cellY + d[1];
    m.moving = true;
    m.moveStart = at;
    m.moveDur = dur;
    m.px = m.fromX;
    m.py = m.fromY;
    return true;
  }

  /**
   * 推进移动。
   * @param m       mover：{cellX,cellY,px,py,fromX,fromY,toX,toY,moving,moveStart,moveDur,speed}
   * @param now     当前时间（ms，同一时钟）
   * @param opts    { dir, canEnter(x,y), durFor(speed), dirs, onArrive(m), maxSteps }
   */
  function advance(m, now, opts) {
    const o = opts || {};
    const dirs = o.dirs || DIRS;
    const durFor = o.durFor || ((s) => moveDur(s));
    const canEnter = o.canEnter || (() => true);
    const maxSteps = o.maxSteps || 8;

    for (let step = 0; step < maxSteps; step++) {
      // 静止：有方向就起步（这一步让"按键即动"成为可能）
      if (!m.moving) {
        const dir = o.dir;
        const d = dirs[dir];
        if (!d) return;
        m.dir = dir;
        const nx = m.cellX + d[0];
        const ny = m.cellY + d[1];
        if (!canEnter(nx, ny)) return;
        begin(m, dir, now, durFor(m.speed), dirs);
      }

      const t = (now - m.moveStart) / m.moveDur;
      if (t < 1) {
        // 帧内插值：直接按时间比例算，和帧率无关
        m.px = m.fromX + (m.toX - m.fromX) * t;
        m.py = m.fromY + (m.toY - m.fromY) * t;
        return;
      }

      // 到格：把"到达时刻"而不是 now 作为下一格的起点 → 剩余时间不丢
      const arriveAt = m.moveStart + m.moveDur;
      m.cellX = m.toX;
      m.cellY = m.toY;
      m.px = m.cellX;
      m.py = m.cellY;
      m.moving = false;
      if (o.onArrive) o.onArrive(m);

      const dir = o.dir;
      const d = dirs[dir];
      if (!d) return;
      if (!canEnter(m.cellX + d[0], m.cellY + d[1])) {
        m.dir = dir;
        return;
      }
      begin(m, dir, arriveAt, durFor(m.speed), dirs);
      // 循环回去继续消耗 now - arriveAt 的余量
    }
  }

  /**
   * 远端玩家插值：在一串带到达时间的样本之间做线性插值。
   * 比指数平滑更稳 —— 指数平滑在每个快照到达的瞬间会"跳一下再收敛"，
   * 60ms 一帧的快照下看起来就是一格一格地顿。
   * @param samples [{t,x,y}]（按 t 升序）
   * @param rt      渲染时间（一般是 now - 延迟）
   */
  function sampleAt(samples, rt, opts) {
    const o = opts || {};
    const extrapolate = o.extrapolate === undefined ? 120 : o.extrapolate;
    const n = samples.length;
    if (!n) return null;
    if (n === 1) return { x: samples[0].x, y: samples[0].y };

    // 找最后一个 t <= rt 的样本
    let i = n - 1;
    while (i > 0 && samples[i].t > rt) i--;
    const a = samples[i];
    const b = samples[i + 1];

    if (!b) {
      // 越过最新样本：按最后一段速度短距离外推，避免"卡住不动"
      const prev = samples[i - 1] || a;
      const span = a.t - prev.t;
      if (extrapolate <= 0 || span <= 0) return { x: a.x, y: a.y };
      const dt = Math.min(extrapolate, rt - a.t) / span;
      return {
        x: a.x + (a.x - prev.x) * dt,
        y: a.y + (a.y - prev.y) * dt,
      };
    }

    const span = b.t - a.t;
    const k = span > 0 ? Math.max(0, Math.min(1, (rt - a.t) / span)) : 1;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  return { DIRS, moveDur, begin, advance, sampleAt, DEFAULTS };
});
