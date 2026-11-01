/* ============================================================
   布局适配层
   ------------------------------------------------------------
   职责（只做布局，不碰游戏逻辑）：
   1. 棋盘尺寸 —— 唯一真源。按 .stage 的可用宽高、HUD 的占位，
      在「可用宽 / 可用高 / --board-max」之间取小，等比缩放写回 --board-w，
      保证任何视口下棋盘都完整可见且不溢出（而不是靠 vh 魔法数字硬算）。
   2. 视口高度 —— 把 visualViewport 的高度写进 --vvh，
      软键盘弹出时覆盖层不会被顶出屏幕。
   3. 能力与断点标记 —— body.touch-on / body.dataset.bp / body.dataset.orient，
      供 CSS 与自动化测试使用。
   ============================================================ */
(function () {
  'use strict';

  // 棋盘 15 列 × 13 行（与 server/game.js 的 cols/rows 一致）
  const RATIO = 15 / 13;
  // 与 style.css 的 xl 断点（1200px）保持一致：宽屏时 HUD 变成右侧竖栏
  const RAIL_MQ = '(min-width: 1200px)';
  const MIN_W = 140; // 兜底：可用空间极小时也不小于此宽度

  let stage = null;
  let boardCol = null;
  let hud = null;
  let railMQ = null;
  let lastW = 0;
  let rafId = 0;

  function readMaxWidth() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--board-max').trim();
    // xs 档写的是 100%（跟随父容器），此时不设上限
    if (!raw || raw.indexOf('%') >= 0) return Infinity;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : Infinity;
  }

  function setWidth(w) {
    if (Math.abs(w - lastW) < 1) return;
    lastW = w;
    boardCol.style.setProperty('--board-w', w + 'px');
  }

  /** 重新计算棋盘宽度（同步两次：HUD 换行会改变自身高度） */
  function fit() {
    if (!stage || !boardCol) return;
    const cs = getComputedStyle(stage);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const availW = Math.max(MIN_W, stage.clientWidth - padX);
    const availH = Math.max(80, stage.clientHeight - padY);

    const rail = railMQ.matches;
    const gap = rail ? 18 : 8;
    const maxW = readMaxWidth();

    const hudW = rail ? hud.offsetWidth : 0;
    let hudH = rail ? 0 : hud.offsetHeight;

    let w = Math.min(availW - hudW - (rail ? gap : 0), (availH - hudH - gap) * RATIO, maxW);
    w = Math.max(MIN_W, Math.floor(w));
    setWidth(w);

    // 第 2 趟：HUD 的宽度依赖棋盘宽度，换行后高度会变，需要再收一次
    if (!rail) {
      const hudH2 = hud.offsetHeight;
      if (Math.abs(hudH2 - hudH) > 1) {
        w = Math.max(MIN_W, Math.floor(Math.min(availW, (availH - hudH2 - gap) * RATIO, maxW)));
        setWidth(w);
      }
    }
  }

  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      fit();
    });
  }

  /** 断点 / 朝向标记，纯信息用途（CSS 用媒体查询，测试用这里） */
  function mark() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    document.body.dataset.bp = w < 480 ? 'xs' : w < 768 ? 'sm' : w < 1024 ? 'md' : w < 1200 ? 'lg' : 'xl';
    document.body.dataset.orient = w >= h ? 'landscape' : 'portrait';
  }

  /**
   * 显示虚拟摇杆的两种触发：
   *   1. 主指针就是手指（pointer: coarse）→ 手机/平板
   *   2. 触摸笔记本这类「鼠标为主、但能摸」的设备：默认不显示，
   *      一旦真的摸了一下屏幕再切过去，避免平白占用 158px 高度
   */
  function setTouch(on) {
    const touch = document.getElementById('touch');
    if (document.body.classList.contains('touch-on') === on) return;
    document.body.classList.toggle('touch-on', on);
    if (touch) touch.hidden = !on;
    schedule();
  }

  function syncPointer() {
    setTouch(!!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches));
  }

  function enableTouch() {
    setTouch(true);
  }

  /** 软键盘 / 地址栏伸缩时，把真实可视高度写给覆盖层 */
  function syncViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    document.documentElement.style.setProperty('--vvh', Math.round(vv.height) + 'px');
  }

  function init() {
    stage = document.querySelector('.stage');
    boardCol = document.getElementById('boardCol');
    hud = document.getElementById('hud');
    if (!stage || !boardCol || !hud) return;
    railMQ = window.matchMedia(RAIL_MQ);

    mark();
    syncPointer();
    syncViewport();
    fit();

    window.addEventListener('resize', () => {
      mark();
      syncViewport();
      schedule();
    });
    window.addEventListener('orientationchange', () => {
      // 部分移动端在 orientationchange 时尺寸还没更新，延后一帧再算
      setTimeout(() => {
        mark();
        schedule();
      }, 120);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewport);
    }
    if (railMQ.addEventListener) railMQ.addEventListener('change', schedule);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(schedule);
      ro.observe(stage);
      ro.observe(hud);
    }
    // 字体异步加载完成后高度可能变化
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  }

  window.Layout = {
    init,
    fit,
    schedule,
    enableTouch,
    get boardWidth() {
      return lastW;
    },
  };
})();
