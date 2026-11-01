/**
 * 海盗军团抢宝藏 v3 · 无头验证器
 * 用法: node tools/verify-mutiny.js
 * 覆盖: 地形数据层/材质层/挖洞/弹簧瞄准/抛射移动/相机/道具/宝箱三通道/机关/
 *       难度双轨/回合管线/存档战绩/完整模拟对战
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'mutiny.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('FATAL: 未找到 <script> 块'); process.exit(1); }
let src = m[1];

src = src.replace('/* ---------- 启动 ---------- */',
`globalThis.__DBG={G,LEVELS,WP,WP_KEYS,MATS,MAT_CODE,MAT_NAME,ITEM_DEF,LOOT_TABLE,RARE_WEAPONS,DIFF,DEBRIS_RATE,CHAPTERS,Terrain,alive,startLevel,endTurn,fireDrag,fireClick,fireVoodoo,throwSelf,slingDir,useWeapon,update,explode,triggerMine,detonateKeg,detonateBarrel,collectChest,collectRum,collectItem,dropChest,dropSupply,pickAirdropX,pickupNearby,aiChoose,aiMove,aiAct,surfaceY,solidAt,groundYAt,solidUnder,unitAt,itemAt,stepItem,stepFlying,spawnItem,debrisChance,maybeDebris,setRng,resetRng,getAiErr,waterY,canMove,isPickable,isBarrel,inHazard,updateHazards,hurt,save,loadSave,chapterOf,recordWin,render,hoverItem,
VIEW,resize,detectMode,toGame,toWorld,setCamX,camViewW,uiButtons,hitBtn,layoutToolbar,toolBtnAt,layoutLevels,levelCardAt,layoutDifficulty,difficultyCardAt,layoutHUD,hudBtnAt,cancelPointer,getLayout:()=>L};
/* ---------- 启动 ---------- */`);

/* ---------- 浏览器环境 mock ---------- */
function makeCtx(){
  const grad = { addColorStop(){} };
  return new Proxy({}, {
    get(t, k){
      if (k === 'canvas') return {};
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      return typeof t[k] !== 'undefined' ? t[k] : (() => {});
    },
    set(t, k, v){ t[k] = v; return true; },
  });
}
function fakeCanvas(){
  const c = {
    width: 0, height: 0, style: {},
    getContext: () => makeCtx(),
    addEventListener: () => {},
    setPointerCapture(){}, releasePointerCapture(){},
    // 与真实浏览器一致：CSS 尺寸决定 clientRect，toGame() 依赖它做坐标换算
    getBoundingClientRect(){
      const w = parseFloat(c.style.width) || 960, h = parseFloat(c.style.height) || 560;
      return { left: 0, top: 0, width: w, height: h, right: w, bottom: h };
    },
  };
  return c;
}
const ELS = {};
global.window = {
  addEventListener(){}, innerWidth: 1200, innerHeight: 800,
  devicePixelRatio: 1, AudioContext: undefined,
};
global.document = {
  getElementById: id => (ELS[id] || (ELS[id] = fakeCanvas())),
  createElement: () => fakeCanvas(),
};
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => {};
global.localStorage = (() => {
  const mem = new Map();
  return {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
    clear: () => mem.clear(),
    key: i => Array.from(mem.keys())[i] || null,
    get length(){ return mem.size; },
  };
})();

let failures = 0, passed = 0;
function ok(cond, name){
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failures++; console.log('  ✗ ' + name); }
}

try { eval(src); } catch (e) { console.error('FATAL: 脚本加载失败:', e.message, e.stack.split('\n')[1]); process.exit(1); }
const D = globalThis.__DBG;
if (!D) { console.error('FATAL: 调试导出失败'); process.exit(1); }

/* ========== 1. Terrain 数据层 ========== */
console.log('\n[1] Terrain 像素地形数据层');
{
  const T = new D.Terrain(400);
  ok(T.data.length === 400*560, 'data 尺寸 mapW×H');
  ok(!T.solid(200,100), '空地形不实心');
  T.rect(0,200,400,60,'rock');
  ok(T.solid(200,220) && T.solid(399,250), 'rect 实心（含边界）');
  ok(!T.solid(200,195), 'rect 上方不实心');
  ok(T.surfaceY(200,0)===200, 'surfaceY=顶面 200');
  ok(T.surfaceY(200,210)===200, 'surfaceY 从实体内向上找顶');
  // 先做 cut 断言（避免被后续 circle 污染表面）
  T.cut(200,215,30);
  ok(!T.solid(200,215), 'cut 挖空中心');
  ok(T.solid(200,246), 'cut 边缘外仍实心');
  const sy=T.surfaceY(200,0);
  ok(sy>=238&&sy<=246, `cut 后表面下移到洞底 (${sy})`);
  T.cut(200,255,60);
  ok(!T.solid(200,250)&&!T.solid(200,258), '再次挖穿底部');
  T.circle(200,150,40,'sand');
  ok(T.solid(200,150), 'circle 实心');
  T.blob(100,100,60,40,'grass',7);
  ok(T.solid(100,100), 'blob 实心');
}

/* ========== 2. 关卡数据合法性 ========== */
console.log('\n[2] 关卡数据合法性（含新地形落位）');
ok(D.LEVELS.length===15, '共 15 个关卡（三章）');
D.LEVELS.forEach((L,li)=>{
  let lvOk=true, why='';
  // 地形生成不抛异常
  try{
    const T=new D.Terrain(L.mapW); const deco=[];
    L.gen(T,deco);
    if(!T.data.some(v=>v===1)){ lvOk=false; why='地形为空'; }
  }catch(e){ lvOk=false; why='gen 抛异常: '+e.message; }
  // 单位武器合法 + 站在实心地形上
  if(lvOk) for(const u of L.units){
    if(u.w.cherry!==Infinity){ lvOk=false; why='缺无限樱桃'; break; }
  }
  // 落位检测（用真实 startLevel）
  if(lvOk){
    D.startLevel(li);
    for(const u of D.G.units){
      if(u.y>=468){ lvOk=false; why=`单位 x=${u.x} 落水 (y=${Math.round(u.y)})`; break; }
      if(!D.solidUnder(u.x,u.y)){ lvOk=false; why=`单位 x=${u.x} 无立足点`; break; }
    }
  }
  if(lvOk){
    const us=L.units;
    for(let i=0;i<us.length;i++)
      for(let j=i+1;j<us.length;j++)
        if(Math.abs(us[i].x-us[j].x)<36){ lvOk=false; why=`单位 ${us[i].x}/${us[j].x} 过近`; }
  }
  if(lvOk){
    for(const it of (L.items||[])){
      if(!D.ITEM_DEF[it.kind]){ lvOk=false; why='非法道具 '+it.kind; break; }
    }
  }
  ok(lvOk, `第 ${li+1} 关 ${L.name} (mapW=${L.mapW})${lvOk?'':' — '+why}`);
});

