/* ============================================================
   客户端主控
   ------------------------------------------------------------
   核心职责：
   1. 输入 → 立刻本地预测（零延迟手感），同时把输入序号发往服务端
   2. 收到权威快照 → 远端玩家做指数插值；本地玩家做"软校正"
   3. 场景 / 房间 / 结算 的界面状态机
   ============================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const DIRS = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  };
  const TILE = 44;
  const BOMB_FUSE = 2400;
  const MOVE_BASE = 150;
  const MOVE_SPEED_STEP = 0.82;
  const MOVE_MIN = 78;
  const MOVE_CFG = { base: MOVE_BASE, step: MOVE_SPEED_STEP, min: MOVE_MIN };

  // 远端玩家回放延迟：比最新快照晚 90ms 播放，正好卡在两个快照之间做线性插值
  const REMOTE_DELAY = 90;
  // 本地校正偏移的收敛速度（越大收敛越快，14 ≈ 150ms 内消掉 90%）
  const CORR_RATE = 14;

  // 本地设置与战绩（storage 不可用时自动降级为内存态）
  const store = window.Store ? window.Store.createStore() : null;

  // ---------------------------------------------------------------
  // 音效（WebAudio 合成，无外部资源）
  // ---------------------------------------------------------------
  const Sfx = (() => {
    let ac = null;
    let master = null;
    let volume = 0.7;
    let muted = false;

    function ensure() {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ac = new AC();
        master = ac.createGain();
        master.gain.value = muted ? 0 : volume;
        master.connect(ac.destination);
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    }

    function setVolume(v) {
      const n = Number(v);
      volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7;
      if (master) master.gain.value = muted ? 0 : volume;
    }

    function setMuted(v) {
      muted = !!v;
      if (master) master.gain.value = muted ? 0 : volume;
    }

    function tone(freq, to, dur, type, gain, delay) {
      const c = ensure();
      if (!c) return;
      const t0 = c.currentTime + (delay || 0);
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, to || freq), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.12, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(master || c.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    }
    function noise(dur, gain, freq) {
      const c = ensure();
      if (!c) return;
      const len = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      }
      const src = c.createBufferSource();
      src.buffer = buf;
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq || 620;
      f.Q.value = 0.9;
      const g = c.createGain();
      g.gain.value = gain || 0.18;
      src.connect(f).connect(g).connect(master || c.destination);
      src.start();
    }
    return {
      setVolume,
      setMuted,
      place() {
        tone(520, 300, 0.1, 'sine', 0.1);
      },
      boom() {
        noise(0.42, 0.26, 780);
        tone(180, 60, 0.32, 'sine', 0.12);
      },
      pick() {
        tone(760, 760, 0.07, 'square', 0.05);
        tone(1020, 1020, 0.09, 'square', 0.05, 0.07);
      },
      trap() {
        tone(430, 150, 0.4, 'triangle', 0.12);
      },
      die() {
        tone(300, 70, 0.5, 'sawtooth', 0.1);
      },
      win() {
        [523, 659, 784, 1046].forEach((f, i) => tone(f, f, 0.16, 'triangle', 0.1, i * 0.11));
      },
    };
  })();

  // ---------------------------------------------------------------
  // 全局状态
  // ---------------------------------------------------------------
  const S = {
    screen: 'home',
    myId: null,
    name: '',
    room: null,
    playing: false,

    cols: 15,
    rows: 13,
    tiles: new Uint8Array(15 * 13),
    items: [],
    bombs: [],
    explosions: [],
    players: new Map(),
    timeLeft: 0,

    me: null, // 本地预测对象
    seq: 0,
    inputDir: null,
    heldDirs: [],
    bombLatch: false,
    lastTrapped: false,
    countEnd: 0, // 开局倒计时结束时刻（performance.now 基准）
    countDone: true,
    teamMode: false, // 本局是否为分队模式
    myTeam: null,
    autoDeadline: 0, // 快速匹配房自动开局的本地时间点
    matchStartAt: 0, // 本局开始时刻（performance.now 基准，用于战绩兜底）
    lastOverKey: null, // 结算去重，避免同一局写两条战绩
  };

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------
  const el = {
    canvas: $('board'),
    hud: $('hud'),
    veil: $('boardVeil'),
    boardWrap: $('boardWrap'),
    netState: $('netState'),
    netText: $('netText'),
    roomTag: $('roomTag'),
    roomCodeTop: $('roomCodeTop'),
    screens: {
      home: $('screenHome'),
      room: $('screenRoom'),
      over: $('screenOver'),
    },
    nameInput: $('nameInput'),
    codeInput: $('codeInput'),
    roomCode: $('roomCode'),
    roomHint: $('roomHint'),
    playerList: $('playerList'),
    btnReady: $('btnReady'),
    btnStart: $('btnStart'),
    overTitle: $('overTitle'),
    overSub: $('overSub'),
    resultList: $('resultList'),
    roomCfg: $('roomCfg'),
    cfgRow: $('cfgRow'),
    modeTabs: $('modeTabs'),
    diffTabs: $('diffTabs'),
    teamTabs: $('teamTabs'),
    teamLine: $('teamLine'),
    botCount: $('botCount'),
    botMinus: $('botMinus'),
    botPlus: $('botPlus'),
    lineupText: $('lineupText'),
    toast: $('toast'),
    countdown: $('countdown'),
    countdownNum: $('countdownNum'),
    btnSettings: $('btnSettings'),
    btnStats: $('btnStats'),
    btnInvite: $('btnInvite'),
    inviteUrl: $('inviteUrl'),
  };

  const timerEl = $('timerEl');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms || 2200);
  }

  function showScreen(name) {
    const prev = S.screen;
    // 真正切换界面时收起模态弹层；同一屏内的房间广播不应关闭设置/战绩
    if (prev !== name && window.Panels && Panels.isOpen()) {
      Panels.close({ restoreFocus: false });
    }
    S.screen = name;
    for (const k of Object.keys(el.screens)) {
      el.screens[k].hidden = k !== name;
    }
    if (name === 'game') {
      el.screens.home.hidden = true;
      el.screens.room.hidden = true;
      el.screens.over.hidden = true;
      S.playing = true;
      el.roomTag.hidden = false;
      // 进局后把焦点从按钮上移走：否则空格既放炸弹又可能再触发一次按钮
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    } else if (prev && prev !== name) {
      // 覆盖层切换时把焦点送到主按钮，键盘用户的 Tab 不用从头扫一遍；
      // 首次进入首页不自动聚焦，免得手机上软键盘直接把界面顶起来
      const panel = el.screens[name] && el.screens[name].querySelector('.panel');
      const primary = panel && panel.querySelector('.btn.primary:not([hidden])');
      if (primary) setTimeout(() => primary.focus({ preventScroll: true }), 30);
    }
    // 棋盘尺寸随界面切换（HUD 出现/消失）重新适配
    if (window.Layout) window.Layout.schedule();
  }

  // ---------------------------------------------------------------
  // 输入
  // ---------------------------------------------------------------
  const KEYMAP = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
  };

  function setDir(dir) {
    if (S.inputDir === dir) return;
    S.inputDir = dir;
    sendInput(dir);
    // 按下方向键的当下就起步，不等到下一帧 —— 手感上是"零延迟"
    kickLocal();
  }

  function pushDir(dir) {
    if (!S.heldDirs.includes(dir)) S.heldDirs.push(dir);
    setDir(dir);
  }

  function releaseDir(dir) {
    const i = S.heldDirs.indexOf(dir);
    if (i >= 0) S.heldDirs.splice(i, 1);
    setDir(S.heldDirs.length ? S.heldDirs[S.heldDirs.length - 1] : null);
  }

  function sendInput(dir, bomb) {
    if (!S.myId) return;
    S.seq++;
    Net.send({ t: 'input', seq: S.seq, dir: dir === undefined ? undefined : dir, bomb: !!bomb });
  }

  /** 与服务端 cellOf 保持一致：移动中取更近的一格 */
  function nearestCell() {
    const m = S.me;
    if (!m.moving) return { x: m.cellX, y: m.cellY };
    const t = (performance.now() - m.moveStart) / m.moveDur;
    return t < 0.5 ? { x: m.fromX, y: m.fromY } : { x: m.toX, y: m.toY };
  }

  function placeBomb() {
    if (window.Panels && Panels.isOpen()) return;
    if (!S.me || !S.me.alive || S.me.trapped) return;
    if (performance.now() < S.countEnd) return;
    sendInput(undefined, true);

    // 乐观本地放泡：不等服务端回包，先画出来（服务端确认后由权威列表接管）
    const m = S.me;
    const { x: cx, y: cy } = nearestCell();
    const own = S.bombs.filter((b) => b.owner === S.myId).length + m.pending.length;
    if (own >= m.capacity) return;
    if (bombAt(cx, cy)) return;
    m.pending.push({ x: cx, y: cy, at: performance.now() });
    Sfx.place();
  }

  window.addEventListener('keydown', (e) => {
    if (window.Panels && Panels.isOpen()) return; // Esc 由弹层自己处理
    if (e.repeat) return;
    const dir = KEYMAP[e.code];
    if (S.screen === 'game' && dir) {
      e.preventDefault();
      pushDir(dir);
      return;
    }
    if (S.screen === 'game' && (e.code === 'Space' || e.code === 'KeyJ' || e.code === 'KeyK')) {
      e.preventDefault();
      placeBomb();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (window.Panels && Panels.isOpen()) return;
    const dir = KEYMAP[e.code];
    if (dir) releaseDir(dir);
  });

  window.addEventListener('blur', () => {
    S.heldDirs.length = 0;
    setDir(null);
  });

  // 触屏方向键（显示与否由 layout.js 按 pointer 能力决定，这里只绑事件）
  const touch = $('touch');
  touch.querySelectorAll('[data-dir]').forEach((btn) => {
    const dir = btn.dataset.dir;
    const down = (e) => {
      if (window.Panels && Panels.isOpen()) return;
      e.preventDefault();
      pushDir(dir);
    };
    const up = (e) => {
      e.preventDefault();
      releaseDir(dir);
    };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
  });
  $('touchBomb').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (window.Panels && Panels.isOpen()) return;
    placeBomb();
  });
  // 触摸笔记本：摸过一次屏幕再启用摇杆
  window.addEventListener('touchstart', () => {
    if (window.Layout) window.Layout.enableTouch();
  }, { once: true, passive: true });

  // ---------------------------------------------------------------
  // 本地预测
  // ---------------------------------------------------------------
  function moveDur(speed) {
    return Motion.moveDur(speed, MOVE_CFG);
  }

  function bombAt(x, y) {
    for (const b of S.bombs) if (b.x === x && b.y === y) return true;
    if (S.me) for (const b of S.me.pending) if (b.x === x && b.y === y) return true;
    return false;
  }

  function canEnterLocal(x, y) {
    if (x < 0 || y < 0 || x >= S.cols || y >= S.rows) return false;
    if (S.tiles[y * S.cols + x] !== 0) return false;
    return !bombAt(x, y);
  }

  function moveOpts() {
    return { dir: S.inputDir, canEnter: canEnterLocal, durFor: moveDur };
  }

  /**
   * 推进本地预测。
   * Motion.advance 内部会做两件关键的事：
   *  1. 到格时用「到达时刻」而不是「当前帧时刻」续接下一格 —— 不丢时间，
   *     所以 30/60/144Hz 下走一格都是 150ms，不会走起来一顿一顿；
   *  2. 松开方向键时把当前这一格走完再停，避免半格悬空。
   */
  function updateLocal(now) {
    const m = S.me;
    if (!m) return;
    if (!m.alive || m.trapped) {
      m.moving = false;
      return;
    }
    if (now < S.countEnd) return; // 开局倒计时期间锁操作
    Motion.advance(m, now, moveOpts());
  }

  /** 立即尝试起步（按下方向键的当下就动，不等下一帧） */
  function kickLocal() {
    const m = S.me;
    if (!m || !m.alive || m.trapped || m.moving) return;
    if (performance.now() < S.countEnd) return;
    Motion.advance(m, performance.now(), moveOpts());
  }

  function snapLocal(x, y) {
    const m = S.me;
    m.moving = false;
    m.cellX = m.px = m.toX = m.fromX = x;
    m.cellY = m.py = m.toY = m.fromY = y;
    m.corrX = 0;
    m.corrY = 0;
  }

  /**
   * 服务端快照 → 本地校正。
   * 旧实现是"位置不对就直接吸过去"，网络稍有延迟就会在格子中途被拉回，
   * 表现就是走两步顿一下、人物往回弹。
   * 现在的策略：
   *  - 只要有一端还在移动，就认为是网络延迟（预测本来就该领先），不校正；
   *  - 两端都静止且确实差了 ≥ 半格 → 只改逻辑格，渲染位置用可衰减的偏移滑过去；
   *  - 只有误差大到离谱（> 2 格，通常是传送/复活）才硬吸附。
   */
  function reconcile(sp) {
    const m = S.me;
    if (!m) return;
    m.alive = sp.alive;
    m.trapped = sp.trapped;
    m.trappedLeft = sp.trappedLeft;
    m.speed = sp.speed;
    m.power = sp.power;
    m.capacity = sp.capacity;

    if (!sp.alive) {
      snapLocal(sp.x, sp.y);
      return;
    }
    if (sp.trapped) {
      snapLocal(sp.x, sp.y);
      return;
    }

    const dist = Math.abs(sp.x - m.px) + Math.abs(sp.y - m.py);
    if (sp.moving || m.moving) {
      // 预测领先是正常的，只在偏差大到不可能由延迟解释时才硬拉回
      if (dist > 2.4) snapLocal(sp.x, sp.y);
      return;
    }

    if (dist < 0.34) {
      // 位置一致，把残余偏移继续收敛掉即可
      return;
    }
    if (dist > 2.4) {
      snapLocal(sp.x, sp.y);
      return;
    }

    // 逻辑格立刻对齐，渲染位置靠偏移平滑过渡（不会出现"跳一格"）
    m.cellX = m.toX = m.fromX = Math.round(sp.x);
    m.cellY = m.toY = m.fromY = Math.round(sp.y);
    m.corrX = sp.x - m.px;
    m.corrY = sp.y - m.py;
  }

  // ---------------------------------------------------------------
  // 网络事件
  // ---------------------------------------------------------------
  Net.on('status', ({ state }) => {
    el.netState.className = 'net ' + (state === 'ok' ? 'ok' : state === 'down' ? 'bad' : '');
    el.netText.textContent = state === 'ok' ? '在线' : state === 'down' ? '断线重连中' : '连接中';
  });

  Net.on('hello', (msg) => {
    S.myId = msg.id;
  });

  Net.on('room', ({ room }) => {
    S.room = room;
    el.roomTag.hidden = !room;
    if (!room) {
      // 被踢/房间解散：链接与聊天一并收干净
      if (window.Chat) Chat.bind(null);
      if (window.Share) Share.clearRoomUrl();
      return;
    }
    el.roomCodeTop.textContent = room.code;
    renderRoom(room);

    // 进入/切换房间时同步地址栏，方便直接分享当前页
    if (window.Share) Share.syncRoomUrl(room.code);
    if (window.Chat) Chat.bind(room);

    if (room.state === 'playing') return;
    if (S.screen !== 'over') showScreen('room');
  });

  Net.on('chat', (msg) => {
    if (window.Chat) Chat.receive(msg);
  });

  Net.on('left', () => {
    S.room = null;
    S.playing = false;
    el.roomTag.hidden = true;
    timerEl.hidden = true;
    if (window.Chat) Chat.reset();
    if (window.Share) Share.clearRoomUrl();
    if (window.Panels) Panels.close({ restoreFocus: false });
    showScreen('home');
  });

  Net.on('game', (msg) => {
    // 开局后房间聊天不可用，日志也一并清掉（避免上局的对话串到下一局）
    if (window.Chat) Chat.reset();
    if (window.Panels) Panels.close({ restoreFocus: false });
    S.matchStartAt = performance.now();
    S.lastOverKey = null;

    S.cols = msg.cols;
    S.rows = msg.rows;
    S.tiles = new Uint8Array(msg.map);
    S.items = msg.items || [];
    S.bombs = [];
    S.explosions = [];
    S.players.clear();
    S.timeLeft = 0;

    for (const p of msg.players) {
      S.players.set(p.id, {
        id: p.id,
        name: p.name,
        color: p.color,
        team: p.team,
        isBot: !!p.isBot,
        rx: p.x,
        ry: p.y,
        tx: p.x,
        ty: p.y,
        dir: 'down',
        moving: false,
        alive: true,
        trapped: false,
        trappedLeft: 0,
        power: 1,
        capacity: 1,
        speed: 0,
        kills: 0,
        samples: [{ t: performance.now(), x: p.x, y: p.y }], // 远端插值用的历史样本
      });
    }

    const mine = msg.players.find((p) => p.id === S.myId);
    S.teamMode = !!msg.teamMode;
    S.myTeam = mine ? mine.team : null;
    S.autoDeadline = 0;
    S.me = {
      cellX: mine ? mine.x : 1,
      cellY: mine ? mine.y : 1,
      px: mine ? mine.x : 1,
      py: mine ? mine.y : 1,
      fromX: mine ? mine.x : 1,
      fromY: mine ? mine.y : 1,
      toX: mine ? mine.x : 1,
      toY: mine ? mine.y : 1,
      moving: false,
      moveStart: 0,
      moveDur: MOVE_BASE,
      corrX: 0, // 校正偏移（只作用于渲染，不参与逻辑）
      corrY: 0,
      dir: 'down',
      alive: true,
      trapped: false,
      trappedLeft: 0,
      speed: 0,
      power: 1,
      capacity: 1,
      pending: [],
    };

    S.seq = 0;
    S.inputDir = null;
    S.heldDirs.length = 0;

    // 开局倒计时（服务端在倒计时结束前不接受任何操作）
    S.countEnd = performance.now() + (msg.startIn || 0);
    S.countDone = (msg.startIn || 0) <= 0;
    el.countdown.hidden = S.countDone;

    Render.init(el.canvas, S.cols, S.rows);
    showScreen('game');
    timerEl.hidden = false;
    el.veil.classList.remove('show');
    if (S.countDone) toast(msg.resumed ? '已重新连接到对局' : '开战！', 1600);
  });

  Net.on('state', onState);

  function onState(s) {
    const tNow = performance.now();
    S.timeLeft = s.timeLeft;

    // --- 玩家 ---
    const seen = new Set();
    for (const sp of s.players) {
      seen.add(sp.id);
      let p = S.players.get(sp.id);
      if (!p) {
        p = { rx: sp.x, ry: sp.y, samples: [{ t: tNow, x: sp.x, y: sp.y }] };
        S.players.set(sp.id, p);
      }
      p.id = sp.id;
      p.name = sp.name;
      p.color = sp.color;
      p.team = sp.team;
      p.isBot = !!sp.isBot;
      p.moving = sp.moving;
      p.dir = sp.dir;
      p.alive = sp.alive;
      p.trapped = sp.trapped;
      p.trappedLeft = sp.trappedLeft;
      p.power = sp.power;
      p.capacity = sp.capacity;
      p.speed = sp.speed;
      p.kills = sp.kills;
      p.tx = sp.x;
      p.ty = sp.y;
      if (sp.id === S.myId) {
        reconcile(sp);
      } else {
        pushSample(p, sp.x, sp.y, tNow);
      }
    }
    for (const id of [...S.players.keys()]) if (!seen.has(id)) S.players.delete(id);

    S.teamMode = !!s.teamMode;
    const mine = S.players.get(S.myId);
    S.myTeam = mine ? mine.team : null;

    // --- 地图变化（箱子被炸掉）---
    for (const ch of s.changes || []) {
      S.tiles[ch[1] * S.cols + ch[0]] = 0;
    }

    // --- 炸弹：服务端权威 ---
    S.bombs = s.bombs;
    if (S.me) {
      const now = performance.now();
      S.me.pending = S.me.pending.filter((pb) => {
        const confirmed = s.bombs.some((b) => b.owner === S.myId && b.x === pb.x && b.y === pb.y);
        return !confirmed && now - pb.at < 800;
      });
    }

    // --- 爆炸：记录出生时间，让视觉自己淡出 ---
    const now = performance.now();
    S.explosions = (s.explosions || []).map((e) => ({ cells: e.cells, born: now - e.age }));

    S.items = s.items;

    // --- 事件音效 ---
    for (const ev of s.events || []) {
      if (ev.type === 'boom') Sfx.boom();
      else if (ev.type === 'pick') Sfx.pick();
      else if (ev.type === 'place') Sfx.place();
      else if (ev.type === 'trap') Sfx.trap();
      else if (ev.type === 'die') Sfx.die();
      else if (ev.type === 'save') Sfx.pick();
    }

    // 自己被打晕的提示
    if (S.me) {
      if (S.me.trapped && !S.lastTrapped) toast('被炸中了！狂按方向键挣脱，或等队友来救', 2000);
      S.lastTrapped = S.me.trapped;
    }

    renderHud();
  }

  /**
   * 结算写一条本地战绩。
   * 断线重连后服务端可能重发同一条 over，用 startedAt + durationMs 去重，
   * 避免一个对局在战绩里出现两条。
   */
  function recordMatch(msg) {
    if (!store || !window.Store) return;
    const key = `${msg.startedAt || 0}-${msg.durationMs || 0}-${(msg.results || []).length}`;
    if (S.lastOverKey === key) return;
    S.lastOverKey = key;

    const rec = window.Store.matchFromOver(msg, S.myId, {
      mode: CFG.mode,
      durationMs: S.matchStartAt ? Math.round(performance.now() - S.matchStartAt) : 0,
    });
    if (!rec) return; // 观战者 / 中途加入没有自己的结算行，不记录
    store.addMatch(rec);
    if (window.Panels) Panels.refreshStats();
  }

  /** 设置落地：音量与静音直接作用于 WebAudio 主增益 */
  function applyPrefs(prefs) {
    Sfx.setMuted(!prefs.sfx);
    Sfx.setVolume(prefs.volume);
  }

  Net.on('over', (msg) => {
    S.playing = false;
    timerEl.hidden = true;
    const teamMode = !!msg.teamMode;
    const results = msg.results || [];
    const teamNames = msg.teamNames || ['蓝队', '红队'];
    const mineRow = results.find((r) => r.id === S.myId);
    const win = mineRow ? !!mineRow.winner : msg.winner === S.myId;

    el.overTitle.textContent = win ? '你赢了！' : '本局结束';
    if (teamMode && msg.winnerTeam !== null && msg.winnerTeam !== undefined) {
      el.overSub.hidden = false;
      el.overSub.textContent = `${teamNames[msg.winnerTeam]}胜利` + (win ? '，你们队笑到了最后' : '，下一局再战');
    } else if (!msg.winner) {
      el.overSub.hidden = false;
      el.overSub.textContent = '平局';
    } else {
      el.overSub.hidden = true;
    }

    el.resultList.innerHTML = results
      .map((r, i) => {
        const badges = [];
        if (teamMode) badges.push(`<i class="badge t${r.team}">${teamNames[r.team]}</i>`);
        if (r.isBot) badges.push('<i class="badge ai">AI</i>');
        return `<li class="${r.winner ? 'win' : ''}">
          <span class="rk">${i + 1}</span>
          <span class="av" style="background:${esc(r.color)}"></span>
          <span class="nm">${esc(r.name)}${r.id === S.myId ? ' (你)' : ''}${badges.join('')}</span>
          <span class="sc">淘汰 ${r.kills}</span>
        </li>`;
      })
      .join('');
    showScreen('over');
    if (win) Sfx.win();
    recordMatch(msg);
  });

  Net.on('err', ({ msg }) => toast(msg, 2600));
  Net.on('notice', ({ msg }) => toast(msg, 2600));

  // ---------------------------------------------------------------
  // 广播状态 → 渲染帧
  // ---------------------------------------------------------------

  /** 记录远端玩家的位置样本，供插值回放（最多留 12 个） */
  function pushSample(p, x, y, t) {
    const s = p.samples || (p.samples = []);
    const last = s[s.length - 1];
    if (last && Math.abs(x - last.x) + Math.abs(y - last.y) > 3) {
      // 传送 / 复活：样本失去连续性，直接重置
      s.length = 0;
      s.push({ t, x, y });
      p.rx = x;
      p.ry = y;
      return;
    }
    s.push({ t, x, y });
    while (s.length > 12) s.shift();
  }

  /**
   * 远端玩家插值。
   * 旧实现是指数平滑（每个快照到了就跳一下再收敛），在 60ms 一个快照下
   * 看起来就是一格一格地顿。现在改成「回放 90ms 前的样本 + 样本间线性插值」：
   * 渲染时间永远落在两个快照之间，位置是连续直线，帧率再低也不会抖。
   */
  function smoothRemotes(now) {
    const rt = now - REMOTE_DELAY;
    for (const p of S.players.values()) {
      if (p.id === S.myId) continue;
      const s = p.samples;
      if (!s || !s.length) continue;
      const v = Motion.sampleAt(s, rt);
      if (!v) continue;
      p.rx = v.x;
      p.ry = v.y;
    }
  }

  /** 校正偏移按时间指数衰减，约 150ms 内收敛到 10% 以内 */
  function decayCorrection(dt) {
    const m = S.me;
    if (!m) return;
    if (!m.corrX && !m.corrY) return;
    const k = Math.exp(-dt * CORR_RATE);
    m.corrX *= k;
    m.corrY *= k;
    if (Math.abs(m.corrX) < 0.004) m.corrX = 0;
    if (Math.abs(m.corrY) < 0.004) m.corrY = 0;
  }

  function scene() {
    if (S.me) {
      const me = S.players.get(S.myId);
      if (me) {
        me.rx = S.me.px + S.me.corrX;
        me.ry = S.me.py + S.me.corrY;
        me.dir = S.me.dir;
        me.moving = S.me.moving;
        me.trapped = S.me.trapped;
        me.trappedLeft = S.me.trappedLeft || 0;
        me.alive = S.me.alive;
      }
    }

    const bombs = S.bombs.slice();
    if (S.me) {
      for (const pb of S.me.pending) {
        bombs.push({ x: pb.x, y: pb.y, left: BOMB_FUSE, power: S.me.power, owner: S.myId });
      }
    }

    const now = performance.now();
    const explosions = S.explosions.map((e) => ({ cells: e.cells, age: now - e.born }));

    return {
      cols: S.cols,
      rows: S.rows,
      tiles: S.tiles,
      items: S.items,
      bombs,
      explosions,
      players: [...S.players.values()],
      meId: S.myId,
      teamMode: S.teamMode,
    };
  }

  let lastT = performance.now();
  let lastTimerText = '';

  function frame(now) {
    const dt = Math.min(0.06, (now - lastT) / 1000);
    lastT = now;

    if (S.playing) {
      // 开局倒计时
      if (!S.countDone) {
        if (now < S.countEnd) {
          const txt = String(Math.max(1, Math.ceil((S.countEnd - now) / 1000)));
          if (el.countdownNum.textContent !== txt) {
            el.countdownNum.textContent = txt;
            el.countdownNum.style.animation = 'none';
            void el.countdownNum.offsetWidth; // 重启动画
            el.countdownNum.style.animation = '';
          }
        } else {
          S.countDone = true;
          el.countdown.hidden = true;
          toast('开战！', 1200);
          if (S.inputDir) {
            sendInput(S.inputDir);
            kickLocal();
          }
        }
      }

      updateLocal(now);
      decayCorrection(dt);
      smoothRemotes(now);
      Render.draw(scene(), now);

      const total = Math.max(0, Math.ceil(S.timeLeft / 1000));
      const text = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      if (text !== lastTimerText) {
        lastTimerText = text;
        timerEl.textContent = text;
      }
    } else if (S.screen === 'room' && S.autoDeadline) {
      // 快速匹配房：展示自动开局倒计时
      const left = Math.max(0, Math.ceil((S.autoDeadline - now) / 1000));
      const txt =
        left > 0
          ? `${left} 秒后自动开局（AI 补位）· 也可以等朋友加入`
          : '正在开局…';
      if (el.roomHint.textContent !== txt) el.roomHint.textContent = txt;
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------
  // 对局配置（模式 / AI 数量 / 难度 / 是否分队）
  // ---------------------------------------------------------------
  const DIFF_NAME = { 1: '简单', 2: '普通', 3: '困难' };
  const MODE_NAME = { pvp: '玩家对战', pve: '人机对战', hybrid: '混合对战' };
  const CFG = { mode: 'pvp', bots: 2, difficulty: 2, teamMode: false };

  function syncCfgUI() {
    const isPvp = CFG.mode === 'pvp';
    el.cfgRow.hidden = isPvp;
    el.modeTabs.querySelectorAll('.mode').forEach((b) => {
      const on = b.dataset.mode === CFG.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    el.diffTabs.querySelectorAll('button').forEach((b) => {
      const on = Number(b.dataset.diff) === CFG.difficulty;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    el.teamTabs.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.team === (CFG.teamMode ? '1' : '0');
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    el.botCount.textContent = CFG.bots;
    el.botMinus.disabled = CFG.bots <= 1;
    el.botPlus.disabled = CFG.bots >= 3;

    const seats = 4 - CFG.bots;
    if (CFG.mode === 'pve') {
      el.lineupText.innerHTML = `1 名真人 + <b>${CFG.bots}</b> 个 AI = ${CFG.bots + 1} 人，立即开战`;
    } else {
      el.lineupText.innerHTML =
        `真人 <b>1–${seats}</b> 名 + AI <b>${CFG.bots}</b> 个 ≤ 4 人（真人席位 ${seats} 个）` +
        (CFG.teamMode ? '<br>2v2 需凑满 4 人，人数不足时自动按混战开局' : '');
    }
  }

  function switchMode(mode) {
    CFG.mode = mode;
    CFG.bots = mode === 'pve' ? 3 : 2;
    CFG.teamMode = false;
    syncCfgUI();
  }

  function roomPayload(name) {
    return { name, mode: CFG.mode, bots: CFG.bots, difficulty: CFG.difficulty, teamMode: CFG.teamMode };
  }

  el.modeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode');
    if (btn) switchMode(btn.dataset.mode);
  });
  el.diffTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    CFG.difficulty = Number(btn.dataset.diff);
    syncCfgUI();
  });
  el.teamTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    CFG.teamMode = btn.dataset.team === '1';
    syncCfgUI();
  });
  el.botMinus.addEventListener('click', () => {
    CFG.bots = Math.max(1, CFG.bots - 1);
    syncCfgUI();
  });
  el.botPlus.addEventListener('click', () => {
    CFG.bots = Math.min(3, CFG.bots + 1);
    syncCfgUI();
  });
  syncCfgUI();

  // ---------------------------------------------------------------
  // 界面渲染
  // ---------------------------------------------------------------
  let hudSig = '';
  function renderHud() {
    const list = [...S.players.values()];
    // 内容没变就不动 DOM，避免每帧重建节点
    const sig = list
      .map(
        (p) =>
          `${p.id}${p.alive ? 1 : 0}${p.trapped ? 1 : 0}${Math.ceil(p.trappedLeft / 100)}${p.power}${p.capacity}${p.speed}${p.team}${p.isBot ? 1 : 0}`
      )
      .join('|');
    if (sig === hudSig) return;
    hudSig = sig;

    el.hud.innerHTML = list
      .map((p) => {
        const cls = ['pcard'];
        if (p.id === S.myId) cls.push('me');
        if (!p.alive) cls.push('dead');
        const stats = p.trapped
          ? `<i style="background:#fff2d8;color:#b47b16">眩晕 ${(p.trappedLeft / 1000).toFixed(1)}s</i>`
          : `<i>火${p.power}</i><i>弹${p.capacity}</i>` + (p.id === S.myId ? `<i>速${p.speed}</i>` : '');
        const teamChip =
          S.teamMode && p.team !== undefined && p.team !== null
            ? `<span class="tm t${p.team}">${p.team === 0 ? '蓝' : '红'}</span>`
            : '';
        const aiChip = p.isBot ? '<span class="ai">AI</span>' : '';
        return `<div class="${cls.join(' ')}">
          <span class="av" style="background:${esc(p.color)}"></span>
          ${teamChip}
          <span class="nm">${esc(p.name)}</span>
          ${aiChip}
          <span class="st">${stats}</span>
        </div>`;
      })
      .join('');

    // 状态卡数量/换行变化会影响棋盘可用高度，交给布局层重算
    if (window.Layout) window.Layout.schedule();
  }

  function renderRoom(room) {
    el.roomCode.textContent = room.code;
    el.roomCodeTop.textContent = room.code;

    const me = room.players.find((p) => p.id === S.myId);
    const isHost = me && me.host;
    const others = room.players.filter((p) => p.id !== S.myId);
    const seats = room.totalSeats;

    el.btnReady.hidden = !!isHost;
    el.btnReady.textContent = me && me.ready ? '取消准备' : '准备';
    el.btnStart.hidden = !isHost;

    const allReady = others.every((p) => p.ready);
    el.btnStart.disabled = seats < 2 || !allReady;

    el.roomCfg.innerHTML =
      room.mode === 'pvp'
        ? '<b>玩家对战</b> · 2–4 名真人'
        : `<b>${MODE_NAME[room.mode]}</b> · AI ${room.botCount} 个（${DIFF_NAME[room.difficulty] || '普通'}）· ` +
          `${room.teamMode ? '2v2 分队' : '混战'} · 真人席位 ${room.humanCapacity}`;

    el.roomHint.textContent =
      seats < 2
        ? '至少需要 2 名参战者'
        : isHost
          ? allReady
            ? '人齐了，可以开战'
            : '等待其他玩家准备…'
          : me && me.ready
            ? '已准备，等待房主开始'
            : '点击「准备」等待房主开始';

    // 自动开局倒计时（本地时间轴，避免客户端时钟偏差）
    S.autoDeadline = room.autoStartIn ? performance.now() + room.autoStartIn : 0;

    const rows = room.players.map((p) => {
      const tags = [];
      if (p.host) tags.push('<span class="tag host">房主</span>');
      if (p.ready) tags.push('<span class="tag ready">已准备</span>');
      if (!p.online) tags.push('<span class="tag off">离线</span>');
      return `<li>
        <span class="av" style="background:${esc(p.color)}"></span>
        <span class="nm">${esc(p.name)}${p.id === S.myId ? ' (你)' : ''}</span>
        ${tags.join('')}
      </li>`;
    });
    for (const b of room.bots || []) {
      rows.push(`<li class="bot">
        <span class="av" style="background:#cfe2f6"></span>
        <span class="nm">${esc(b.name)}</span>
        <span class="tag ai">AI</span>
        <span class="tag">开局入场</span>
      </li>`);
    }
    for (let i = seats; i < 4; i++) {
      rows.push('<li class="empty"><span class="av" style="background:#dbe8f3"></span><span class="nm">等待加入…</span></li>');
    }
    el.playerList.innerHTML = rows.join('');
  }

  // ---------------------------------------------------------------
  // 按钮
  // ---------------------------------------------------------------
  function ensureName() {
    const v = (el.nameInput.value || '').trim().slice(0, 8);
    const name = v || '泡泡' + Math.floor(Math.random() * 900 + 100);
    Net.setName(name);
    S.name = name;
    el.nameInput.value = name;
    return name;
  }

  $('btnQuick').addEventListener('click', () => {
    Net.send({ t: 'quick', ...roomPayload(ensureName()) });
  });

  $('btnCreate').addEventListener('click', () => {
    Net.send({ t: 'create', ...roomPayload(ensureName()) });
  });

  $('btnJoin').addEventListener('click', () => {
    const code = (el.codeInput.value || '').trim().toUpperCase();
    // 与服务端 makeCode 同一字符集：去掉容易看错的 I / O / 0 / 1
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) return toast('请输入 4 位房间号（字母或数字，不含 I O 0 1）', 2200);
    Net.send({ t: 'join', code, name: ensureName() });
  });

  el.codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnJoin').click();
  });
  el.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnQuick').click();
    e.stopPropagation();
  });

  // 邀请链接：系统剪贴板 → execCommand → 手动复制，逐级降级
  if (el.btnInvite) {
    el.btnInvite.addEventListener('click', async () => {
      if (!S.room || !window.Share) return;
      const url = Share.inviteUrl(S.room.code);
      el.btnInvite.disabled = true;
      const ok = await Share.copy(url);
      el.btnInvite.disabled = false;
      if (ok) {
        Share.hideFallback();
        toast('邀请链接已复制，发给朋友即可直接加入', 2400);
      } else {
        Share.showFallback(url);
        toast('浏览器不允许自动复制，请长按下方链接手动复制', 3000);
      }
    });
  }

  if (el.btnSettings) {
    el.btnSettings.addEventListener('click', () => {
      if (window.Panels) Panels.open('settings');
    });
  }
  if (el.btnStats) {
    el.btnStats.addEventListener('click', () => {
      if (window.Panels) Panels.open('stats');
    });
  }

  el.btnReady.addEventListener('click', () => {
    if (!S.room) return;
    const me = S.room.players.find((p) => p.id === S.myId);
    Net.send({ t: 'ready', value: !(me && me.ready) });
  });

  el.btnStart.addEventListener('click', () => Net.send({ t: 'start' }));

  $('btnLeave').addEventListener('click', () => {
    Net.send({ t: 'leave' });
    S.room = null;
    el.roomTag.hidden = true;
    if (window.Chat) Chat.reset();
    if (window.Share) Share.clearRoomUrl();
    if (window.Panels) Panels.close({ restoreFocus: false });
    showScreen('home');
  });

  $('btnBackRoom').addEventListener('click', () => {
    if (S.room) showScreen('room');
    else showScreen('home');
  });

  // ---------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------
  const savedName = Net.name;
  if (savedName) el.nameInput.value = savedName;

  // 弹层先初始化：里面会把"音效/音量/减少动效/操作提示"落到 body 与 Sfx 上，
  // 必须早于第一次绘制，否则首页会先按默认动效播一下再突然静止
  if (window.Panels) {
    Panels.init({ store, toast, onApplySettings: applyPrefs });
  }

  if (window.Chat) {
    Chat.init({
      send: Net.send,
      toast,
      getMyId: () => S.myId,
    });
  }

  // 移动端软键盘弹出时，把输入框滚到可视区域中间，避免被键盘挡住
  for (const input of [el.nameInput, el.codeInput]) {
    input.addEventListener('focus', () => {
      setTimeout(() => input.scrollIntoView({ block: 'center', behavior: 'auto' }), 220);
    });
  }

  if (window.Layout) window.Layout.init();
  Net.connect();
  showScreen('home');

  // ?room=CODE 预填：只填不自动加入，避免打开链接就被拉进陌生房间
  if (window.Share) {
    const fromUrl = Share.readRoomFromUrl();
    if (fromUrl.code) {
      el.codeInput.value = fromUrl.code;
      toast(`已带入房间号 ${fromUrl.code}，点「加入」进入`, 3200);
    } else if (fromUrl.invalid) {
      Share.clearRoomUrl();
      toast('链接里的房间号无效，请输入 4 位房间号', 2800);
    }
  }

  requestAnimationFrame(frame);

  // 暴露内部状态，便于调试与自动化验收（只读用途）
  window.__game = S;

  // 去掉首帧之前的空白遮罩
  setTimeout(() => el.veil.classList.remove('show'), 300);
})();
