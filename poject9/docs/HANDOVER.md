# project9 交接文档 — 海盗军团抢宝藏 · Mutiny 复刻版 v5

> 交接对象：接手本项目的开发者 / AI agent
> 最后更新：v5.0（在 v4 内容基础上补齐**响应式三档布局 / 触屏交互 / 安全区**，验证器 229 断言）
> 状态：**可用**，验证器 **229 项断言 / 21 组**全绿（2026-10-19 实测；随机相关用例已固定种子）
>
> 📄 配套文档：[`REQUIREMENTS.md`](REQUIREMENTS.md)（需求、用户、场景、验收）· [`ARCHITECTURE.md`](ARCHITECTURE.md)（模块、机制、ADR、行号索引）

---

## 1. 项目是什么

复刻 4399 的《海盗军团抢宝藏》，原作是 **Nitrome《Mutiny》(2008)**——类似《百战天虫》的回合制海盗对垒：双方海盗站在岛屿/船上互相扔炸弹，把对方全炸飞或轰下海获胜。

- 单文件游戏：`mutiny.html`（HTML+CSS+JS，IIFE 零全局变量，零外部依赖，双击即玩，3662 行）
- 无头验证器：`tools/verify-mutiny.js`（Node，mock 浏览器环境跑游戏逻辑，229 断言 / 21 组）
- 运行：浏览器直接打开；验证：`node tools/verify-mutiny.js`

## 2. 玩法速览（新同事 5 分钟上手）

1. 点选己方海盗（金色椭圆环）→ 底部工具栏选工具：**1=抛射移动**，2~9=武器
2. **弹簧拉弓**：在海盗身上按住鼠标**往反方向拉**（像愤怒的小鸟），松手朝反向弹射；力度=拉距，虚线=真实弹道预览
3. 点击类武器（铁锚/地雷/板条箱）不需要拉弓，选中后直接**点击目标位置**
4. 巫毒娃娃：先点敌人锁定（紫圈），再反向拉弓把他弹飞
5. 每回合每人：**抛射 ×1 + 武器 ×1**（移动不结束回合，攻击/空格结束回合）
6. 抛射自己 = 移动手段：跨沟壑、抢道具、神风撞人；落水即死
7. 鼠标贴画面左右边缘 → 平移镜头；Tab 换海盗（镜头跟随）；ESC 回菜单
8. **鼠标悬停任意道具 → 弹出说明卡**（名称 / 类别 / 效果 / 可否拾取）

## 3. 代码地图（模块索引）

