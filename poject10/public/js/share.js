/* ============================================================
   邀请链接 / 剪贴板
   ------------------------------------------------------------
   职责：
   1. 解析 ?room=CODE，只接受与服务端一致的 4 位房号；
   2. 进入房间时用 history.replaceState 同步 URL，离开时移除；
   3. 生成邀请链接；剪贴板失败时降级为只读输入框手动复制。
   ============================================================ */
(function () {
  'use strict';

  const CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;

  function readRoomFromUrl(search) {
    const rawSearch = typeof search === 'string' ? search : location.search || '';
    let raw = '';
    try {
      raw = (new URLSearchParams(rawSearch).get('room') || '').trim().toUpperCase();
    } catch (e) {
      raw = '';
    }
    if (!raw) return { code: null, raw, invalid: false };
    return { code: CODE_RE.test(raw) ? raw : null, raw, invalid: true };
  }

  function replaceQuery(mutator) {
    try {
      const url = new URL(location.href);
      mutator(url.searchParams);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {
      // file:// 或历史 API 不可用时保持原 URL，不影响游戏
    }
  }

  function syncRoomUrl(code) {
    if (!code) return;
    replaceQuery((params) => params.set('room', code));
  }

  function clearRoomUrl() {
    replaceQuery((params) => params.delete('room'));
  }

  function inviteUrl(code) {
    const base = location.origin && location.origin !== 'null' ? location.origin : '';
    return base + location.pathname + '?room=' + encodeURIComponent(code);
  }

  async function copy(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      // 权限拒绝 / 非安全上下文，继续走 execCommand 降级
    }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function showFallback(url) {
    const input = document.getElementById('inviteUrl');
    if (!input) return;
    input.value = url;
    input.hidden = false;
    try {
      input.focus();
      input.setSelectionRange(0, url.length);
    } catch (e) {
      // 某些浏览器对 readonly 输入框的 selection 有限制
    }
    if (input.scrollIntoView) input.scrollIntoView({ block: 'nearest' });
  }

  function hideFallback() {
    const input = document.getElementById('inviteUrl');
    if (!input) return;
    input.hidden = true;
    input.value = '';
  }

  window.Share = {
    readRoomFromUrl,
    syncRoomUrl,
    clearRoomUrl,
    inviteUrl,
    copy,
    showFallback,
    hideFallback,
  };
})();
