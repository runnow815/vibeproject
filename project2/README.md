# vibeproject

It collects my vibe coding.

---

**五子棋 · 古典棋韵** — 基于纯 HTML/CSS/JavaScript 的古典中国风五子棋游戏。

- 文件：`gomoku.html`（单页应用，零外部依赖）
- 运行方式：直接在浏览器打开 `gomoku.html` 即可（无需构建、无需服务器）
- 对弈模式：双人对弈 / 人机对战（三档棋力，可选执黑或执白）
- 测试：无测试框架，无构建步骤，无需安装依赖

## 功能特性

| 功能 | 说明 |
|------|------|
| 15×15 标准棋盘 | Canvas 绘制，木纹背景，朱砂红星位 |
| 对战模式 | 双人对弈 / 人机·我执黑 / 人机·我执白，切换即开新局 |
| 人机 AI | 三档棋力：简单（强噪声）/ 中等（棋型评分）/ 困难（两层搜索） |
| 黑棋禁手 | 简化连珠规则（长连/双四/双活三），悬停实时提示，可开关 |
| 胜负判定 | 横、竖、斜四方向检测五子连珠 |
| 悔棋 | 双人撤一手；人机模式自动连 AI 的一起撤 |
| 计时器 | 每方 15 分钟倒计时超时判负，可切换不限时 |
| 落子动画 | 棋子回弹缓动（easeOutBack） |
| WebAudio 音效 | 落子/禁手/胜利合成音效，可开关 |
| 回合记录 | 右侧历史列表，点击可标记对应位置 |
| 胜负统计 | localStorage 持久化（key: `gomoku_stats_chinese`） |
| 设置持久化 | 模式/难度/禁手/计时/音效（key: `gomoku_settings_chinese`） |
| 古典中国风 | 宣纸色背景、木纹棋盘、毛笔书法字体、朱砂红点缀 |

## AI 与禁手实现

AI 评分基于 9 格窗口的棋型识别（`buildLine` 提取方向线 → 连五/活四/冲四/活三/眠三/活二分档打分）：

- **简单**：一层评分 + 大幅随机扰动，会漏防失误
- **中等**：进攻分 + 0.95×防守分，取最高分点
- **困难**：前 8 个候选做两层搜索，扣减对手最佳应手威胁

禁手检测（`forbiddenCheck`）：长连 → 恰连五（获胜优先）→ 双四 → 双活三，逐级判定；AI 执黑时自动规避禁手点。

## 代码架构

整个应用在一个 `gomoku.html` 文件中，按出现顺序分为三部分：

### CSS（~200 行）
古典中国风样式，含响应式断点。关键类名约定：`.timer-row.active-turn` 标记当前走棋方，`.status-bar.win` / `.status-bar.draw` 标记终局状态。

### JavaScript IIFE（~450 行）
自执行函数（`(function() { 'use strict'; ... })()`），无全局变量泄漏。内部结构：

```
init()                    ← 入口：加载设置/统计 → 同步控件 → 重置棋盘 → 绘制 → 更新 UI
 ├─ resetBoard()          ← 清空状态数组、按设置重置计时
 ├─ draw()                ← 渲染管线，顺序执行：
 │   ├─ drawBoardBackground()  ← 线性渐变木纹底色
 │   ├─ drawGrid()             ← 横竖线
 │   ├─ drawStarPoints()       ← 九星位（朱砂红圆点）
 │   ├─ drawStones()           ← 遍历 board 数组，径向渐变立体棋子（含落子动画缩放）
 │   ├─ drawLastMoveMarker()   ← 上一步标记（朱砂红小点）
 │   ├─ drawHoverStone()       ← 鼠标悬停半透明预览（禁手点画朱砂叉）
 │   ├─ drawWinHighlight()     ← 获胜五子朱砂红光圈
 │   └─ drawHistoryMarker()    ← 回合记录选中标记（虚线圆圈）
 └─ updateUI()           ← DOM 更新：状态栏、按钮状态、计时器、回合记录、统计
```

#### AI / 禁手 / 事件流

- **事件流**：Canvas click → 禁手拦截 → `placeStone()` → `checkWin()` → `scheduleAI()`（轮到 AI 时延时落子）
- **AI**：`genCandidates`（邻域 2 格候选）→ `evalPoint`（四方向棋型评分）→ `aiChooseMove`（按难度分档）
- **禁手**：`isForbiddenMove(r, c)` 临时落子 → `forbiddenCheck` 判长连/双四/双活三

#### 核心数据流

- **状态对象 `state`**: 集中存储棋盘数组、当前走棋方、落子历史、计时器状态、鼠标悬停位等
- **渲染**: 纯函数式绘制，每次 `draw()` 全量重绘 Canvas（无脏区优化，简单场景够用）
- **UI 更新**: `updateUI()` 同步 DOM 与 state
- **事件 → 状态变更 → 重绘**: Canvas click → `placeStone()` → `checkWin()` → `draw()` + `updateUI()`

#### 关键实现模式

| 模式 | 说明 |
|------|------|
| 胜利检测 | `checkWin(r, c, player)` — 从落子位沿四个方向向量双向扫描，收集连珠坐标 |
| 计时器 | `setInterval(1000)` tick，`state.blackTime/whiteTime` 递减，超时调用 `handleTimeout()` |
| 悔棋 | `undoMove()` — pop 最后一步，恢复棋盘和 current 方，保留剩余时间 |
| 坐标转换 | `getCanvasCoords()` → `getBoundingClientRect` + 缩放比；`getNearestIntersection()` 四舍五入取最近交叉点，距离 > 0.48 CELL_SIZE 忽略 |
| Canvas 尺寸 | `PADDING * 2 + (BOARD_SIZE - 1) * CELL_SIZE` = 534px |

### HTML（~30 行）
结构骨架：标题 → 棋盘容器 → 侧边面板（计时器/回合记录/按钮/统计）→ 状态栏。

## 关键常量

```
BOARD_SIZE   = 15      // 棋盘大小
CELL_SIZE    = 36      // 格子间距（px）
PADDING      = 30      // 棋盘边距（px）
STONE_RADIUS = ~15.8   // 棋子半径（CELL_SIZE * 0.44）
TOTAL_TIME   = 900     // 每方总时间（秒）
```

星位（0-indexed）：传统围棋九星位 `[[3,3], [3,7], [3,11], [7,3], [7,7], [7,11], [11,3], [11,7], [11,11]]`

## 开发指南

- 直接编辑 `gomoku.html`，保存后刷新浏览器即可
- 无构建步骤、无需安装依赖、无需测试命令
- Canvas 坐标转换使用 `getBoundingClientRect` + 缩放比
- 所有代码均为原生 JS，无框架依赖
- localStorage key：`gomoku_stats_chinese`（统计）、`gomoku_settings_chinese`（设置），可手动清除重置
