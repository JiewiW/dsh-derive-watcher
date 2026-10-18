/**
 * dsh-derive-watcher — 设置（计划书 §5.6 全量键）。
 *
 * 规则：
 *  - clamp：数值越界回退到边界（记 warning）；非法/非有限回退默认（记 warning）；
 *  - 联动：enableInjection=true 要求 enableJourney=true；
 *          enableStall2Deny / enableStall3Reject 要求 enableInjection=true；
 *  - 阈值倒挂（不严格递增 stall1<stall2<stall3）→ 拒绝保存（error）；
 *  - 持久化损坏 → 返回 null 回退默认并告警。
 *  - schema 默认值 ≠ 首发强制态：首发固定 enableInjection=false、enableStall3Reject=false
 *    （与默认一致；由 apply 层在 load 后不放宽，见 index.js 的 firstRunGuards）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SETTINGS_FILE = "settings.json";

/** §5.6 六组全量键的默认值。 */
export const DEFAULT_SETTINGS = Object.freeze({
	// 基础
	enableJourney: true,
	enableInjection: false,
	// 总结（flash 钉定：留空跟随宿主）
	summaryProvider: "",
	summaryModel: "",
	summaryTimeoutSec: 30, // 等一份小结多久算超时（秒）：超时即放弃并记 gap；宿主模型慢/渠道排队时调大
	maxConcurrency: 1,
	// 注入与折叠
	injectionTokenBudget: 1200,
	recentN: 8,
	excludeRecentSteps: 2, // 注入时排除最近 N 步的结论（让模型先把刚写的消化完，每步都塞会稀释注意力）
	injectionStepInterval: 1, // 注入间隔步数：=1 每步都塞；=3 每 3 步塞一次（step 差值≥interval 才触发）
	injectionEnableOnStall: true, // 停滞告警时无视 interval 强制注入（安全闸：卡住了必须发警示，不让间隔挡住）
	injectionObjectiveLimit: 3, // 目标区最多注入几条未完成目标（按最近优先）；防只增不减吃穿预算
	injectionDeadEndLimit: 3, // 死胡同区最多注入几条（按最近优先）
	enableMilestoneFold: true,
	// 新颖性
	noveltyMode: "schema-selfcheck",
	embeddingModel: "",
	lexicalThreshold: 0.8, // 词法层 3-gram Jaccard 相似度阈值（novelty.js JACCARD_THRESHOLD 的设置化）；≥该值判词法重复并短路语义层
	// 语义停滞
	stall1Steps: 3,
	stall2Steps: 6,
	stall3Steps: 10,
	enableStall2Deny: false, // 偏离计划书默认 true：enableInjection 首发强制 false 时，true 会触发联动校验错误导致持久化回读被拒；显式开启仍受联动校验
	enableStall2SoftCut: false, // 首发保守钉死：经 cot-anchor 独立服务软切，不经注入投递通道，无需 enableInjection
	enableStall3Reject: false,
	enableLexicalStallCount: false, // 词法重复计入升级（走 stall 计数/escalate，code 派生 lexical-stall-*）；默认关保持原行为：只记账+lexical-repeat
	lexicalStallSteps: 0, // 词法复读独立警告阈值：连续 N 条词法重复发 LEXICAL_STALL 事件（不升级 deny/reject）；0 = 关闭该独立通道
	// 语义停滞 · 墙钟观察（P0-8：独立于总结器的观察水位）
	stallWatchSteps: 3, // 连续 K 个无 text/产物 step
	stallWatchWindowSec: 300, // 且墙钟跨度 ≥ T 秒（默认 5 分钟）才报 stall-1
	// 会话生命周期（P1-12）
	sessionTtlMinutes: 10, // turn/end（或最后事件）后该时长无新事件 → 删除会话并停止写心跳
	// 存储
	storagePath: "",
	retentionDays: 30,
	ledgerRetentionDays: 0, // 主账本保留天数；0 = 不清理主账本（仅归档目录清理）
	// reasoning-only 模型语义沉淀（独立通道，非正式结论）
	enableReasoningJourney: true, // 纯 reasoning step 也提炼推理过程（独立账本/注入分区）；关闭后 reasoning 不入队，观察记录照旧
	reasoningRecentN: 8, // reasoning 通道独立候选窗口大小（与 text recentN 同界）
	reasoningStallWatchSteps: 6, // 连续多少个纯 reasoning step 起算推理停滞
	reasoningStallWatchWindowSec: 300, // 且这些 step 首末墙钟跨度≥该秒数才报 reasoning-stall（相对窗口跨度，不依赖注入开关）
	escapeClosingTags: true,
	// ── 静默中断（计划书 §6 C1–C9，键名与默认值逐字照表）──
	silentAbortAction: "notify", // C1 动作模式（I1 单选）：off/notify/followup/goal-resume；默认 notify（fail-safe，不自动续跑）
	enableSilentAbortWatch: true, // C2 总开关：false 时不注册 turn/end 检测（D7）
	maxAutoResumePerSession: 3, // C3 每会话自动续跑硬顶（G1；跨冷却不重置，真人接管才清零）
	cooldownMs: 15000, // C4 turn/end 后冷却毫秒（G2；绝对墙钟）
	progressMinSteps: 3, // C5 续跑 turn 进展步数（G5；与「≥1 个 tool/call」为 OR）
	errorNoRetryCodes: ["401", "403", "signed-out"], // C6 error 终态禁重试 code 子串清单（D4）
	concludingTextMinLen: 200, // C7 结论性文本长度（D6 仅记录统计，不参与拦截）
	zombieSilentMs: 120000, // C8 B 类僵死静默毫秒（D5；P1 只注册键，检测属 P2）
	zombieAutoAction: false // C9 B 类自动重建总闸（U2 查明前强制 false；P1 无消费方）
});