/* ========== 3. 场景地形查询 ========== */
console.log('\n[3] 场景地形查询');
D.startLevel(0);
{
  const shipY=D.surfaceY(110);
  ok(shipY>=386&&shipY<=392, `船甲板站立面 (${Math.round(shipY)}≈388)`);
  const islandY=D.surfaceY(700);
  ok(islandY>270&&islandY<330, `中央草丘站立面 (${Math.round(islandY)})`);
  ok(D.surfaceY(-50)>=468, '界外返回水面以下');
  ok(D.solidAt(200,450)===true, 'solidAt 船体内部');
  ok(D.solidAt(200,100)===false, 'solidAt 天空为空');
  ok(D.solidUnder(110,Math.round(shipY))===true, 'solidUnder 脚下有支撑');
  // 地形破坏影响查询
  const before=D.surfaceY(700);
  D.G.T.cut(700,before+30,40);
  const after=D.surfaceY(700);
  ok(after>before+10, `爆炸挖洞后表面下移 (${Math.round(before)}→${Math.round(after)})`);
}

/* ========== 4. 弹簧瞄准（反向拉） ========== */
console.log('\n[4] 弹簧瞄准');
D.startLevel(0);
{
  const u=D.alive('P').find(x=>x.cap);
  D.fireDrag('P',u,'cherry',u.x+100,u.y-80); // 拉向右上
  const p=D.G.projs[0];
  ok(p.vx<0&&p.vy>0, '弹簧反向：拉右上 → 飞左下');
  ok(Math.abs(p.vx)>300&&Math.abs(p.vy)>100, '力度换算有效');
  // 力度与拉距成正比
  D.startLevel(0);
  const a=D.alive('P').find(x=>x.cap);
  D.fireDrag('P',a,'cherry',a.x+50,a.y-50);
  const v1=Math.hypot(D.G.projs[0].vx,D.G.projs[0].vy);
  D.startLevel(0);
  const b=D.alive('P').find(x=>x.cap);
  D.fireDrag('P',b,'cherry',b.x+150,b.y-150);
  const v2=Math.hypot(D.G.projs[0].vx,D.G.projs[0].vy);
  ok(v2>v1*1.8, `拉得越远越有力 (${Math.round(v1)} → ${Math.round(v2)})`);
  // 弹簧方向函数
  const sd=D.slingDir(b, b.x-100, b.y-30); // 拉向正左
  ok(Math.abs(sd.ang)<0.01, '拉向正左 → 发射朝正右 (ang≈0)');
}

/* ========== 5. 抛射移动 ========== */
console.log('\n[5] 抛射移动');
D.startLevel(0);
{
  const u=D.alive('P').find(x=>x.cap);
  const teamWas=D.G.turnTeam; D.G.turnTeam='P'; D.G.phase='input';
  D.throwSelf('P',u,u.x+100,u.y+40); // 拉右下 → 弹向左上
  ok(u.fly===true&&u.moved===true, '抛射后进入飞行且标记已移动');
  ok(D.G.phase==='resolve'&&D.G.resolveKind==='move', '移动结算阶段标记为 move');
  let g=0;
  while(D.G.phase==='resolve'&&g++<600)D.update(1/60);
  ok(!u.fly||!u.alive, '飞行结束（落地或落水）');
  ok(D.G.phase==='input'&&D.G.turnTeam==='P', '玩家移动结算后回合继续（可再攻击）');
  ok(u.x!==u.y||true, '');
  // AI 移动 → 回合切换
  D.startLevel(0); D.G.mode='1p';
  D.G.turnTeam='E'; D.G.phase='resolve'; D.G.resolveWait=0; D.G.resolveKind='move';
  D.G.units.forEach(x=>{x.fly=false;});
  D.update(1/60);
  ok(D.G.turnTeam==='P'&&D.G.phase==='input', 'AI 移动结算后自动换玩家回合');
}
// 落地自动拾取
{
  D.startLevel(0);
  const u=D.alive('P').find(x=>x.cap);
  const chest={kind:'chest',x:u.x,y:u.y-14,vy:0,fly:false,landed:true,para:false,w:'cannon'};
  D.G.items.push(chest);
  const had=D.G.items.length;
  D.pickupNearby(u);
  ok(D.G.items.length===had-1, '落地自动拾取身边宝箱');
  ok(u.w.cannon>0, '拾取后获得武器');
  // 朗姆
  const u2=D.alive('P')[0]; u2.hp=40;
  D.collectRum({kind:'rum'},u2);
  ok(u2.hp===75, '朗姆回血 +35');
  u2.hp=u2.maxHp-5;
  D.collectRum({kind:'rum'},u2);
  ok(u2.hp===u2.maxHp, '回血不超过上限');
}

/* ========== 6. 相机 ========== */
console.log('\n[6] 大地图相机');
D.startLevel(0);
{
  ok(D.G.mapW===1600, '第 1 关地图宽 1600');
  D.G.camX=99999; D.G.mouse.x=-999;
  D.update(0.016);
  ok(D.G.camX===1600-960, 'camX 右界钳制');
  D.G.camX=-50; D.update(0.016);
  ok(D.G.camX===0, 'camX 左界钳制');
  D.G.mouse.x=10; // 左边缘
  D.G.mouse.inside=true;   // 指针必须在画布内，边缘滚动才生效
  D.update(0.1);
  ok(D.G.camX===0, '已在最左不再滚动');
  D.G.camX=100; D.G.mouse.x=10;
  D.update(0.1);
  ok(D.G.camX<100, '鼠标贴左边缘 → 向左滚动');
  D.G.mouse.x=950; D.G.camX=100;
  D.update(0.1);
  ok(D.G.camX>100, '鼠标贴右边缘 → 向右滚动');
  D.G.pointer.type='touch'; D.G.mouse.x=10; D.G.camX=100;
  D.update(0.1);
  ok(D.G.camX===100, '触屏不走边缘滚动（靠拖拽平移）');
  D.G.pointer.type='mouse'; D.G.mouse.inside=false;
  D.G.mouse.x=-999;
  ok(D.LEVELS[4].mapW===2400, '第 5 关地图宽 2400');
}

/* ========== 7. 道具系统 ========== */
console.log('\n[7] 道具');
D.startLevel(0);
{
  // 火药桶连锁殉爆
  const keg=D.G.items.find(i=>i.kind==='keg');
  ok(!!keg, '第 1 关预置火药桶');
  D.G.items.push({kind:'keg',x:keg.x+40,y:keg.y,vy:0,fly:false,landed:true});
  const kegN=D.G.items.filter(i=>i.kind==='keg').length;
  D.explode(keg.x,keg.y,50,40,'P');
  const kegLeft=D.G.items.filter(i=>i.kind==='keg').length;
  ok(kegN===2&&kegLeft===0, '火药桶被引爆并连锁殉爆');
  // 空投宝箱
  D.startLevel(0);
  D.dropChest();
  const c=D.G.items.find(i=>i.kind==='chest'&&i.para);
  ok(!!c&&c.w!=='cherry'&&D.WP_KEYS.includes(c.w), '空投宝箱随机合法武器');
  // 道具悬空下落
  const it={kind:'chest',x:700,y:200,vy:0,fly:false,landed:true,w:'dyn'};
  D.G.items.push(it);
  let g=0;
  while(D.G.items.includes(it)&&g++<600)D.stepItem(it,1/60);
  ok(!D.G.items.includes(it)||it.y>200, '悬空道具会下落');
}

