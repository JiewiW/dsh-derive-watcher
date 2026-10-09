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

const lineOf = (e, tag) =>
	`- ${e.id} [${tag}${e.kind ? "·" + e.kind : ""}] (turn=${e.turn ?? "-"} step=${e.step ?? "-"}) ${e.summary}`;

/**
 * 组装注入载荷。返回：
 *   { ok:true, text, tokenEstimate, latestSummarized, dropped, trimmed, sections }
 *   { ok:false, suppressReason, dropped, trimmed }
 */
export function buildInjectionPayload({
	entries = [], milestones = [], watermark = null,
	currentTurn = null, currentStep = null,
	excludeRecentSteps = EXCLUDE_RECENT_STEPS_DEFAULT,
	recentN = 8, tokenBudget = 1200
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

	const objectives = collectOpenObjectives(clean, miles);
	const excl = Math.min(3, Math.max(1, Math.trunc(excludeRecentSteps) || EXCLUDE_RECENT_STEPS_DEFAULT));
	const isExcluded = (e) =>
		currentStep != null && Number.isFinite(e.step) &&
		e.step >= currentStep - excl + 1 && e.step <= currentStep;

	const ordered = [...clean].sort((a, b) =>
		((a.step ?? Number.MAX_SAFE_INTEGER) - (b.step ?? Number.MAX_SAFE_INTEGER)) ||
		String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
	const deadEnds = ordered.filter((e) => e.kind === "dead-end");
	const pool = ordered.filter((e) => e.kind !== "dead-end" && !isExcluded(e));
	const recent = pool.slice(-Math.max(1, recentN));

	// latestSummarized：除当前正在执行的 step 外都已总结 → true（currentStep 未知时不判落后）
	const lastSeq = watermark && Number.isFinite(watermark.lastStepSeq) ? watermark.lastStepSeq : null;
	const latestSummarized = currentStep == null
		? true
		: (lastSeq != null && lastSeq >= currentStep - excl); // 排除窗内的 step 允许尚未总结

	let mileState = miles.map((m) => ({ m, body: m.detail ?? "", titleOnly: false }));
	let recentKept = [...recent];
	let milesKept = [...miles];

	function assemble() {
		const head = ["【语义旅程 · dsh-derive-watcher】（总结注入，预算内裁剪）"];
		if (!latestSummarized) {
			head.push(`注意：总结水位落后（最后已总结 step=${lastSeq ?? "无"} < 当前 step=${currentStep}）。` +
				"以下内容可能不含最新进展，请以当前上下文为准，勿将陈旧条目当作最新结论。");
		}
		const parts = [...head];
		if (objectives.length) {
			parts.push("◆ 目标（open objectives，置顶）");
			for (const o of objectives) parts.push(lineOf(o, "目标"));
		}
		const mileLines = [];
		for (const { m, body, titleOnly } of mileState) {
			if (!milesKept.includes(m)) continue;
			mileLines.push(lineOf(m, "里程碑"));
			if (!titleOnly && body) mileLines.push(`  ${body.replace(/\n/g, "\n  ")}`);
		}
		if (mileLines.length) { parts.push("◆ 里程碑（折叠蒸馏）"); parts.push(...mileLines); }
		if (recentKept.length) {
			parts.push(`◆ 最近结论（最近 ${recentKept.length} 条；不含最近 ${excl} 步）`);
			for (const e of recentKept) parts.push(lineOf(e, "结论"));
		}
		if (deadEnds.length) {
			parts.push("◆ 死胡同（dead-end，永不遗忘）");
			for (const d of deadEnds) parts.push(lineOf(d, "死胡同"));
		}
		return parts.join("\n");
	}

	// 预算裁剪：句界裁剪里程碑正文（最旧优先）→ 整条剔除最旧最近结论；
	// 里程碑标题行保值不整条剔除（蒸馏浓缩产物零丢失口径），仍超支则走预算溢出。
	let text = assemble();
	let guard = 0;
	while (estimateTokens(text) > tokenBudget && guard++ < 200) {
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
		if (recentKept.length) {
			const evicted = recentKept.shift();
			dropped.push(evicted.id ?? null);
			acted = true;
			text = assemble();
			if (estimateTokens(text) <= tokenBudget) break;
		}
		if (!acted) break;
	}

	if (estimateTokens(text) > tokenBudget) {
		return {
			ok: false,
			suppressReason: `预算溢出：不可裁剪项（目标/死胡同标题）已超 token 预算 ${tokenBudget}`,
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
		dropped,
		trimmed,
		sections: {
			objectives: objectives.length,
			milestones: milesKept.length,
			recent: recentKept.length,
			deadEnds: deadEnds.length
		}
	};
}