/** C1 允许的动作模式（I1：互斥穷尽；非法值运行期回退 notify）。 */
export const SILENT_ABORT_ACTIONS = Object.freeze(["off", "notify", "followup", "goal-resume"]);

export const NOVELTY_MODES = ["schema-selfcheck", "embedding", "both", "semantic-only"];

/** 数值键的 [min, max]（schema 与 clamp 同源）。 */
export const NUMBER_BOUNDS = Object.freeze({
	maxConcurrency: [1, 2],
	summaryTimeoutSec: [10, 600], // 秒：下限 10 秒避免误伤，上限 10 分钟
	injectionTokenBudget: [800, 1500],
	recentN: [4, 16],
	excludeRecentSteps: [0, 5], // 0 = 不排除任何最近步（激进）；上限 5
	injectionStepInterval: [1, 20], // 1 = 每步；20 = 每 20 步一次（稀疏）
	injectionObjectiveLimit: [1, 10],
	injectionDeadEndLimit: [1, 10],
	reasoningRecentN: [4, 16],
	stall1Steps: [2, 50],
	stall2Steps: [3, 60],
	stall3Steps: [4, 80],
	stallWatchSteps: [2, 50],
	stallWatchWindowSec: [60, 3600],
	reasoningStallWatchSteps: [2, 50],
	reasoningStallWatchWindowSec: [60, 3600],
	sessionTtlMinutes: [1, 1440],
	retentionDays: [7, 365],
	ledgerRetentionDays: [0, 3650],
	lexicalThreshold: [0.1, 0.95], // 小数键：coerceSetting 仅在 bounds 全整数时 round
	lexicalStallSteps: [0, 50], // 0 = 关闭独立复读警告通道
	cooldownMs: [0, 600000], // C4：允许 0（立即到点）便于测试与紧急工况；上限 10 分钟
	progressMinSteps: [1, 100], // C5：G5 进展步数下限 1
	concludingTextMinLen: [0, 100000], // C7：仅统计，0 关闭统计口径
	zombieSilentMs: [1000, 3600000], // C8：B 类僵死静默毫秒（P1 未消费，先定界）
	maxAutoResumePerSession: [1, 10] // C3：自然数硬顶，上限 10 防失控
});