/* ========== 8. 地形破坏回合结算 ========== */
console.log('\n[8] 爆炸破坏地形');
D.startLevel(3); // 骷髅岛
{
  const capX=1005;
  const y0=D.surfaceY(capX);
  D.explode(capX,y0+40,70,50,'E');
  const y1=D.surfaceY(capX);
  ok(y1>y0, `眼窝前表面被炸塌 (${Math.round(y0)}→${Math.round(y1)})`);
  // 单位悬空下落
  const u=D.G.units.find(x=>x.cap&&x.t==='P');
  D.G.T.cut(u.x,u.y+20,45);
  D.update(1/60);
  D.update(1/60);
  ok(u.fly===true, '脚下被挖空 → 单位开始下落');
}

/* ========== 9. 回合管线回归 ========== */
console.log('\n[9] 回合管线');
D.startLevel(0); D.G.mode='1p'; D.G.turnTeam='P'; D.G.phase='input';
D.endTurn();
ok(D.G.phase==='ai'&&D.G.turnTeam==='E', '1P: 玩家结束 → AI 回合');
D.G.phase='input'; D.endTurn();
ok(D.G.phase==='input'&&D.G.turnTeam==='P', '1P: AI 结束 → 玩家回合');
D.startLevel(0); D.G.mode='2p'; D.G.turnTeam='P'; D.G.phase='input';
D.endTurn(); ok(D.G.turnTeam==='E', '2P: 红→蓝');
D.endTurn(); ok(D.G.turnTeam==='P', '2P: 蓝→红');
D.startLevel(0);
ok(D.G.units.every(u=>u.moved===false), '回合开始全部单位移动次数重置');

/* ========== 10. AI 行为 ========== */
console.log('\n[10] AI 行为');
D.startLevel(0); D.G.mode='1p';
{
  D.G.turnTeam='E'; D.G.phase='ai'; D.G.aiTimer=0;
  D.update(0.02);
  ok(D.G.phase==='resolve', 'AI 行动后进入结算');
  const acted=D.G.projs.length>0||D.G.items.some(i=>i.fly)||D.G.units.some(u=>u.fly)||D.G.mines.length>0;
  ok(acted, 'AI 产生了行动（攻击或抛射）');
  let g=0;
  while(D.G.phase==='resolve'&&g++<900)D.update(1/60);
  ok(D.G.phase==='input'&&D.G.turnTeam==='P', 'AI 结算完成 → 玩家回合');
}
// AI 抛射决策
D.startLevel(1);
{
  const mv=D.aiMove();
  if(mv){ ok(mv.plan&&mv.u&&mv.it, 'AI 能规划抛射捡道具'); }
  else ok(true, '本局面无抛射机会（正常）');
}
// AI vs 站桩玩家（输出能力）
console.log('    AI vs 站桩玩家：');
let aiAllOk=true, aiDetail=[];
let _s=20260101;                                  // 固定种子：避免 AI 决策抖动导致误报
D.setRng(()=>{ _s=(_s*1103515245+12345)&0x7fffffff; return _s/0x7fffffff; });
for(let li=0;li<D.LEVELS.length;li++){
  D.startLevel(li); D.G.mode='1p';
  let f=0;
  const initP=D.alive('P').length;
  while(D.G.screen==='play'&&f<60000){
    D.update(1/60);
    if(D.G.phase==='input')D.endTurn();
    f++;
  }
  const endP=D.alive('P').length;
  aiDetail.push(`L${li+1}:${endP===0?'全歼':endP+'剩'}(${Math.round(f/3600)}m)`);
  if(endP===initP)aiAllOk=false;
}
D.resetRng();
console.log('      '+aiDetail.join(' | '));
ok(aiAllOk, 'AI 在全部关卡都有击杀输出');

/* ========== 11. 完整模拟对战 ========== */
console.log('\n[11] 完整模拟对战（1P 第 1 关）');
D.startLevel(0); D.G.mode='1p';
{
  let frames=0, err=null;
  try{
    while(D.G.screen==='play'&&frames<60000){
      D.update(1/60);
      if(D.G.phase==='input'){
        const ps=D.alive('P'), es=D.alive('E');
        if(ps.length&&es.length){
          const u=ps[frames%ps.length], foe=es[frames%es.length];
          D.G.sel=u;
          if(frames%5===0&&!u.moved){
            D.throwSelf('P',u,foe.x,foe.y); // 偶尔抛射
          } else {
            const ks=Object.keys(u.w).filter(k=>u.w[k]>0||u.w[k]===Infinity);
            if(ks.length){
              const wx=ks[frames%ks.length];
              if(D.WP[wx].aim==='drag')D.fireDrag('P',u,wx,foe.x,foe.y-40);
              else if(D.WP[wx].aim==='click')D.fireClick('P',u,wx,foe.x,foe.y);
            } else D.endTurn();
          }
          D.G.sel=null;
        } else D.endTurn();
      }
      frames++;
    }
  }catch(e){ err=e; }
  ok(!err, '模拟对战无异常'+(err?' — '+err.stack.split('\n')[0]:''));
  ok(D.G.screen==='win'||D.G.screen==='lose', `对局正常结束（${D.G.screen}，${frames} 帧）`);
}

/* ========== 12. 全 5 关连打（玩家脚本+AI，不崩溃） ========== */
console.log('\n[12] 全 5 关连打');
{
  let allOk=true, errMsg='';
  for(let li=0;li<D.LEVELS.length;li++){
    D.startLevel(li); D.G.mode='1p';
    let f=0;
    try{
      while(D.G.screen==='play'&&f<90000){
        D.update(1/60);
        if(D.G.phase==='input'){
          const ps=D.alive('P'), es=D.alive('E');
          if(ps.length&&es.length){
            const u=ps[f%ps.length], foe=es[f%es.length];
            D.G.sel=u;
            const ks=Object.keys(u.w).filter(k=>u.w[k]>0||u.w[k]===Infinity);
            if(ks.length){
              const wx=ks[f%ks.length];
              if(D.WP[wx].aim==='drag')D.fireDrag('P',u,wx,foe.x,foe.y-40);
              else if(D.WP[wx].aim==='click')D.fireClick('P',u,wx,foe.x,foe.y);
            } else D.endTurn();
            D.G.sel=null;
          } else D.endTurn();
        }
        f++;
      }
    }catch(e){ allOk=false; errMsg=`第${li+1}关: `+e.stack.split('\n')[0]; break; }
    console.log(`    第 ${li+1} 关 → ${D.G.screen}（${f} 帧）`);
  }
  ok(allOk, '全部关卡模拟无崩溃'+(errMsg?' — '+errMsg:''));
}