> 行号级明细已迁至 [`ARCHITECTURE.md` §3.2 与附录 A](ARCHITECTURE.md#32-模块总表)，此处只保留模块索引。行号以 2026-10-19 基线为准（`mutiny.html` 3662 行）。

| 模块 | 区间 | 内容 |
| --- | --- | --- |
| M01 | 35–67 | 常量三层、`RNG/setRng`、`rnd/rndi/hash1` |
| M02 | 68–210 | 布局引擎：`detectMode/calcLayout/syncView/resize/toGame/toWorld`、`fs/wfont/fitText` |
| M03 | 211–216 | 相机唯一入口 `setCamX/centerCamX/camViewW/camMaxX` |
| M04 | 217–260 | WebAudio 音效（`tone/noise` + 18 个合成音效） |
| M05 | 261–340 | `WP` 12 武器、`ITEM_DEF` 15 道具、`DIFF` 三档、`DEBRIS_*`、`CHAPTERS` |
| M06 | 341–501 | `MATS` + `class Terrain`（碰撞/材质/离屏渲染） |
| M07 | 502–918 | `LEVELS` 15 关定义（`makeTop` 为死代码） |
| M08 | 919–970 | `G` 全局状态 + 存档 v2 |
| M09 | 971–1037 | 地形查询四件套、队伍工具、`startLevel` |
| M10 | 1038–1168 | 特效、`hurt/killUnit/stepFlying`、`explode` 爆炸链 |
| M11 | 1169–1357 | `slingDir` 四类发射入口、`stepProj`、`detonate` |
| M12 | 1358–1690 | 道具工厂、空投三通道、`stepItem`、拾取分发、破坏掉落 |
| M13 | 1691–1760 | 机关：`inHazard/stormStrike/updateHazards` |
| M14 | 1761–1950 | AI：`aiChoose/simShot/getAiErr/aiMove/aiAct` |
| M15 | 1951–2001 | `endTurn`（胜负/空投计数/轮换/增益递减）+ `skipTurn` |
| M16 | 2002–2436 | UI 布局层 + 指针状态机 |
| M17 | 2437–2615 | 世界绘制：天空/水/装饰/箱子/机关/迷雾 |
| M18 | 2616–3143 | 实体与 HUD 绘制：道具/海盗/投射物/瞄准/`drawHUD` |
| M19 | 3144–3444 | 菜单 / 选关 / 难度 / 帮助 / 结算 |
| M20 | 3445–3517 | `frame` + `update`（含 resolve 状态机） |
| M21 | 3518–3642 | 悬停说明卡 / `coverBand` 补边 / `render` 编排 |
| M22 | 3643–3661 | `?dbg` 钩子 + 启动 |

## 4. 核心设计决策（为什么这么做）

### 4.1 Terrain 双层 + 材质平行层（可破坏地形 + 掉落统计）
- **权威数据**：`Terrain.data = Uint8Array(mapW×H)`，1=实心 0=空。所有查询（solidAt/surfaceY）只读它
- **材质层**：`Terrain.mat = Uint8Array(mapW×H)`，0=空 1草 2沙 3岩 4木 5雪。`setPx/clrPx/rect/circle/blob/colFill` 写 data 时同步写 mat，`cut()` 清 data 时同步清零
- **渲染**：同名尺寸离屏 canvas；挖洞 `cut()` 同时把 data 置 0 + canvas `destination-out`；`burn()` 用 `source-atop` 画焦环（**必须先 burn 后 cut**）
- **cut 的返回值是掉落系统的输入**：`cut()` 返回 `{total, counts[6]}`，"炸毁了什么材质、各多少像素"由此传给 `maybeDebris`
- **好处**：游戏逻辑完全不和 canvas 像素耦合 → 无头验证器不需要真像素（mock ctx 是 no-op 也照常工作）
- `surfaceY(x,fromY)`：2px 步长粗扫 + **命中后回溯细扫**（修过奇数行顶面跳过的 bug）

### 4.2 弹簧瞄准 = 单一方向函数
- `slingDir(u,tx,ty)` 返回 `{pow, ang}`：**方向 = 单位位置 − 拖拽点**（反向），力度 = 拉距
- 发射、弹道预览、AI 换算全部经过它 → 预览与实际弹道永不背离
- **AI 的坑**：AI 求解得到"发射角 a"，传给 fireDrag 的拖拽点必须放在**反侧**

### 4.3 回合管线与 resolveKind
```
input（玩家操作 / AI 决策）
  → 发射（设 phase='resolve', resolveKind='attack'|'move'）
  → resolve（等 G.projs 空 && 无 fly 单位 && resolveWait≤0）
  → resolveKind==='move' ? 玩家回 input（继续攻击）/ AI 直接 endTurn
                          : endTurn()（胜负 → 空投 → 换边 → 重置移动次数）
```
- **防死锁三保险丝**：投射物 25s / 飞行单位 8s / resolve 30s 强制清场换边

### 4.4 宝箱三通道（v4 重点）
| 通道 | 入口 | 触发条件 |
| --- | --- | --- |
| 空投 | `dropChest()` / `dropSupply()`，由 `endTurn` 计数触发 | 每完成一个**整回合**（1P 下 P 方回合结束、2P 下红方结束）`G.airdropT+1`；达到 `airdropInterval` 且 `airborne<1 && airItems<2 && items<24` 时投放。**每第 4 次改投放补给箱**（`dropSupply`，从 LOOT_TABLE 按权重抽） |
| 结构破坏 | `explode → maybeDebris(x,y,cutInfo)` | `cut.total ≥ DEBRIS_MIN_PX(80)`、距上次 ≥ 0.6s、`debrisBudget>0`、场上破坏掉落物 < 6、`rnd < debrisChance(counts)` |
| 预置 | `startLevel` 读 `L.items[]` | 固定位置 |

- 空投间隔 `airdropInterval = max(2, round(L.airdropEvery×D().airMul))` → 简单 3 / 普通 4 / 困难 5
- 掉落率公式：`λ = Σ counts[m]×DEBRIS_RATE[m]/100`，`p = clamp((1−e^−λ)×面积加成×dropMul, 0, 0.35)`；面积加成 `1+clamp((total−1500)/10000,0,0.35)`
- **落点采样是三级降级**（`pickAirdropX`）：40 次严格择优（避水面/贴顶/机关，按坡度与拥挤度评分）→ 放宽坡度 → 全图 20px 步进扫最靠上平台 → 只保证不落水不入机关。**保证必然有解**，避免"到点却不空投"的静默失败
- **空投状态机**：`warn`（1.2s 预警，有鹦鹉时 3.7s）→ `open`（0.3s 开伞）→ `fall`（伞下漂移，加速下落）→ `done`（落地扬尘、收伞、`landed=true`）；越过水位直接 `sink`（0.4s 下沉后移除）
- **历史缺陷**：悬空坠落分支曾漏设 `landed=true`，导致空投箱永远无法拾取——回归断言在验证器 [15]

### 4.5 难度双轨
- **轨道一（关卡曲线）**：`LEVELS` 里敌方血量/人数逐关抬升，15 关总血 320→1700，每章首关再次抬升
- **轨道二（三档可选）**：`DIFF` 只影响四个乘区——AI 瞄准误差 `aimMul`、敌方血量 `hpMul`、空投间隔 `airMul`、掉落率 `dropMul`，外加 `debrisBonus`/`decoySense`/`aStep`/`pStep`/`moveProb`/`atkThresh`/`delayMul`
- **玩家数值恒等**：三档下玩家血量/武器完全一致，只动 AI 与资源投放
- `G.difficulty` 全局保留，切关不重置（`startLevel(i)` 不传 diff 时沿用上次选择）

### 4.6 确定性随机（让概率可测）
- `let RNG = Math.random` + `setRng(fn)` / `resetRng()`；所有随机走 `rnd(a,b)`/`rndi`
- 验证器里 `setRng(()=>0)` 可让"必定掉落"成立，从而精确断言冷却、预算、上限等分支
- **新增随机逻辑必须走 `rnd()`，禁止直接 `Math.random()`**

### 4.7 动态水位
- 所有水面判断走 `waterY()`（读 `G.waterY`，默认 `WATER=468`）；涨潮机关只插值 `G.waterY`
- 保留直接引用 `WATER` 的地方仅为：常量定义、`surfaceY` 兜底、菜单装饰

### 4.8 移动即抛射（还原原版"扔海盗"）
- `throwSelf`：`fly=true` 复用 `stepFlying`；落地判定 `groundYAt(x,py-14)`，速度 >420 落地自伤；撞敌方=神风；撞火药桶=引爆
- `movesUsed/moveMax` 每回合在 endTurn 重置；疾行道具把上限提到 2（`canMove(u)`）

### 4.9 响应式：常量三层 + 布局函数化 + 指针状态机（v5 重点）

**① 常量三层拆分**（改造的根本前提）
```js
const BASE_W=960, BASE_H=560;   // 设计基准：只用于"桌面长什么样"
const WORLD_H=560;              // 世界高度：地形/水位/光柱，任何屏幕下都不变
let   W=BASE_W, H=BASE_H;       // 画布逻辑尺寸（UI 坐标系）：由布局决定
```
> 坑：老的 `W/H` 同时承担"视口"和"世界高度"两种语义，手机上世界会被压扁。现在 `Terrain` 内 **禁止出现 `H`**（一律 `WORLD_H`），`grep` 校验见 §8。

**② `VIEW` 世界视口 = 唯一的坐标映射**
```js
VIEW = { w,h,s, y, rect:{x,y,w,h} }   // w/h 可见世界尺寸；s 缩放；rect 画布上的矩形
不变量：rect.w===w*s, rect.h===h*s, rect 必须完整落在 L.band 内
```
- `setWorldTransform()`：`scale(cssScale*dpr*VIEW.s)` + `translate(rect.x-camX*VIEW.s, rect.y-VIEW.y*VIEW.s)`
- `setScreenTransform()`：只 `scale(cssScale*dpr)`，UI 一律用逻辑像素
- 于是所有世界绘制代码（drawSky/pirate/proj…）**一行都不用改**，坐标语义不变

**③ 三档模式**（`detectMode`）
| 模式 | 判定 | 画布 | VIEW |
| --- | --- | --- | --- |
| desktop | 其余全部（含平板） | 960×560，CSS `clamp(min((vw-32)/960,(vh-32)/560), .6, 1.6)` | 恒 960×560，`s=1` |
| portrait | `vw≤600 && vh>vw` | 原生 vw×vh，`cssScale=1` | `w∈[480,620]`，`s=min(W/480, band.h/560)` |
| compact | `vw>vh && vh≤560` | 原生 vw×vh | `w=960`，`s=W/960`，纵向按高裁切居中 |

**④ 布局函数化**（消灭"看到的 ≠ 点得到的"）
```
layoutHUD() / layoutToolbar() / layoutLevels() / layoutDifficulty() / uiButtons()
```
每个 UI 簇只有一个几何来源，`drawXxx()` 和 `xxxAt(mx,my)` **都消费它的返回值**。改造前 `toolBtnAt/levelCardAt/difficultyCardAt` 各自复制一份坐标，改布局必然漂移。

**⑤ 指针状态机**
```
idle --pointerdown--> aiming（拉弓/巫毒） | panning（拖拽平移 + 可携带一次延迟点按）
```
- 8 CSS px（`dragThr()`）以内抬指 = 点按；超出 = 拖拽
- 触屏空白处按下 → `panning`，`tap={k:'fire'|'deselect'}` 延迟到抬指且未拖动时执行
- 鼠标保持"按下即动作"的即时手感；边缘滚动仅限鼠标（`!ptrTouch() && !mouse.down`）
- `pointercancel / lostpointercapture / 失焦 / 布局变化` 统一走 `cancelPointer()`

**⑥ 文本与留白**
- `fs(px)`：屏幕字号（×布局系数 + 最小字号）；`wfont(px)`：世界字号（÷`VIEW.s` 补偿，保证各端视觉一致）；`fitText(str,maxW)`：二分截断加 `…`
- 帮助页是"内容流"（`helpRows()` → 折行/分栏 → 可滚动），小屏放不下时出现滚动条，触屏拖拽 / 滚轮都能滚
- `coverBand()`：band 比世界画面大时，上方补天空渐变、下方补深水色，消除黑边

## 5. 数据结构备忘

```js
unit = { id,t:'P'|'E',x,y,hp,maxHp,cap:0|1|2,w:{武器key:数量|Infinity},
         alive,fly,flyT,vx,vy,moved,movesUsed,moveMax,face,flash,bob,
         shield,shieldT,        // 护盾吸收值 / 剩余回合（-1=Boss 常驻）
         rageT,hasteT,frozen,   // 狂暴 / 疾行 / 冻结 剩余回合
         scrollUsed,freezeResist }

item = { kind, x,y,vx,vy, fly, landed, para,
         src:'preset'|'air'|'debris',   // 三条生成通道
         phase:'warn'|'open'|'fall'|'done', t, sway, tx,
         tier:0|1,        // 1=黄金宝箱
         sink,sinkT,flashT, dead,
         w:'武器key'(仅 chest 有) }

hazard = { type:'fog'|'magma'|'storm'|'tide', ...,
           zones:[{x,y,w,h}](magma), t,warnT,warnX,phaseT }

G.sel = 当前选中海盗引用   G.selW = 'move' 或武器 key
G.phase = 'input'|'ai'|'resolve'|'over'   G.resolveKind='attack'|'move'
G.difficulty = 'easy'|'normal'|'hard'
G.waterY = 当前水位（tide 机关会改）
G.airdropT / airdropInterval / airdropCount
G.debrisBudget / debrisCount / lastDebris / _explodeDepth
G.assist = {P:回合数,E:回合数}   G.scout = {P,E}
G.records = { '关卡索引': { easy:{win,best}, normal:{...}, hard:{...} } }
```

## 6. 关卡定义格式（LEVELS）

```js
{ name, theme:'day'|'sunset'|'night'|'fog'|'volcano'|'storm'|'cave'|'snow'|'tide'|'abyss',
  mapW:2000~2600, sky:[顶色,底色],
  gen(T, deco){ /* 用 T.rect/circle/blob/colFill 画地形；注意传材质名 */ },
  units:[ {t:'P'|'E', x, hp, cap:1|2, baseShield:80, freezeResist:true, w:{...}} ],
  items:[ {kind:'chest',x,y,tier:1}, {kind:'shield',x}, {kind:'keg',x} ],
  hazards:[ {type:'magma', zones:[{x,y,w,h}]}, {type:'fog', dens:.6},
            {type:'storm'}, {type:'tide'} ],
  airdropEvery:4,     // 空投间隔基数（乘以难度 airMul）
  debrisChests:2,     // 破坏掉落预算基数（叠加难度 debrisBonus，最小 1）
  lootBias:0.05 }     // 额外黄金宝箱概率偏置
```
- 单位 y 由 `surfaceY(x)` 自动落位——**gen 必须保证每个 unit.x 下方有实心地形**（验证器 [2]/[18] 会查）
- 单位间距需 ≥36px；`cap=2` 是 Boss（体型 1.35x + 王冠），`baseShield` 给常驻护盾
- 道具 x 必须落在**水面之上的实心地形**上（验证器 [2] 会逐个校验 y）
- 新增关卡只需追加 LEVELS 条目，无需改引擎

## 7. 验证器（tools/verify-mutiny.js）

- 原理：提取 `<script>`，在 `/* ---------- 启动 ---------- */` 前注入 `globalThis.__DBG={...}` 导出内部符号；mock `window/document(perf/raf/localStorage/createElement)` 后 `eval`
- localStorage 是 **Map 支撑的实现**（存档测试需要读写回环）
- **21 组 229 项断言**：
  [1]Terrain 数据层 [2]关卡合法性 [3]场景查询 [4]弹簧方向/力度 [5]抛射移动 [6]相机
  [7]道具（连锁殉爆/回血封顶/悬空下落）[8]爆炸破坏地形 [9]回合管线
  [10]AI 行为+全关输出 [11]完整模拟对战 [12]全 15 关连打
  **[13]材质层 [14]破坏掉落 [15]宝箱三通道 [16]道具图鉴与增益 [17]难度双轨 [18]15×3 冒烟+血量曲线**
  **[19]存档与战绩 [20]渲染冒烟 [21]响应式布局**
- **[21] 组的四类检查**（11 分辨率 × 4 = 44 条）：① 模式判定 + `VIEW` 不变量（`rect==w*s`、不溢出 band、桌面恒 960×560、竖屏 w∈[480,620]）② 六界面元素不溢出 + HUD 互不重叠 ③ 命中回环（按钮/关卡卡/难度卡/工具栏/触屏钮的中心点必命中自己）④ 触控尺寸（工具 ≥40~44、按钮 ≥36、卡 ≥40）+ `toGame/toWorld` 反算 + 七界面渲染冒烟
- **注意随机性**：AI 决策含 rnd()，`[10]` 的"全关都有击杀输出"已用固定种子 LCG（`setRng`）锁死，不再波动
- mock 要点：`document.createElement` 必须返回 fake canvas（Terrain 用）；`render` 依赖的 ctx 全部走 no-op Proxy；`getElementById` 需按 id 缓存同一元素，且 `getBoundingClientRect()` 必须跟随 `style.width/height`（`toGame` 的坐标换算是按 CSS 尺寸算的）

## 8. 踩坑记录（勿重蹈覆辙）

1. **edit 的 old_string 误匹配**：两个函数尾模式相同时 edit 会命中第一个，改完必须 grep 验证
2. **AI 弹簧方向回归**：AI 换算拖拽点没反转 → AI 全打反方向
3. **AI 无脑跑路**：40% 概率追空投 → 17 分钟杀 0 人。修复 = 攻击评分 < 阈值才移动
4. **fireClick 先扣武器后验证**：地雷放水里也扣武器 → 改为先验证再 useWeapon
5. **items 被炸飞忘设 vx** → NaN 传染
6. **surfaceY 步长 2 跳过奇数行顶面** → 命中后回溯细扫
7. **HP 归零不死**：hurt 里只清零不 kill
8. **2P 回合不轮换**：endTurn 条件写错
9. **setTimeout 编排回合**（v1）：竞态百出 → 改 resolve 管线
10. **空投箱永不落地**（v4）：`stepItem` 悬空坠落分支漏设 `landed=true` → 落地了却永远拾取不到、伞也收不起来
11. **AI 大炮 NaN**（v4）：`shotAim` 的 `Math.atan(-(1.6/0.55)*(dy/bx))` 在 dx=0 时 bx=0 → 除零。修复 = `bx=Math.max(1,Math.abs(dx))`
12. **先移动后埋雷白赚行动**（v4）：`fireClick` 尾部未设 `resolveKind='attack'`，沿用上一次的 `'move'` → 修复 = 每次攻击入口显式设 attack
13. **`WATER` 被 25 处硬引用**（v4）：加涨潮前先抽 `waterY()` 做恒等替换、跑绿后再启用，避免一次性改动 25 处
14. **空投落点采样过严**（v4）：14 次全不满足就返回 null，实测失败率 10%，表现为"到点却静默不空投"。修复 = 三级降级采样（见 §4.4），失败率降到 0
15. **道具落位在水下**（v4）：9 个关卡的道具 y 自动落在海面下 → 逐个改 x 到有地形的列；验证器 [2] 现在会查
16. **假宝箱递归**：`applyDecoy` 必须先 `itemRemove` 再 `explode`，否则爆炸递归里重复触发
17. **`W/H` 三重语义**（v5）：`W/H` 同时被当"设计基准/世界高度/画布尺寸"，改响应式时世界会被压扁。修复 = 拆出 `WORLD_H` 常量，`Terrain` 内禁止出现 `H`。改完用 `sed -n '/^class Terrain/,/^const LEVELS/p' mutiny.html | grep "\bH\b"` 必须为空
18. **`G.mapW-W` 散落 5 处**（v5）：每处都自己算镜头钳制，模式一变就出现"镜头能滑出地图"。修复 = 唯一入口 `setCamX/centerCamX`，且 `update()` 里**无条件**再钳制一次（防其它写入点）
19. **桌面字号在高 DPI 下不可读**（v5）：画布逻辑 960 宽被缩到手机 382 CSS px → 11px 字实际 4.5px。修复 = 手机改用**原生 CSS 像素**（`cssScale=1`），字号即 CSS px
20. **大屏无限放大**（v5）：1920 宽下画布被拉到 1.6 倍上限即止，避免 UI 元素巨大且模糊
21. **CJK 文案溢出**（v5）：`ctx.measureText` 前必须先设好 `ctx.font`，否则量的是上一次的字号；统一用 `fitText(str,maxW)` 二分截断
22. **帮助页在小屏放不下**（v5）：写死行距必然溢出 → 改为"内容流"（`helpRows()` 产出带高度的行，再折行/分栏/滚动）

## 9. 已知限制与改进方向（Backlog）

- **移动只有抛射一种**：无走路/跳跃；可考虑同平台点击行走（Worms 式）+ 沿边跳沟
- **风场未接入物理**：`LEVELS` 尚无 `wind` 字段驱动，可作为第十四五关的变化点
- **武器未复刻原版**：海鸥轰炸、船锚拖拽摆放、扇子吹降落伞未做
- **横屏战场偏矮**：`compact` 下世界纵向只显示 440~540 单位（宽 960 恒定），上下各裁一点；若要做"横屏全景"需引入纵向相机
- **竖屏左右留白天生偏大**：视野宽下限 480 世界单位是"看得见对手"的底线，屏幕更窄时就会出现上下 letterbox（已用 `coverBand()` 补成天空/海面，不出现黑边）
- **AI 不会主动打爆危险物**：目前只规避假宝箱，可让困难档 AI 主动引爆敌人身边油桶/信标
- **平衡仍需人肉试玩**：AI 对站桩玩家在多数关卡 1~4 分钟清场，真人手感待校准（三档系数集中在 DIFF 表，调参方便）
- **性能**：地形 2600×560 位图 + 每帧 drawImage 全图，实测流畅；更大规模需分块渲染
- **双人模式无雾战**：双方地图全可见；可作可选开关

## 10. 调试技巧

- 浏览器 console 有启动 banner；临时调试可把 IIFE 内部挂到 `window.__DBG`（参照验证器的注入法，不要提交）
- **`mutiny.html?dbg`**：URL 带 `?dbg` 时挂载 `window.__mutiny`（`L`/`VIEW`/`G` + 5 个 layout 函数），可以直接在 console 里查布局几何；不带参数时零全局变量
- 无头复现逻辑：拷贝验证器头部 mock + 注入导出，即可在 Node 里单步 `startLevel → update 循环`
- 概率类机制调试：`setRng(()=>0)` 让随机判定必然通过，再逐步调 `G.time`/`G.debrisBudget` 隔离分支
- 渲染问题只在浏览器里能看：地形挖洞可看小地图（实时缩略）
- **多分辨率检查**：把 `mutiny.html` 套进一个指定宽高的 iframe（`<iframe style="width:390px;height:844px">`），用 Edge 无头截图 `msedge --headless=new --window-size=390,844 --screenshot=out.png <url>`——**注意**：无头窗口有约 500 CSS px 的最小宽度，直接 `--window-size` 小于 500 得到的是被裁切的画面，必须用 iframe 包一层才是真实视口
- 改动 Terrain/物理/布局后**必跑** `node tools/verify-mutiny.js`，重点关注 [1]/[8]/[13]/[18]/[21]

## 11. 版本历史

| 版本 | 内容 |
| --- | --- |
| v1 | 初版骨架：平台矩形 + 顺向拖拽 + 6 武器（位置重叠、setTimeout 竞态、AI 不准） |
| v2 | 重写：resolve 回合管线、12 武器、击飞物理、弹道模拟 AI、5 关、2P，44 断言 |
| v3 | 弹簧拉弓、抛射移动（resolveKind）、大地图相机、Terrain 像素可破坏地形、道具、AI 弹簧适配，65 断言 |
| v4 | **15 关三章**（迷雾/岩浆/雷暴/涨潮 机关）、**15 种道具四类**（增益/战术/危险物/容器变体）、**宝箱三通道**（空投降落伞动画 + 破坏按材质掉落 + 预置）、**难度双轨**（关卡曲线 + 三档可选）、材质层、确定性 RNG、动态水位、悬停说明卡、存档 v2（分档战绩），177 断言 |
| v5 | **响应式三档**（desktop/portrait/compact）：常量三层拆分（`BASE_*`/`WORLD_H`/`W,H`）、`VIEW` 世界视口唯一映射、6 个 `layoutXxx()` 让绘制与命中共源、指针状态机（8px 阈值/拖拽平移/延迟点按）、触屏 44px 按钮 + 安全区、帮助页内容流与滚动、`coverBand()` 补边；验证器加 `[21] 响应式布局`（11 分辨率），**229 断言** |