/** 设置 schema（控件形态与宿主 L1 路由一致：key/label/type/min/max/group/hint）。 */
export const SETTINGS_SCHEMA = Object.freeze([
	{ key: "enableJourney", label: "开启会话观察与记录", type: "boolean", group: "总开关", hint: "总开关：记录这个会话里 AI 每一步在做什么。关闭后既不观察也不保存任何记录。" },
	{ key: "enableInjection", label: "把阶段小结自动塞回对话", type: "boolean", group: "总开关", hint: "需要先开启上一项；默认关闭，建议先观察一段时间再打开。" },
	{ key: "summaryProvider", label: "小结由哪个服务商生成（留空＝跟着当前会话）", type: "text", group: "生成小结", hint: "一般留空，等于你此刻用什么服务商、它就用同一个。只有当侧栏刷「总结跳过：无可用模型路由」时才需要指定。" },
	{ key: "summaryModel", label: "小结用哪个模型生成（留空＝跟着当前会话）", type: "text", group: "生成小结", hint: "留空＝沿用你此刻的模型。想让记录更省，可改填一个更小更快的模型；改填后小结走这个模型，不影响你正在用的对话。" },
	{ key: "summaryTimeoutSec", label: "等一份小结多久算超时（秒）", type: "number", min: 10, max: 600, group: "生成小结", hint: "默认 30 秒。时间一到还没写完就放弃这次总结，侧栏记一条「总结跳过：调用超时」。老是刷这条，说明这个模型太慢或渠道在排队：调大（比如 60）能救回一部分，换个更快的模型更彻底。注意：只影响生成小结，不会打断你当前的对话。" },
	{ key: "maxConcurrency", label: "同时生成几份小结", type: "number", min: 1, max: 2, group: "生成小结", hint: "默认 1（一次只做一份），最多 2。" },
	{ key: "enableReasoningJourney", label: "提炼模型的思考过程（仅推理模型）", type: "boolean", group: "生成小结", hint: "对只产出思考块、从不输出正式结论的模型，单独提炼其推理中的决策、假设、自我修正与计划。这些内容会标注为「非正式结论」，单独存放、单独分区展示，不会当成已确认事实。关闭后只保留观察记录，不提炼推理。" },
	{ key: "reasoningRecentN", label: "思考过程提炼时参考最近几步推理", type: "number", min: 4, max: 16, group: "生成小结", hint: "推理提炼去重时只回看最近这几条推理记录，与正式结论的条数互不影响。" },
	{ key: "injectionTokenBudget", label: "每次塞回上下文的小结字数上限", type: "number", min: 800, max: 1500, group: "塞回上下文", hint: "默认 1200 字，可调范围 800~1500。" },
	{ key: "recentN", label: "每次保留最近几条小结", type: "number", min: 4, max: 16, group: "塞回上下文", hint: "塞回上下文时只取最近这几条，同时也是折叠旧内容的分界线。计划类条目只在顶部目标区展示，这里只放有推进意义的结论。" },
	{ key: "excludeRecentSteps", label: "注入时排除最近几步的新结论", type: "number", min: 0, max: 5, group: "塞回上下文", hint: "把刚写完的结论先让模型自己消化一会儿，不立刻塞回去。默认排除最近 2 步；设 0 等于把所有已总结的都塞回（激进，容易注意力稀释）。" },
	{ key: "injectionStepInterval", label: "每隔多少步塞一次", type: "number", min: 1, max: 20, group: "塞回上下文", hint: "默认 1 = 每步都塞。调大到 3 或 5 让注入稀疏一点：模型跑了好几步之后才回头看阶段小结，不会每步都被打扰。注意：停滞告警触发时会无视这个间隔强制注入。" },
	{ key: "injectionEnableOnStall", label: "停滞告警时无视间隔强制注入", type: "boolean", group: "塞回上下文", hint: "默认开：哪怕间隔还没到，只要检测到停滞（stall 1/2/3 任意一级），就强制注入警示 + 小结。卡住了必须发信号，不能让间隔挡住。" },
	{ key: "injectionObjectiveLimit", label: "最多注入几条未完成目标", type: "number", min: 1, max: 10, group: "塞回上下文", hint: "默认 3，只取最近的目标，更早的只在标题里报数量。目标若永不剔除，会随会话无限累积并把预算吃穿，导致每一步都注入跳过。" },
	{ key: "injectionDeadEndLimit", label: "最多注入几条死胡同", type: "number", min: 1, max: 10, group: "塞回上下文", hint: "默认 3，按最近优先；更早的只在标题里报数量，避免历史死胡同挤占预算。" },
	{ key: "enableMilestoneFold", label: "小结攒太多时自动折叠旧内容", type: "boolean", group: "塞回上下文", hint: "条数超过上面那个数字的 3 倍时，把最旧的一批折叠起来。" },
	{ key: "noveltyMode", label: "判断内容有没有新意的算法", type: "select", group: "判断新旧内容",
		options: [
			{ value: "schema-selfcheck", label: "结构检查（默认，最快最省）" },
			{ value: "embedding", label: "语义相似度（更准，需要向量模型）" },
			{ value: "both", label: "结构检查 + 语义相似度（最准，稍慢）" },
			{ value: "semantic-only", label: "纯语义（跳过词法层，逐字复读也做语义判定）" }
		],
		hint: "默认选第一种；语义相似度不可用时会自动退回第一种。" },
	{ key: "embeddingModel", label: "算语义相似度用的向量模型（留空＝跟随当前会话）", type: "text", group: "判断新旧内容", hint: "相似度阈值 0.85；没有可用向量模型时自动退回结构检查。" },
	{ key: "lexicalThreshold", label: "词法重复判定阈值（3-gram 相似度）", type: "number", min: 0.1, max: 0.95, group: "判断新旧内容", hint: "与最近可见文本的 3-gram Jaccard 相似度达到该值时判为词法重复并短路语义判定；越小越容易被判重复。" },
	{ key: "stall1Steps", label: "轻微停滞：连续几步没产出算一级", type: "number", min: 2, max: 50, group: "发现卡死", hint: "这个数字必须小于二级阈值。" },
	{ key: "stall2Steps", label: "中度停滞：连续几步没产出算二级", type: "number", min: 3, max: 60, group: "发现卡死", hint: "这个数字必须小于三级阈值。" },
	{ key: "stall3Steps", label: "重度停滞：连续几步没产出算三级", type: "number", min: 4, max: 80, group: "发现卡死", hint: "最高级别。默认不会直接终止，只告警并写下交接说明。" },
	{ key: "enableStall2Deny", label: "二级停滞时禁止再读文件/调工具", type: "boolean", group: "发现卡死", hint: "需要先开启「把阶段小结自动塞回对话」；这项拦截能力尚未完全上线时只提醒不拦。" },
	{ key: "enableStall2SoftCut", label: "二级停滞时请求思维锚点软切", type: "boolean", group: "发现卡死", hint: "经 dsh-cot-anchor 的软切在生成边界中断重复生成；不要求开启「把阶段小结自动塞回对话」（走独立插件服务，不经注入通道）；需 dsh-cot-anchor 已加载，并在其设置中开启「允许外部插件请求软切」。" },
	{ key: "enableStall3Reject", label: "三级停滞时直接终止这一轮", type: "boolean", group: "发现卡死", hint: "需要先开启「把阶段小结自动塞回对话」；默认关闭，只告警并写下交接说明。" },
	{ key: "enableLexicalStallCount", label: "词法复读也计入停滞升级", type: "boolean", group: "发现卡死", hint: "开启后，逐字/近逐字复读也会累计进停滞计数并触发二/三级升级（code 为 lexical-stall-*）；默认关闭保持原行为：只记一次词法重复事件不升级。" },
	{ key: "lexicalStallSteps", label: "连续多少条词法复读发独立警告", type: "number", min: 0, max: 50, group: "发现卡死", hint: "连续 N 条词法重复（复读机）发一条词法复读停滞警告，不升级、不拦截；填 0 关闭该独立通道。" },
	{ key: "stallWatchSteps", label: "卡住多久开始计时：连续几步没产出", type: "number", min: 2, max: 50, group: "发现卡死", hint: "连续这么几步既没说话也没有产出，就开始看墙钟时间。" },
	{ key: "stallWatchWindowSec", label: "卡住多久算停滞（秒）", type: "number", min: 60, max: 3600, group: "发现卡死", hint: "没有任何产出的时间跨过这个秒数，就判定为一级停滞。" },
	{ key: "reasoningStallWatchSteps", label: "光思考不产出：连续几步只在推理", type: "number", min: 2, max: 50, group: "发现卡死", hint: "模型连续这么多步只有思考块、既不输出结论也不调工具时，开始看墙钟时间；仅提示，不会触发二/三级拦截。" },
	{ key: "reasoningStallWatchWindowSec", label: "光思考不产出持续多久算停滞（秒）", type: "number", min: 60, max: 3600, group: "发现卡死", hint: "口径为窗口内首个与最近一个纯推理 step 的相对墙钟跨度；跨过该秒数才发一次推理停滞提示，与自动塞回小结开关无关。" },
	{ key: "sessionTtlMinutes", label: "会话多久没动静就清理（分钟）", type: "number", min: 1, max: 1440, group: "发现卡死", hint: "一轮回答结束（或最后一个动作）之后，这么长时间没有任何新动作就清掉这个会话的记录。" },
	{ key: "storagePath", label: "记录文件存放目录（留空＝用默认位置）", type: "text", group: "文件存放", hint: "默认存在 ~/.dsh/storages/semantic-watcher。" },
	{ key: "retentionDays", label: "归档文件保留天数", type: "number", min: 7, max: 365, group: "文件存放", hint: "只清理归档目录，不动里程碑记录。" },
	{ key: "ledgerRetentionDays", label: "完整会话记录保留天数", type: "number", min: 0, max: 3650, group: "文件存放", hint: "填 0 表示永不清理完整记录，只清归档。" },
	{ key: "escapeClosingTags", label: "自动转义尖括号结尾", type: "boolean", group: "文件存放", hint: "写入前把参数、函数结束符转义，读取时还原。" },
	{ key: "silentAbortAction", label: "静默中断动作模式", type: "select", group: "静默中断",
		options: [
			{ value: "off", label: "关闭（不检测）" },
			{ value: "notify", label: "仅告警（默认，不自动续跑）" },
			{ value: "followup", label: "自动续跑（原窗口 followup）" },
			{ value: "goal-resume", label: "目标优先续跑（goal-resume，回退 followup）" }
		],
		hint: "回合被步限/上限/错误打断且没有面向用户的结论时怎么办。默认只告警不自动续跑（fail-safe）；要自动续跑请显式切到后两档。" },
	{ key: "enableSilentAbortWatch", label: "开启静默中断检测", type: "boolean", group: "静默中断", hint: "总开关：关闭后不监听回合结束事件、完全不检测。动作模式选「关闭」即可既不检测也不告警。" },
	{ key: "maxAutoResumePerSession", label: "每个会话最多自动续跑几次", type: "number", min: 1, max: 10, group: "静默中断", hint: "默认 3 次；次数跨冷却不重置，只有你亲自发消息接管后才清零。用尽后升级为人工处理。" },
	{ key: "cooldownMs", label: "回合结束后等多久再介入（毫秒）", type: "number", min: 0, max: 600000, group: "静默中断", hint: "默认 15000 毫秒（15 秒）：给真人和其他插件让位；等待期间出现新回合或真人消息就放弃介入。" },
	{ key: "progressMinSteps", label: "续跑后几步内没进展就升级（步数）", type: "number", min: 1, max: 100, group: "静默中断", hint: "默认 3 步；续跑的新回合内步数达到该值、或至少调用了 1 次工具，才算有进展；两者都不满足就升级人工。" },
	{ key: "errorNoRetryCodes", label: "错误码命中即不自动续跑（逗号分隔）", type: "text", group: "静默中断", hint: "运行时错误以错误收尾时，错误码包含清单中任一子串（如鉴权类 401/403/signed-out）就只告警不重试；默认 401,403,signed-out。" },
	{ key: "concludingTextMinLen", label: "结论性文本统计阈值（字符）", type: "number", min: 0, max: 100000, group: "静默中断", hint: "默认 200 字符；仅用于事件里记录「末条消息是否达到结论性长度」，不参与任何拦截判定。" },
	{ key: "zombieSilentMs", label: "会话僵死判定静默时长（毫秒）", type: "number", min: 1000, max: 3600000, group: "静默中断", hint: "默认 120000 毫秒（2 分钟）；当前版本只保留设置，僵死检测与自动重建属下一阶段。" },
	{ key: "zombieAutoAction", label: "允许僵死自动重建（下一阶段）", type: "boolean", group: "静默中断", hint: "默认关闭；僵死自动重建能力尚未实现，当前开启也不会产生任何动作。" }
]);

function isPlainObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** C6 数组键（errorNoRetryCodes）：数组原样过滤；字符串按分隔符拆分；空结果/其余回退默认（防误清空保护清单）。 */
function coerceStringList(raw, fallback) {
	const parts = Array.isArray(raw)
		? raw
		: typeof raw === "string" ? raw.split(/[,，;；\s]+/) : null;
	if (parts === null) return [...fallback];
	const cleaned = parts.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
	return cleaned.length > 0 ? cleaned : [...fallback];
}

/**
 * 单键收敛：返回 { value, warnings[] }。非法回退默认；数值越界 clamp 到边界。
 */
export function coerceSetting(key, raw) {
	const def = DEFAULT_SETTINGS[key];
	const warnings = [];
	if (key === "errorNoRetryCodes") {
		return { value: coerceStringList(raw, def), warnings };
	}
	if (key === "silentAbortAction") {
		if (typeof raw === "string" && SILENT_ABORT_ACTIONS.includes(raw)) return { value: raw, warnings };
		if (raw === undefined || raw === null) return { value: def, warnings };
		warnings.push(`${key}: 非法值 ${JSON.stringify(raw)}，回退 ${def}`);
		return { value: def, warnings };
	}
	if (key in NUMBER_BOUNDS) {
		let n = typeof raw === "boolean" ? NaN : Number(raw);
		const [bmin, bmax] = NUMBER_BOUNDS[key];
		if (Number.isInteger(bmin) && Number.isInteger(bmax)) n = Math.round(n);
		if (!Number.isFinite(n)) {
			warnings.push(`${key}: 非法数值 ${JSON.stringify(raw)}，回退默认 ${def}`);
			return { value: def, warnings };
		}
		const [min, max] = NUMBER_BOUNDS[key];
		if (n < min) { warnings.push(`${key}: ${n} 低于下界，clamp 到 ${min}`); n = min; }
		if (n > max) { warnings.push(`${key}: ${n} 高于上界，clamp 到 ${max}`); n = max; }
		return { value: n, warnings };
	}
	if (typeof def === "boolean") {
		if (raw === undefined || raw === null || raw === "") return { value: def, warnings };
		return { value: raw === true || raw === "true", warnings };
	}
	// text：空串合法（summaryProvider/Model/storagePath/embeddingModel 均可为空）
	const s = raw === undefined || raw === null ? def : String(raw).trim();
	return { value: s, warnings };
}