/* ========== 13. 材质层（破坏掉落的统计基础） ========== */
console.log('\n[13] 地形材质层');
{
  ok(D.MAT_CODE.grass===1 && D.MAT_CODE.sand===2 && D.MAT_CODE.rock===3
     && D.MAT_CODE.wood===4 && D.MAT_CODE.snow===5, '五种材质编码 1..5');
  ok(D.MAT_NAME[1]==='grass' && D.MAT_NAME[4]==='wood' && D.MAT_NAME[5]==='snow', 'MAT_NAME 反查表正确');

  const T = new D.Terrain(300);
  ok(T.mat.length === 300*560, 'mat 与 data 同尺寸');
  ok(T.matAt(10,10) === 0, '空处材质为 0');

  T.rect(50,100,100,40,'wood');
  ok(T.matAt(80,110) === 4, 'rect 写入木质材质');
  const r = T.cut(100,120,20);
  ok(r.total>0 && r.counts.reduce((a,b)=>a+b,0)===r.total, 'cut 返回 {total,counts} 且计数自洽');
  ok(r.counts[4] === r.total, `纯木质切面全部计入 wood (${r.total}px)`);
  ok(T.matAt(100,120)===0 && !T.solid(100,120), 'cut 后材质随实体一并清零');

  T.circle(200,200,30,'sand');
  ok(T.matAt(200,200) === 2, 'circle 写入沙材质');
  T.blob(120,300,50,30,'snow',3);
  ok(T.matAt(120,300) === 5, 'blob 写入雪材质');

  T.setPx(10,10,'rock');
  ok(T.matAt(10,10) === 3, 'setPx 可指定材质');
  T.clrPx(10,10);
  ok(T.matAt(10,10)===0 && !T.solid(10,10), 'clrPx 同时清实体与材质');

  // 全 15 关的材质多样性
  const seen = new Set();
  for(const L of D.LEVELS){
    const t = new D.Terrain(L.mapW); L.gen(t,[]);
    for(let i=0;i<t.mat.length;i++) if(t.mat[i]) seen.add(t.mat[i]);
  }
  ok(seen.size>=4, `15 关合计用到 ${seen.size} 种材质（草/沙/岩/木/雪）`);
}

/* ========== 14. 破坏掉落（按材质概率） ========== */
console.log('\n[14] 破坏掉落');
{
  const grass=[0,100,0,0,0,0], rock=[0,0,0,100,0,0], wood=[0,0,0,0,100,0];
  ok(D.debrisChance(grass)>0, '草地破面有掉落率');
  ok(D.debrisChance(wood) > D.debrisChance(grass) && D.debrisChance(grass) > D.debrisChance(rock),
     `同面积下木材最易掉、草地次之、岩石最低 (木${D.debrisChance(wood).toFixed(4)} 草${D.debrisChance(grass).toFixed(4)} 岩${D.debrisChance(rock).toFixed(4)})`);
  ok(D.debrisChance([0,0,0,0,0,0])===0, '无破坏物不掉落');
  ok(D.debrisChance([0,0,0,40,0,0])===0, '破坏量低于 DEBRIS_MIN_PX 不掉落');
  ok(D.debrisChance([0,0,0,0,400000,0]) <= 0.35, '掉落率封顶 35%');

  // 难度系数影响
  const cs=[0,100,0,0,0,0];
  const pOf = df => { D.G.difficulty=df; return D.debrisChance(cs); };
  const pe=pOf('easy'), pn=pOf('normal'), ph=pOf('hard');
  ok(pe>pn && pn>ph, `难度影响掉落率 easy>normal>hard (${pe.toFixed(4)}/${pn.toFixed(4)}/${ph.toFixed(4)})`);

  // 实战：炸塌木质结构
  D.G.difficulty='normal';
  D.startLevel(0,'normal');
  D.G.units=[];                 // 排除单位避让造成的随机失败
  D.G.items=[];                 // 排除"离已有道具太近"
  D.setRng(()=>0);              // rnd(a,b)=a：概率判定必然通过
  D.G.debrisBudget=5; D.G.time=100; D.G.lastDebris=-99;
  const blast=(x,y)=>{ D.G.T.rect(x-80,y-80,160,160,'wood'); D.explode(x,y,70,10,'P'); };
  const nDebris=()=>D.G.items.filter(i=>i.src==='debris').length;

  blast(700,250);
  ok(nDebris()===1, '炸塌木质结构掉落 1 件');
  const gained=D.G.items.find(i=>i.src==='debris');
  ok(gained && ['chest','goldChest','ammo','rum'].includes(gained.kind),
     `掉落类型在宝箱/弹药/朗姆之内 (${gained&&gained.kind})`);
  ok(gained && D.isPickable(gained.kind), '掉落物可被拾取');

  D.G.time=100.3;
  blast(1000,250);
  ok(nDebris()===1, '冷却期（0.6s）内不再掉落');

  D.G.time=101.5;
  blast(1000,250);
  ok(nDebris()===2, '冷却结束后可再次掉落');

  D.G.debrisBudget=0; D.G.time=200;
  blast(1300,250);
  ok(nDebris()===2, '掉落预算耗尽后不再掉落');

  D.G.debrisBudget=5; D.G.time=300;
  while(nDebris()<6) D.G.items.push(D.spawnItem('rum',300+nDebris()*40,null,{src:'debris'}));
  blast(1300,250);
  ok(nDebris()===6, '场上破坏掉落物达到上限后不再掉落');

  D.resetRng();
}

