# 离线回放脚手架

## 数据来源

transcript 一律经 `dsh-session-log-extract` 技能 dump 获得（本目录不手写会话数据）：

```powershell
node replay/dump-sessions.mjs
# 逐会话调用：node ~/.dsh/skills/dsh-session-log-extract/extract-session-log.mjs dump <sessionId>
# 产物：replay/transcripts/<sessionId>.jsonl（首行 {"type":"session",...}，明文 JSONL）
```

脚本定位：技能脚本默认取 `~/.dsh/skills/…`（环境变量 `DSH_SESSION_LOG_EXTRACT` 可覆盖）；项目根取环境变量 `DSH_SESSION_PROJECT_ROOT`（未设置时用当前 cwd）。

三个事故会话（id 与 `expected-ranges.json` 同源）：

- `session-4f4ead96`
- `session-a915fee0`
- `session-554d7536-2b99-4f09-a6ee-3b5621a09056`

## 合成样例（session-4f4ead96）

验收方预登记处置：原轨迹已被清理，以脚手架自带合成流替代。§5.5 定谳口径：纯词法 duplicate 只记账+发 lexical-repeat，**不触发 stall 升级**；只有 semantic_duplicate=true 才计入升级。因此合成流分两阶段：

1. **阶段 A**：10 条同文循环 → j_0001 new + 9 条纯词法 duplicate（LEXICAL_REPEAT ×9，零升级——验证不升级口径）；
2. **归零步**：真人 user 消息（stall 状态与级动作状态清零）+ 3 条真新结论（new 保持归零）；
3. **阶段 B**：10 条词法互异但语义同结论的变体（mock selfcheck 判 duplicate 指向 j_0001）→ 恰好在 S0+3/6/10 触发 stall-1/2/3（符合验收 ±2 容差）。

stall-2 走 L2 fail-open（getL2→null，发 execution-unavailable）；stall-3 只写会话种子（enableStall3Reject=false，绝不触碰 L2）。

### 已核验结果（2026-10-12，mock 离线，含 P0-2/P0-8 观察通道）

> 2026-10-12 起回放同步 P0-2 reasoning 观察通道（`store.appendObservation` + `observation` watermark）与 P0-8 wall-clock 停滞观察（`stall.onObservation`）。真实事故会话的 reasoning-only step 现已产生独立观察条目（kind=`reasoning-observation`），不再只吃 text。

| 会话 | enqueued/entries | observations | reasoning-only 观察 | stallLevels | gaps/degraded | corruption | exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| session-4f4ead96（合成） | 23/115 | 23 | 0 | [1,2,3]（count=3/6/10） | 0/0 | 0 | 0 |
| session-a915fee0 | 46/230 | 117 | 70 | [] | 0/0 | 0 | 0 |
| session-554d7536-… | 299/1495 | 473 | 172 | [] | 0/0 | 0 | 0 |

> `entries` 在某步内 >`enqueued` 是词法/语义重复仍逐条落账（每条 sourceMessageId 不同）+ 里程碑折叠前多 step 分批累计所致，非 BUG。合成会话 `reciprocal` 23 观察条目（全 text）吻合 enqueued；两会话 reasoning-only 观察条数为真实轨迹中「有 reasoning、无 text、无产物」的 step 数——**这正是事故会话此前零 entry 的原因现已通过观察通道捕获**。

真实会话在 mock 模式下验证的是**管线与账本完整性**（落账条数、观察条数、双水位推进、零 corruption、零 gap）；novelty 全 new 属预期（mock 无真实语义判定能力）。验收方预登记的 stall 预期区间（a915fee0 turn3 step49-52；554d turn4 第 3/6/10 次 compaction 前后）需 `--live` 影子期核验。

## 运行回放

```powershell
node replay/replay.mjs                # 默认 --mock-llm，离线确定性，绝不调真实 LLM
node replay/replay.mjs --check        # 额外校验验收方预登记的预期步区间
node replay/replay.mjs --session session-4f4ead96   # 只重放指定会话
```

- 账本根默认 `replay/replay-ledger/`（隔离，绝不写真实 `~/.dsh/storages/semantic-watcher/`）；`--root` 可覆盖。
- stall-2 的 L2 denyToolCategory 在回放中恒走 fail-open（getL2→null，发 `semantic-watcher/execution-unavailable`）；stall-3 默认只告警（`enableStall3Reject=false`）。
- **禁止在真实 goal 会话运行 `--live` 触发 stall-3**；stall-2/3 联调就位前只在 mock 与回放执行。

## 预期步区间（验收方预登记）

`replay/expected-ranges.json` 中每个会话的 `stepRange` 字段由**验收方**登记；模型与脚手架只读取校验，不填写、不修改。未登记（null）时 `--check` 跳过并打印 SKIP。

## 产出核验（增长型标量）

回放输出逐会话 JSON 摘要，核验点：

| 标量 | 含义 |
| --- | --- |
| `enqueued` / `entries` | 入队 assistant/message 数 / 落账条目数（JSONL 行数随之增长） |
| `duplicate` / `semanticDuplicate` | 词法重复 / 语义重复条数 |
| `observations` / `reasoningObservations` | 观察条数 / 纯 reasoning-only 观察条数（kind=`reasoning-observation`） |
| `lexicalRepeat` / `stallEvents` / `stallLevels` | 词法重复事件数 / stall 事件数与级别序列 |
| `watchStalls` | wall-clock（P0-8）stall-1 事件数 |
| `gaps` / `degraded` | gap 行数 / 总结降级事件数 |
| `corruption` | 账本完整性事件数（回放期应为 0） |
| `watermarkStepSeq` | 最终总结水位 |
| `observationWatermarkStepSeq` | 最终观察水位（独立于总结水位） |
