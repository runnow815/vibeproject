'use strict';
/**
 * AI 实验补丁集（只作用于内存中的源码字符串，不写磁盘）
 *
 * 每个补丁 = (src) => src'。命中不到锚点即返回原串，bench-ai.js 会据此报错，
 * 避免"以为打了补丁其实没打"的假阳性。
 *
 * 这些补丁是 docs/AI-IMPROVEMENT.md 里改造项的**可执行原型**，
 * 用来做消融实验（ablation），量化每一项单独的收益。
 */

/* ---------- 1. 全单位择优：不再随机挑一个单位，而是在全部可用单位里取全局最优 ---------- */
function patchUnit(src) {
  const FROM = `  const u=me[rndi(0,me.length-1)];
  const diff=getAiErr();
  const opts=[];
  for(const wx of Object.keys(u.w)){`;
  const TO = `  const diff=getAiErr();
  const opts=[];
  for(const u of me)
  for(const wx of Object.keys(u.w)){`;
  let s = src.replace(FROM, TO);
  if (s === src) return src;
  // 循环变量 u 只活在循环体内，末尾的 return 需要重新绑定到被选中的单位
  const F2 = `  if(!opts.length)return{u,skip:true};
  opts.sort((a,b)=>b.score-a.score);
  const pick=opts[0];`;
  const T2 = `  if(!opts.length)return{skip:true};
  opts.sort((a,b)=>b.score-a.score);
  const pick=opts[0];
  const u=pick.u;`;
  const s2 = s.replace(F2, T2);
  return s2 === s ? src : s2;
}

/* ---------- 2. 期望伤害评分：把"落点距离"换成"对敌期望伤害 - 友军误伤"，并给残血目标加权 ---------- */
function patchEdmg(src) {
  const FROM = `        if(best){
          const landNearBuddy=me.some(o=>o!==u&&dist(best.rx,best.ry,o.x,o.y-14)<WP[wx].r+24);
          const sc2=best.sc<26?(115-best.sc):Math.min(76,115-best.sc);
          opts.push({wx,u,f,score:landNearBuddy?sc2*0.4:sc2,aim:{a:best.a,pw:clamp(best.pw,.2,1)}});
        }`;
  const TO = `        if(best){
          const def2=WP[wx], rr=def2.r||30;
          let gain=0, ff=0;
          for(const o of G.units){
            if(!o.alive)continue;
            const dd=dist(best.rx,best.ry,o.x,o.y-14);
            if(dd>=rr)continue;
            const ee=def2.dmg*(1-dd/rr);
            if(o.t===u.t)ff+=ee;
            else gain+=ee*(1+.6*(1-o.hp/o.maxHp));
          }
          if(best.sc<26)gain+=def2.dmg*.35;
          const cap=Math.max(20,f.hp);
          const eff=Math.min(gain,cap*1.4);
          const sc2=115*clamp(eff/(cap*.9),0,1)-1.5*ff;
          opts.push({wx,u,f,score:sc2,aim:{a:best.a,pw:clamp(best.pw,.2,1)}});
        }`;
  return src.replace(FROM, TO);
}

/* ---------- 3. 像素化瞄准误差：误差按"米"而非"角度"给定，远距离不再必然失手 ----------
   现状：误差是固定角度，距离翻倍 → 横向偏移翻倍，长图必空。
   改后：aErr = min(角度上限, 基准像素误差 / 距离)，近距离更准，远距离不再失控。 */
function patchErrPx(src) {
  const FROM = `    const a=pick.aim.a+rnd(-diff,diff);
    const pw=clamp(pick.aim.pw+rnd(-diff,diff)*.5,.2,1);`;
  const TO = `    const _dd=Math.max(80,dist(pick.u.x,pick.u.y,pick.f.x,pick.f.y));
    const _ae=Math.min(diff,70*D().aimMul/_dd);
    const a=pick.aim.a+rnd(-_ae,_ae);
    const pw=clamp(pick.aim.pw+rnd(-_ae,_ae)*.5,.2,1);`;
  return src.replace(FROM, TO);
}

/* ---------- 4. 武器信誉记忆：跨回合记住"上一发有没有打中"，据此调整同类武器权重 ----------
   零新增全局状态入口，只在 G 上挂三个字段；判断依据是敌方总血量是否变化。 */
function patchMem(src) {
  const FROM = `  if(!foes.length)return null;
  // 顺手拾取脚边道具`;
  const TO = `  if(!foes.length)return null;
  // 记忆：上一发是否命中 → 武器信誉（跨回合，1.0 为中性）
  const _hpNow=alive('P').reduce((s,o)=>s+o.hp,0);
  if(G.aiLast&&G.aiLast.wx){
    G.aiRep=G.aiRep||{};
    const _r0=G.aiRep[G.aiLast.wx]==null?1:G.aiRep[G.aiLast.wx];
    G.aiRep[G.aiLast.wx]=clamp(_r0*(_hpNow<G.aiLast.hp-.5?1.12:.88),.35,1.6);
  }
  G.aiLast={hp:_hpNow,wx:null};
  // 顺手拾取脚边道具`;
  let s = src.replace(FROM, TO);
  if (s === src) return src;
  const FROM2 = `  opts.sort((a,b)=>b.score-a.score);
  const pick=opts[0];`;
  const TO2 = `  if(G.aiRep)for(const o of opts)o.score*=(G.aiRep[o.wx]==null?1:G.aiRep[o.wx]);
  opts.sort((a,b)=>b.score-a.score);
  const pick=opts[0];
  if(G.aiLast)G.aiLast.wx=pick.wx;`;
  s = s.replace(FROM2, TO2);
  return s === src ? src : s;
}

/* ---------- 组合 ---------- */
const P = { unit: patchUnit, edmg: patchEdmg, errpx: patchErrPx, mem: patchMem };
function combo(...names) {
  return src => names.reduce((s, n) => P[n](s), src);
}

module.exports = Object.assign({}, P, {
  all3: combo('unit', 'edmg', 'errpx'),
  all4: combo('unit', 'edmg', 'errpx', 'mem'),
});
