/**
 * dsh-derive-watcher — L3 语义监视者主入口（P0–P3 装配，计划书 §2/§4–§6）。
 *
 * 职责：
 *  - P0：设置（§5.6 全量键，持久化 ~/.dsh/storages/semantic-watcher/settings.json）+ 设置路由（GET 返回 schema）+ 事件出口；
 *  - P1：session/event 观察 assistant/message → summarizer 入队 → journey-store 落账（JSONL/MD、转写、长度守恒、水位）；
 *  - P2：onSummarized → stall 判定 + fold 阈值检查（里程碑/归档/retention）；
 *  - P3：agent/pre-step 注入（默认关；stall 警示与旅程摘要合并为一条 user 消息追加）；
 *  - stall：L2 契约（stepGovernor.denyToolCategory/rejectStep），不可用 fail-open；
 *  - 心跳（§5.8）：每 5 个事件或每 60s，载荷含队列长度与水位 stepSeq。
 *
 * 注入机制（内核 0.2.0 实测钉死）：cordis waterfall 的 next() 不接受传参
 * （cordis/lib/index.js:317-325），因此监听器先 `await next()` 取默认决策，
 * 再把注入消息 createUserMessage(...) 追加到 decision.messages 尾部返回；
 * 内核 dsh-agent-loop/lib/index.js:1127 会在本 step 首次尝试时把这些消息
 * 逐条 session.append("user/message", ...) 落盘。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { EVT, PLUGIN_ID, createEventSink } from "./events.js";
import {
	DEFAULT_SETTINGS,
	SETTINGS_SCHEMA,
	applyRuntimeSettings,
	firstRunGuards,
	makeSettingsStore
} from "./settings.js";
import { createJourneyStore } from "./journey-store.js";
import { createSummarizer, makeLlmCall } from "./summarizer.js";
import { createStallController } from "./stall.js";
import { createFold } from "./fold.js";
import { buildInjectionPayload, collectOpenObjectives } from "./injection.js";

export const name = PLUGIN_ID;
export const inject = ["webServer"];

/** v4 producerKind 标准形态（内核迁移器：kind:"plugin:<id>" + plugin:<id>）。 */
const PLUGIN_SOURCE = Object.freeze({ kind: `plugin:${PLUGIN_ID}`, plugin: PLUGIN_ID });

const SETTINGS_ROUTE = "/plugins/derive-watcher/settings";
const HEARTBEAT_SCAN_MS = 30000; // 心跳扫描周期
const HEARTBEAT_IDLE_MS = 60000; // 每 60s 至少一次心跳（§5.8：每分钟或每 5 事件）
const HEARTBEAT_EVENT_BURST = 5; // 每 5 个事件一次心跳
const EXCLUDE_RECENT_STEPS = 2; // 注入/种子排除最近 1–3 步（取 2）
const RETENTION_SWEEP_MS = 3600000; // retention 清理扫描周期（1h）

function sendJson(res, status, payload) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			try { resolve(JSON.parse(body || "{}")); } catch (error) { reject(error); }
		});
		req.on("error", reject);
	});
}

/** assistant/message content 块数组 → 纯文本（只取 text 块；reasoning 不入账）。 */
function blocksToText(content) {
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
	}
	return typeof content === "string" ? content : "";
}

