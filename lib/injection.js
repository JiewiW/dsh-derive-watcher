/**
 * dsh-derive-watcher — 上下文注入组装（计划书 §5.4）。纯函数，无 IO。
 *
 * 组装顺序（自上而下）：open objectives（置顶，永不剔除）→ 里程碑（正文可句界裁剪）
 *   → 最近 N 条 summary（排除最近 1–3 步结论；预算不足时整条剔除最旧）
 *   → dead-end 标题行（永不剔除）。
 * 裁剪纪律：只允许「句界裁剪里程碑正文」与「整条剔除」，禁止截断单条中间。
 * 水位落后（当前 step 的上一 step 尚未总结）时头部带 latestSummarized:false 警示，
 * 不用陈旧 entry 冒充最新进展。
 * 组装后结构校验（围栏配平、无残留转写记号、括号配平）；失败 → ok:false，
 * 调用方发 semantic-watcher/injection-skipped（含 suppressReason）。
 */
import { estimateTokens, trimToSentence } from "./textutil.js";
import { hasTranscriptionMarker } from "./journey-store.js";

/** 排除最近 1–3 步结论；默认 2（处于 1–3 区间内）。 */
export const EXCLUDE_RECENT_STEPS_DEFAULT = 2;

/**
 * 步骤5：reasoning 分区独立子预算占总 injectionTokenBudget 的上限（40%）。
 * reasoning 超长只在本分区内整条裁剪，绝不挤占上方正式结论分区；
 * 正式结论分区始终按完整 tokenBudget 独立组装（reasoning 为空时输出与改造前字节级一致）。
 */
export const REASONING_BUDGET_RATIO = 0.4;

/** reasoning 独立分区标题（固定标注串：显式声明非正式结论，禁止当作已确认事实引用）。 */
export const REASONING_SECTION_TITLE = "◆ 以下为模型推理过程提炼，非正式结论，不得作为已确认事实引用";

/**
 * open objectives：kind 为 plan/hypothesis、未被任何存活条目的 supersedes 链取代、
 * 且未被里程碑 covers 沉淀的条目。新→旧排序。
 */
export function collectOpenObjectives(entries, milestones = []) {
	const all = [...(milestones ?? []), ...(entries ?? [])];
	const superseded = new Set();
	for (const e of all) for (const s of e?.supersedes ?? []) superseded.add(s);
	const covered = new Set();
	for (const m of milestones ?? []) for (const c of m?.covers ?? []) covered.add(c);
	const sorted = [...(entries ?? [])].sort((a, b) => (b.step ?? -1) - (a.step ?? -1));
	return sorted.filter((e) =>
		e && (e.kind === "plan" || e.kind === "hypothesis") &&
		!superseded.has(e.id) && !covered.has(e.id));
}

/**
 * 单条文本净化：去除残留转写记号与围栏记号（防结构校验误伤），
 * ASCII 括号/方括号换全角（不损失语义，保证组装后括号配平可静态判定）。
 */
export function sanitizeEntryText(s) {
	if (typeof s !== "string") return "";
	return s
		.replace(/<SLASH_[A-Z0-9_]+_ESCAPED>/g, "")
		.replace(/\(/g, "（").replace(/\)/g, "）")
		.replace(/\[/g, "【").replace(/\]/g, "】")
		.replace(/`{3,}/g, "(代码块)") // 围栏记号最后替换：避免占位符被括号全角化吞掉
		.trim();
}

/** 组装后结构校验（§5.4）：围栏配平、无残留转写记号、ASCII 括号配平。 */
export function validateAssembledText(text) {
	const problems = [];
	if (typeof text !== "string" || text.trim() === "") return { ok: false, problems: ["文本为空"] };
	if (hasTranscriptionMarker(text)) problems.push("残留转写记号");
	const fences = (text.match(/```/g) ?? []).length;
	if (fences % 2 !== 0) problems.push(`代码围栏不配平（${fences} 个 \`\`\`）`);
	for (const [open, close, name] of [["(", ")", "圆括号"], ["{", "}", "花括号"]]) {
		let bal = 0;
		for (const ch of text) { if (ch === open) bal++; else if (ch === close) bal--; }
		if (bal !== 0) problems.push(`${name}不配平（净值 ${bal}）`);
	}
	for (const [open, close, name] of [["（", "）", "全角圆括号"], ["【", "】", "全角方括号"]]) {
		const o = (text.match(new RegExp(open, "gu")) ?? []).length;
		const c = (text.match(new RegExp(close, "gu")) ?? []).length;
		if (o !== c) problems.push(`${name}不配平（开 ${o} 闭 ${c}）`);
	}
	return { ok: problems.length === 0, problems };
}

