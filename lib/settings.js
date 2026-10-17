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
	escapeClosingTags: true
});

export const NOVELTY_MODES = ["schema-selfcheck", "embedding", "both", "semantic-only"];

/** 数值键的 [min, max]（schema 与 clamp 同源）。 */
export const NUMBER_BOUNDS = Object.freeze({
	maxConcurrency: [1, 2],
	summaryTimeoutSec: [10, 600], // 秒：下限 10 秒避免误伤，上限 10 分钟
	injectionTokenBudget: [800, 1500],
	recentN: [4, 16],
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
	lexicalStallSteps: [0, 50] // 0 = 关闭独立复读警告通道
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
	{ key: "escapeClosingTags", label: "自动转义尖括号结尾", type: "boolean", group: "文件存放", hint: "写入前把参数、函数结束符转义，读取时还原。" }
]);

function isPlainObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * 单键收敛：返回 { value, warnings[] }。非法回退默认；数值越界 clamp 到边界。
 */
export function coerceSetting(key, raw) {
	const def = DEFAULT_SETTINGS[key];
	const warnings = [];
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
