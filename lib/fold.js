/**
 * dsh-derive-watcher — 里程碑折叠与归档（计划书 §5.3）。
 *
 * 触发：enableMilestoneFold=true 且 entry 数 > recentN×3，或注入超预算（overBudget=true）。
 * 折叠：最旧一批交 flash 蒸馏为里程碑（字段同 entry + milestone:true + covers），
 *       保留全部 dead-end 与 open objectives（不进折叠批）；
 *       原文移 journey/archive/<sessionId>-<ts>.jsonl；
 *       supersedes 链跨折叠保留（里程碑继承被折叠条目的 supersedes 并集，covers 记录原文 id）。
 * 蒸馏失败 fail-open：保留原文，不折叠。
 * retention：仅清理归档（retentionDays 默认 30），清理发 retention-cleaned；里程碑与主账本不清理。
 */
import { EVT } from "./events.js";
import { KINDS } from "./journey-store.js";
import { parseJsonObject } from "./summarizer.js";
import { collectOpenObjectives } from "./injection.js";

export const FOLD_SYSTEM_PROMPT = [
	"你是会话旅程蒸馏器。把一批较早的结论条目蒸馏为少量里程碑（长期有效的大结论）。",
	"只输出一个 JSON 对象：",
	'{"milestones":[{"kind":"finding|decision|dead-end|hypothesis|plan|fact","summary":"里程碑一句话","detail":"合并后的关键细节","artifacts":["路径"]}]}',
	"每个里程碑必须覆盖若干输入条目；被后续条目取代的旧结论不要原样保留。禁止输出其它文字。"
].join("\n");

export function buildFoldPrompt(batchEntries) {
	const lines = (batchEntries ?? []).map((e) =>
		`- id=${e.id} kind=${e.kind} step=${e.step ?? "?"} supersedes=[${(e.supersedes ?? []).join(",")}] ${e.summary}${e.detail ? " ｜ " + e.detail.slice(0, 200) : ""}`);
	return `【待折叠条目（旧→新）】\n${lines.join("\n")}\n\n请输出 JSON。`;
}

/** 解析蒸馏输出：非法里程碑丢弃，返回有效列表。 */
export function extractMilestones(text) {
	const parsed = parseJsonObject(text);
	if (!parsed || !Array.isArray(parsed.milestones)) return [];
	const out = [];
	for (const raw of parsed.milestones) {
		if (!raw || typeof raw !== "object") continue;
		const kind = KINDS.includes(raw.kind) ? raw.kind : null;
		const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
		if (!kind || !summary) continue;
		out.push({
			kind,
			summary,
			detail: typeof raw.detail === "string" ? raw.detail : "",
			artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.filter((a) => typeof a === "string") : []
		});
	}
	return out;
}

/**
 * @param opts.store   journey-store 实例
 * @param opts.emit    (name, payload) 事件出口
 * @param opts.callLlm 异步 LLM 文本调用（可注入假实现）
 */