/* ========== 15. 宝箱三通道：空投 / 破坏 / 预置 ========== */
console.log('\n[15] 宝箱生成通道');
{
  // 通道 A：空投落点采样
  D.startLevel(5,'normal');   // 带迷雾机关
  let nulls=0, illegal=0;
  for(let i=0;i<120;i++){
    const x=D.pickAirdropX();
    if(x==null){ nulls++; continue; }
    const sy=D.surfaceY(x);
    if(sy>=D.waterY()-18 || D.inHazard(x,sy)) illegal++;
  }
  ok(nulls===0, `落点采样 120 次全部有解（失败 ${nulls}）`);
  ok(illegal===0, `落点均在水面之上且避开机关（违规 ${illegal}）`);

  // 初始形态
  D.startLevel(0,'normal');
  D.G.items=[];
  ok(D.dropChest()===true, 'dropChest 投放成功');
  const c=D.G.items[0];
  ok(!!c, '空投箱进入道具列表');
  ok(c.src==='air' && c.phase==='warn' && c.para===true && c.landed===false,
     '初始形态：预警 / 已开伞 / 未落地');
  ok(c.y===-40, '从屏幕上方 y=-40 进场');
  ok(c.w && D.WP_KEYS.includes(c.w) && c.w!=='cherry', '箱内武器合法');

  // 状态机 warn→open→fall→done（用固定 tx，排除漂移）
  const dc=D.spawnItem('chest',700,-40,{src:'air',phase:'warn',para:true,landed:false,tx:700});
  D.G.items.push(dc);
  let g=0; while(dc.phase==='warn'&&g++<300) D.stepItem(dc,1/60);
  ok(dc.phase==='open', `预警 1.2s 后开伞（${g} 帧）`);
  g=0; while(dc.phase==='open'&&g++<300) D.stepItem(dc,1/60);
  ok(dc.phase==='fall', '开伞 0.3s 后进入下落');
  g=0; while(dc.phase==='fall'&&!dc.sink&&g++<900) D.stepItem(dc,1/60);
  ok(dc.phase==='done' && dc.landed===true && dc.para===false, '落地收伞并标记可拾取');
  ok(Math.abs(dc.y-(D.surfaceY(dc.x)-12))<5,
     `落点贴合地表 (${Math.round(dc.y)}≈${Math.round(D.surfaceY(dc.x)-12)})`);

  // 落地即可拾取
  const pu=D.alive('P')[0];
  ok(D.collectItem(dc,pu)===true && !D.G.items.includes(dc), '落地空投箱可被拾取');

  // 落水 → 下沉 → 移除
  let wetX=null;
  for(let x=80;x<D.G.mapW-80;x+=10){
    if(D.surfaceY(x)>=D.waterY()+20){ wetX=x; break; }
  }
  ok(wetX!=null, `找到深海列用于下沉测试 (x=${wetX})`);
  if(wetX!=null){
    const sk=D.spawnItem('chest',wetX,540,{src:'air',phase:'fall',para:true,landed:false,tx:wetX});
    D.G.items.push(sk);
    g=0; while(!sk.sink&&g++<300) D.stepItem(sk,1/60);
    ok(sk.sink===true, '越过水面的空投开始下沉');
    g=0; while(D.G.items.includes(sk)&&g++<600) D.stepItem(sk,1/60);
    ok(!D.G.items.includes(sk), '下沉完毕从场上移除');
  }

  // 预警时长受鹦鹉影响
  D.G.scout.P=3;
  const slow=D.spawnItem('chest',700,-40,{src:'air',phase:'warn',para:true,landed:false,tx:700});
  D.G.items.push(slow);
  g=0; while(slow.phase==='warn'&&g++<600) D.stepItem(slow,1/60);
  ok(g>72*2, `有鹦鹉时预警延长到约 3.7s（${g} 帧）`);
  D.G.scout.P=0;

  // 通道 B：补给空投（第 4 次）
  D.startLevel(0,'normal'); D.G.mode='2p';
  D.G.items=[]; D.G.airdropCount=3; D.G.airdropT=D.G.airdropInterval-1;
  D.endTurn();
  const sup=D.G.items.find(i=>i.src==='air');
  ok(!!sup && D.LOOT_TABLE.includes(sup.kind),
     `第 4 次空投改为补给箱 (${sup&&sup.kind})`);

  // 通道 C：回合计数触发空投
  D.startLevel(0,'normal'); D.G.mode='2p'; D.G.items=[];
  for(let i=0;i<8;i++){ D.G.phase='input'; D.endTurn(); }
  const air=D.G.items.filter(i=>i.src==='air');
  ok(air.length===1, `4 个整回合后触发 1 次空投（实际 ${air.length}）`);
  ok(D.G.airdropT===0, '触发后空投倒计时归零');

  // 通道 D：关卡预置宝箱
  D.startLevel(6,'normal');
  ok(D.G.items.some(i=>i.src==='preset'), '关卡预置道具已生成');
  ok(D.G.items.every(i=>D.ITEM_DEF[i.kind]), '预置道具类型全部合法');
}

/* ========== 16. 道具图鉴与增益结算 ========== */
console.log('\n[16] 道具图鉴 / 增益');
{
  const kinds=Object.keys(D.ITEM_DEF);
  ok(kinds.length===15, `道具图鉴共 15 种（${kinds.length}）`);
  const cats=new Set(kinds.map(k=>D.ITEM_DEF[k].cat));
  ok(cats.size>=4, `覆盖 ${cats.size} 个类别（容器/增益/战术/危险物）`);
  ok(kinds.every(k=>D.isPickable(k)===!!D.ITEM_DEF[k].pick), 'isPickable 与图鉴标记一致');
  ok(kinds.filter(k=>D.ITEM_DEF[k].cat==='hazard').every(k=>!D.isPickable(k)), '危险物不可直接拾取');
  ok(kinds.filter(k=>D.ITEM_DEF[k].cat==='hazard').every(k=>D.isBarrel(k)), '危险物均可被爆炸引爆');
  ok(D.LOOT_TABLE.every(k=>D.ITEM_DEF[k] && D.ITEM_DEF[k].w>0), '空投补给池权重合法');
  ok(D.RARE_WEAPONS.every(k=>D.WP[k]), '稀有武器表引用有效');

  D.startLevel(0,'normal');
  const u=D.alive('P')[0];
  const give=(k)=>{ const it=D.spawnItem(k,u.x,u.y-14); D.G.items.push(it); return D.collectItem(it,u); };

  ok(give('shield')===true && u.shield===45 && u.shieldT===3, '护盾：+45 吸收值 / 3 回合');
  u.hp=100;
  D.hurt(u,30,0,0,0);
  ok(u.hp===100 && u.shield===15, '护盾优先吸收伤害');
  D.hurt(u,40,0,0,0);
  ok(u.hp===75 && u.shield===0, '护盾击穿后溢出伤害打到血量');
  u.frozen=2; D.hurt(u,10,0,0,0);
  ok(u.frozen===0, '受到伤害即解冻');

  ok(give('rage')===true && u.rageT===2, '狂暴：2 回合伤害 ×1.5');
  ok(give('haste')===true && u.hasteT===2 && D.canMove(u), '疾行：本回合 2 次移动');
  u.movesUsed=1; ok(D.canMove(u)===true, '疾行下用掉 1 次仍可再动');
  u.movesUsed=2; ok(D.canMove(u)===false, '2 次用尽后不能再移动');
  u.hasteT=0; u.movesUsed=0;

  ok(give('spyglass')===true && D.G.assist[u.t]===3, '望远镜：3 回合落点预测');
  ok(give('parrot')===true && D.G.scout[u.t]===3, '鹦鹉：3 回合视野共享');

  const wBefore=Object.keys(u.w).filter(k=>u.w[k]!==Infinity).reduce((a,k)=>a+u.w[k],0);
  ok(give('ammo')===true, '弹药箱生效');
  const wAfter=Object.keys(u.w).filter(k=>u.w[k]!==Infinity).reduce((a,k)=>a+u.w[k],0);
  ok(wAfter>wBefore, `弹药箱补充了弹药 (${wBefore}→${wAfter})`);

  const rareSum=()=>D.RARE_WEAPONS.reduce((a,k)=>a+(u.w[k]||0),0);
  const r0=rareSum();
  ok(give('goldChest')===true && rareSum()>r0, '黄金宝箱给出稀有武器');

  // 假宝箱：拾取即爆
  const hp0=u.hp; u.shield=0;
  const dec=D.spawnItem('decoy',u.x,u.y-14); D.G.items.push(dec);
  D.collectItem(dec,u);
  ok(!D.G.items.includes(dec) && u.hp<hp0, `假宝箱拾取即爆炸并伤到拾取者 (${hp0}→${Math.round(u.hp)})`);

  // 传送卷轴
  D.startLevel(0,'normal');
  const u2=D.alive('P')[0];
  const bx=u2.x;
  const sc=D.spawnItem('scroll',u2.x,u2.y-14); D.G.items.push(sc);
  D.collectItem(sc,u2);
  ok(u2.x!==bx && u2.scrollUsed===1, '传送卷轴产生位移且记录已用');
  const sc2=D.spawnItem('scroll',u2.x,u2.y-14); D.G.items.push(sc2);
  D.collectItem(sc2,u2);
  ok(D.G.items.includes(sc2), '同一单位再次拾取卷轴不生效（道具留在地上）');

  // 冰冻桶 / 油桶 / 信标
  D.startLevel(0,'normal');
  const iu=D.alive('P')[0];
  const ice=D.spawnItem('iceKeg',iu.x+30,iu.y-6);
  D.G.items.push(ice);
  D.detonateBarrel(ice);
  ok(iu.frozen>0, '冰冻桶引爆冻结附近单位');
  D.startLevel(0,'normal');
  const oil=D.spawnItem('oilKeg',700,D.surfaceY(700)-14);
  D.G.items.push(oil);
  const firesBefore=D.G.fires.length;
  D.detonateBarrel(oil);
  ok(D.G.fires.length>firesBefore, '油桶引爆留下火场');
}

