/**
 * dsh-derive-watcher — timeline 聚合层（v0.2.0 步骤2）。
 *
 * 为右侧栏「语义监视」tab 提供只读聚合：
 *  - 五来源归并：journey 语义条目 / gap 总结跳过 / milestone 里程碑 / observation 每步观察 / 会话事件（semantic-watcher/* 前缀，含 intervention）；
 *  - intervention 是 watcher-event 中 action 类事件的特化（source 单独取值，UI 据此做醒目样式）；
 *  - 每个来源独立 try/catch：单源失败不影响其余，响应携带语义化 warnings。
 *
 * 亲验偏差记录（写入验收报告）：
 *  - 0.2.0-rc.2 内核 listEvents 返回轻量记录 {sessionId,seq,type,time,surface}（无 data）；
 *    实时/历史均如此。故事件源先 listEvents 拿清单，缺 data 时回退 readSession 全量事件补字段；
 *    两条通道都失败才记 warning「session-events-unavailable」并置空该来源。
 *  - ts 双形态归一：账本与事件载荷为 ISO 字符串，内核记录 time 为毫秒数字 → 统一转毫秒数字（toMillis）。
 *  - 排序方向取「新→旧」（ts 降序）：面板首屏看最新动态；缺 ts 的条目排在有 ts 条目之后，按 (turn,step) 降序。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** timeline item 的 source 取值（spec §步骤2）。 */
export const TIMELINE_SOURCES = Object.freeze({
	INTERVENTION: "intervention",
	WATCHER_EVENT: "watcher-event",
	MILESTONE: "milestone",
	GAP: "gap",
	JOURNEY: "journey",
	OBSERVATION: "observation"
});

/** 同序（ts 与 turn/step 都相同）时的稳定优先级：intervention > watcher-event > milestone > gap > journey > observation。 */
const SOURCE_PRIORITY = { [TIMELINE_SOURCES.INTERVENTION]: 0, [TIMELINE_SOURCES.WATCHER_EVENT]: 1, [TIMELINE_SOURCES.MILESTONE]: 2, [TIMELINE_SOURCES.GAP]: 3, [TIMELINE_SOURCES.JOURNEY]: 4, [TIMELINE_SOURCES.OBSERVATION]: 5 };

export const TIMELINE_DEFAULT_LIMIT = 200;
export const TIMELINE_MAX_LIMIT = 1000;
export const WATCHER_EVENT_PREFIX = "semantic-watcher/";

/** 事件短名 → 中文卡片标题（未收录事件回退「监视事件 · <短名>」）。 */
const EVENT_TITLES = Object.freeze({
	"stall": "语义停滞升级",
	"store-corruption": "账本数据损坏",
	"injection-skipped": "注入已跳过",
	"execution-unavailable": "干预不可用（已降级）",
	"lexical-repeat": "词法重复",
	"summarizer-degraded": "总结质量降级",
	"handoff-written": "交接账本已写入",
	"heartbeat": "心跳",
	"fold-milestone": "里程碑折叠",
	"retention-cleaned": "保留期清理"
});

/** journey 六 kind → 中文小标签（client 也引用它）。 */
export const KIND_LABELS = Object.freeze({
	finding: "发现", decision: "决策", "dead-end": "死路", hypothesis: "假设", plan: "计划", fact: "事实"
});