/**
 * 目标区/死胡同区默认只注入最近 N 条。
 * 这两类旧口径「永不剔除」会让未完成目标集合只增不减：单是标题行就能吃穿预算，
 * 触发持续注入跳过。改为按「最近」保留，超出的只在标题行里报数量。
 */
export const OBJECTIVE_LIMIT_DEFAULT = 3;
export const DEAD_END_LIMIT_DEFAULT = 3;

/** 计划/假设只在目标区展示；结论区不再重复占位，让位给真正推进过的结论。 */
const PLAN_KINDS = new Set(["plan", "hypothesis"]);

/** 降级模式下单条摘要压到的字符上限（仍在句界内截断）。 */
const COMPACT_SUMMARY_CHARS = 60;

/** 上限收敛：整数、夹在 [1,10]，非法回退默认。 */
function clampLimit(value, fallback) {
	const n = Math.trunc(Number(value));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(10, Math.max(1, n));
}

/** 复读条目（novelty=duplicate 或语义重复）不携带新信息，不参与注入。 */
function isDuplicateEntry(e) {
	return e?.novelty === "duplicate" || e?.semantic_duplicate === true;
}

/** 有实际意义的条目：非复读、摘要不是空壳。 */
function isMeaningfulEntry(e) {
	const s = typeof e?.summary === "string" ? e.summary.trim() : "";
	return s.length >= 4 && !isDuplicateEntry(e);
}

/** 收集已被任何存活条目/里程碑取代的 id（被取代的旧计划不再当结论注入）。 */
function collectSupersededIds(entries, milestones) {
	const superseded = new Set();
	for (const e of [...(entries ?? []), ...(milestones ?? [])]) {
		for (const s of e?.supersedes ?? []) superseded.add(s);
	}
	return superseded;
}

/** 句界压短；没有可用句界时按字符硬截并加省略号（仅降级模式使用）。 */
function shrinkSummary(summary, maxChars) {
	if (typeof summary !== "string" || summary.length <= maxChars) return summary;
	const cut = trimToSentence(summary, maxChars);
	if (cut) return cut;
	return summary.slice(0, maxChars) + "…";
}

const lineOfSummary = (e, tag, summary) =>
	`- ${e.id} [${tag}${e.kind ? "·" + e.kind : ""}] (turn=${e.turn ?? "-"} step=${e.step ?? "-"}) ${summary}`;

const lineOf = (e, tag) => lineOfSummary(e, tag, e.summary);

/**
 * 正式结论分区组装（text 通道）。返回：
 *   { ok:true, text, tokenEstimate, latestSummarized, degraded, dropped, trimmed, sections }
 *   { ok:false, suppressReason, dropped, trimmed }
 * 预算裁剪顺序：里程碑正文句界裁剪 → 整条剔除最旧结论（保留最新 1 条）
 *   → 目标区收缩到 1 条 → 死胡同收缩到 1 条 → 摘要压缩为短句（degraded）。
 * 只有「连一条压缩后的要点行都放不下」才返回 ok:false。
 */