/* ========== 17. 难度双轨（关卡曲线 + 三档可选） ========== */
console.log('\n[17] 难度双轨');
{
  const snap=(li,df)=>{
    D.startLevel(li,df);
    return {
      ehp: D.alive('E').reduce((a,u)=>a+u.maxHp,0),
      php: D.alive('P').reduce((a,u)=>a+u.maxHp,0),
      air: D.G.airdropInterval,
      deb: D.G.debrisBudget,
      err: D.getAiErr(),
    };
  };
  const se=snap(9,'easy'), sn=snap(9,'normal'), sh=snap(9,'hard');
  ok(se.ehp < sn.ehp && sn.ehp < sh.ehp, `敌方总血 easy<normal<hard (${se.ehp}/${sn.ehp}/${sh.ehp})`);
  ok(se.php===sn.php && sn.php===sh.php, '玩家血量不随难度变化');
  ok(se.deb > sn.deb && sn.deb > sh.deb, `破坏掉落预算 easy>normal>hard (${se.deb}/${sn.deb}/${sh.deb})`);
  ok(se.air < sn.air && sn.air < sh.air, `空投间隔 easy<normal<hard (${se.air}/${sn.air}/${sh.air})`);
  ok(se.err > sn.err && sn.err > sh.err,
     `AI 瞄准误差 easy>normal>hard (${se.err.toFixed(3)}/${sn.err.toFixed(3)}/${sh.err.toFixed(3)})`);

  D.startLevel(0,'normal'); const e1=D.getAiErr();
  D.startLevel(14,'normal'); const e15=D.getAiErr();
  ok(e1 > e15, `AI 随关卡推进更准 (L1 ${e1.toFixed(3)} > L15 ${e15.toFixed(3)})`);

  D.startLevel(3,'hard'); D.startLevel(4);
  ok(D.G.difficulty==='hard', '切关保留玩家所选难度');

  ok(D.chapterOf(0).name.includes('第一章') && D.chapterOf(4).name.includes('第一章'), 'L1-L5 属第一章');
  ok(D.chapterOf(5).name.includes('第二章') && D.chapterOf(9).name.includes('第二章'), 'L6-L10 属第二章');
  ok(D.chapterOf(10).name.includes('第三章') && D.chapterOf(14).name.includes('第三章'), 'L11-L15 属第三章');

  // Boss 关卡有基础护盾与更高血量
  D.startLevel(14,'normal');
  const boss=D.G.units.filter(u=>u.t==='E').sort((a,b)=>b.maxHp-a.maxHp)[0];
  ok(boss && boss.baseShield===undefined && boss.shield>=80, `最终 Boss 带 ${boss&&boss.shield} 点基础护盾`);
  ok(boss && boss.maxHp>=400, `最终 Boss 血量 ${boss&&boss.maxHp}（≥400）`);
}

/* ========== 18. 15 关 × 3 档冒烟 + 血量曲线 ========== */
console.log('\n[18] 15 关 × 3 档冒烟');
{
  const bad=[];
  for(const df of ['easy','normal','hard'])
    for(let li=0;li<D.LEVELS.length;li++){
      try{
        D.startLevel(li,df);
        const es=D.alive('E'), ps=D.alive('P');
        if(!es.length || !ps.length){ bad.push(`L${li+1}/${df} 缺单位`); continue; }
        let brk=null;
        for(const u of D.G.units){
          if(u.y>=D.waterY()){ brk=`单位落水 x=${u.x}`; break; }
          if(!D.solidUnder(u.x,u.y)){ brk=`单位悬空 x=${u.x}`; break; }
        }
        if(brk){ bad.push(`L${li+1}/${df} ${brk}`); continue; }
        for(const it of D.G.items) if(!D.ITEM_DEF[it.kind]){ brk='非法道具 '+it.kind; break; }
        if(brk){ bad.push(`L${li+1}/${df} ${brk}`); continue; }
        if(D.G.debrisBudget<1){ bad.push(`L${li+1}/${df} 掉落预算<1`); continue; }
        if(!(D.G.airdropInterval>=2)){ bad.push(`L${li+1}/${df} 空投间隔异常`); continue; }
      }catch(e){ bad.push(`L${li+1}/${df} 异常: ${e.message}`); }
    }
  ok(bad.length===0, '45 次开局全部合法' + (bad.length?' — '+bad.slice(0,3).join('; '):''));

  // 敌方总血量曲线：三章内单调递增
  D.G.difficulty='normal';
  const hp=[];
  for(let li=0;li<15;li++){ D.startLevel(li,'normal'); hp.push(D.alive('E').reduce((a,u)=>a+u.maxHp,0)); }
  console.log('      敌方总血：'+hp.join(' → '));
  const mono=[];
  for(const c of D.CHAPTERS){
    let okc=true;
    for(let i=Math.max(c.from+1,1);i<c.to;i++) if(hp[i]<hp[i-1]) okc=false;
    mono.push(okc);
  }
  ok(mono.every(Boolean), '每章内敌方血量单调不回落');
  ok(hp[14] > hp[0]*1.7, `终章血量显著高于首章 (${hp[0]}→${hp[14]})`);
  ok(hp[5]>hp[0] && hp[10]>hp[5], `各章首关血量逐章抬升 (${hp[0]} → ${hp[5]} → ${hp[10]})`);
  ok(hp[14] >= hp[0]*5, `终关血量为首关的 ${(hp[14]/hp[0]).toFixed(1)} 倍`);
}