/** ts 双形态归一为毫秒数字：有限数字原样；可解析 ISO 字符串 → epoch；其余 null。 */
export function toMillis(ts) {
	if (typeof ts === "number" && Number.isFinite(ts)) return ts;
	if (typeof ts === "string") {
		const parsed = Date.parse(ts);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function clampLimit(raw) {
	const n = Math.round(Number(raw));
	if (!Number.isFinite(n) || n < 1) return TIMELINE_DEFAULT_LIMIT;
	return Math.min(n, TIMELINE_MAX_LIMIT);
}

function truncate(text, max = 90) {
	const s = String(text ?? "");
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 无 ts 条目排序键：(turn,step) 合成单一数字（turn/step 均小整数，1e6 权重足够）。 */
function turnStepKey(item) {
	return (Number.isFinite(item.turn) ? item.turn : -1) * 1e6 + (Number.isFinite(item.step) ? item.step : -1);
}

function cmpItems(a, b) {
	if (a.tsMs != null && b.tsMs != null) { if (a.tsMs !== b.tsMs) return b.tsMs - a.tsMs; }
	else if ((a.tsMs == null) !== (b.tsMs == null)) return a.tsMs == null ? 1 : -1;
	const ta = turnStepKey(a); const tb = turnStepKey(b);
	if (ta !== tb) return tb - ta;
	const pr = SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
	if (pr !== 0) return pr;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** intervention 载荷 → 中文标题/摘要（字段只取事件里真实存在的值）。 */
export function interventionCard(p) {
	const accepted = p.accepted === true;
	if (p.action === "deny-read") {
		const release = Number.isFinite(p.expiresAtStep) ? `，第 ${p.expiresAtStep} 步后解除` : "";
		const ttl = Number.isFinite(p.ttlSteps) ? `TTL ${p.ttlSteps} 步` : "";
		return {
			title: accepted ? "已临时禁止读取文件等工具（二级停滞干预已生效）" : "读取类工具的临时禁止未能生效",
			summary: `连续 ${p.stallCount ?? "?"} 条结论没有新进展；${accepted ? `禁读 ${ttl}，${release.replace("，", "")}` : "步数治理插件未受理，继续放行"}`
		};
	}
	if (p.action === "reject-step") {
		return {
			title: accepted ? "已判定这一轮应当结束（三级停滞干预已生效）" : "结束本轮的请求已提交，等待处理",
			summary: `连续 ${p.stallCount ?? "?"} 条结论没有新进展；${accepted ? "步数治理插件已受理" : p.pending === true ? "排队中，尚未生效" : "步数治理插件未受理"}`
		};
	}
	return { title: "干预事件（类型未知）", summary: "" };
}

/** 事件短名 + 载荷 → 卡片标题/摘要。 */
function watcherEventCard(shortName, p) {
	if (shortName === "intervention") return interventionCard(p);
	const title = EVENT_TITLES[shortName] ?? "监视事件（类型未知）";
	const bits = [];
	if (Number.isFinite(p.level)) bits.push(`停滞等级 ${p.level} 级`);
	if (Number.isFinite(p.stallCount)) bits.push(`连续重复 ${p.stallCount} 条`);
	if (typeof p.suppressReason === "string" && p.suppressReason) bits.push(truncate(p.suppressReason, 120));
	if (typeof p.warning === "string" && p.warning) bits.push(truncate(p.warning, 120));
	if (p.path) bits.push(`文件 ${String(p.path).split(/[\\/]/).pop()}`);
	if (Number.isFinite(p.count)) bits.push(`清理 ${p.count} 项`);
	if (Array.isArray(p.foldedIds) && p.foldedIds.length) bits.push(`折叠 ${p.foldedIds.length} 条`);
	return { title, summary: bits.join("；") };
}

function entryItem(e, idx) {
	const id = typeof e.id === "string" && e.id ? e.id : `j:${idx}:${toMillis(e.ts) ?? "nops"}`;
	return {
		id, source: TIMELINE_SOURCES.JOURNEY, ts: e.ts ?? null, tsMs: toMillis(e.ts),
		turn: Number.isFinite(e.turn) ? e.turn : null, step: Number.isFinite(e.step) ? e.step : null,
		kind: e.kind ?? "fact", title: truncate(e.summary ?? "", 120), summary: truncate(e.detail ?? "", 200),
		novelty: e.novelty ?? null, duplicate_of: e.duplicate_of ?? null,
		data: { semantic_duplicate: e.semantic_duplicate === true, artifacts: e.artifacts ?? [], supersedes: e.supersedes ?? [], confidence: e.confidence ?? null, sourceMessageId: e.sourceMessageId ?? null }
	};
}

function milestoneItem(m, idx) {
	const baseId = typeof m.id === "string" && m.id ? m.id : `${toMillis(m.ts) ?? "nops"}:${idx}`;
	return {
		id: `ms:${baseId}`, source: TIMELINE_SOURCES.MILESTONE, ts: m.ts ?? null, tsMs: toMillis(m.ts),
		turn: Number.isFinite(m.turn) ? m.turn : null, step: Number.isFinite(m.step) ? m.step : null,
		kind: m.kind ?? "finding", title: truncate(m.summary ?? "里程碑", 120),
		summary: Array.isArray(m.covers) && m.covers.length ? `蒸馏覆盖 ${m.covers.length} 条原文` : truncate(m.detail ?? "", 200),
		data: { covers: m.covers ?? [], detail: m.detail ?? "" }
	};
}

/** gap grade → 中文卡片标题（老数据无 grade 回退原因未知）。 */
const GAP_GRADE_TITLES = Object.freeze({
	"no-adapter": "总结跳过：无可用模型路由",
	"timeout": "总结跳过：调用超时",
	"parse-error": "总结跳过：草稿解析失败",
	"empty": "总结跳过：模型空回复",
	"empty-ok": "总结跳过：空结果",
	"other": "总结跳过：其他故障",
	__unknown: "总结跳过（原因未知）"
});

function gapItem(g, idx) {
	const tsMs = toMillis(g.ts);
	const grade = typeof g.grade === "string" && g.grade ? g.grade : null;
	const title = GAP_GRADE_TITLES[grade] ?? GAP_GRADE_TITLES.__unknown;
	return {
		id: `gap:${tsMs ?? "nops"}:${idx}`, source: TIMELINE_SOURCES.GAP, ts: g.ts ?? null, tsMs,
		turn: Number.isFinite(g.turn) ? g.turn : null, step: Number.isFinite(g.step) ? g.step : null,
		kind: "summary-gap", grade, title,
		summary: truncate(typeof g.reason === "string" ? g.reason : "", 200),
		data: { grade }
	};
}

function observationItem(o, idx) {
	const turn = Number.isFinite(o.turn) ? o.turn : null;
	const step = Number.isFinite(o.step) ? o.step : null;
	const id = turn != null && step != null ? `obs:${turn}:${step}` : `obs:${idx}:${toMillis(o.ts) ?? "nops"}`;
	const bits = [];
	bits.push(o.hasText ? `文本 ${o.textLen ?? 0} 字` : "无可见文本");
	if (o.reasoningLen > 0) bits.push(`推理 ${o.reasoningLen} 字`);
	if (o.hasArtifact) bits.push("有产物");
	return {
		id, source: TIMELINE_SOURCES.OBSERVATION, ts: o.ts ?? null, tsMs: toMillis(o.ts),
		turn, step, kind: "reasoning-observation",
		title: `step ${step ?? "?"} 观察`, summary: bits.join(" · "),
		data: { hasText: o.hasText === true, textLen: o.textLen ?? 0, reasoningLen: o.reasoningLen ?? 0, hasArtifact: o.hasArtifact === true }
	};
}

/** 单条会话事件（双形态：ev.data 存在取载荷；否则取记录层 time/seq）。 */
function eventItem(ev, idx) {
	const name = String(ev.type ?? "");
	const shortName = name.startsWith(WATCHER_EVENT_PREFIX) ? name.slice(WATCHER_EVENT_PREFIX.length) : name;
	const p = ev.data && typeof ev.data === "object" ? ev.data : {};
	const rawTs = p.ts ?? ev.time ?? null;
	const tsMs = toMillis(rawTs);
	const seqPart = Number.isFinite(ev.seq) ? ev.seq : (tsMs ?? `nops:${idx}`);
	const card = shortName === "intervention" && Object.keys(p).length
		? interventionCard(p)
		: watcherEventCard(shortName, p);
	const isIntervention = shortName === "intervention";
	return {
		id: `evt:${name}:${seqPart}`, source: isIntervention ? TIMELINE_SOURCES.INTERVENTION : TIMELINE_SOURCES.WATCHER_EVENT,
		ts: rawTs, tsMs,
		turn: Number.isFinite(p.turn) ? p.turn : null, step: Number.isFinite(p.step) ? p.step : null,
		kind: isIntervention ? (p.action ?? "intervention") : shortName,
		title: card.title, summary: card.summary,
		accepted: isIntervention && typeof p.accepted === "boolean" ? p.accepted : undefined,
		data: p, _fallbackTs: tsMs
	};
}

/**
 * 会话事件源读取（含双形态回退）：
 * ① listEvents → 若命中事件缺 data 且存在 readSession → ② readSession 全量事件替换。
 * 返回 { events, warnings }；任何异常该来源置空并记 warning。
 */
async function readWatcherEvents(query, sessionId, log) {
	const warnings = [];
	if (!query || typeof query.listEvents !== "function") {
		return { events: [], warnings: ["session-query-unavailable"] };
	}
	let records = [];
	try {
		records = (await query.listEvents(sessionId)) ?? [];
	} catch (error) {
		log(`timeline 事件源 listEvents 失败 ${sessionId}: ${error?.message ?? error}`);
		return { events: [], warnings: ["session-events-unavailable"] };
	}
	const hits = Array.isArray(records) ? records.filter((ev) => typeof ev?.type === "string" && ev.type.startsWith(WATCHER_EVENT_PREFIX)) : [];
	const needsData = hits.some((ev) => ev.data == null);
	if (needsData && query && typeof query.readSession === "function") {
		try {
			const full = await query.readSession(sessionId);
			const richer = (Array.isArray(full?.events) ? full.events : []).filter((ev) => typeof ev?.type === "string" && ev.type.startsWith(WATCHER_EVENT_PREFIX));
			return { events: richer.length ? richer : hits, warnings };
		} catch (error) {
			log(`timeline 事件源 readSession 回退失败 ${sessionId}: ${error?.message ?? error}`);
			warnings.push("session-event-data-unavailable");
		}
	} else if (needsData) {
		warnings.push("session-event-data-unavailable");
	}
	return { events: hits, warnings };
}

/** 扫账本目录取有账本的会话 id 集合（journey/*.jsonl 排除 *.milestones.jsonl 与 archive，加 observation/*.jsonl）。 */
function scanLedgerSessionIds(ledgerRoot, fsImpl) {
	const ids = new Set();
	const collect = (dir, suffix, excludeSuffix = null) => {
		try {
			for (const f of fsImpl.readdirSync(dir)) {
				if (typeof f !== "string" || !f.endsWith(suffix)) continue;
				if (excludeSuffix && f.endsWith(excludeSuffix)) continue;
				ids.add(f.slice(0, -suffix.length));
			}
		} catch { /* 目录不存在 = 无账本 */ }
	};
	collect(join(ledgerRoot, "journey"), ".jsonl", ".milestones.jsonl");
	collect(join(ledgerRoot, "observation"), ".jsonl");
	return ids;
}

/**
 * 构造 timeline 聚合器。
 * @param {{store:object, ledgerRoot:string, getSessionQuery?:()=>object|null, fs?:object, log?:(line:string)=>void}} deps
 *   store：createJourneyStore 实例；ledgerRoot：账本根（与 index.js 同源）；
 *   getSessionQuery：软依赖取用（不可用返回 null）；fs：注入 readdirSync 供测试。
 */
export function createTimeline({ store, ledgerRoot, getSessionQuery = () => null, fs = { readdirSync }, log = (line) => console.warn(line) } = {}) {
	if (!store || !ledgerRoot) throw new Error("createTimeline 需要 store 与 ledgerRoot");

	/** ① GET timeline/sessions：账本会话 ∪ sessionQuery 会话的并集视图。 */
	async function listSessionsView() {
		const warnings = [];
		const ledgerIds = scanLedgerSessionIds(ledgerRoot, fs);
		const byId = new Map();
		for (const sid of ledgerIds) byId.set(sid, { sessionId: sid, hasLedger: true });
		let query = null;
		try { query = getSessionQuery(); } catch { query = null; }
		if (query && typeof query.listSessions === "function") {
			try {
				const records = await query.listSessions() ?? [];
				for (const rec of records) {
					const sid = rec?.header?.id;
					if (typeof sid !== "string" || !sid) continue;
					const row = byId.get(sid) ?? { sessionId: sid, hasLedger: false };
					row.title = typeof rec.title === "string" ? rec.title : row.title ?? null;
					row.createdAt = Number.isFinite(rec.header.createdAt) ? rec.header.createdAt : null;
					row.cwd = rec.header.cwd ?? null;
					row.live = rec.live === true;
					row.persisted = rec.persisted === true;
					byId.set(sid, row);
				}
			} catch (error) {
				log(`timeline sessions listSessions 失败: ${error?.message ?? error}`);
				warnings.push("session-query-list-unavailable");
			}
		} else {
			warnings.push("session-query-unavailable");
		}
		// 标题尽力补全（仅账本会话；任何失败只降级无标题，不阻塞列表）
		if (query && typeof query.readTitleSnapshots === "function") {
			const want = [...byId.values()].filter((r) => r.hasLedger && !r.title);
			if (want.length) {
				try {
					const snaps = await query.readTitleSnapshots(want.map((r) => r.sessionId));
					const bySess = new Map((Array.isArray(snaps) ? snaps : []).map((s, i) => [want[i]?.sessionId, s]));
					for (const sid of want.map((r) => r.sessionId)) {
						const v = bySess.get(sid)?.status === "fulfilled" ? bySess.get(sid).value : null;
						if (typeof v?.title === "string" && v.title) {
							byId.get(sid).title = v.title;
							if (Number.isFinite(v.session?.createdAt) && byId.get(sid).createdAt == null) byId.get(sid).createdAt = v.session.createdAt;
						}
					}
				} catch { /* 标题属锦上添花，失败静默 */ }
			}
		}
		const sessions = [...byId.values()].sort((a, b) => (b.createdAt ?? -1) - (a.createdAt ?? -1) || String(a.sessionId).localeCompare(String(b.sessionId)));
		return { sessions, warnings };
	}

	/** ② GET timeline：五来源归并 + 排序 + limit。账本不存在返回 {notFound:true}。 */
	async function timelineFor(sessionId, limitRaw) {
		const hasLedger = scanLedgerSessionIds(ledgerRoot, fs).has(sessionId);
		if (!hasLedger) return { notFound: true };
		const limit = clampLimit(limitRaw);
		const warnings = [];
		const items = [];
		const counts = {};
		let journey = [];
		try { journey = store.readEntries(sessionId) ?? []; } catch (error) { log(`timeline journey 失败: ${error?.message ?? error}`); warnings.push("journey-unavailable"); }
		let milestones = [];
		try { milestones = store.readMilestones(sessionId) ?? []; } catch (error) { log(`timeline milestone 失败: ${error?.message ?? error}`); warnings.push("milestone-unavailable"); }
		let gaps = [];
		try { gaps = store.readGaps(sessionId) ?? []; } catch (error) { log(`timeline gap 失败: ${error?.message ?? error}`); warnings.push("gap-unavailable"); }
		let observations = [];
		try { observations = store.readObservations(sessionId) ?? []; } catch (error) { log(`timeline observation 失败: ${error?.message ?? error}`); warnings.push("observation-unavailable"); }
		let query = null;
		try { query = getSessionQuery(); } catch { query = null; }
		const { events, warnings: eventWarnings } = await readWatcherEvents(query, sessionId, log);
		warnings.push(...eventWarnings);
		for (const e of journey) items.push(entryItem(e, items.length));
		for (const g of gaps) items.push(gapItem(g, items.length));
		for (const m of milestones) items.push(milestoneItem(m, items.length));
		for (const o of observations) items.push(observationItem(o, items.length));
		for (const ev of events) items.push(eventItem(ev, items.length));
		items.sort(cmpItems);
		for (const it of items) counts[it.source] = (counts[it.source] ?? 0) + 1;
		const page = items.slice(0, limit);
		for (const it of page) { delete it.tsMs; delete it._fallbackTs; }
		return { sessionId, items: page, counts, warnings, limit };
	}

	return { listSessionsView, timelineFor, scanLedgerSessionIds: () => scanLedgerSessionIds(ledgerRoot, fs) };
}