export function createFold({ store, emit = () => {}, log = (line) => console.warn(line), callLlm = async () => null, timeoutMs = 30000 } = {}) {

	/** 选取折叠批：保护界（最近 recentN + 全部 dead-end + open objectives）之外的更旧条目。 */
	function selectBatch(entries, recentN) {
		const objectives = collectOpenObjectives(entries, []);
		const protect = new Set();
		for (const e of entries.slice(-recentN)) protect.add(e.id);
		for (const o of objectives) protect.add(o.id);
		for (const e of entries) if (e.kind === "dead-end") protect.add(e.id);
		return entries.filter((e) => !protect.has(e.id));
	}

	async function distill(sessionId, batch, route = null) {
		// fold 无单条消息上下文：复用该会话最近成功总结的模型路由，缺省回退 settings/宿主默认
		const routeOpts = route && (route.provider || route.model)
			? { provider: route.provider || null, model: route.model || null }
			: {};
		const promptBase = buildFoldPrompt(batch);
		let milestones = extractMilestones(await callLlm({
			system: FOLD_SYSTEM_PROMPT, prompt: promptBase, sessionId,
			purpose: "semantic-watcher/fold", timeoutMs, ...routeOpts
		}));
		if (!milestones.length) {
			milestones = extractMilestones(await callLlm({
				system: FOLD_SYSTEM_PROMPT, prompt: promptBase + "\n（上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。）",
				sessionId, purpose: "semantic-watcher/fold-retry", timeoutMs, ...routeOpts
			}));
		}
		return milestones;
	}

	/**
	 * 尝试折叠。返回 { folded:true, milestoneIds, foldedIds, archive } |
	 *             { folded:false, reason }。
	 */
	async function maybeFold(sessionId, { recentN = 8, overBudget = false, route = null } = {}) {
		let entries = [];
		try { entries = store.readEntries(sessionId); } catch { entries = []; }
		if (!overBudget && entries.length <= recentN * 3) {
			return { folded: false, reason: `未达折叠阈值（${entries.length} ≤ recentN×3=${recentN * 3}）` };
		}
		const batch = selectBatch(entries, recentN);
		if (!batch.length) return { folded: false, reason: "无可折叠条目（保护界覆盖全部条目）" };

		const distilled = await distill(sessionId, batch, route);
		if (!distilled.length) {
			return { folded: false, reason: "蒸馏失败（fail-open，保留原文不折叠）" };
		}

		// supersedes 链跨折叠保留：里程碑继承被折叠条目的 supersedes 并集；covers 记录原文 id
		const coveredIds = batch.map((e) => e.id);
		const inheritedSupersedes = [...new Set(batch.flatMap((e) => e.supersedes ?? []))]
			.filter((id) => !coveredIds.includes(id));
		const lastOf = batch[batch.length - 1];
		const tsLabel = new Date().toISOString().replace(/[:.]/g, "-");
		const milestoneIds = [];
		for (const d of distilled) {
			const m = store.appendMilestone(sessionId, {
				id: store.nextEntryId(sessionId),
				turn: lastOf.turn ?? null,
				step: lastOf.step ?? null,
				sourceMessageId: null,
				kind: d.kind,
				summary: d.summary,
				detail: d.detail,
				artifacts: d.artifacts,
				supersedes: inheritedSupersedes,
				confidence: null,
				covers: coveredIds
			});
			if (m) milestoneIds.push(m.id);
		}
		if (!milestoneIds.length) {
			return { folded: false, reason: "蒸馏结果全部落账失败（里程碑账本写入异常），保留原文不折叠" };
		}

		const archive = store.archiveEntries(sessionId, batch, tsLabel);
		if (!archive.ok) {
			// 归档失败：fail-open，原文保留（可能出现重复蒸馏，下次重试覆盖同一内容）
			return { folded: false, reason: `归档失败（${archive.reason}），里程碑已写但原文未移除` };
		}
		log(`[dsh-derive-watcher] fold session=${sessionId} milestones=${milestoneIds.length} archived=${archive.archived} → ${archive.path}`);
		emit(EVT.FOLD_MILESTONE, {
			sessionId,
			turn: lastOf.turn ?? null,
			step: lastOf.step ?? null,
			milestoneIds,
			foldedIds: coveredIds,
			archive: archive.path,
			archived: archive.archived
		});
		return { folded: true, milestoneIds, milestoneCount: milestoneIds.length, foldedIds: coveredIds, archive: archive.path };
	}

	/** retention 清理：清归档过期文件 + 主账本/gap 保留期清理；有删除时发 retention-cleaned。 */
	function retentionSweep(retentionDays = 30, ledgerRetentionDays = 0) {
		const removed = store.retentionClean(retentionDays);
		// P2-21③：ledgerRetentionDays>0 时额外清理早于该天数的会话主账本与 gap
		const ledgerRemoved = store.retentionCleanLedger(ledgerRetentionDays);
		const all = [...removed, ...ledgerRemoved.filter((f) => !removed.includes(f))];
		if (all.length) {
			emit(EVT.RETENTION_CLEANED, {
				sessionId: "*", turn: null, step: null, evidenceSeq: null,
				removed: all, count: all.length
			});
		}
		return all;
	}

	return { maybeFold, retentionSweep, selectBatch, distill };
}