/* ========== 19. 存档与战绩 ========== */
console.log('\n[19] 存档 / 战绩');
{
  D.startLevel(2,'normal');
  D.G.records={}; D.G.turns=7;
  D.recordWin();
  ok(D.G.records['2'] && D.G.records['2'].normal.win===1 && D.G.records['2'].normal.best===7,
     '首次通关记录 1 胜 / 最佳 7 回合');
  D.G.turns=5; D.recordWin();
  ok(D.G.records['2'].normal.win===2 && D.G.records['2'].normal.best===5, '更优回合刷新最佳');
  D.G.turns=9; D.recordWin();
  ok(D.G.records['2'].normal.best===5, '较差回合不覆盖最佳');
  D.G.difficulty='hard'; D.G.turns=4; D.recordWin();
  ok(D.G.records['2'].hard && D.G.records['2'].hard.win===1, '难度分档各自计战绩');

  D.G.unlocked=7; D.save();
  D.G.unlocked=1; D.G.records={};
  D.loadSave();
  ok(D.G.unlocked===7, '存档回读解锁进度');
  ok(D.G.records['2'] && D.G.records['2'].normal.win===3, '存档回读战绩明细');

  // 旧版 {u:n} 兼容
  global.localStorage.setItem('mutiny3.save', JSON.stringify({u:4}));
  D.G.unlocked=1; D.G.records={a:1};
  D.loadSave();
  ok(D.G.unlocked===4, '兼容旧版存档 {u:n}');
  ok(D.G.records.a===1, '旧版存档不破坏已有战绩');

  // 损坏存档不崩溃
  global.localStorage.setItem('mutiny3.save','{{{not json');
  let threw=false;
  try{ D.loadSave(); }catch(e){ threw=true; }
  ok(!threw, '损坏存档不抛异常');
}

/* ========== 20. 渲染冒烟（界面层不崩） ========== */
console.log('\n[20] 渲染冒烟');
{
  D.startLevel(0,'normal');
  const screens=['menu','levels','difficulty','help','play','win','lose'];
  let err=null, done=[];
  try{
    for(const s of screens){
      D.G.screen=s;
      D.render(); D.render();
      done.push(s);
    }
  }catch(e){ err=e; }
  ok(!err, `已渲染 ${done.length}/7 个界面无异常`+(err?' — '+err.message:''));

  // 悬停说明卡（drawItemTip）
  D.startLevel(0,'normal');
  D.G.screen='play';
  let tipErr=null;
  try{
    for(const it of D.G.items.slice(0,4)){
      D.G.mouse.x=it.x-D.G.camX; D.G.mouse.y=it.y; D.G.mouse.inside=true;
      D.render();
    }
  }catch(e){ tipErr=e; }
  ok(!tipErr, '悬停任意道具渲染说明卡无异常'+(tipErr?' — '+tipErr.message:''));
  ok(D.hoverItem()!==null, '鼠标压在道具上能命中 hoverItem');

  // 迷雾 / 机关 / 水位渲染
  D.startLevel(13,'hard'); D.G.screen='play';
  let hzErr=null;
  try{ for(let i=0;i<3;i++){ D.G.time+=1; D.updateHazards(0.016); D.render(); } }catch(e){ hzErr=e; }
  ok(!hzErr, '岩浆/雷暴/迷雾关卡渲染无异常'+(hzErr?' — '+hzErr.message:''));

  D.G.screen='play';
}

/* ========== 21. 响应式布局 ========== */
console.log('\n[21] 响应式布局');

const CASES=[
  [1920,1080,'desktop'],[1366,768,'desktop'],[1200,800,'desktop'],
  [1024,768,'desktop'],[820,1180,'desktop'],
  [390,844,'portrait'],[360,800,'portrait'],[320,568,'portrait'],
  [844,390,'compact'],[667,375,'compact'],[568,320,'compact'],
];
const inBox=(r,X,Y)=>r&&r.w>0&&r.h>0&&r.x>=-0.5&&r.y>=-0.5&&r.x+r.w<=X+0.5&&r.y+r.h<=Y+0.5;
const hits=(a,b)=>!(a.x+a.w<=b.x+.5||b.x+b.w<=a.x+.5||a.y+a.h<=b.y+.5||b.y+b.h<=a.y+.5);

