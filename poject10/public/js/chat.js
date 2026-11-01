/* ============================================================
   房间聊天
   ------------------------------------------------------------
   职责：
   1. 8 条快捷语 + 自由输入（最多 40 个 Unicode 码点）；
   2. 仅房间等待期可用，开局后禁用并清空；
   3. 所有玩家文本用 textContent 渲染，禁止 HTML 注入；
   4. 客户端 700ms 冷却 + DOM 最多 50 条，服务端另有令牌桶；
   5. 中文输入法组合期间不裁剪、不发送。
   ============================================================ */
(function () {
  'use strict';

  const QUICK = [
    '准备好了吗？',
    '等我一下',
    '开始吧！',
    '别炸我',
    '这局稳了',
    '换个模式？',
    '打得好！',
    '再来一局',
  ];
  const MAX_LEN = 40;
  const MAX_ITEMS = 50;
  const COOLDOWN = 700;

  let refs = null;
  let opts = null;
  let currentCode = null;
  let lastSent = 0;
  let enabled = false;
  let composing = false;

  const $ = (id) => document.getElementById(id);

  function truncate(text) {
    const chars = Array.from(String(text == null ? '' : text));
    return chars.length > MAX_LEN ? chars.slice(0, MAX_LEN).join('') : chars.join('');
  }

  function updateCount() {
    if (!refs) return;
    refs.count.textContent = Array.from(refs.input.value).length + '/' + MAX_LEN;
  }

  function clearLog() {
    if (refs) refs.log.textContent = '';
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!refs) return;
    refs.input.disabled = !enabled;
    refs.send.disabled = !enabled;
    for (const b of refs.quick.querySelectorAll('button')) b.disabled = !enabled;
    refs.input.placeholder = enabled ? '说点什么（最多 40 字）' : '对局进行中不可聊天';
  }

  function append(msg) {
    if (!refs) return;
    const item = document.createElement('div');
    item.className = 'chat-item' + (msg.id === (opts && opts.getMyId && opts.getMyId()) ? ' self' : '');

    const who = document.createElement('b');
    who.textContent = msg.name || '玩家';
    if (typeof msg.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(msg.color)) {
      who.style.color = msg.color;
    }

    const text = document.createElement('span');
    text.textContent = msg.text;

    item.appendChild(who);
    item.appendChild(text);
    refs.log.appendChild(item);
    while (refs.log.children.length > MAX_ITEMS) refs.log.removeChild(refs.log.firstChild);
    refs.log.scrollTop = refs.log.scrollHeight;
  }

  function sendText(raw) {
    if (!enabled || !refs) return;
    const text = truncate(raw).trim();
    if (!text) return;

    const now = Date.now();
    if (now - lastSent < COOLDOWN) {
      if (opts && opts.toast) opts.toast('发得太快了，稍等一下', 1200);
      return;
    }

    const ok = opts && opts.send ? opts.send({ t: 'chat', text }) : false;
    if (!ok && opts && opts.toast) opts.toast('网络未连接，消息将在重连后发送', 1800);

    lastSent = now;
    refs.input.value = '';
    updateCount();
  }

  function init(options) {
    opts = options || {};
    refs = {
      log: $('chatLog'),
      quick: $('chatQuick'),
      input: $('chatInput'),
      send: $('btnChatSend'),
      count: $('chatCount'),
    };
    if (!refs.log || !refs.quick || !refs.input || !refs.send || !refs.count) return;

    for (const text of QUICK) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = text;
      b.addEventListener('click', () => sendText(text));
      refs.quick.appendChild(b);
    }

    refs.input.addEventListener('input', () => {
      if (composing) return;
      const v = truncate(refs.input.value);
      if (v !== refs.input.value) refs.input.value = v;
      updateCount();
    });

    refs.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      if (e.isComposing || composing) return;
      e.preventDefault();
      sendText(refs.input.value);
    });

    refs.input.addEventListener('compositionstart', () => {
      composing = true;
    });
    refs.input.addEventListener('compositionend', () => {
      composing = false;
      const v = truncate(refs.input.value);
      if (v !== refs.input.value) refs.input.value = v;
      updateCount();
    });

    refs.send.addEventListener('click', () => sendText(refs.input.value));
    updateCount();
    setEnabled(false);
  }

  function bind(room) {
    if (!room) {
      reset();
      return;
    }
    if (room.code !== currentCode) {
      currentCode = room.code;
      clearLog();
    }
    setEnabled(room.state === 'waiting');
  }

  function reset() {
    currentCode = null;
    clearLog();
    if (refs) {
      refs.input.value = '';
      updateCount();
    }
    setEnabled(false);
  }

  function receive(msg) {
    if (!msg || typeof msg.text !== 'string') return;
    if (!enabled) return;
    append(msg);
  }

  window.Chat = {
    init,
    bind,
    reset,
    receive,
    setEnabled,
    // 供自动化测试读取，不参与业务
    get enabled() {
      return enabled;
    },
  };
})();