export function apply(ctx, config) {
	const log = (line) => console.warn(`[dsh-derive-watcher] ${line}`);

	// ── 设置（§5.6）：损坏回退默认并告警；首发钉定 enableInjection=false ──
	const settingsDir = join(homedir(), ".dsh", "storages", "semantic-watcher");
	const settingsStore = makeSettingsStore(settingsDir);
	let settings;
	{
		const loaded = settingsStore.load();
		if (loaded) {
			settings = loaded.settings;
			for (const w of loaded.warnings) log(`设置告警: ${w}`);
		} else {
			settings = firstRunGuards({ ...DEFAULT_SETTINGS });
			try {
				settingsStore.save(settings);
				log("首次运行：写入默认设置（enableInjection=false、enableStall3Reject=false，P4 前钉定）");
			} catch (error) {
				log(`默认设置写入失败（不阻塞）: ${error?.message ?? error}`);
			}
		}
	}
	const getSettings = () => settings;

	// ── 账本根：storagePath 可覆盖；默认与设置同根 ──
	const ledgerRoot = typeof settings.storagePath === "string" && settings.storagePath.trim()
		? settings.storagePath.trim()
		: settingsDir;

	// ── 事件出口：模块内两参 emit → sink 三参（session 由 sessionId 反查/伪 session 兜底）──
	const sink = createEventSink({ log });
	const sessionById = new Map();
	const emitForModule = (evtName, payload) => {
		const sid = payload?.sessionId ?? null;
		const session = (sid != null && sessionById.get(sid)) || (sid != null ? { id: sid } : null);
		return sink.emit(session, evtName, payload);
	};

	// ── LLM（flash 钉定：summaryProvider/summaryModel 留空跟随宿主默认档）──
	const getLlm = () => {
		try {
			const l = ctx.get("llm");
			return l && typeof l.stream === "function" ? l : null;
		} catch {
			return null;
		}
	};
	const callLlm = async (opts = {}) => {
		const llm = getLlm();
		if (!llm) return null;
		const s = getSettings();
		const inner = makeLlmCall({
			llm,
			provider: s.summaryProvider || undefined,
			model: s.summaryModel || undefined,
			source: PLUGIN_SOURCE
		});
		return inner(opts);
	};

	// ── 账本（journey-store：JSONL/MD/里程碑/水位/归档）──
	const store = createJourneyStore({
		root: ledgerRoot,
		escapeTags: settings.escapeClosingTags !== false,
		emit: emitForModule,
		log
	});

	// ── L2（step-governor）：不可用返回 null（fail-open）──
	const getL2 = () => {
		for (const key of ["stepGovernor", "dsh-step-governor", "step-governor"]) {
			try {
				const s = ctx.get(key);
				if (s) return s;
			} catch { /* 服务未提供 */ }
		}
		return null;
	};

	// ── stall-3 交接账本 + 续跑种子（单 JSON 文件：里程碑+open objectives+最近结论+artifacts）──
	async function writeHandoff(sessionId, meta = {}) {
		const entries = store.readEntries(sessionId);
		const milestones = store.readMilestones(sessionId);
		const objectives = collectOpenObjectives(entries, milestones);
		const maxStep = entries.reduce((m, e) => (Number.isFinite(e.step) && e.step > m ? e.step : m), 0);
		const isRecent = (e) => Number.isFinite(e.step) && e.step >= maxStep - EXCLUDE_RECENT_STEPS + 1;
		const recent = entries.filter((e) => !isRecent(e));
		const deadEnds = entries.filter((e) => e.kind === "dead-end");
		const artifacts = [...new Set([...entries, ...milestones]
			.flatMap((e) => (Array.isArray(e.artifacts) ? e.artifacts : []))
			.filter((a) => typeof a === "string" && a))];
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const dir = join(ledgerRoot, "handoff");
		mkdirSync(dir, { recursive: true });
		const seed = {
			sessionId,
			generatedAt: new Date().toISOString(),
			evidenceSeq: meta.evidenceSeq ?? null,
			stallCount: meta.stallCount ?? null,
			turn: meta.turn ?? null,
			step: meta.step ?? null,
			openObjectives: objectives.map((o) => ({ id: o.id, kind: o.kind, step: o.step, summary: o.summary })),
			milestones: milestones.map((m) => ({ id: m.id, kind: m.kind, step: m.step, summary: m.summary })),
			deadEnds: deadEnds.map((d) => ({ id: d.id, step: d.step, summary: d.summary, detail: d.detail ?? "" })),
			recentFindings: recent.slice(-20).map((e) => ({ id: e.id, kind: e.kind, step: e.step, summary: e.summary })),
			artifacts
		};
		const seedPath = join(dir, `${sessionId}-${stamp}.seed.json`);
		writeFileSync(seedPath, JSON.stringify(seed, null, 2) + "\n", "utf8");
		const handoffPath = join(dir, `${sessionId}-${stamp}.handoff.md`);
		const md = [
			`# 语义停滞交接（stall-3）— ${sessionId}`,
			"",
			`- evidenceSeq=${meta.evidenceSeq ?? "?"} stallCount=${meta.stallCount ?? "?"} turn=${meta.turn ?? "?"} step=${meta.step ?? "?"}`,
			"",
			"## 任务状态",
			"",
			`会话 ${sessionId} 触发 semantic-stall（连续 ${meta.stallCount ?? "?"} 条重复结论，仅语义重复计入）。本回合建议终止；续跑凭下方目标与种子文件，不得重复已记录的 dead-end。`,
			"",
			"## 目标",
			"",
			...(objectives.length
				? objectives.map((o) => `- [${o.kind}] (step≤${o.step ?? "?"}) ${o.summary}`)
				: ["-（账本无未闭合目标）"]),
			"",
			"## 已试方案与失败原因",
			"",
			...(deadEnds.length
				? deadEnds.map((d) => `- (step ${d.step ?? "?"}) ${d.summary}`)
				: ["-（无 dead-end 记录）"]),
			"",
			"## 进度与下一步",
			"",
			`- 种子文件: ${seedPath}`,
			`- 最近结论（排除最近 ${EXCLUDE_RECENT_STEPS} 步）：`,
			...recent.slice(-8).map((e) => `  - [${e.kind}] ${e.summary}`),
			""
		].join("\n");
		writeFileSync(handoffPath, md, "utf8");
		return { path: handoffPath, seedPath };
	}

	// ── stall 状态机（§5.5 全口径；emit 两参）──
	const stall = createStallController({ emit: emitForModule, log, getSettings, getL2, writeHandoff });

	// ── 折叠（§5.3）：阈值/超预算异步触发，逐会话串行链防重入 ──
	const fold = createFold({ store, emit: emitForModule, log, callLlm });
	const foldChains = new Map();
	function triggerFold(sessionId, overBudget) {
		const s = getSettings();
		if (!s.enableMilestoneFold || !s.enableJourney) return;
		const prev = foldChains.get(sessionId) ?? Promise.resolve();
		const nextRun = prev.catch(() => {}).then(async () => {
			try {
				const r = await fold.maybeFold(sessionId, { recentN: s.recentN, overBudget: overBudget === true });
				if (r?.folded) log(`折叠完成 session=${sessionId} 里程碑=${r.milestoneCount} 归档条目=${r.foldedIds?.length ?? 0}`);
			} catch (error) {
				log(`折叠异常（fail-open，原文保留）: ${error?.message ?? error}`);
			}
		});
		foldChains.set(sessionId, nextRun);
	}

	// ── pending 警示与去重簿 ──
	const warnings = new Map(); // sessionId → 待注入 stall 警示文本（pre-step 用后即删）
	const knownSourceIds = new Map(); // sessionId → Set<sourceMessageId>（重启后从账本重建，防双写）
	const knownFor = (sid) => {
		let set = knownSourceIds.get(sid);
		if (!set) {
			set = new Set();
			try {
				for (const e of store.readEntries(sid)) if (e.sourceMessageId) set.add(e.sourceMessageId);
			} catch { /* 账本缺失按空 */ }
			knownSourceIds.set(sid, set);
		}
		return set;
	};
	const lastOverBudget = new Map(); // sessionId → 最近一次注入是否超预算（fold overBudget 依据）

	// ── summarizer（P1）──
	const summarizer = createSummarizer({
		store,
		emit: emitForModule,
		log,
		getSettings,
		callLlm,
		embed: null, // embedding 可选：宿主无嵌入通路时 novelty 回退 schema-selfcheck（novelty.js fallback）
		onSummarized: (sessionId, { entries, messageId }) => {
			if (messageId) {
				try { knownFor(sessionId).add(messageId); } catch { /* ignore */ }
			}
			let r = null;
			try { r = stall.onEntries(sessionId, entries); } catch (error) {
				log(`stall 判定异常（fail-open）: ${error?.message ?? error}`);
			}
			if (r?.warningText) warnings.set(sessionId, r.warningText);
			triggerFold(sessionId, lastOverBudget.get(sessionId) === true);
		},
		onGap: (sessionId, meta) => {
			try { stall.onGap(sessionId, meta); } catch { /* ignore */ }
		}
	});

	// ── 心跳（§5.8）：每 5 个事件或每 60s；载荷含队列长度与水位 stepSeq ──
	const beats = new Map(); // sid → { count, lastBeat, turn, step }
	function beatNow(session, info) {
		const sid = session.id;
		let wmStep = null;
		try { wmStep = store.loadWatermark(sid)?.lastStepSeq ?? null; } catch { /* ignore */ }
		sink.emit(session, EVT.HEARTBEAT, {
			sessionId: sid,
			turn: info.turn ?? null,
			step: info.step ?? null,
			queueLength: summarizer.stats().queued,
			watermarkStepSeq: wmStep
		});
	}
	function beatTick(session, turn, step) {
		const sid = session.id;
		const b = beats.get(sid) ?? { count: 0, lastBeat: Date.now(), turn: null, step: null };
		b.count += 1;
		if (turn != null) b.turn = turn;
		if (step != null) b.step = step;
		if (b.count >= HEARTBEAT_EVENT_BURST) {
			b.count = 0;
			b.lastBeat = Date.now();
			beatNow(session, b);
		}
		beats.set(sid, b);
	}
	let lastSweep = Date.now();
	const timer = setInterval(() => {
		try {
			const now = Date.now();
			for (const [sid, b] of beats) {
				if (now - b.lastBeat < HEARTBEAT_IDLE_MS) continue;
				const session = sessionById.get(sid);
				if (!session) { beats.delete(sid); continue; }
				b.lastBeat = now;
				b.count = 0;
				beatNow(session, b);
			}
			if (now - lastSweep >= RETENTION_SWEEP_MS) {
				lastSweep = now;
				const removed = fold.retentionSweep(getSettings().retentionDays);
				if (removed?.length) log(`retention 清理 ${removed.length} 个过期归档`);
			}
		} catch (error) {
			log(`心跳扫描异常（忽略）: ${error?.message ?? error}`);
		}
	}, HEARTBEAT_SCAN_MS);
	timer.unref?.();
	Promise.resolve()
		.then(() => fold.retentionSweep(getSettings().retentionDays))
		.catch(() => { /* 启动清理失败不阻塞 */ });

	// ── session/event 观察（P1 入口；listener 异步副作用全部容错）──
	ctx.on("session/event", (session, event) => {
		try {
			const type = event?.type;
			const sid = session?.id;
			if (!sid) return;
			sessionById.set(sid, session);
			const data = event?.data ?? {};
			const turn = data.turn ?? null;
			const step = data.step ?? null;
			if (type === "assistant/message") {
				const msg = data.message ?? {};
				if (msg?.source?.plugin === PLUGIN_ID) return; // 自注入防回环
				beatTick(session, turn, step);
				if (!getSettings().enableJourney) return;
				const text = blocksToText(msg?.content);
				if (!text.trim()) return; // 纯 reasoning/空文本不入账
				const messageId = msg?.id ?? null;
				if (messageId && knownFor(sid).has(messageId)) return; // sourceMessageId 去重（重启补扫防双写）
				summarizer.enqueue(sid, { messageId, turn, step, text });
			} else if (type === "user/message") {
				const msg = data.message ?? {};
				if (msg?.source?.plugin) return; // 插件来源（含本插件注入）不算真人消息
				stall.onUserMessage(sid); // 真人消息：停滞计数与级动作状态全归零（§5.5）
			}
		} catch (error) {
			log(`session/event 处理异常（忽略）: ${error?.message ?? error}`);
		}
	});

	// ── agent/pre-step 注入（P3，默认关）+ stall 警示投递 ──
	async function deliver(payload, next, extraText) {
		const decision = await next();
		if (!extraText) return decision;
		if (decision?.kind === "reject" || !Array.isArray(decision?.messages)) return decision;
		const message = createUserMessage({
			content: [{ type: "text", text: extraText }],
			source: PLUGIN_SOURCE
		});
		return { ...decision, messages: [...decision.messages, message] };
	}

	ctx.on("agent/pre-step", async (payload, next) => {
		try {
			const sid = payload?.agent?.session?.id ?? null;
			const turn = payload?.turn ?? null;
			const step = payload?.step ?? null;
			const s = getSettings();
			let warningText = null;
			if (sid) {
				warningText = warnings.get(sid) ?? null;
				warnings.delete(sid); // 用后即删：警示只投递一次
			}
			if (!sid || !s.enableInjection || !s.enableJourney) {
				return deliver(payload, next, warningText);
			}
			let entries = [];
			let milestones = [];
			let wm = null;
			try {
				entries = store.readEntries(sid);
				milestones = store.readMilestones(sid);
				wm = store.loadWatermark(sid);
			} catch (error) {
				log(`账本读取失败（跳过注入）: ${error?.message ?? error}`);
				return deliver(payload, next, warningText);
			}
			if (entries.length === 0 && milestones.length === 0) {
				return deliver(payload, next, warningText); // 空账本：无内容可注入，头部行无意义
			}
			const built = buildInjectionPayload({
				entries,
				milestones,
				watermark: wm,
				currentTurn: turn,
				currentStep: step,
				excludeRecentSteps: EXCLUDE_RECENT_STEPS,
				recentN: s.recentN,
				tokenBudget: s.injectionTokenBudget
			});
			lastOverBudget.set(sid, !built.ok);
			if (!built.ok) {
				emitForModule(EVT.INJECTION_SKIPPED, { sessionId: sid, turn, step, suppressReason: built.suppressReason });
				triggerFold(sid, true); // 超预算 → 立即触发里程碑折叠
				return deliver(payload, next, warningText);
			}
			const text = warningText ? `${warningText}\n\n${built.text}` : built.text;
			return deliver(payload, next, text);
		} catch (error) {
			log(`pre-step 注入异常（fail-open 放行）: ${error?.message ?? error}`);
			return next();
		}
	});

	// ── 设置路由（P0）：GET 返回 schema；POST 合并校验后保存 ──
	const webServer = ctx.webServer;
	if (webServer && typeof webServer.register === "function") {
		webServer.register({
			kind: "exact",
			path: SETTINGS_ROUTE,
			async handler(req, res) {
				try {
					if (req.method === "GET") {
						sendJson(res, 200, {
							ok: true,
							schema: SETTINGS_SCHEMA,
							settings,
							defaults: DEFAULT_SETTINGS,
							capabilities: {
								llm: !!getLlm(),
								stepGovernor: !!getL2(),
								injection: settings.enableInjection === true,
								ledgerRoot
							}
						});
						return;
					}
					if (req.method === "POST") {
						const body = await readRequestBody(req);
						const patch = body && typeof body.settings === "object" && body.settings !== null ? body.settings : body;
						const r = applyRuntimeSettings(settings, patch ?? {});
						if (r.errors.length > 0) {
							sendJson(res, 400, { ok: false, errors: r.errors, warnings: r.warnings });
							return;
						}
						settings = r.settings;
						settingsStore.save(settings);
						sendJson(res, 200, { ok: true, settings, warnings: r.warnings });
						return;
					}
					sendJson(res, 405, { ok: false, error: "method not allowed" });
				} catch (error) {
					sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
				}
			}
		});
	} else {
		log("webServer 未就绪：设置路由未注册（inject 已声明 webServer，不应发生）");
	}

	// 卸载清理：心跳定时器（ctx.on 监听器由 cordis fiber 自动释放）。
	return () => {
		clearInterval(timer);
	};
}
