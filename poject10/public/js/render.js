/* ============================================================
   渲染层：Canvas 2D，全部图形用代码绘制（零图片资源）
   - 静态地面/墙体缓存到离屏画布，逐帧只重绘动态物体
   - 角色走位用连续坐标 rx/ry（本地预测 / 远端插值），因此是像素级平滑的
   ============================================================ */
(function () {
  'use strict';

  const TILE = 44;
  const BOMB_FUSE = 2400;
  const EXPLOSION_LIFE = 600;
  const FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

  let canvas, ctx;
  let dpr = 1;
  let W = 0;
  let H = 0;
  let groundCache = null;
  let cacheKey = '';
  let viewScale = 1; // CSS 宽度 / 画布逻辑宽度，用于小屏降级

  // ---------- 小工具 ----------
  function rr(c, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rad, y);
    c.arcTo(x + w, y, x + w, y + h, rad);
    c.arcTo(x + w, y + h, x, y + h, rad);
    c.arcTo(x, y + h, x, y, rad);
    c.arcTo(x, y, x + w, y, rad);
    c.closePath();
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    const b = Math.max(0, Math.min(255, (n & 255) + amt));
    return `rgb(${r},${g},${b})`;
  }

  // ---------- 初始化 ----------
  function init(el, cols, rows) {
    canvas = el;
    ctx = el.getContext('2d');
    W = cols * TILE;
    H = rows * TILE;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.aspectRatio = `${W} / ${H}`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    groundCache = null;
  }

  /** 静态层：草地 + 永久墙体（只在开局 / 窗口变化时重建） */
  function buildGround(tiles, cols, rows) {
    const off = document.createElement('canvas');
    off.width = Math.round(W * dpr);
    off.height = Math.round(H * dpr);
    const g = off.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 草地底色 + 棋盘格
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        g.fillStyle = (x + y) % 2 === 0 ? '#addda3' : '#a6d89c';
        g.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    // 草地点缀（用格子坐标做伪随机，保证稳定）
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (tiles[y * cols + x] !== 0) continue;
        const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        const r = s - Math.floor(s);
        if (r > 0.62) {
          g.strokeStyle = 'rgba(255,255,255,0.28)';
          g.lineWidth = 1.4;
          g.beginPath();
          const gx = x * TILE + 10 + r * 20;
          const gy = y * TILE + 14 + ((r * 97) % 1) * 18;
          g.moveTo(gx, gy);
          g.lineTo(gx + 2, gy - 5);
          g.moveTo(gx + 3, gy);
          g.lineTo(gx + 4, gy - 4);
          g.stroke();
        }
      }
    }

    // 永久墙体
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (tiles[y * cols + x] !== 1) continue;
        drawWall(g, x * TILE, y * TILE);
      }
    }
    return off;
  }

  function drawWall(g, px, py) {
    const pad = 1.5;
    const x = px + pad;
    const y = py + pad;
    const s = TILE - pad * 2;
    // 投影
    g.fillStyle = 'rgba(46,80,60,0.16)';
    rr(g, x, y + 3, s, s, 9);
    g.fill();
    // 主体
    const grad = g.createLinearGradient(x, y, x, y + s);
    grad.addColorStop(0, '#b6c3d1');
    grad.addColorStop(0.45, '#9aa9ba');
    grad.addColorStop(1, '#7d8b9d');
    g.fillStyle = grad;
    rr(g, x, y, s, s, 9);
    g.fill();
    // 高光
    g.fillStyle = 'rgba(255,255,255,0.55)';
    rr(g, x + 4, y + 4, s - 8, 6, 4);
    g.fill();
    // 砖纹
    g.strokeStyle = 'rgba(84,102,122,0.42)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(x + 5, y + s * 0.52);
    g.lineTo(x + s - 5, y + s * 0.52);
    g.moveTo(x + s * 0.5, y + s * 0.52);
    g.lineTo(x + s * 0.5, y + s - 5);
    g.stroke();
    // 底部暗边
    g.strokeStyle = 'rgba(74,92,112,0.55)';
    g.lineWidth = 1.4;
    rr(g, x + 1, y + 1, s - 2, s - 2, 8.5);
    g.stroke();
  }

  function drawBox(g, px, py) {
    const pad = 2;
    const x = px + pad;
    const y = py + pad;
    const s = TILE - pad * 2;
    g.fillStyle = 'rgba(46,80,60,0.16)';
    rr(g, x, y + 3, s, s, 7);
    g.fill();

    const grad = g.createLinearGradient(x, y, x, y + s);
    grad.addColorStop(0, '#eec287');
    grad.addColorStop(1, '#cf9556');
    g.fillStyle = grad;
    rr(g, x, y, s, s, 7);
    g.fill();

    g.strokeStyle = 'rgba(150,96,44,0.55)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x + 5, y + 5);
    g.lineTo(x + s - 5, y + s - 5);
    g.moveTo(x + s - 5, y + 5);
    g.lineTo(x + 5, y + s - 5);
    g.stroke();

    g.strokeStyle = 'rgba(150,96,44,0.75)';
    g.lineWidth = 2;
    rr(g, x + 1, y + 1, s - 2, s - 2, 6);
    g.stroke();

    g.fillStyle = 'rgba(255,255,255,0.35)';
    rr(g, x + 4, y + 4, s - 8, 4, 3);
    g.fill();
  }

  // ---------- 道具 ----------
  function drawItem(g, cx, cy, type, now) {
    const bob = Math.sin(now / 320 + cx * 0.1) * 2;
    const y = cy + bob;

    g.save();
    g.globalAlpha = 0.22;
    g.fillStyle = '#2e5a3a';
    g.beginPath();
    g.ellipse(cx, cy + 13, 11, 4, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // 底座
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(cx, y, 13, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(160,190,215,0.9)';
    g.lineWidth = 1.5;
    g.stroke();

    if (type === 1) {
      // 炸弹 +1（同时放置数）
      const grad = g.createRadialGradient(cx - 2.5, y - 3.5, 0.8, cx, y, 8.4);
      grad.addColorStop(0, '#7f8da4');
      grad.addColorStop(0.4, '#3c4557');
      grad.addColorStop(1, '#171c26');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, y + 1, 7.8, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(20,26,36,0.65)';
      g.lineWidth = 1.1;
      g.stroke();
      // 顶盖 + 引线
      g.fillStyle = '#aab7c9';
      rr(g, cx - 2.6, y - 8.4, 5.2, 2.6, 1.1);
      g.fill();
      g.strokeStyle = '#d8c39a';
      g.lineWidth = 1.5;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(cx + 1.4, y - 8);
      g.quadraticCurveTo(cx + 5.4, y - 11.4, cx + 4.6, y - 5.6);
      g.stroke();
      // 高光
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.beginPath();
      g.ellipse(cx - 2.8, y - 1.6, 2.2, 1.4, -0.6, 0, Math.PI * 2);
      g.fill();
      // 火花
      g.fillStyle = '#ffce54';
      starShape(g, cx + 4.8, y - 5.2, 2.4, 0.4);
      g.fill();
    } else if (type === 2) {
      // 火力 +1
      g.fillStyle = '#ff7043';
      g.beginPath();
      g.moveTo(cx, y - 9);
      g.bezierCurveTo(cx + 7, y - 2, cx + 6, y + 7, cx, y + 8);
      g.bezierCurveTo(cx - 6, y + 7, cx - 7, y - 2, cx, y - 9);
      g.fill();
      g.fillStyle = '#ffce54';
      g.beginPath();
      g.moveTo(cx, y - 2);
      g.bezierCurveTo(cx + 3.4, y + 1.5, cx + 3, y + 6, cx, y + 7);
      g.bezierCurveTo(cx - 3, y + 6, cx - 3.4, y + 1.5, cx, y - 2);
      g.fill();
    } else {
      // 速度 +1
      g.fillStyle = '#ffc531';
      g.beginPath();
      g.moveTo(cx + 1, y - 9);
      g.lineTo(cx - 6, y + 1.5);
      g.lineTo(cx - 0.5, y + 1.5);
      g.lineTo(cx - 2, y + 9);
      g.lineTo(cx + 6, y - 2);
      g.lineTo(cx + 0.5, y - 2);
      g.closePath();
      g.fill();
      g.strokeStyle = '#e2a300';
      g.lineWidth = 1;
      g.stroke();
    }
  }

  // ---------- 炸弹 ----------
  /** Q 版小星星（眩晕、火花都用它） */
  function starShape(g, x, y, r, rot) {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : r * 0.44;
      const a = rot + (i / 10) * Math.PI * 2 - Math.PI / 2;
      const px = x + Math.cos(a) * rad;
      const py = y + Math.sin(a) * rad;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
  }

  /**
   * 炸弹：深色球体 + 金属顶盖 + 弯引线 + 闪烁火花，
   * 用厚描边和大高光保持 Q 版质感；剩余时间越少脉动越快、越红。
   */
  function drawBomb(g, cx, cy, left, power, now, scale) {
    const frac = Math.max(0, Math.min(1, left / BOMB_FUSE));
    const hot = frac < 0.3;
    const pulse = 1 + Math.sin(now * (hot ? 0.026 : 0.009)) * (hot ? 0.1 : 0.05);
    const r = 15 * pulse * (scale || 1);

    // 落地投影
    g.save();
    g.globalAlpha = 0.22;
    g.fillStyle = '#255a2d';
    g.beginPath();
    g.ellipse(cx, cy + r * 0.98, r * 0.86, 4.4, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // 快炸时的红色警示光晕
    if (hot) {
      const glow = g.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 2);
      const a = 0.24 + Math.sin(now / 90) * 0.12;
      glow.addColorStop(0, `rgba(255,96,72,${Math.max(0, a)})`);
      glow.addColorStop(1, 'rgba(255,96,72,0)');
      g.fillStyle = glow;
      g.beginPath();
      g.arc(cx, cy, r * 2, 0, Math.PI * 2);
      g.fill();
    }

    // 引线（画在球体后面，只露出上半段）
    const fx = cx + r * 0.18;
    const fy = cy - r * 0.9;
    const tx = cx + r * 0.78;
    const ty = cy - r * 1.52;
    g.strokeStyle = 'rgba(60,44,28,0.55)';
    g.lineWidth = 5;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(fx, fy);
    g.quadraticCurveTo(cx + r * 0.72, cy - r * 1.06, tx, ty);
    g.stroke();
    g.strokeStyle = '#d8c39a';
    g.lineWidth = 2.8;
    g.beginPath();
    g.moveTo(fx, fy);
    g.quadraticCurveTo(cx + r * 0.72, cy - r * 1.06, tx, ty);
    g.stroke();

    // 球体
    const body = g.createRadialGradient(cx - r * 0.34, cy - r * 0.42, r * 0.1, cx, cy, r * 1.04);
    body.addColorStop(0, '#8b98ae');
    body.addColorStop(0.24, '#4a5568');
    body.addColorStop(0.62, '#2a3241');
    body.addColorStop(1, '#151a23');
    g.fillStyle = body;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();

    // 外描边（在浅色地面上也能看清轮廓）
    g.strokeStyle = 'rgba(14,19,28,0.75)';
    g.lineWidth = 2.2;
    g.beginPath();
    g.arc(cx, cy, r + 0.6, 0, Math.PI * 2);
    g.stroke();

    // Q 版大高光
    g.fillStyle = 'rgba(255,255,255,0.82)';
    g.beginPath();
    g.ellipse(cx - r * 0.36, cy - r * 0.4, r * 0.3, r * 0.18, -0.62, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.beginPath();
    g.arc(cx + r * 0.34, cy + r * 0.36, r * 0.11, 0, Math.PI * 2);
    g.fill();

    // 金属顶盖
    const capW = r * 0.62;
    const capH = r * 0.3;
    const capX = cx - capW / 2;
    const capY = cy - r * 0.94;
    const cap = g.createLinearGradient(capX, capY, capX, capY + capH);
    cap.addColorStop(0, '#e6edf7');
    cap.addColorStop(0.45, '#aab7c9');
    cap.addColorStop(1, '#77839a');
    g.fillStyle = cap;
    rr(g, capX, capY, capW, capH, 3.2);
    g.fill();
    g.strokeStyle = 'rgba(90,102,122,0.7)';
    g.lineWidth = 1.2;
    g.stroke();

    // 引线末端的火花
    const flick = 0.7 + Math.random() * 0.5;
    const sg = g.createRadialGradient(tx, ty, 0.5, tx, ty, 9 * flick);
    sg.addColorStop(0, 'rgba(255,255,224,1)');
    sg.addColorStop(0.4, 'rgba(255,196,84,0.95)');
    sg.addColorStop(1, 'rgba(255,138,42,0)');
    g.fillStyle = sg;
    g.beginPath();
    g.arc(tx, ty, 9 * flick, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff6cf';
    starShape(g, tx, ty, 3.4 * flick, now / 140);
    g.fill();

    // 引信进度环
    g.strokeStyle = hot ? 'rgba(255,110,110,0.95)' : 'rgba(255,196,84,0.8)';
    g.lineWidth = 2.4;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(cx, cy, r + 3.6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    g.stroke();
  }

  // ---------- 爆炸冲击 ----------
  function drawExplosion(g, cell, age) {
    const t = Math.max(0, Math.min(1, age / EXPLOSION_LIFE));
    const alpha = 1 - t * t * t; // 前段保持饱满，尾段快速消失
    const cx = cell.x * TILE + TILE / 2;
    const cy = cell.y * TILE + TILE / 2;

    const grow = 1 + Math.sin(Math.min(1, age / 80) * Math.PI * 0.5) * 0.1;
    const horiz = cell.dir === 'left' || cell.dir === 'right';
    const vert = cell.dir === 'up' || cell.dir === 'down';

    // 中心白 → 亮黄 → 橙 → 红的火球质感
    const core = g.createRadialGradient(cx, cy, 1, cx, cy, TILE * 0.55 * grow);
    core.addColorStop(0, 'rgba(255,255,255,0.98)');
    core.addColorStop(0.22, 'rgba(255,246,200,0.97)');
    core.addColorStop(0.5, 'rgba(255,205,92,0.95)');
    core.addColorStop(0.78, 'rgba(255,140,56,0.9)');
    core.addColorStop(1, 'rgba(238,86,42,0.72)');

    g.save();
    g.globalAlpha = alpha;

    if (cell.dir === 'center') {
      // 中心：火球 + 向外扩散的冲击波
      g.fillStyle = core;
      g.beginPath();
      g.arc(cx, cy, TILE * 0.48 * grow, 0, Math.PI * 2);
      g.fill();

      g.strokeStyle = `rgba(255,232,170,${0.55 * (1 - t)})`;
      g.lineWidth = 3 * (1 - t) + 1;
      g.beginPath();
      g.arc(cx, cy, TILE * (0.24 + 0.34 * t), 0, Math.PI * 2);
      g.stroke();

      // 炸开的小火舌
      g.fillStyle = 'rgba(255,166,64,0.85)';
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.4;
        const d = TILE * (0.34 + 0.2 * t);
        g.beginPath();
        g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, TILE * 0.1 * (1 - t * 0.6), 0, Math.PI * 2);
        g.fill();
      }
    } else {
      // 冲击臂：沿方向铺满整格（横向臂要"宽而扁"，纵向臂要"窄而高"），中间最亮
      const w = horiz ? TILE * 0.94 : TILE * 0.56;
      const h = vert ? TILE * 0.94 : TILE * 0.56;
      const beam = horiz
        ? g.createLinearGradient(cx - w / 2, cy, cx + w / 2, cy)
        : g.createLinearGradient(cx, cy - h / 2, cx, cy + h / 2);
      beam.addColorStop(0, 'rgba(238,86,42,0.62)');
      beam.addColorStop(0.5, 'rgba(255,226,132,0.96)');
      beam.addColorStop(1, 'rgba(238,86,42,0.62)');
      g.fillStyle = beam;
      rr(g, cx - w / 2, cy - h / 2, w, h, 10);
      g.fill();

      g.strokeStyle = 'rgba(255,246,214,0.75)';
      g.lineWidth = 1.6;
      g.stroke();

      // 内芯
      g.fillStyle = 'rgba(255,255,255,0.85)';
      const iw = horiz ? w * 0.5 : w * 0.34;
      const ih = vert ? h * 0.5 : h * 0.34;
      rr(g, cx - iw / 2, cy - ih / 2, iw, ih, 8);
      g.fill();
    }

    // 迸出的火星
    g.fillStyle = 'rgba(255,238,190,0.95)';
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 + age / 200;
      const rad = TILE * (0.36 + 0.05 * i) * grow;
      g.beginPath();
      g.arc(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, 2.6 - i * 0.5, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  // ---------- 角色 ----------
  function drawPlayer(g, p, now, isMe, teamMode) {
    const cx = p.rx * TILE + TILE / 2;
    const cy = p.ry * TILE + TILE / 2;
    const moving = p.moving;

    // 分队模式：脚下画一圈队伍色，混战不画
    if (teamMode && p.team !== undefined && p.team !== null && p.alive) {
      g.save();
      g.globalAlpha = 0.85;
      g.strokeStyle = p.team === 0 ? '#3f8efc' : '#ff6b8a';
      g.lineWidth = 3;
      g.beginPath();
      g.ellipse(cx, cy + 13, 16, 6, 0, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }

    // 影子
    g.save();
    g.globalAlpha = p.alive ? 0.22 : 0.1;
    g.fillStyle = '#25522c';
    g.beginPath();
    g.ellipse(cx, cy + 14, 13, 4.6, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();

    if (!p.alive) return;

    const bob = moving ? Math.sin(now / 55) * 1.6 : Math.sin(now / 620) * 0.9;
    const squash = moving ? 1 + Math.sin(now / 55) * 0.04 : 1;
    // 被炸晕之后站不稳：轻微左右摇晃 + 上下浮动
    const wobble = p.trapped ? Math.sin(now / 150) * 0.1 : 0;
    const by = cy - 2 + bob + (p.trapped ? Math.sin(now / 210) * 1.3 : 0);

    g.save();
    if (wobble) {
      g.translate(cx, by);
      g.rotate(wobble);
      g.translate(-cx, -by);
    }

    // 身体
    const body = g.createRadialGradient(cx - 5, by - 7, 2, cx, by, 16);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.35, shade(p.color, 46));
    body.addColorStop(1, p.color);
    g.fillStyle = body;
    g.beginPath();
    g.ellipse(cx, by, 14 * squash, 14.5 / squash, 0, 0, Math.PI * 2);
    g.fill();

    // 描边
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 1.6;
    g.stroke();

    // 肚皮
    g.fillStyle = 'rgba(255,255,255,0.72)';
    g.beginPath();
    g.ellipse(cx, by + 5.5, 8, 6, 0, 0, Math.PI * 2);
    g.fill();

    // 帽子
    g.fillStyle = shade(p.color, -48);
    g.beginPath();
    g.ellipse(cx, by - 12, 13, 7, 0, Math.PI, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.beginPath();
    g.ellipse(cx - 4, by - 14, 3.4, 1.6, -0.4, 0, Math.PI * 2);
    g.fill();

    // 眼睛（跟随朝向）
    let ex = 0;
    let ey = 0;
    if (p.dir === 'left') ex = -3.4;
    else if (p.dir === 'right') ex = 3.4;
    else if (p.dir === 'up') ey = -1.6;
    else ey = 1.2;

    const eyeY = by - 1 + ey * 0.6;
    if (p.trapped) {
      // 眩晕：眼睛变成两个叉叉
      g.strokeStyle = '#243446';
      g.lineWidth = 1.9;
      g.lineCap = 'round';
      for (const ox of [-4.6, 4.6]) {
        const x0 = cx + ox;
        g.beginPath();
        g.moveTo(x0 - 2.3, eyeY - 2.3);
        g.lineTo(x0 + 2.3, eyeY + 2.3);
        g.moveTo(x0 + 2.3, eyeY - 2.3);
        g.lineTo(x0 - 2.3, eyeY + 2.3);
        g.stroke();
      }
    } else {
      g.fillStyle = '#243446';
      g.beginPath();
      g.ellipse(cx - 4.6 + ex * 0.8, eyeY, 2.1, 2.5, 0, 0, Math.PI * 2);
      g.ellipse(cx + 4.6 + ex * 0.8, eyeY, 2.1, 2.5, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(cx - 5.1 + ex * 0.8, eyeY - 0.8, 0.8, 0, Math.PI * 2);
      g.arc(cx + 4.1 + ex * 0.8, eyeY - 0.8, 0.8, 0, Math.PI * 2);
      g.fill();
    }

    // 腮红
    g.fillStyle = 'rgba(255,138,158,0.5)';
    g.beginPath();
    g.ellipse(cx - 9.5, by + 4, 2.6, 1.7, 0, 0, Math.PI * 2);
    g.ellipse(cx + 9.5, by + 4, 2.6, 1.7, 0, 0, Math.PI * 2);
    g.fill();

    g.restore(); // 结束眩晕摇晃

    // 眩晕标记：头顶转圈的星星 + 脚下计时环
    if (p.trapped) {
      const f = Math.max(0, Math.min(1, (p.trappedLeft || 0) / 4200));

      for (let i = 0; i < 3; i++) {
        const ang = now / 240 + (i * Math.PI * 2) / 3;
        const sx = cx + Math.cos(ang) * 13;
        const sy = by - 21 + Math.sin(ang) * 4.6;
        const near = (Math.sin(ang) + 1) / 2; // 转到前面时更亮更大
        g.globalAlpha = 0.55 + near * 0.45;
        g.fillStyle = '#ffdc5c';
        starShape(g, sx, sy, 3 + near * 1.2, ang);
        g.fill();
        g.strokeStyle = 'rgba(214,150,20,0.75)';
        g.lineWidth = 0.8;
        g.stroke();
      }
      g.globalAlpha = 1;

      // 计时环
      g.strokeStyle = f < 0.35 ? 'rgba(255,96,96,0.95)' : 'rgba(255,190,74,0.95)';
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath();
      g.arc(cx, by, 23, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
      g.stroke();
    }

    // 名字（自己更醒目）；眩晕时上移，给头顶的星星让位
    // 棋盘被缩到很小时（手机横屏 / 小屏），文字会糊成一团 → 只给自己画一个定位箭头
    if (viewScale < 0.58) {
      if (isMe) {
        const ty = by - 22;
        g.save();
        g.beginPath();
        g.moveTo(cx, ty + 7);
        g.lineTo(cx - 5.5, ty - 2);
        g.lineTo(cx + 5.5, ty - 2);
        g.closePath();
        g.fillStyle = '#2f8fff';
        g.strokeStyle = 'rgba(255,255,255,0.95)';
        g.lineWidth = 2;
        g.fill();
        g.stroke();
        g.restore();
      }
      return;
    }

    const labelY = p.trapped ? by - 38 : by - 24;
    g.save();
    g.font = `700 ${isMe ? 11 : 10}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    const label = isMe ? p.name + ' (你)' : p.isBot ? p.name + ' · AI' : p.name;
    g.strokeText(label, cx, labelY);
    g.fillStyle = isMe ? '#1f5fa8' : '#3a5468';
    g.fillText(label, cx, labelY);
    g.restore();
  }

  // ---------- 主绘制 ----------
  function draw(scene, now) {
    if (!ctx) return;
    const { cols, rows, tiles, items, bombs, explosions, players, meId, teamMode } = scene;

    // 画布被 CSS 等比缩小后的比例：用来决定文字/details 是否还看得清
    const rect = canvas.getBoundingClientRect();
    viewScale = rect.width > 0 ? rect.width / W : 1;

    const key = `${cols}x${rows}:${tiles.length}`;
    if (!groundCache || cacheKey !== key) {
      groundCache = buildGround(tiles, cols, rows);
      cacheKey = key;
    }

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(groundCache, 0, 0, W, H);

    // 箱子（每帧重绘，数量少）
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (tiles[y * cols + x] === 2) drawBox(ctx, x * TILE, y * TILE);
      }
    }

    for (const it of items) {
      drawItem(ctx, it.x * TILE + TILE / 2, it.y * TILE + TILE / 2, it.type, now);
    }

    // 有人站在炸弹上时往下挪一点，避免被角色完全挡住（炸弹是实心的，不做压扁）
    const occupied = new Set(
      players.filter((p) => p.alive).map((p) => `${Math.round(p.rx)},${Math.round(p.ry)}`)
    );
    for (const b of bombs) {
      const under = occupied.has(`${b.x},${b.y}`);
      const bx = b.x * TILE + TILE / 2;
      const by = b.y * TILE + TILE / 2 + (under ? 9 : 0);
      drawBomb(ctx, bx, by, b.left, b.power, now, under ? 0.94 : 1);
    }

    // 按 y 排序，形成前后遮挡
    const list = [...players].sort((a, b) => a.ry - b.ry);
    for (const p of list) drawPlayer(ctx, p, now, p.id === meId, teamMode);

    for (const e of explosions) {
      for (const c of e.cells) drawExplosion(ctx, c, e.age);
    }

    // 边框内阴影
    ctx.save();
    ctx.strokeStyle = 'rgba(31,72,120,0.14)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.restore();
  }

  // preview 只给测试/美术验收用（画单个元素），不参与正常渲染
  window.Render = { init, draw, TILE, preview: { drawItem, drawBomb, drawExplosion } };
})();