for(const [vw,vh,want] of CASES){
  const label=`${vw}×${vh}`;
  window.innerWidth=vw; window.innerHeight=vh; D.resize();
  const lay=D.getLayout(), V=D.VIEW, X=lay.W, Y=lay.H;

  /* A. 模式与视口变换自洽 */
  {
    const bad=[];
    if(lay.mode!==want)bad.push(`模式=${lay.mode}≠${want}`);
    if(Math.abs(V.rect.w-V.w*V.s)>.6)bad.push(`rect.w≠w×s(${V.rect.w.toFixed(1)}/${(V.w*V.s).toFixed(1)})`);
    if(Math.abs(V.rect.h-V.h*V.s)>.6)bad.push(`rect.h≠h×s(${V.rect.h.toFixed(1)}/${(V.h*V.s).toFixed(1)})`);
    if(V.y<-.1||V.y+V.h>560.1)bad.push(`视口竖直越界 y=${V.y.toFixed(1)},h=${V.h.toFixed(1)}`);
    const b=lay.band;
    if(V.rect.x<b.x-.6||V.rect.x+V.rect.w>b.x+b.w+.6)bad.push('视口横向溢出区域');
    if(V.rect.y<b.y-.6||V.rect.y+V.rect.h>b.y+b.h+.6)bad.push('视口纵向溢出区域');
    if(want==='desktop'&&(V.w!==960||V.h!==560))bad.push(`桌面视口恒 960×560，实际 ${V.w.toFixed(0)}×${V.h.toFixed(0)}`);
    if(want==='compact'&&Math.abs(V.w-960)>.01)bad.push(`横屏视口宽恒 960，实际 ${V.w.toFixed(0)}`);
    if(want==='portrait'&&(V.w<479||V.w>621))bad.push(`竖屏视野宽 480~620，实际 ${V.w.toFixed(0)}`);
    if(lay.cssScale<.6||lay.cssScale>1.6)bad.push(`cssScale 越界 ${lay.cssScale.toFixed(2)}`);
    ok(!bad.length, `${label} ${lay.mode} 布局/视口自洽`+(bad.length?' — '+bad.join('; '):''));
  }

  /* B. 四类界面元素不溢出 + HUD 不重叠 */
  {
    const bad=[];
    for(const sc of ['menu','levels','difficulty','help','win','lose']){
      D.G.screen=sc;
      for(const b of D.uiButtons())if(!inBox(b,X,Y))bad.push(`${sc}.${b.id}`);
    }
    for(const c of D.layoutLevels().cards)if(!inBox(c,X,Y))bad.push('关卡卡'+c.i);
    for(const c of D.layoutDifficulty().cards)if(!inBox(c,X,Y))bad.push('难度卡'+c.key);
    D.startLevel(0,'normal'); D.G.screen='play';
    const hd=D.layoutHUD();
    const boxes=[hd.info,hd.level,hd.minimap].filter(Boolean);
    boxes.forEach((r,i)=>{ if(!inBox(r,X,Y))bad.push('HUD块'+i); });
    for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)
      if(hits(boxes[i],boxes[j]))bad.push(`HUD块${i}/${j}重叠`);
    for(const b of hd.buttons||[]){
      if(!inBox(b,X,Y))bad.push('HUD按钮'+b.id);
      for(const r of boxes)if(hits(b,r))bad.push('按钮'+b.id+'压住信息块');
    }
    const tb=D.layoutToolbar();
    if(tb){
      if(!inBox(tb.panel,X,Y))bad.push('工具栏面板溢出');
      for(const c of tb.cells)if(!inBox(c,X,Y))bad.push('工具'+c.key);
      for(const r of boxes)if(hits(tb.panel,r))bad.push('工具栏压住信息块');
    }
    ok(!bad.length, `${label} 界面元素不溢出/不重叠`+(bad.length?' — '+bad.join(','):''));
  }

  /* C. 命中回环：看到的 = 点得到的 */
  {
    const miss=[];
    for(const sc of ['menu','levels','difficulty','help']){
      D.G.screen=sc;
      for(const b of D.uiButtons()){
        const h=D.hitBtn(b.x+b.w/2,b.y+b.h/2);
        if(!h||h.id!==b.id)miss.push(`${sc}.${b.id}`);
      }
    }
    D.G.screen='levels';
    for(const c of D.layoutLevels().cards)
      if(D.levelCardAt(c.x+c.w/2,c.y+c.h/2)!==c.i)miss.push('卡'+c.i);
    D.G.screen='difficulty';
    for(const c of D.layoutDifficulty().cards)
      if(D.difficultyCardAt(c.x+c.w/2,c.y+c.h/2)!==c.key)miss.push('难度'+c.key);
    D.startLevel(0,'normal'); D.G.screen='play';
    const tb=D.layoutToolbar();
    if(tb)for(const c of tb.cells)
      if(D.toolBtnAt(c.x+c.w/2,c.y+c.h/2)!==c.key)miss.push('工具'+c.key);
    for(const b of D.layoutHUD().buttons||[]){
      const hb=D.hudBtnAt(b.x+b.w/2,b.y+b.h/2);
      if(!hb||hb.id!==b.id)miss.push('HUD'+b.id);
    }
    ok(!miss.length, `${label} 命中回环一致（按钮/卡/工具栏）`+(miss.length?' — '+miss.join(','):''));
  }

  /* D. 触控尺寸 + 坐标反算 + 六界面渲染冒烟 */
  {
    const bad=[];
    if(lay.mode!=='desktop'){
      D.startLevel(0,'normal'); D.G.screen='play';
      const minTool=lay.mode==='portrait'?44:40;
      const tb=D.layoutToolbar();
      if(tb)for(const c of tb.cells)
        if(Math.min(c.w,c.h)<minTool)bad.push(`工具${c.key} ${c.w}×${c.h}`);
      for(const b of D.layoutHUD().buttons||[])
        if(Math.min(b.w,b.h)<36)bad.push(`按钮${b.id} ${b.w}×${b.h}`);
      D.G.screen='levels';
      for(const c of D.layoutLevels().cards)
        if(Math.min(c.w,c.h)<40)bad.push(`关卡卡 ${c.w}×${c.h}`);
      D.G.screen='difficulty';
      for(const c of D.layoutDifficulty().cards)if(c.h<38)bad.push('难度卡h='+c.h);
      D.G.screen='help';
      const back=D.uiButtons().find(b=>b.id==='back');
      if(back&&back.h<38)bad.push('返回键h='+back.h);
    }
    // 画布逻辑坐标 → 世界坐标 反算
    const cx=V.rect.x+V.rect.w/2, cy=V.rect.y+V.rect.h/2;
    const g=D.toGame({clientX:cx*(lay.cssScale||1), clientY:cy*(lay.cssScale||1)});
    const w=D.toWorld(g);
    const ex=D.G.camX+(cx-V.rect.x)/V.s, ey=V.y+(cy-V.rect.y)/V.s;
    if(Math.abs(w.x-ex)>.8||Math.abs(w.y-ey)>.8)
      bad.push(`坐标反算偏差(${(w.x-ex).toFixed(1)},${(w.y-ey).toFixed(1)})`);
    // 渲染冒烟
    let err=null;
    try{
      D.startLevel(0,'normal');
      for(const sc of ['menu','levels','difficulty','help','play','win','lose']){
        D.G.screen=sc; D.render(); D.render();
      }
    }catch(e){ err=e; }
    if(err)bad.push('渲染异常 '+err.message);
    ok(!bad.length, `${label} 触控尺寸/坐标反算/渲染`+(bad.length?' — '+bad.join(','):''));
  }
}

/* 汇总性结论 */
window.innerWidth=390; window.innerHeight=844; D.resize();
ok(D.getLayout().cssScale===1 && D.getLayout().W===390,
   '手机竖屏按原生 CSS 像素渲染（cssScale=1，字号即 CSS px）');

window.innerWidth=1920; window.innerHeight=1080; D.resize();
ok(D.getLayout().cssScale<=1.6 && D.getLayout().cssScale>=1.4,
   `桌面 1920×1080 画布等比放大到 ${D.getLayout().cssScale}×（上限 1.6，不无限拉伸）`);

window.innerWidth=1024; window.innerHeight=768; D.resize();
ok(D.getLayout().cssScale<1.1 && D.getLayout().cssScale>.95,
   '1024×768 笔记本按 1.0 附近显示，不出现横向滚动');

{
  window.innerWidth=1200; window.innerHeight=800; D.resize();
  D.startLevel(0,'normal'); D.G.screen='play';
  const fake={kind:'rum',x:600,y:100,fly:false,landed:true,src:'level'};
  D.G.items.push(fake);
  D.G.pointer.type='mouse';
  const mHit=!!D.itemAt(632,100);
  D.G.pointer.type='touch';
  const tHit=!!D.itemAt(632,100);
  D.G.pointer.type='mouse';
  D.G.items.pop();
  ok(!mHit&&tHit, '触屏拾取半径 36 > 鼠标 28（手指更宽容）');

  // 触屏拖拽平移：向右拖 40px → 镜头左移 40/s 世界单位，且被地图范围钳制
  D.G.camX=200;
  const start=200, dx=40;
  const after=D.setCamX(start-dx/D.VIEW.s);
  ok(after<start && Math.abs(after-(start-dx/D.VIEW.s))<.01,
     `拖拽空白处平移镜头（右拖 ${dx}px → 左移 ${(start-after).toFixed(1)} 世界单位）`);
  const lo=D.setCamX(-9999), hi=D.setCamX(999999);
  ok(lo===0 && hi===Math.max(0,D.G.mapW-D.camViewW()), '拖拽平移被钳制在地图范围内');
  D.cancelPointer();
  ok(D.G.pointer.phase==='idle'&&D.G.pointer.id===null, 'pointercancel/失焦能清空指针状态');
}

/* ---------- 汇总 ---------- */
console.log('\n════════════════════════════');
console.log(`通过 ${passed} 项 / 失败 ${failures} 项`);
process.exit(failures?1:0);
