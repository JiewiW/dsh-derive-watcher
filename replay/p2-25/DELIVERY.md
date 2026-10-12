# P2-25 事务四线失效端到端回归 —— 绿阶段交付（11/11 全绿）

> 整改书《治理插件修复计划-整改书-20261012.md》FIX-06 落点。断言①②⑤⑥已由源码字符串
> 正则判定升级为行为级回放；改造只动本目录测试与夹具，未改任何产品代码凑绿。断言⑥转绿
> 的唯一产品侧前提是 FIX-01（lib/index.js user/message 双形状分支），已在本卡步骤 1 落地。

## 全绿入口（一行可复跑）

```powershell
# 在本仓库根（dsh-derive-watcher）执行：
npm run test:p225
# = node --test replay/p2-25/p2-25-regression.test.mjs
```

- 实测：**tests 11 / pass 11 / fail 0，exit 0，duration_ms ≈ 435**。
- **p225 不并入默认闸门**：`npm test`（= `node --test "test/*.test.js"`）保持纯 watcher 单测，
  默认套件实测 tests 117 / fail 0 / exit 0。本回放经 `npm run test:p225` 单独进入。
- 无真实 sleep、无 setTimeout/setInterval/Atomics.wait；②的 300 秒墙钟推进经 stall.js 的
  可注入时钟（`now` 注入 + 显式 `obs.ts` 递增）；异步排空只用 `summarizer.flush()`（setImmediate）
  与有界 setImmediate 轮询。不碰真实 storages（⑥用临时 USERPROFILE 隔离 settingsDir/账本）。
- 事故 transcript 只读流式取段，不整文件 require；①只读安装副本内核（readFileSync 提取真实
  `turn()` 做行为回放），未改内核一字。

## 交付文件清单（均在本目录 `replay/p2-25/`）

| 文件 | 内容 |
|---|---|
| `p2-25-regression.test.mjs` | 6 条断言（③展开为 6 个子用例，共 11 个 test）；①②⑤⑥行为级 |
| `fixtures/event-shapes.mjs` | 统一事件夹具：tool/call、tool/result、assistant/message、user/message；注释行号已按安装副本内核实读更正 |
| `fixtures/incident-args.mjs` | 黄金回归集：事故 6 笔被误拦截的 read/grep/pwsh 实参（断言③），未改 |
| `DELIVERY.md` | 本交付说明 |

## 六断言矩阵（实测 11/11 全绿）

| 断言 | P0 编号 | 结果 | 行为级判定依据（实测） |
|---|---|---|---|
| ① abort-turn 不被工具结果 additionalContexts 架空 | **P0-1** | 🟢 | 安装副本内核真实 `turn()` 回放：stepsRun deepEqual `[36,37]`（止于 draining 一步，不增到 38/39）；turn/end reason `{kind:"abort-turn", reason:"soft-cut-budget-exhausted"}`；draining 事件 pendingContexts=2、tags=[command-exec-discipline, cot-anchor-conclusions]；final via="draining"、droppedContexts=1（step37 新挂注入被丢，不驱动额外 step）；turn-stopping 恰 1 次 |
| ② reasoning-only 计入观察账本 + 注入时钟推进 300s 触发 wall-clock stall-1；结论通道单列通过 | **P0-2 / P0-8** | 🟢 | 真实键名 `stallWatchSteps=3`/`stallWatchWindowSec=300`（DEFAULT_SETTINGS :41-42 + schema 同名两行）；reasoning-only（reasoningLen=128、hasText=false）写入观察账本且观察水位推进；注入时钟跨 300000ms 喂 3 个 barren step → 恰好一次 STALL level=1，载荷 `stallCount=3`、`spanMs≥300000`（实现载荷字段为 stallCount/spanMs，"barrenRun" 仅为日志文案）；结论通道单列：空文本 `enqueue` 返 `{queued:false}`（reasoning 不入结论队列，期望行为，断言通过） |
| ③ 事故 6 笔拦截实参零误杀（inc-1…inc-6） | **P0-5** | 🟢×6 | 逐笔真实 tool/call+tool/result 后 evaluateG2 全判放行（G2-A/G2-B 均不 block） |
| ④ 两次插件自 deny 不产生 G2-B | **P0-5** | 🟢 | error.info.plugin=dsh-step-governor 的自 deny 不累积成 G2-B |
| ⑤ 合法顶层 `{"entries":[]}` 不 gap、水位推进；嵌套/畸形才记 gap | **P0-3** | 🟢 | 正例：顶层空 entries → onGap 0 次、账本无 gap 行、无 SUMMARIZER_DEGRADED、结论水位推进到 step2、degraded=0；负对照（同一 test 体内）：嵌套 `{"draft":{"entries":[]}}` → 重试 1 次仍畸形，恰好 1 条 gap + 1 条 degraded 事件、retried=1（"畸形才记 gap"） |
| ⑥ source.plugin 直挂 user/message 不清零 stall；gui 形状负对照清零 | **FIX-01**（P0 user/message 双形状） | 🟢 | 真实 watcher apply 行为级：plugin 形状 `{source:{plugin:"x"}}`（内核 user/message data 直挂，安装副本 lib/index.js:1351）后再 3 条语义重复 → stall 序列 `[1,2]`（count 3→6 续计，step7 升级 level:2，未清零）；独立实例 gui 负对照 `{source:{surface:"gui"}}` 后再 3 条 → 序列 `[1,1]`、无 level:2、第二次 level:1 的 stallCount 重新计为 3（清零一次） |

## 行为级改造要点（相对红阶段）

- 删除全部 watcher 源码字符串正则判定（原 :74、:79-89、:240-242 等）：
  - ① 改为只读安装副本内核、`AsyncFunction` 构造真实 `turn()` + 复刻 `agent-loop-p5-replay-step36.mjs`
    的 ctx 夹具做行为回放（该参考脚本 16 passed）。
  - ② 改为真实 store/stall 控制器行为：观察账本落账读取 + 注入时钟触发 wall-clock stall-1。
  - ⑤ mock 由嵌套 `{draft:{entries:[]}}` 改正为顶层 `{"entries":[]}`；畸形负对照保留在同一 test。
  - ⑥ 改为经真实 `apply(ctx)` 喂 session/event：mock llm.stream 产出 text-delta，selfcheck 恒判
    语义重复，从 EVT.STALL 事件序列（经 mock session.append 收集）客观区分清零与否。
- 两处豁免存量 setTimeout（原 :200/:217 的 20/30ms mock flush）已删除，改用 `summarizer.flush()`；
  目录内现无任何 setTimeout/setInterval/Atomics.wait。
- 注释 stale 内核行号已按安装副本实读更正：appendToolResult 定义 :798（调用 :678/:772）、
  appendToolCall 定义 :788（调用 :687/:771）、user/message append :1351、
  assistant/message append :1522/:1599/:1636。

## 红线自查

- 只改 `replay/p2-25/` 下测试与夹具；产品代码唯一改动是本卡步骤 1 的 FIX-01
  （lib/index.js user/message 分支照整改书双形状），无第二处产品改动。
- 内核 @deepseek-ai/dsh-agent-loop 任何副本零修改（①仅 readFileSync 只读）。
- 无真实 sleep/新定时器；300 秒推进只经注入时钟。
