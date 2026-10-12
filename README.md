# dsh-derive-watcher

DeepSeek Harness（DSH）插件：观察 agent 会话的**语义进展**，把每个助手回合沉淀成一本「语义旅程账本」，并在模型语义停滞时分级告警、向上层治理请求干预。

**只观察与建议，不直接执行**——需要真正拦截工具或步骤时，由姊妹插件 step-governor（L2）动手；L2 不在线时本插件自动放行（fail-open），绝不因为治理联动失败卡住任务。

## 三层治理中的位置

| 层 | 插件 | 职责 |
| --- | --- | --- |
| L1 | [dsh-cot-anchor](https://github.com/JiewiW/dsh-cot-anchor) | 单次生成内的思维锚点注入与软切 |
| L2 | [dsh-step-governor](https://github.com/JiewiW/dsh-step-governor) | 跨步骤治理：工具限流、步骤拒绝 |
| L3 | 本插件 | 会话语义旅程账本、新颖性判定、里程碑折叠、上下文注入、三级停滞响应 |

## 它具体做什么

**1. 语义旅程账本**
把每个助手消息总结成结构化条目（finding / decision / dead-end / hypothesis / plan / fact），JSONL 与 Markdown 双镜像落盘。每条写入都做长度守恒校验（写入字节数等于序列化字节数）并回读验证，校验失败只丢弃这一条、发事件告警，不会让账本静默损坏。水位线记录每会话最后处理的消息，进程重启后自动幂等补扫，不永久漏账。

reasoning（思考块）与正式 text 分开观察、走独立账本：当模型长期只有思考没有正文产出时，以 reasoning 流为准，且思考内容绝不混入正式结论。

**2. Flash 总结**
条目由小模型异步总结产出：单并发队列（上限 2）、单次 30 秒超时、畸形结果重试 1 次、队列溢出丢最旧并记 gap。模型返回空数组算正常结果（只推进水位），只有解析失败才算 gap。

**3. 新颖性判定**
中文归一化后做字符 3-gram MinHash 词法比对（Jaccard 阈值 0.8），再经 LLM schema 自检确认；也可选 embedding 余弦（阈值 0.85），模型无 embedding 能力时自动回退。

**4. 里程碑折叠**
账本条目超过阈值（`recentN × 3`）时，最旧一批交模型蒸馏成里程碑、原文移入归档。失败教训（dead-end）全量保留零丢失，未完成目标（open objectives）跨折叠保留。

**5. 上下文注入（默认关闭）**
在下一步前把「未完成目标（置顶）+ 里程碑 + 最近 N 条结论」注入上下文；只做整条剔除和句界裁剪，不会截断单条中间。水位落后时明确标注 `latestSummarized:false`，不用陈旧条目冒充新结论。

**6. 三级语义停滞响应**

| 级别 | 触发 | 动作 |
| --- | --- | --- |
| stall-1 | 连续若干步只有重复、没有新结论（或墙钟旁路：连续 3 个无正文/无产物步骤且跨度 ≥ 5 分钟） | 注入警示 |
| stall-2 | 重复继续累积 | 请求 L2 拒读类工具（`denyToolCategory`，默认关闭） |
| stall-3 | 进一步恶化 | 请求 L2 硬终止本步（`rejectStep`），并写交接账本与续跑种子（默认关闭） |

纯字面重复（措辞一模一样）只记账不升级，只有**语义重复**才推进停滞级别；真人发来新消息归零所有状态（系统/插件注入的消息不算）。

**7. 生命周期管理**
worker 每分钟心跳；会话结束或最后事件后 10 分钟无新事件，自动清理会话状态与心跳；归档按保留期定期清扫。

## 安装

```sh
dsh plugin --profile <你的profile> add github:JiewiW/dsh-derive-watcher#v0.1.1
```

零第三方运行时依赖。账本默认落在 `~/.dsh/storages/semantic-watcher/`（设置项 `storagePath` 可改）。

## 设置

22 项、六个分组（旅程账本 / 总结 / 注入与折叠 / 新颖性 / 停滞阈值 / 存储），运行时经 `GET/POST /plugins/derive-watcher/settings` 读写，GET 返回完整 schema。常用默认值：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enableJourney` | `true` | 旅程账本总开关 |
| `enableInjection` | `false` | 上下文注入总开关（首发默认关） |
| `enableStall2Deny` / `enableStall3Reject` | `false` / `false` | stall-2/3 与 L2 的联动（首发默认关，L2 不在线时 fail-open） |
| `stall1Steps` / `stall2Steps` / `stall3Steps` | 3 / 6 / 10 | 语义停滞分级阈值（保存时校验严格递增，倒挂拒绝） |
| `stallWatchSteps` / `stallWatchWindowSec` | 3 / 300 | 墙钟旁路：连续无产出步骤数 K 与跨度 T（秒） |
| `injectionTokenBudget` | 1200（允许 800–1500） | 注入 token 预算 |
| `recentN` | 8 | 最近结论窗口，也是折叠阈值基准 |
| `noveltyMode` | `schema-selfcheck` | 另可选 `embedding` / `both` |
| `maxConcurrency` | 1（上限 2） | 总结并发闸 |
| `sessionTtlMinutes` | 10 | 会话无新事件后的存活时间 |
| `retentionDays` / `ledgerRetentionDays` | 30 / 0 | 归档保留天数；主账本保留天数（0 = 不清主账本） |
| `escapeClosingTags` | `true` | 闭标签写入前转写、读取还原 |

联动约束：`enableInjection` 要求 `enableJourney`；`enableStall2Deny` / `enableStall3Reject` 要求 `enableInjection`。

## 事件

10 个事件（`semantic-watcher/*` 前缀），全部载荷样例见 [docs/events.md](docs/events.md)：

`stall` · `store-corruption` · `injection-skipped` · `execution-unavailable` · `lexical-repeat` · `summarizer-degraded` · `handoff-written` · `heartbeat` · `fold-milestone` · `retention-cleaned`

## 测试

```sh
npm test            # node --test "test/*.test.js"，117+ 用例
npm run test:p225   # P2-25 事务四线回归（11 用例）
```

覆盖：账本转写与长度守恒、MinHash 边界、畸形 JSON 重试、折叠链完整性（dead-end 零丢失）、注入预算与句界裁剪、stall 全部口径（gap / 背离 / 重置 / 阈值倒挂 / 墙钟旁路）、设置 clamp 与联动、L2 不可用降级。

## 离线回放

[replay/README.md](replay/README.md)：用真实事故会话加合成样例驱动，mock-LLM 离线确定性运行（不调真实模型、不写真实账本根），核验账本完整性、新颖性判定与 stall 三级触发。

## 待办

- 与 L2（step-governor）真实联调：stall-2 `denyToolCategory` / stall-3 `rejectStep` 的端到端验证；
- 宿主 driver 对 stall-3 拒绝码（`semantic-stall`）的分派支持；
- `enableStall2Deny` / `enableStall3Reject` 待影子期验收后开启默认值。

## 许可

[MIT](LICENSE)
