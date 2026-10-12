# dsh-derive-watcher 事件契约（docs/events.md）

所有事件名以 `semantic-watcher/` 为前缀，经 `session.append(name, payload)` 落入会话事件流（可被 GUI/日志检索），同时打 console.warn 旁证行。

## 公共约定

- 每个事件载荷**必带**：`sessionId`、`turn`、`step`、`evidenceSeq`、`ts`。
  - `sessionId` 不可得时回退 `"*"`；`turn`/`step`/`evidenceSeq` 非有限数值时置 `null`（`evidenceSeq` 缺失时由事件汇自增兜底）。
- 抑制类事件（`injection-skipped` / `execution-unavailable` / `summarizer-degraded`）**必带** `suppressReason`（人类可读的一行原因）；缺失时自动补 `"unspecified"`。
- 事件为 fire-and-forget 旁路信号：发射方不因事件失败阻塞主流程（fail-open 原则）。

## 事件清单与载荷样本

### semantic-watcher/stall

停滞状态机升级时发出（每级动作只发一次；`level` 1/2/3 分别对应注入提醒 / 注入+L2 deny / 注入+交接账本+可选 L2 reject）。**P0-8 观察旁路**：连续 K 个无 text/产物 step 且墙钟跨度≥T 时 also 发 `level=1` stall（此时经 `stallWatch` 路径，载荷带 `spanMs` 字段）。

```json
{
  "sessionId": "session-4f4ead96",
  "turn": 12,
  "step": 47,
  "evidenceSeq": 2,
  "level": 2,
  "stallCount": 6,
  "code": "semantic-stall-2",
  "warning": "检测到语义停滞（连续 6 条重复结论）。已升级至 L2 拒绝：读取类工具将被限流，TTL=4 步，到期自动解除。",
  "ts": "2026-10-09T08:15:30.123Z"
}
```

wall-clock stall-1 的另一载荷形态（observation 旁路路径，无 `stallCount`/`code`，带 `spanMs`）：

```json
{
  "sessionId": "session-4f4ead96",
  "turn": 12,
  "step": 47,
  "evidenceSeq": 2,
  "level": 1,
  "spanMs": 305000,
  "warning": "【语义监视 · stall-1】连续 3 个 step 未产出可见 text/产物（墙钟约 305 秒）。会话可能已空转停滞：请回顾目标，改变方法或换一条路径。",
  "ts": "2026-10-09T08:15:31.000Z"
}
```

`code` 取值：`level=2` → `"semantic-stall-2"`（L2 denyToolCategory，TTL 到期自动解除）；`level=3` → `"semantic-stall"`（不可重试、不走 G1，经 rejectStep 在本 turn 下一 pre-step 边界消费）；`level=1` → `null`（含 wall-clock 路径）。

### semantic-watcher/store-corruption

账本完整性校验失败（长度守恒破坏 / 回读 JSON.parse 失败 / 条目校验失败 / 水位写入失败）时发出，同时停止该条写入。

```json
{
  "sessionId": "session-4f4ead96",
  "turn": 12,
  "step": 47,
  "evidenceSeq": 3,
  "reason": "长度守恒失败: 增量 128 != 期望 96",
  "stage": "append",
  "entryId": "j_0042",
  "ts": "2026-10-09T08:15:31.456Z"
}
```

`stage` 取值：`validate`（条目 schema 校验失败，未落盘）/ `append`（长度守恒或回读解析失败）/ `md`（MD 镜像失败，非致命）/ `milestone` / `watermark` / `observation`（观察账本写入失败）/ `read`（账本读取时遇不可解析行）/ `gap`。

### semantic-watcher/injection-skipped

agent/pre-step 注入组装失败时发出（结构校验失败 / token 预算溢出 / 账本读取失败），本步不注入。

```json
{
  "sessionId": "session-4f4ead96",
  "turn": 12,
  "step": 48,
  "evidenceSeq": 4,
  "suppressReason": "预算溢出：不可裁剪项（目标/死胡同标题）已超 token 预算 1200",
  "ts": "2026-10-09T08:15:32.000Z"
}
```

### semantic-watcher/execution-unavailable

L2 step-governor 不可用或调用失败时发出，动作按 fail-open 降级（stall-2 仅注入、stall-3 仅告警），**不阻塞、不重试**。

```json
{
  "sessionId": "session-4f4ead96",
  "turn": 12,
  "step": 47,
  "evidenceSeq": 5,
  "suppressReason": "L2 step-governor 未就绪（denyToolCategory 降级为仅注入）",
  "ts": "2026-10-09T08:15:33.000Z"
}
```

