/* ============================================================
   模态弹层：设置中心 + 本地战绩
   ------------------------------------------------------------
   职责：
   1. 统一管理「设置」「战绩」两个模态层：打开 / 关闭 / 焦点陷阱 / Esc；
   2. 打开时把背景（棋盘、首页、房间、结算）设为 inert，避免 Tab 与
      读屏器穿透到弹层背后；关闭时恢复并把焦点还给触发按钮；
   3. 设置改动即时生效（音效 / 音量 / 减少动效 / 操作提示），
      通过 hooks.onApplySettings 交给主控去落地，本模块不直接碰 Sfx；
   4. 战绩只读渲染，导出 JSON、清空（二次确认，不弹系统对话框）；
   5. 所有玩家可控文本走 textContent / 数值格式化，不拼接 HTML。

   依赖：window.Store（可缺省，缺省时弹层仍可打开，但内容为空态）
   ============================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // 打开模态层时需要屏蔽的背景容器（顺序无意义）
  const BACKDROP_IDS = ['app', 'screenHome', 'screenRoom', 'screenOver'];
  const SCREENS = { settings: 'screenSettings', stats: 'screenStats' };
  const FOCUSABLE = [
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[href]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const MODE_LABEL = { pvp: '玩家对战', pve: '人机对战', hybrid: '混合对战' };
  const RESULT_LABEL = { win: '胜', lose: '负', draw: '平' };

  let store = null;
  let hooks = {};
  let current = null; // 'settings' | 'stats' | null
  let lastFocus = null;
  let saveTimer = null;
  let confirmTimer = null;
  let confirmBtn = null;
  let warnedStorage = false;
  let bound = false;

  const el = {};

  function esc(v) {
    return String(v == null ? '' : v).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function toast(msg, ms) {
    if (hooks.toast) hooks.toast(msg, ms);
  }

  // ---------------------------------------------------------------
  // 焦点管理
  // ---------------------------------------------------------------
  function focusables(root) {
    if (!root) return [];
    const list = Array.prototype.slice.call(root.querySelectorAll(FOCUSABLE));
    return list.filter((n) => n.getClientRects().length > 0 || n === document.activeElement);
  }

  function setBackdropInert(on) {
    for (const id of BACKDROP_IDS) {
      const node = $(id);
      if (!node) continue;
      if (on) {
        node.setAttribute('inert', '');
        node.setAttribute('aria-hidden', 'true');
      } else {
        node.removeAttribute('inert');
        node.removeAttribute('aria-hidden');
      }
    }
  }

  function onKeydown(e) {
    if (!current) return;
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;

    const root = el[current] && el[current].querySelector('.panel');
    const list = focusables(root);
    if (!list.length) {
      e.preventDefault();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    const inside = root && root.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ---------------------------------------------------------------
  // 设置
  // ---------------------------------------------------------------
  function reflect(s) {
    document.body.classList.toggle('reduce-motion', s.motion === 'reduce');
    document.body.classList.toggle('hide-tips', s.tips === false);
    if (hooks.onApplySettings) hooks.onApplySettings(s);
  }

  function paintSettings(s) {
    if (!s) return;
    if (el.setSfx) el.setSfx.checked = !!s.sfx;
    if (el.setVolume) {
      const pct = Math.round((Number(s.volume) || 0) * 100);
      el.setVolume.value = String(pct);
      el.setVolume.disabled = !s.sfx;
    }
    if (el.volText) el.volText.textContent = Math.round((Number(s.volume) || 0) * 100) + '%';
    if (el.setTips) el.setTips.checked = !!s.tips;
    if (el.motionTabs) {
      for (const b of el.motionTabs.querySelectorAll('button')) {
        const on = b.dataset.motion === s.motion;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
  }

  function save(patch, immediate) {
    if (!store) return;
    clearTimeout(saveTimer);
    const run = () => {
      const next = store.saveSettings(patch);
      paintSettings(next);
      reflect(next);
      if (!store.available && !warnedStorage) {
        warnedStorage = true;
        toast('本机存储不可用，设置仅在本次会话生效', 2600);
      }
      if (hooks.onSettingsSaved) hooks.onSettingsSaved(next);
    };
    if (immediate) run();
    else saveTimer = setTimeout(run, 180);
  }

  // ---------------------------------------------------------------
  // 战绩
  // ---------------------------------------------------------------
  function fmtTime(ms) {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '--';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function matchRow(m) {
    const mode = MODE_LABEL[m.mode] || '对局';
    const seat = m.bots ? `${m.humans} 人 + AI ${m.bots}` : `${m.humans} 人`;
    const result = RESULT_LABEL[m.result] || '负';
    return (
      `<li class="stat-item r-${esc(m.result)}">` +
      `<span class="sr" aria-label="${esc(result)}">${esc(result)}</span>` +
      `<span class="sm">${esc(mode)} · ${esc(seat)}</span>` +
      `<span class="sk">淘汰 ${esc(m.kills)}</span>` +
      `<span class="sd">${esc(fmtTime(m.at))}</span>` +
      `</li>`
    );
  }

  function paintStats() {
    if (!el.statList) return;
    const matches = store ? store.getStats().matches : [];
    const sum = store ? store.getSummary() : { total: 0, winRate: 0, bestKills: 0 };

    if (el.statTotal) el.statTotal.textContent = String(sum.total);
    if (el.statWinRate) el.statWinRate.textContent = sum.total ? sum.winRate + '%' : '—';
    if (el.statBest) el.statBest.textContent = String(sum.bestKills);

    if (!matches.length) {
      el.statList.innerHTML = '<li class="stat-empty">还没有战绩，打一局试试</li>';
      return;
    }
    el.statList.innerHTML = matches.map(matchRow).join('');
  }

  function exportStats() {
    if (!store) return;
    const payload = store.exportPayload();
    const text = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bubble-stats-${stamp}.json`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(`已导出 ${payload.stats.matches.length} 条战绩`, 2200);
    } catch (e) {
      toast('当前浏览器不支持文件导出', 2400);
    }
  }

  /**
   * 二次确认（两步点击），不弹系统 confirm：
   * 第一次点按钮变成「确认清空？」，3.2 秒内再点一次才真正执行。
   */
  function armConfirm(btn, label, action) {
    if (!btn) return;
    if (confirmBtn === btn) {
      disarm();
      action();
      return;
    }
    disarm();
    confirmBtn = btn;
    btn.dataset.label = btn.textContent;
    btn.textContent = label;
    confirmTimer = setTimeout(disarm, 3200);
  }

  function disarm() {
    clearTimeout(confirmTimer);
    if (confirmBtn && confirmBtn.dataset.label) {
      confirmBtn.textContent = confirmBtn.dataset.label;
    }
    confirmBtn = null;
  }

  // ---------------------------------------------------------------
  // 打开 / 关闭
  // ---------------------------------------------------------------
  function open(name) {
    const node = SCREENS[name] ? $(SCREENS[name]) : null;
    if (!node || current === name) return false;
    if (current) close({ restoreFocus: false });

    lastFocus = document.activeElement;
    current = name;
    el[name] = node;
    node.hidden = false;
    setBackdropInert(true);

    if (name === 'settings') {
      paintSettings(store ? store.getSettings() : null);
    } else {
      paintStats();
    }

    const panel = node.querySelector('.panel');
    const list = focusables(panel);
    const target =
      (name === 'settings' && el.btnSettingsDone) || (name === 'stats' && el.btnStatsDone) || list[0];
    setTimeout(() => {
      const first = focusables(panel)[0];
      (target || first || panel).focus({ preventScroll: true });
    }, 30);
    return true;
  }

  function close(options) {
    if (!current) return false;
    const opts = options || {};
    const node = el[current];
    current = null;
    disarm();
    clearTimeout(saveTimer);

    if (node) node.hidden = true;
    setBackdropInert(false);

    if (opts.restoreFocus !== false) {
      const back = lastFocus;
      lastFocus = null;
      if (back && back.isConnected && back.focus) {
        setTimeout(() => back.focus({ preventScroll: true }), 20);
      }
    } else {
      lastFocus = null;
    }
    return true;
  }

  function isOpen() {
    return !!current;
  }

  // ---------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------
  function bind() {
    if (bound) return;
    bound = true;

    document.addEventListener('keydown', onKeydown, true);

    if (el.setSfx) {
      el.setSfx.addEventListener('change', () => save({ sfx: !!el.setSfx.checked }, true));
    }
    if (el.setVolume) {
      el.setVolume.addEventListener('input', () => {
        const pct = Number(el.setVolume.value) || 0;
        if (el.volText) el.volText.textContent = pct + '%';
        save({ volume: pct / 100 }, false);
      });
      el.setVolume.addEventListener('change', () => {
        save({ volume: (Number(el.setVolume.value) || 0) / 100 }, true);
      });
    }
    if (el.motionTabs) {
      el.motionTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-motion]');
        if (!btn) return;
        save({ motion: btn.dataset.motion === 'reduce' ? 'reduce' : 'system' }, true);
      });
    }
    if (el.setTips) {
      el.setTips.addEventListener('change', () => save({ tips: !!el.setTips.checked }, true));
    }
    if (el.btnClearData) {
      el.btnClearData.addEventListener('click', () => {
        armConfirm(el.btnClearData, '确认清空？', () => {
          if (store) store.clearAll();
          paintSettings(store ? store.getSettings() : null);
          paintStats();
          reflect(store ? store.getSettings() : { motion: 'system', tips: true });
          toast('本地设置与战绩已清空', 2400);
        });
      });
    }
    if (el.btnSettingsDone) el.btnSettingsDone.addEventListener('click', () => close());
    if (el.btnStatsDone) el.btnStatsDone.addEventListener('click', () => close());
    if (el.btnExportStats) el.btnExportStats.addEventListener('click', exportStats);
    if (el.btnClearStats) {
      el.btnClearStats.addEventListener('click', () => {
        armConfirm(el.btnClearStats, '确认清空？', () => {
          if (store) store.clearStats();
          paintStats();
          toast('战绩已清空', 2000);
        });
      });
    }

    // 点遮罩空白处关闭（面板内部点击不冒泡到遮罩）
    for (const name of Object.keys(SCREENS)) {
      const node = $(SCREENS[name]);
      if (!node) continue;
      node.addEventListener('mousedown', (e) => {
        if (e.target === node) close();
      });
    }
  }

  function init(options) {
    hooks = options || {};
    store = hooks.store || null;

    el.settings = $('screenSettings');
    el.stats = $('screenStats');
    el.setSfx = $('setSfx');
    el.setVolume = $('setVolume');
    el.volText = $('volText');
    el.motionTabs = $('motionTabs');
    el.setTips = $('setTips');
    el.btnClearData = $('btnClearData');
    el.btnSettingsDone = $('btnSettingsDone');
    el.btnStatsDone = $('btnStatsDone');
    el.statTotal = $('statTotal');
    el.statWinRate = $('statWinRate');
    el.statBest = $('statBest');
    el.statList = $('statList');
    el.btnExportStats = $('btnExportStats');
    el.btnClearStats = $('btnClearStats');

    bind();

    // 初始设置无条件落地：即使 storage 不可用也要让 body class 正确
    const initial = store ? store.getSettings() : { sfx: true, volume: 0.7, motion: 'system', tips: true };
    paintSettings(initial);
    reflect(initial);
    if (!store) {
      // 没有存储层时禁用可写控件，避免"点了没反应"的困惑
      if (el.setSfx) el.setSfx.disabled = true;
      if (el.setVolume) el.setVolume.disabled = true;
      if (el.setTips) el.setTips.disabled = true;
      if (el.btnClearData) el.btnClearData.disabled = true;
    }
  }

  window.Panels = {
    init,
    open,
    close,
    isOpen,
    refreshSettings: () => paintSettings(store ? store.getSettings() : null),
    refreshStats: () => {
      if (current === 'stats') paintStats();
    },
    // 供自动化测试读取，不参与业务
    get current() {
      return current;
    },
  };
})();
