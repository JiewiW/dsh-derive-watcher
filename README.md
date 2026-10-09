# dsh-derive-watcher

DSH（DeepSeek Harness）插件：**语义监视者（L3）**。观察 agent 会话的语义进展，维护「语义旅程账本」，在检测到语义停滞时分级告警、注入干预建议、请求上层治理——**只观察与建议，不直接执行**。

在三层语义治理架构中的定位：

- **L1**（dsh-cot-anchor）：步骤间思维锚点注入；
- **L2**（dsh-step-governor）：步骤治理（工具类限流 / 步骤拒绝）；
- **L3**（本插件）：会话语义旅程账本 + 新颖性判定 + 里程碑折叠 + 上下文注入 + 三级语义停滞响应（调用 L2，L2 不可用时 fail-open）。

## 功能（P0–P3）

- **语义旅程账本（journey-store）**：每个 assistant/message 总结为结构化条目（finding/decision/dead-end/hypothesis/plan/fact），JSONL + MD 双镜像落账；字面闭标签写前转写、读时还原（`escapeClosingTags`）；每条 append 做长度守恒校验（写入字节 == 序列化字节）且回读可 JSON.parse，失败发 `semantic-watcher/store-corruption` 并停止该条写入；watermark 水位记录每会话最后成功 messageId/stepSeq，支持重启补扫。
- **flash 总结（summarizer）**：异步 worker 队列消费；并发闸默认 1（上限 2）、单次 30s 超时（独立 AbortController）、畸形 JSON 重试 1 次、队列上限 8 溢出丢最旧并记 gap；gap 不产出条目、不参与停滞判定。
- **新颖性判定（novelty）**：中文归一化后字符 3-gram MinHash 词法判定（Jaccard 阈 0.8）+ LLM schema 自检；embedding 余弦（阈 0.85）可选，模型无能力时自动回退 schema 自检。
- **里程碑折叠（fold）**：账本条目超阈值（>recentN×3）或注入超预算时，最旧一批交 flash 蒸馏为里程碑，原文移入归档；**dead-end 全量保留零丢失**、open objectives 跨折叠保留；retention 定期清理过期归档并发事件。
- **上下文注入（injection，默认关）**：pre-step 时组装 open objectives（置顶）+ 里程碑 + 最近 N 条结论注入下一轮上下文；排除最近 1–3 步；水位落后带 `latestSummarized:false` 不用陈旧条目冒充；token 预算内只做整条剔除/句界裁剪，禁止截断单条中间；组装后结构校验，失败发 `semantic-watcher/injection-skipped` 并放弃注入。
- **三级语义停滞响应（stall）**：连续无新结论（duplicate 且无 new）计步 → stall-1（注入警示）/ stall-2（请求 L2 `denyToolCategory`，code=`semantic-stall-2`，TTL=stall3−stall2）/ stall-3（请求 L2 `rejectStep`，code=`semantic-stall` + 写交接账本与续跑种子）；纯词法重复只记账发 `lexical-repeat` 不升级，仅语义重复计入升级；真人消息归零所有状态；L2 不可用全部 fail-open 并发 `semantic-watcher/execution-unavailable`。
- **worker 心跳**：每分钟或每 5 个事件发出，载荷含队列长度与水位 stepSeq。

## 事件

10 个事件（`semantic-watcher/*` 前缀），全部载荷样本见 [docs/events.md](docs/events.md)：

`stall` / `store-corruption` / `injection-skipped` / `execution-unavailable` / `lexical-repeat` / `summarizer-degraded` / `handoff-written` / `heartbeat` / `fold-milestone` / `retention-cleaned`。

## 安装

作为 DSH 插件目录放置于宿主工作区（与其它 cordis 插件一致，经 `cordis.patch.yml` 挂载），零第三方依赖。账本根目录默认 `~/.dsh/storages/semantic-watcher/`（设置 `storagePath` 可覆盖）。

## 设置

18 键六大组（旅程账本 / 总结 / 注入与折叠 / 新颖性 / 停滞阈值 / 存储），运行时经 `GET/POST /plugins/derive-watcher/settings` 读写，GET 返回完整 schema。关键默认值：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enableJourney` | `true` | 旅程账本总开关 |
| `enableInjection` | `false` | 注入总开关（**首发固定关**） |
| `stall1Steps` / `stall2Steps` / `stall3Steps` | 3 / 6 / 10 | 停滞分级阈值（保存时校验严格递增，倒挂拒绝） |
| `enableStall2Deny` / `enableStall3Reject` | `false` / `false` | stall-2/3 的 L2 联动（**首发固定关**） |
| `injectionTokenBudget` | 1200（800–1500） | 注入 token 预算 |
| `recentN` | 8 | 最近结论窗口 |
| `noveltyMode` | `schema-selfcheck` | 词法之外的语义判定模式（可 `embedding` / `both`） |
| `retentionDays` | 30 | 归档保留天数 |
| `escapeClosingTags` | `true` | 闭标签转写开关 |

联动约束：`enableInjection` 要求 `enableJourney`；`enableStall2Deny`/`enableStall3Reject` 要求 `enableInjection`。

## 测试

```powershell
node --test test/
```

覆盖：store 转写与长度守恒、MinHash 边界、schema 自检 mock 与畸形 JSON 重试、折叠链完整性、注入预算与句界裁剪、stall 全部口径（gap/背离/重置/阈值倒挂）、设置 clamp/联动/回退、L2 不可用降级等。

## 离线回放

见 [replay/README.md](replay/README.md)：三事故会话 + 合成样例驱动，mock-llm 离线确定性运行（绝不调真实 LLM、绝不写真实账本根），核验账本完整性、novelty 判定与 stall 三级触发。

## P4 待办（依赖点）

- L2（step-governor）真实联调：stall-2 `denyToolCategory` / stall-3 `rejectStep` 的端到端验证（当前 L2 不可用时 fail-open）；
- 宿主 driver 对 stall-3 reject code（`semantic-stall`）的分派支持；
- `enableStall2Deny` / `enableStall3Reject` 首发默认 false，待验收流程开启；
- 真实事故会话的预期步区间预登记与 `--live` 影子期核验。

## License

[MIT](LICENSE)
