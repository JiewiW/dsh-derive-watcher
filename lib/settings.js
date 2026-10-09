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
	// 存储
	storagePath: "",
	retentionDays: 30,
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
	retentionDays: [7, 365]
});

/** 设置 schema（控件形态与宿主 L1 路由一致：key/label/type/min/max/group/hint）。 */
export const SETTINGS_SCHEMA = Object.freeze([
	{ key: "enableJourney", label: "启用语义旅程账本", type: "boolean", group: "基础", hint: "总开关；关闭后不观察、不落账" },
	{ key: "enableInjection", label: "启用上下文注入", type: "boolean", group: "基础", hint: "需要 enableJourney=true；默认关闭" },
	{ key: "summaryProvider", label: "总结 provider（留空跟随宿主）", type: "text", group: "总结", hint: "flash 钉定：建议留空跟随会话" },
	{ key: "summaryModel", label: "总结 model（留空跟随宿主）", type: "text", group: "总结", hint: "flash 档模型" },
	{ key: "maxConcurrency", label: "总结并发闸", type: "number", min: 1, max: 2, group: "总结", hint: "默认 1，上限 2" },
	{ key: "injectionTokenBudget", label: "注入 token 预算", type: "number", min: 800, max: 1500, group: "注入与折叠", hint: "默认 1200" },
	{ key: "recentN", label: "最近保留条数 N", type: "number", min: 4, max: 16, group: "注入与折叠", hint: "注入最近 N 条 summary；折叠保留界" },
	{ key: "enableMilestoneFold", label: "启用里程碑折叠", type: "boolean", group: "注入与折叠", hint: "entry 数超过 N×3 时折叠最旧一批" },
	{ key: "noveltyMode", label: "新颖性判定模式", type: "text", group: "新颖性", hint: "schema-selfcheck | embedding | both；embedding 不可用时回退 selfcheck" },
	{ key: "embeddingModel", label: "embedding 模型（留空跟随宿主）", type: "text", group: "新颖性", hint: "余弦阈 0.85；无能力自动回退" },
	{ key: "stall1Steps", label: "stall-1 阈值", type: "number", min: 2, max: 50, group: "语义停滞", hint: "须严格小于 stall2Steps" },
	{ key: "stall2Steps", label: "stall-2 阈值", type: "number", min: 3, max: 60, group: "语义停滞", hint: "须严格小于 stall3Steps" },
	{ key: "stall3Steps", label: "stall-3 阈值", type: "number", min: 4, max: 80, group: "语义停滞", hint: "最高级；enableStall3Reject 默认 false 只告警" },
	{ key: "enableStall2Deny", label: "stall-2 拒读工具类", type: "boolean", group: "语义停滞", hint: "需 enableInjection=true；L2 未就位时 fail-open 仅注入" },
	{ key: "enableStall3Reject", label: "stall-3 硬终止", type: "boolean", group: "语义停滞", hint: "需 enableInjection=true；默认 false 只告警+写交接" },
	{ key: "storagePath", label: "账本根目录（留空用默认）", type: "text", group: "存储", hint: "默认 ~/.dsh/storages/semantic-watcher" },
	{ key: "retentionDays", label: "归档保留天数", type: "number", min: 7, max: 365, group: "存储", hint: "清理仅作用于归档；里程碑与主账本不清理" },
	{ key: "escapeClosingTags", label: "闭标签转写", type: "boolean", group: "存储", hint: "参数/函数结束符写入前转写、读取还原" }
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
	s.enableInjection = s.enableInjection === true && s.enableJourney === true ? false : false; // 首发 P3 默认关
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
