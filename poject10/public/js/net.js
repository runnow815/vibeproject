/* ============================================================
   网络层：WebSocket 封装
   - 断线自动重连（指数退避），重连后自动 hello，服务端按 id 恢复房间/对局
   - 轻量 RTT 探测，用于顶栏延迟显示
   ============================================================ */
(function () {
  'use strict';

  const KEY = 'bubble.clientId';
  const MAX_QUEUE = 20;

  function readSession(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeSession(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (e) {
      // 隐私模式 / 配额异常时退化为内存态，不影响本局
    }
  }

  function makeId() {
    return 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  // sessionStorage 天然按标签页隔离：同一浏览器开两个标签页 = 两个玩家
  let clientId = readSession(KEY);
  if (!clientId) {
    clientId = makeId();
    writeSession(KEY, clientId);
  }

  const listeners = {};
  let ws = null;
  let name = readSession('bubble.name') || '';
  let retry = 0;
  let closedByUser = false;
  let pingTimer = null;
  let queue = [];
  let latency = 0;

  function emit(type, payload) {
    const fns = listeners[type];
    if (fns) for (const fn of fns) fn(payload);
  }

  function on(type, fn) {
    (listeners[type] || (listeners[type] = [])).push(fn);
  }

  function url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
  }

  function bind(socket) {
    socket.onopen = () => {
      retry = 0;
      emit('status', { state: 'ok' });
      try {
        socket.send(JSON.stringify({ t: 'hello', id: clientId, name }));
      } catch (e) {
        return;
      }
      // 握手前排队的消息
      const q = queue;
      queue = [];
      for (const m of q) {
        try {
          socket.send(JSON.stringify(m));
        } catch (e) {
          break;
        }
      }
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'ping', c: Date.now() }));
      }, 3000);
    };

    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        const rtt = Date.now() - msg.c;
        latency = latency ? Math.round(latency * 0.7 + rtt * 0.3) : rtt;
        emit('latency', latency);
        return;
      }
      emit(msg.t, msg);
    };

    socket.onclose = () => {
      clearInterval(pingTimer);
      if (closedByUser) return;
      emit('status', { state: 'down' });
      retry++;
      const delay = Math.min(6000, 300 * Math.pow(1.7, retry));
      setTimeout(connect, delay);
    };

    socket.onerror = () => {};
  }

  function connect() {
    closedByUser = false;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    emit('status', { state: 'connecting' });
    ws = new WebSocket(url());
    bind(ws);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
        return true;
      } catch (e) {
        return false;
      }
    }
    if (obj.t !== 'input' && obj.t !== 'ping') {
      // 队列有上限：满时优先丢最旧的聊天消息，避免挤掉建房/加入
      if (queue.length >= MAX_QUEUE) {
        const chatIdx = queue.findIndex((m) => m.t === 'chat');
        if (chatIdx >= 0) queue.splice(chatIdx, 1);
        else queue.shift();
      }
      queue.push(obj);
    }
    if (!ws || ws.readyState > 1) connect();
    return false;
  }

  function setName(v) {
    name = v;
    writeSession('bubble.name', v);
  }

  window.Net = {
    connect,
    send,
    on,
    setName,
    getLatency: () => latency,
    get id() {
      return clientId;
    },
    get name() {
      return name;
    },
  };
})();