function buildTextSection({
	entries = [], milestones = [], watermark = null,
	currentTurn = null, currentStep = null,
	excludeRecentSteps = EXCLUDE_RECENT_STEPS_DEFAULT,
	recentN = 8, tokenBudget = 1200,
	objectiveLimit = OBJECTIVE_LIMIT_DEFAULT,
	deadEndLimit = DEAD_END_LIMIT_DEFAULT
} = {}) {
	const dropped = [];
	const trimmed = [];

	const clean = [];
	for (const e of entries ?? []) {
		if (!e || typeof e.summary !== "string") continue;
		const s = sanitizeEntryText(e.summary);
		if (!s) { dropped.push(e.id ?? null); continue; }
		clean.push({ ...e, summary: s, detail: sanitizeEntryText(e.detail) });
	}
	const miles = [];
	for (const m of milestones ?? []) {
		if (!m || typeof m.summary !== "string") continue;
		const s = sanitizeEntryText(m.summary);
		if (!s) { dropped.push(m.id ?? null); continue; }
		miles.push({ ...m, summary: s, detail: sanitizeEntryText(m.detail) });
	}

	const supersededIds = collectSupersededIds(clean, miles);
	// 目标与死胡同都只保留最近 N 条：未完成目标集合不再无界增长。
	const allObjectives = collectOpenObjectives(clean, miles).filter(isMeaningfulEntry);
	const objectives = allObjectives.slice(0, clampLimit(objectiveLimit, OBJECTIVE_LIMIT_DEFAULT));
	const excl = Math.min(3, Math.max(1, Math.trunc(excludeRecentSteps) || EXCLUDE_RECENT_STEPS_DEFAULT));
	const isExcluded = (e) =>
		currentStep != null && Number.isFinite(e.step) &&
		e.step >= currentStep - excl + 1 && e.step <= currentStep;

	const ordered = [...clean].sort((a, b) =>
		((a.step ?? Number.MAX_SAFE_INTEGER) - (b.step ?? Number.MAX_SAFE_INTEGER)) ||
		String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
	// 死胡同按旧→新排序，保留尾部（最近）N 条。
	const allDeadEnds = ordered.filter((e) => e.kind === "dead-end" && isMeaningfulEntry(e));
	const deadEnds = allDeadEnds.slice(-clampLimit(deadEndLimit, DEAD_END_LIMIT_DEFAULT));
	// 结论区：排除死胡同、计划/假设（目标区已展示）、复读、被取代的旧结论。
	const pool = ordered.filter((e) =>
		e.kind !== "dead-end" && !PLAN_KINDS.has(e.kind) && !isExcluded(e) &&
		isMeaningfulEntry(e) && !supersededIds.has(e.id));
	const recent = pool.slice(-Math.max(1, recentN));

	// latestSummarized：除当前正在执行的 step 外都已总结 → true（currentStep 未知时不判落后）
	const lastSeq = watermark && Number.isFinite(watermark.lastStepSeq) ? watermark.lastStepSeq : null;
	const latestSummarized = currentStep == null
		? true
		: (lastSeq != null && lastSeq >= currentStep - excl); // 排除窗内的 step 允许尚未总结

	let mileState = miles.map((m) => ({ m, body: m.detail ?? "", titleOnly: false }));
	let recentKept = [...recent];
	let milesKept = [...miles];
	let objectivesKept = [...objectives];
	let deadEndsKept = [...deadEnds];
	let compacted = false; // 降级压缩：摘要压成短句（句界内）
	let degraded = false; // 深度降级：只剩最新要点单行

	const summaryFor = (e) => (compacted ? shrinkSummary(e.summary, COMPACT_SUMMARY_CHARS) : e.summary);

	function assemble() {
		const head = ["【语义旅程 · dsh-derive-watcher】（总结注入，预算内裁剪）"];
		if (!latestSummarized) {
			head.push(`注意：总结水位落后（最后已总结 step=${lastSeq ?? "无"} < 当前 step=${currentStep}）。` +
				"以下内容可能不含最新进展，请以当前上下文为准，勿将陈旧条目当作最新结论。");
		}
		if (compacted || degraded) {
			head.push("（预算已达上限：以下只保留最近要点，更早内容未注入）");
		}
		const parts = [...head];
		if (objectivesKept.length) {
			parts.push("◆ 目标（open objectives，置顶；仅最近几条）");
			for (const o of objectivesKept) parts.push(lineOfSummary(o, "目标", summaryFor(o)));
			const rest = allObjectives.length - objectivesKept.length;
			if (rest > 0) parts.push(`- （另有 ${rest} 条较早目标未展开）`);
		}
		const mileLines = [];
		for (const { m, body, titleOnly } of mileState) {
			if (!milesKept.includes(m)) continue;
			mileLines.push(lineOf(m, "里程碑"));
			if (!titleOnly && body) mileLines.push(`  ${body.replace(/\n/g, "\n  ")}`);
		}
		if (mileLines.length) { parts.push("◆ 里程碑（折叠蒸馏）"); parts.push(...mileLines); }
		if (recentKept.length) {
			parts.push(`◆ 最近结论（最近 ${recentKept.length} 条进展；不含计划与最近 ${excl} 步）`);
			for (const e of recentKept) parts.push(lineOfSummary(e, "结论", summaryFor(e)));
		}
		if (deadEndsKept.length) {
			parts.push("◆ 死胡同（dead-end，最近几条，永不遗忘）");
			for (const d of deadEndsKept) parts.push(lineOfSummary(d, "死胡同", summaryFor(d)));
			const rest = allDeadEnds.length - deadEndsKept.length;
			if (rest > 0) parts.push(`- （另有 ${rest} 条较早死胡同未展开）`);
		}
		return parts.join("\n");
	}

	// 预算裁剪顺序（任一档把预算压回来即停）：
	// 里程碑正文句界裁剪 → 结论整条剔除（始终保留最新 1 条）→ 目标收缩到 1 条
	// → 死胡同收缩到 1 条 → 摘要压成短句（degraded）→ 只剩最新两个单行（极端兜底）。
	// 目标不再是「永不剔除」：无界增长正是历史上持续注入跳过的根因。
	let text = assemble();
	let guard = 0;
	while (estimateTokens(text) > tokenBudget && guard++ < 400) {
		let acted = false;
		for (const item of mileState) {
			if (estimateTokens(text) <= tokenBudget) break;
			if (item.titleOnly || !item.body) continue;
			const cut = trimToSentence(item.body, Math.max(20, Math.floor(item.body.length / 2)));
			if (cut && cut.length < item.body.length) {
				item.body = cut;
				trimmed.push(item.m.id ?? null);
			} else {
				item.body = "";
				item.titleOnly = true;
				trimmed.push(item.m.id ?? null);
			}
			acted = true;
		}
		text = assemble();
		if (estimateTokens(text) <= tokenBudget) break;
		if (recentKept.length > 1) {
			const evicted = recentKept.shift();
			dropped.push(evicted.id ?? null);
			acted = true;
			text = assemble();
			if (estimateTokens(text) <= tokenBudget) break;
		}
		if (objectivesKept.length > 1) {
			const evicted = objectivesKept.pop(); // objectives 为新→旧，pop 掉最旧
			dropped.push(evicted.id ?? null);
			acted = true;
			text = assemble();
			if (estimateTokens(text) <= tokenBudget) break;
		}
		if (deadEndsKept.length > 1) {
			const evicted = deadEndsKept.shift(); // deadEnds 为旧→新，shift 掉最旧
			dropped.push(evicted.id ?? null);
			acted = true;
			text = assemble();
			if (estimateTokens(text) <= tokenBudget) break;
		}
		if (!compacted) {
			compacted = true;
			acted = true;
			text = assemble();
			if (estimateTokens(text) <= tokenBudget) break;
		}
		if (!acted) break;
	}

	if (estimateTokens(text) > tokenBudget) {
		// 极端兜底：只留最新一条目标与最新一条结论的单行；仍放不下才放弃注入。
		degraded = true;
		const tail = [];
		if (objectivesKept.length) {
			tail.push(lineOfSummary(objectivesKept[0], "目标", shrinkSummary(objectivesKept[0].summary, 40)));
		}
		if (recentKept.length) {
			const lastRecent = recentKept[recentKept.length - 1];
			tail.push(lineOfSummary(lastRecent, "结论", shrinkSummary(lastRecent.summary, 40)));
		}
		const minimal = ["【语义旅程 · dsh-derive-watcher】（预算已达上限，仅保留最新要点）", ...tail].join("\n");
		if (estimateTokens(minimal) <= tokenBudget) text = minimal;
	}

	if (estimateTokens(text) > tokenBudget) {
		return {
			ok: false,
			suppressReason: `预算溢出：一条压缩后的要点行仍超 token 预算 ${tokenBudget}`,
			dropped, trimmed
		};
	}

	const check = validateAssembledText(text);
	if (!check.ok) {
		return { ok: false, suppressReason: `结构校验失败：${check.problems.join("; ")}`, dropped, trimmed };
	}

	return {
		ok: true,
		text,
		tokenEstimate: estimateTokens(text),
		latestSummarized,
		degraded,
		dropped,
		trimmed,
		sections: {
			objectives: objectivesKept.length,
			objectivesOmitted: allObjectives.length - objectivesKept.length,
			milestones: milesKept.length,
			recent: recentKept.length,
			deadEnds: deadEndsKept.length,
			deadEndsOmitted: allDeadEnds.length - deadEndsKept.length
		}
	};
}

/**
 * 步骤5：reasoning 独立分区组装（只读 reasoning 通道 entry）。
 * 子预算 = floor(tokenBudget * REASONING_BUDGET_RATIO)；超长时只在本分区内整条剔除最旧，
 * 不触碰、不挤占正式结论分区。返回 { text, dropped, count }，空账本返回 text:""（字节级零追加）。
 */
function buildReasoningSection({
	reasoningEntries = [], currentStep = null,
	excludeRecentSteps = EXCLUDE_RECENT_STEPS_DEFAULT,
	recentN = 8, tokenBudget = 1200
} = {}) {
	const dropped = [];
	const clean = [];
	for (const e of reasoningEntries ?? []) {
		if (!e || typeof e.summary !== "string") continue;
		const s = sanitizeEntryText(e.summary);
		if (!s) { dropped.push(e.id ?? null); continue; }
		clean.push({ ...e, summary: s });
	}
	if (clean.length === 0) return { text: "", dropped, count: 0 };

	const excl = Math.min(3, Math.max(1, Math.trunc(excludeRecentSteps) || EXCLUDE_RECENT_STEPS_DEFAULT));
	const isExcluded = (e) =>
		currentStep != null && Number.isFinite(e.step) &&
		e.step >= currentStep - excl + 1 && e.step <= currentStep;

	const ordered = [...clean].sort((a, b) =>
		((a.step ?? Number.MAX_SAFE_INTEGER) - (b.step ?? Number.MAX_SAFE_INTEGER)) ||
		String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
	// r-dead-end 永不遗忘（与正式分区 dead-end 同口径），其余走最近窗口 + 排除最近步。
	const rDeadEnds = ordered.filter((e) => e.kind === "r-dead-end");
	const pool = ordered.filter((e) => e.kind !== "r-dead-end" && !isExcluded(e));
	let kept = pool.slice(-Math.max(1, recentN));

	const subBudget = Math.max(0, Math.floor(tokenBudget * REASONING_BUDGET_RATIO));
	const render = () => {
		const parts = [REASONING_SECTION_TITLE];
		if (kept.length) parts.push(`◇ 推理中的决策/假设/自我修正/计划（最近 ${kept.length} 条；非正式结论）`);
		for (const e of kept) parts.push(lineOf(e, "推理"));
		if (rDeadEnds.length) {
			parts.push("◇ 推理中放弃的方案（r-dead-end，永不遗忘）");
			for (const d of rDeadEnds) parts.push(lineOf(d, "推理"));
		}
		return parts.join("\n");
	};

	let section = render();
	// 超子预算：整条剔除最旧的普通推理条目；r-dead-end 为永不遗忘项不剔除（若仍超则放弃整个分区）。
	let guard = 0;
	while (estimateTokens(section) > subBudget && kept.length > 0 && guard++ < 200) {
		const evicted = kept.shift();
		dropped.push(evicted.id ?? null);
		section = render();
	}
	if (estimateTokens(section) > subBudget) {
		// 永不遗忘项自身即超子预算：放弃 reasoning 分区（绝不回压正式结论）。
		return { text: "", dropped: [...dropped, ...clean.map((e) => e.id ?? null)], count: 0 };
	}
	const check = validateAssembledText(section);
	if (!check.ok) return { text: "", dropped: clean.map((e) => e.id ?? null), count: 0 };
	return { text: section, dropped, count: kept.length + rDeadEnds.length };
}

/**
 * 步骤5：注入总组装——text 正式结论分区（完整 tokenBudget）+ reasoning 独立分区（≤40% 子预算）。
 * reasoningEntries 为空/缺省时输出与改造前 buildTextSection 字节级一致（零追加、零标题）。
 */
export function buildInjectionPayload({
	entries = [], milestones = [], reasoningEntries = [], watermark = null,
	currentTurn = null, currentStep = null,
	excludeRecentSteps = EXCLUDE_RECENT_STEPS_DEFAULT,
	recentN = 8, reasoningRecentN = 8, tokenBudget = 1200,
	objectiveLimit = OBJECTIVE_LIMIT_DEFAULT,
	deadEndLimit = DEAD_END_LIMIT_DEFAULT
} = {}) {
	const textResult = buildTextSection({
		entries, milestones, watermark,
		currentTurn, currentStep, excludeRecentSteps, recentN, tokenBudget,
		objectiveLimit, deadEndLimit
	});
	if (!textResult.ok) return textResult;

	const reasoningResult = buildReasoningSection({
		reasoningEntries, currentStep, excludeRecentSteps,
		recentN: reasoningRecentN, tokenBudget
	});

	// 空 reasoning：字节级返回原正式分区，保证 5.3 防回归。
	if (!reasoningResult.text) {
		return { ...textResult, reasoningDropped: reasoningResult.dropped, sections: { ...textResult.sections, reasoning: 0 } };
	}
	const combined = `${textResult.text}\n${reasoningResult.text}`;
	// 正式分区已用满预算时，reasoning 分区整体让位（不得把总量顶出预算）。
	if (estimateTokens(combined) > tokenBudget) {
		return {
			...textResult,
			reasoningDropped: [...reasoningResult.dropped],
			sections: { ...textResult.sections, reasoning: 0 }
		};
	}
	return {
		ok: true,
		text: combined,
		tokenEstimate: estimateTokens(combined),
		latestSummarized: textResult.latestSummarized,
		degraded: textResult.degraded,
		dropped: textResult.dropped,
		trimmed: textResult.trimmed,
		reasoningDropped: reasoningResult.dropped,
		sections: { ...textResult.sections, reasoning: reasoningResult.count }
	};
}