/**
 * 校验联动与阈值倒挂。返回 { errors[], warnings[] }；errors 非空 → 拒绝保存。
 */
export function validateSettings(s) {
	const errors = [];
	const warnings = [];
	if (s.enableInjection && !s.enableJourney) {
		errors.push("联动违规：enableInjection=true 需要 enableJourney=true");
	}
	if (s.enableStall2Deny && !s.enableInjection) {
		errors.push("联动违规：enableStall2Deny=true 需要 enableInjection=true");
	}
	if (s.enableStall3Reject && !s.enableInjection) {
		errors.push("联动违规：enableStall3Reject=true 需要 enableInjection=true");
	}
	if (!(s.stall1Steps < s.stall2Steps && s.stall2Steps < s.stall3Steps)) {
		errors.push(`阈值倒挂：必须严格递增 stall1Steps(${s.stall1Steps}) < stall2Steps(${s.stall2Steps}) < stall3Steps(${s.stall3Steps})`);
	}
	if (!NOVELTY_MODES.includes(s.noveltyMode)) {
		warnings.push(`noveltyMode 非法值 ${JSON.stringify(s.noveltyMode)}，回退 schema-selfcheck`);
	}
	if (!SILENT_ABORT_ACTIONS.includes(s.silentAbortAction)) {
		warnings.push(`silentAbortAction 非法值 ${JSON.stringify(s.silentAbortAction)}，回退 notify`);
	}
	if (s.zombieAutoAction === true) {
		warnings.push("zombieAutoAction=true 当前版本不生效：僵死自动重建属下一阶段（U2 未查明前强制 false）");
	}
	return { errors, warnings };
}

