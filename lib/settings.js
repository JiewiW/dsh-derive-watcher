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
	maxConcurrency: 1,
	// 注入与折叠
	injectionTokenBudget: 1200,
	recentN: 8,
	enableMilestoneFold: true,
	// 新颖性
	noveltyMode: "schema-selfcheck",
	embeddingModel: "",
	// 语义停滞
	stall1Steps: 3,
	stall2Steps: 6,
	stall3Steps: 10,
	enableStall2Deny: false, // 偏离计划书默认 true：enableInjection 首发强制 false 时，true 会触发联动校验错误导致持久化回读被拒；显式开启仍受联动校验
	enableStall3Reject: false,
	// 语义停滞 · 墙钟观察（P0-8：独立于总结器的观察水位）
	stallWatchSteps: 3, // 连续 K 个无 text/产物 step
	stallWatchWindowSec: 300, // 且墙钟跨度 ≥ T 秒（默认 5 分钟）才报 stall-1
	// 会话生命周期（P1-12）
	sessionTtlMinutes: 10, // turn/end（或最后事件）后该时长无新事件 → 删除会话并停止写心跳
	// 存储
	storagePath: "",
	retentionDays: 30,
	ledgerRetentionDays: 0, // 主账本保留天数；0 = 不清理主账本（仅归档目录清理）
	escapeClosingTags: true
});

export const NOVELTY_MODES = ["schema-selfcheck", "embedding", "both"];

/** 数值键的 [min, max]（schema 与 clamp 同源）。 */
export const NUMBER_BOUNDS = Object.freeze({
	maxConcurrency: [1, 2],
	injectionTokenBudget: [800, 1500],
	recentN: [4, 16],
	stall1Steps: [2, 50],
	stall2Steps: [3, 60],
	stall3Steps: [4, 80],
	stallWatchSteps: [2, 50],
	stallWatchWindowSec: [60, 3600],
	sessionTtlMinutes: [1, 1440],
	retentionDays: [7, 365],
	ledgerRetentionDays: [0, 3650]
});

/** 设置 schema（控件形态与宿主 L1 路由一致：key/label/type/min/max/group/hint）。 */
export const SETTINGS_SCHEMA = Object.freeze([
	{ key: "enableJourney", label: "开启会话观察与记录", type: "boolean", group: "总开关", hint: "总开关：记录这个会话里 AI 每一步在做什么。关闭后既不观察也不保存任何记录。" },
	{ key: "enableInjection", label: "把阶段小结自动塞回对话", type: "boolean", group: "总开关", hint: "需要先开启上一项；默认关闭，建议先观察一段时间再打开。" },
	{ key: "summaryProvider", label: "生成小结用的大模型服务商（留空＝跟随当前会话）", type: "text", group: "生成小结", hint: "一般不用填，留空就沿用你现在用的服务商。" },
	{ key: "summaryModel", label: "生成小结用的模型（留空＝跟随当前会话）", type: "text", group: "生成小结", hint: "留空＝沿用当前会话的模型；想省 token 可单独指定更小的模型。" },
	{ key: "maxConcurrency", label: "同时生成几份小结", type: "number", min: 1, max: 2, group: "生成小结", hint: "默认 1（一次只做一份），最多 2。" },
	{ key: "injectionTokenBudget", label: "每次塞回上下文的小结字数上限", type: "number", min: 800, max: 1500, group: "塞回上下文", hint: "默认 1200 字，可调范围 800~1500。" },
	{ key: "recentN", label: "每次保留最近几条小结", type: "number", min: 4, max: 16, group: "塞回上下文", hint: "塞回上下文时只取最近这几条，同时也是折叠旧内容的分界线。" },
	{ key: "enableMilestoneFold", label: "小结攒太多时自动折叠旧内容", type: "boolean", group: "塞回上下文", hint: "条数超过上面那个数字的 3 倍时，把最旧的一批折叠起来。" },
	{ key: "noveltyMode", label: "判断内容有没有新意的算法", type: "select", group: "判断新旧内容",
		options: [
			{ value: "schema-selfcheck", label: "结构检查（默认，最快最省）" },
			{ value: "embedding", label: "语义相似度（更准，需要向量模型）" },
			{ value: "both", label: "结构检查 + 语义相似度（最准，稍慢）" }
		],
		hint: "默认选第一种；语义相似度不可用时会自动退回第一种。" },
	{ key: "embeddingModel", label: "算语义相似度用的向量模型（留空＝跟随当前会话）", type: "text", group: "判断新旧内容", hint: "相似度阈值 0.85；没有可用向量模型时自动退回结构检查。" },
	{ key: "stall1Steps", label: "轻微停滞：连续几步没产出算一级", type: "number", min: 2, max: 50, group: "发现卡死", hint: "这个数字必须小于二级阈值。" },
	{ key: "stall2Steps", label: "中度停滞：连续几步没产出算二级", type: "number", min: 3, max: 60, group: "发现卡死", hint: "这个数字必须小于三级阈值。" },
	{ key: "stall3Steps", label: "重度停滞：连续几步没产出算三级", type: "number", min: 4, max: 80, group: "发现卡死", hint: "最高级别。默认不会直接终止，只告警并写下交接说明。" },
	{ key: "enableStall2Deny", label: "二级停滞时禁止再读文件/调工具", type: "boolean", group: "发现卡死", hint: "需要先开启「把阶段小结自动塞回对话」；这项拦截能力尚未完全上线时只提醒不拦。" },
	{ key: "enableStall3Reject", label: "三级停滞时直接终止这一轮", type: "boolean", group: "发现卡死", hint: "需要先开启「把阶段小结自动塞回对话」；默认关闭，只告警并写下交接说明。" },
	{ key: "stallWatchSteps", label: "卡住多久开始计时：连续几步没产出", type: "number", min: 2, max: 50, group: "发现卡死", hint: "连续这么几步既没说话也没有产出，就开始看墙钟时间。" },
	{ key: "stallWatchWindowSec", label: "卡住多久算停滞（秒）", type: "number", min: 60, max: 3600, group: "发现卡死", hint: "没有任何产出的时间跨过这个秒数，就判定为一级停滞。" },
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
		let n = typeof raw === "boolean" ? NaN : Math.round(Number(raw));
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