### semantic-watcher/lexical-repeat

纯词法重复（novelty=duplicate 且 semantic_duplicate=false）仅记账不升级停滞，发本事件留痕。

```json
{
  "sessionId": "session-4f4ead96",
  "turn": 12,
  "step": 45,
  "evidenceSeq": 6,
  "duplicateOf": "j_0038",
  "stallCount": 4,
  "ts": "2026-10-09T08:15:34.000Z"
}
```

### semantic-watcher/summarizer-degraded

总结 worker 降级时发出：畸形 JSON 重试后仍无效 / 队列溢出丢最旧（**P0-8 后连续 gap ≥3 不再暂停停滞响应，改为降级继续计数**）。**P2-22③** 载荷携带 `grade` 区分降级原因：`timeout`（超时/中止）/ `parse-error`（解析失败）/ `other`/（含熔断短路）；`appendGap` 的 gap 行同样写入 `grade` 字段。

```json
{
  "sessionId": "session-4f4ead96",
  "turn": 12,
  "step": 45,
  "evidenceSeq": 7,
  "grade": "parse-error",
  "suppressReason": "总结草稿 JSON 畸形（重试 1 次后仍无效），跳过本条并记 gap",
  "messageId": "am-1057",
  "ts": "2026-10-09T08:15:35.000Z"
}
```

### semantic-watcher/handoff-written

stall-3 触发时交接账本与种子文件写入成功后发出。

```json
{
  "sessionId": "session-4f4ead96",
  "turn": 12,
  "step": 47,
  "evidenceSeq": 8,
  "path": "C:\\Users\\<u>\\.dsh\\storages\\semantic-watcher\\handoff\\session-4f4ead96-20261009-081536.md",
  "seedPath": "C:\\Users\\<u>\\.dsh\\storages\\semantic-watcher\\handoff\\session-4f4ead96-20261009-081536.seed.json",
  "ts": "2026-10-09T08:15:36.000Z"
}
```

### semantic-watcher/heartbeat

worker 心跳：每 5 个观察事件或每 60s 空闲扫描时发出，载荷含总结队列长度与水位 stepSeq（§5.8）。

```json
{
  "sessionId": "session-4f4ead96",
  "turn": 12,
  "step": 47,
  "evidenceSeq": 9,
  "queueLength": 2,
  "watermarkStepSeq": 44,
  "ts": "2026-10-09T08:15:40.000Z"
}
```

### semantic-watcher/fold-milestone

里程碑折叠成功（里程碑落账 + 原文归档移除）后发出。

```json
{
  "sessionId": "session-4f4ead96",
  "turn": 12,
  "step": 47,
  "evidenceSeq": 10,
  "milestoneIds": ["j_0100", "j_0101"],
  "foldedIds": ["j_0001", "j_0002", "j_0003", "j_0004", "j_0005", "j_0006", "j_0007"],
  "archived": 7,
  "archive": "C:\\Users\\<u>\\.dsh\\storages\\semantic-watcher\\journey\\archive\\session-4f4ead96-20261009.jsonl",
  "ts": "2026-10-09T08:15:41.000Z"
}
```

### semantic-watcher/retention-cleaned

retention 清理（默认 30 天，按 mtime 扫描归档目录）删除文件后发出；里程碑文件不参与清理。

```json
{
  "sessionId": "*",
  "turn": null,
  "step": null,
  "evidenceSeq": 11,
  "removed": ["session-a915fee0-20260901.jsonl"],
  "count": 1,
  "ts": "2026-10-09T08:15:42.000Z"
}
```

## 与 L2 契约的对应（§2.2 / §5.5）

- `semantic-stall-2`：denyToolCategory(sessionId, "read", {code, evidenceSeq, ttlSteps})，幂等键 (sessionId, evidenceSeq, code)，TTL=stall3Steps−stall2Steps，到期自动解除。
- `semantic-stall`：rejectStep(sessionId, {code, evidenceSeq})，幂等键 (sessionId, evidenceSeq)，pending 在本 turn 下一 pre-step 边界消费、turn 结束或真人消息清除。默认 `enableStall3Reject=false`（影子期只告警），开启前必须确认 driver 已按 code 分派（现状一律 block 为 prompt-rejected，未满足前禁止在真实 goal 会话开启 stall-3）。
- L2 不可用一律 fail-open 并发 `semantic-watcher/execution-unavailable`。