/**
 * 合并运行时设置：current 为基准，incoming 为部分更新。
 * 返回 { settings, errors, warnings }；errors 非空时 settings 保持 current（调用方拒绝保存）。
 */
export function applyRuntimeSettings(current, incoming) {
	const base = isPlainObject(current) ? current : { ...DEFAULT_SETTINGS };
	const inc = isPlainObject(incoming) ? incoming : {};
	const warnings = [];
	const next = { ...base };
	for (const { key } of SETTINGS_SCHEMA) {
		if (!(key in inc)) continue;
		const r = coerceSetting(key, inc[key]);
		warnings.push(...r.warnings);
		next[key] = r.value;
	}
	if (!NOVELTY_MODES.includes(next.noveltyMode)) next.noveltyMode = "schema-selfcheck";
	const { errors, warnings: linkWarnings } = validateSettings(next);
	warnings.push(...linkWarnings);
	if (errors.length > 0) return { settings: { ...base }, errors, warnings };
	return { settings: next, errors, warnings };
}

/** 首发强制态（§5.6：schema 默认值≠首发态时由这里钉定）。 */
export function firstRunGuards(settings) {
	const s = { ...settings };
	// HTTP 层约束下无合法注入渠道（enableInjection 实际恒 false），等价于直接钉死 false；
	// 显式开启由用户后续通过设置页改写，链路见 validateSettings 联动校验。
	s.enableInjection = false; // 首发 P3 默认关
	s.enableStall3Reject = false; // 首发 P4 默认关（验收流程开启）
	s.enableStall2SoftCut = false; // 首发保守钉死：经 cot-anchor 独立服务软切，验收流程再开启
	return s;
}

/** 持久化存储。load 返回 null 表示损坏/缺失（调用方回退默认并告警）。 */
export function makeSettingsStore(dir, fsImpl = { readFileSync, writeFileSync, mkdirSync: (p, o) => mkdirSync(p, o) }) {
	const path = join(dir, SETTINGS_FILE);
	return {
		path,
		load() {
			try {
				const parsed = JSON.parse(fsImpl.readFileSync(path, "utf8"));
				if (!isPlainObject(parsed)) return null;
				const { settings, warnings } = applyRuntimeSettings(DEFAULT_SETTINGS, parsed);
				return { settings, warnings };
			} catch {
				return null;
			}
		},
		save(settings) {
			fsImpl.mkdirSync(dir, { recursive: true });
			fsImpl.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
			return path;
		}
	};
}
