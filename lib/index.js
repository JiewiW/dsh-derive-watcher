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

import { EVT, PLUGIN_ID, PLUGIN_SOURCE, createEventSink } from "./events.js";
import {
	DEFAULT_SETTINGS,
	SETTINGS_SCHEMA,
	applyRuntimeSettings,
	firstRunGuards,
	makeSettingsStore
} from "./settings.js";
import { createJourneyStore, backfillFromSessionMessages } from "./journey-store.js";
import { createSummarizer, makeLlmCall, DEFAULT_TIMEOUT_MS } from "./summarizer.js";
import { createStallController } from "./stall.js";
import { createFold } from "./fold.js";
import { buildInjectionPayload, collectOpenObjectives } from "./injection.js";
import { createTimeline } from "./timeline.js";
import { createSilentAbortController, readStopReason } from "./silent-abort.js";

export const name = PLUGIN_ID;
export const inject = ["webServer"];

// PLUGIN_SOURCE（v4 producerKind：kind:"plugin:<id>" + plugin:<id>）自 events.js 导入；
// 静默中断续跑消息（I2）与既有注入消息共用同一来源形态，user/message 分支凭 source.plugin 识别（G3）。

const SETTINGS_ROUTE = "/plugins/derive-watcher/settings";
const TIMELINE_SESSIONS_ROUTE = "/plugins/derive-watcher/timeline/sessions";
const TIMELINE_ROUTE = "/plugins/derive-watcher/timeline";
const HEARTBEAT_SCAN_MS = 30000; // 心跳扫描周期
const HEARTBEAT_IDLE_MS = 60000; // 每 60s 至少一次心跳（§5.8：每分钟或每 5 事件）
const HEARTBEAT_EVENT_BURST = 5; // 每 5 个事件一次心跳
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

/** assistant/message content 块数组 → 纯文本（只取 text 块；reasoning 不入正式结论）。 */
function blocksToText(content) {
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
	}
	return typeof content === "string" ? content : "";
}

/** P0-2：content 块数组 → reasoning 文本（reasoning 块字段名是 text）。用于观测通道，不污染正式结论。 */
function blocksToReasoning(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "reasoning" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

/** P0-8：content 块数组是否含产物类块（tool-call / image / file）。 */
function contentHasArtifact(content) {
	if (!Array.isArray(content)) return false;
	return content.some((b) => b && (b.type === "tool-call" || b.type === "image" || b.type === "file"));
}

export function apply(ctx, config) {
	const log = (line) => console.warn(`[dsh-derive-watcher] ${line}`);

	// ── 设置（§5.6）：损坏回退默认并告警；首发钉定 enableStall3Reject=false ──
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
				log("首次运行：写入默认设置（enableInjection=true、enableStall2Deny/SoftCut=true，enableStall3Reject=false）");
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
	// P1-12：会话活跃度账本（sid → 最近一次事件墙钟）。TTL 清扫用；sessionById 仍存 Session 对象。
	const sessionActivity = new Map();
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
	// 最近一次成功总结的模型路由（供无单消息上下文的 fold 蒸馏复用）
	const lastRouteBySession = new Map();
	const callLlm = async (opts = {}) => {
		const llm = getLlm();
		if (!llm) return null;
		const s = getSettings();
		// 内核适配器错误以 finish/error 终块返回（流不抛异常），用 lastMeta 留证，
		// 把空文本翻译成带真因的结构化失败，避免上层统一误诊为"JSON 畸形"（NO_ADAPTER 事故教训）
		let lastMeta = null;
		const inner = makeLlmCall({
			llm,
			provider: s.summaryProvider || undefined,
			model: s.summaryModel || undefined,
			source: PLUGIN_SOURCE,
			onMeta: (meta) => {
				lastMeta = meta;
				// P2-22④ 截断/耗时埋点
				if (meta?.truncationSuspect) {
					log(`[dsh-derive-watcher] summary 疑似截断 finishKind=${meta.finishKind} outputTokens=${meta.outputTokens} elapsedMs=${meta.elapsedMs} purpose=${meta.purpose}`);
				}
				if (meta?.failureCode) {
					log(`[dsh-derive-watcher] summary LLM 失败 code=${meta.failureCode} provider=${meta.provider ?? "undefined"} model=${meta.model ?? "undefined"} purpose=${meta.purpose}: ${meta.failureMessage ?? ""}`);
				}
				// 超时留证：aborted 无 failureCode，单独记录实际耗时与路由，供区分渠道慢/队列排队（2026-10-14 30s 间歇超时排查）
				if (meta?.aborted) {
					log(`[dsh-derive-watcher] summary 调用超时 aborted elapsedMs=${meta.elapsedMs} provider=${meta.provider ?? "undefined"} model=${meta.model ?? "undefined"} purpose=${meta.purpose}`);
				}
			}
		});
		const text = await inner(opts);
		if (typeof text === "string" && text) return text;
		if (lastMeta?.failureCode === "NO_ADAPTER") {
			return { ok: false, grade: "no-adapter", reason: `总结器无可用模型路由（provider=${lastMeta.provider ?? "undefined"}，NO_ADAPTER：${lastMeta.failureMessage ?? "未注册适配器"}），跳过并记 gap` };
		}
		if (lastMeta?.aborted) {
			return { ok: false, grade: "timeout", reason: "总结器调用超时（aborted），跳过并记 gap" };
		}
		if (lastMeta?.failureCode) {
			return { ok: false, grade: "other", reason: `总结器调用失败（${lastMeta.failureCode}：${lastMeta.failureMessage ?? "未知错误"}），跳过并记 gap` };
		}
		return { ok: false, grade: "empty", reason: "总结器返回空文本（无内容且无错误终块），跳过并记 gap" };
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

	// ── cot-anchor 软切服务：不可用返回 null（fail-open，与 getL2 同策略）──
	const getCotAnchor = () => {
		for (const key of ["cotAnchor", "dsh-cot-anchor", "cot-anchor"]) {
			try {
				const s = ctx.get(key);
				if (s) return s;
			} catch { /* 服务未提供 */ }
		}
		return null;
	};

	// ── 静默中断弱探测（计划书 §2.3/§7-④）：agents/goals/agent-notify 缺失一律 null（G6 fail-open）──
	const getAgentsService = () => {
		try {
			const s = ctx.get("agents");
			return s ?? null;
		} catch { /* 服务未提供 */ }
		return null;
	};
	const getGoalsService = () => {
		try {
			const s = ctx.get("goals");
			return s ?? null;
		} catch { /* 服务未提供 */ }
		return null;
	};
	const getNotifyService = () => {
		try {
			const s = ctx.get("agent-notify");
			return s ?? null;
		} catch { /* 服务未提供 */ }
		return null;
	};

	// ── stall-3 交接账本 + 续跑种子（单 JSON 文件：里程碑+open objectives+最近结论+artifacts）──
	async function writeHandoff(sessionId, meta = {}) {
		const entries = store.readEntries(sessionId);
		const milestones = store.readMilestones(sessionId);
		const objectives = collectOpenObjectives(entries, milestones);
		const maxStep = entries.reduce((m, e) => (Number.isFinite(e.step) && e.step > m ? e.step : m), 0);
		const exclRs = Math.max(0, Math.min(5, Math.trunc(getSettings().excludeRecentSteps) || 2));
		const isRecent = (e) => Number.isFinite(e.step) && e.step >= maxStep - exclRs + 1;
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
			`- 最近结论（排除最近 ${exclRs} 步）：`,
			...recent.slice(-8).map((e) => `  - [${e.kind}] ${e.summary}`),
			""
		].join("\n");
		writeFileSync(handoffPath, md, "utf8");
		return { path: handoffPath, seedPath };
	}

	// ── stall 状态机（§5.5 全口径；emit 两参）──
	// 步骤4：reasoning-stall 仅写观察账本（kind="reasoning-stall"）+ 提示/日志，
	// 不进 stall.onEntries、不触发 stall-2/3 的 deny/reject。观察水位由 live 正常路径统一推进，此处不重复写。
	const stall = createStallController({
		emit: emitForModule, log, getSettings, getL2, getCotAnchor, writeHandoff,
		onReasoningStall: (sid, info = {}) => {
			if (!Number.isFinite(info.step)) return;
			try {
				store.appendObservation(sid, {
					kind: "reasoning-stall",
					turn: info.turn ?? null, step: info.step,
					hasText: false, textLen: 0, reasoningLen: 0, hasArtifact: false,
					message: typeof info.message === "string" ? info.message : null
				});
			} catch (error) {
				log(`reasoning-stall 观察账本写入失败 session=${sid} step=${info.step}: ${error?.message ?? error}`);
			}
		}
	});

	// ── 折叠（§5.3）：阈值/超预算异步触发，逐会话串行链防重入 ──
	// 超时阈值走设置项 summaryTimeoutSec（秒→毫秒）：侧栏刷「调用超时」时用户可自行调大/换模型
	const summaryTimeoutMs = () => {
		const sec = Number(getSettings()?.summaryTimeoutSec);
		return Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_TIMEOUT_MS;
	};

	// ── 静默中断控制器（计划书 §3–§5，P1）：A 类检测 + 四模式投递 + 安全闸 ──
	// 冷却到点后由控制器按 C1 模式投递续跑指令（I1–I3）：followup=向原窗口 agent.followup() 发 <silent-resume> 模板；
	// goal-resume=先 goals.resume()，无 goal 或抛错回退 followup，再回退 notify。
	// 全部入口 fail-open（G6/D8）：异常只落事件与日志，禁止抛穿 session/event 主流程。
	const silentAbort = createSilentAbortController({
		emit: emitForModule,
		log,
		getSettings,
		getAgents: getAgentsService,
		getGoals: getGoalsService,
		getNotify: getNotifyService
	});
	const fold = createFold({ store, emit: emitForModule, log, callLlm, timeoutMs: summaryTimeoutMs() });
	const foldChains = new Map();
	function triggerFold(sessionId, overBudget) {
		const s = getSettings();
		if (!s.enableMilestoneFold || !s.enableJourney) return;
		const prev = foldChains.get(sessionId) ?? Promise.resolve();
		const nextRun = prev.catch(() => {}).then(async () => {
			try {
				const r = await fold.maybeFold(sessionId, { recentN: s.recentN, overBudget: overBudget === true, route: lastRouteBySession.get(sessionId) ?? null });
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
	const lastInjectStep = new Map(); // sessionId → 上次成功注入的 step（间隔控制：injectionStepInterval 步差≥interval 才触发）

	// ── summarizer（P1）──
	const summarizer = createSummarizer({
		store,
		emit: emitForModule,
		log,
		getSettings,
		callLlm,
		timeoutMs: summaryTimeoutMs(), // 设置项可调：summaryTimeoutSec（秒）→ 毫秒
		embed: null, // embedding 可选：宿主无嵌入通路时 novelty 回退 schema-selfcheck（novelty.js fallback）
		onSummarized: (sessionId, { entries, messageId, provider = null, model = null, channel = "text" }) => {
			// reasoning 通道的提炼是非正式结论：不进 text 去重簿、不驱动 stall-2/3（onEntries）、不触发里程碑 fold
			if (channel === "reasoning") return;
			if (messageId) {
				try { knownFor(sessionId).add(messageId); } catch { /* ignore */ }
			}
			if (provider || model) lastRouteBySession.set(sessionId, { provider: provider || null, model: model || null });
			let r = null;
			try { r = stall.onEntries(sessionId, entries); } catch (error) {
				log(`stall 判定异常（fail-open）: ${error?.message ?? error}`);
			}
			if (r?.warningText) warnings.set(sessionId, r.warningText);
			triggerFold(sessionId, lastOverBudget.get(sessionId) === true);
		},
		onGap: (sessionId, meta) => {
			// 通道隔离：reasoning 路的降级 gap 不进入 text 停滞状态机（reasoning 不驱动 stall-2/3）
			if (meta?.channel === "reasoning") return;
			try { stall.onGap(sessionId, meta); } catch { /* ignore */ }
		}
	});

	// ── 步骤3：text / reasoning 双通道分流（live 与 P1-13 重启补扫共用同一函数，禁止复制两份分叉）──
	// 入参 content 为助手消息 content 块数组；本函数内部统一计算 text/reasoning 文本与活跃标志。
	// reasoning 原文只在内存传给 summarizer，绝不落入观察账本（观察账本仍只存 reasoningLen 长度）。
	// forceChannel：补扫路径已按各通道水位过滤，据此强制入对应通道，不按内容重新猜通道；
	//               live 路径不传（null），按 hasText / reasoningLen 内容分流。
	// 返回 { text:boolean, reasoning:boolean } 表示各通道是否实际入队。
	function dispatchStepChannels(sid, msg, turn, step, forceChannel = null) {
		const result = { text: false, reasoning: false };
		const content = msg?.content;
		const text = blocksToText(content);
		const reasoningText = blocksToReasoning(content);
		const hasText = text.trim().length > 0;
		const hasReasoning = reasoningText.trim().length > 0;
		const messageId = msg?.id ?? null;
		const provider = msg?.source?.provider ?? null;
		const model = msg?.source?.model ?? null;

		// text 通道：有正式输出块才入队（reasoning-only step 不进正式结论队列）
		if (forceChannel !== "reasoning" && hasText) {
			if (!(messageId && knownFor(sid).has(messageId))) {
				summarizer.enqueue(sid, {
					sourceKind: "text",
					messageId, turn, step, text,
					provider, model
				});
				result.text = true;
			}
		}
		// reasoning 通道：无正式 text 但有 reasoning 块时入队；enableReasoningJourney 仅显式 false 时关闭（默认开；步骤6在 settings 落默认值 true）
		if (forceChannel !== "text" && !hasText && hasReasoning && getSettings().enableReasoningJourney !== false) {
			summarizer.enqueue(sid, {
				sourceKind: "reasoning",
				messageId, turn, step, text: reasoningText,
				provider, model
			});
			result.reasoning = true;
		}
		return result;
	}

	// ── P1-13：重启补扫（按观察水位与结论水位，幂等）──
	// listEvents 返回升序事件数组（含 type/data，可重放）。进程内每会话只补扫一次。
	const backfilledSessions = new Set();
	function getSessionQuery() {
		try { return ctx.get("sessionQuery"); } catch { return null; }
	}
	function backfillSession(sid) {
		if (backfilledSessions.has(sid)) return;
		backfilledSessions.add(sid);
		const query = getSessionQuery();
		if (!query || typeof query.listEvents !== "function") return;
		let records = [];
		try { records = query.listEvents(sid) ?? []; } catch (error) {
			log(`P1-13 补扫读取事件失败 ${sid}: ${error?.message ?? error}`);
			return;
		}
		// ① 观察通道：按观察水位补写观察条目（幂等：水位单调推进）
		try {
			const obsPending = backfillFromSessionMessages(records, store.loadObservationWatermark(sid));
			let obsAdded = 0;
			for (const ev of obsPending) {
				const step = Number.isFinite(ev?.data?.step) ? ev.data.step : null;
				if (!Number.isFinite(step)) continue;
				const msg = ev?.data?.message ?? {};
				const content = msg?.content;
				const text = blocksToText(content);
				const reasoningLen = blocksToReasoning(content).trim().length;
				const hasArtifact = contentHasArtifact(content);
				const hasText = text.trim().length > 0;
				if (hasText || reasoningLen > 0 || hasArtifact) {
					store.appendObservation(sid, { turn: ev?.data?.turn ?? null, step, hasText, textLen: text.length, reasoningLen, hasArtifact });
					store.saveObservationWatermark(sid, { lastStepSeq: step });
					obsAdded++;
				}
			}
			if (obsAdded) log(`P1-13 重启补扫 ${sid}: 补写 ${obsAdded} 条观察`);
		} catch (error) {
			log(`P1-13 观察补扫失败 ${sid}: ${error?.message ?? error}`);
		}
		// ② 结论通道：text / reasoning 各按本通道水位补扫入队（进程内队列丢失不永久漏账；knownFor/seen 去重防双写）
		try {
			const textPending = backfillFromSessionMessages(records, store.loadWatermark(sid, "text"));
			const reasoningPending = backfillFromSessionMessages(records, store.loadWatermark(sid, "reasoning"));
			let textEnqueued = 0;
			let reasoningEnqueued = 0;
			const backfillOne = (ev, forceChannel) => {
				const msg = ev?.data?.message ?? {};
				if (msg?.source?.plugin === PLUGIN_ID) return; // 防回环冗余
				const r = dispatchStepChannels(sid, msg, ev?.data?.turn ?? null,
					Number.isFinite(ev?.data?.step) ? ev.data.step : null, forceChannel);
				textEnqueued += r.text ? 1 : 0;
				reasoningEnqueued += r.reasoning ? 1 : 0;
			};
			for (const ev of textPending) backfillOne(ev, "text");
			for (const ev of reasoningPending) {
				// reasoning 通道只在开关开启时补扫（与 live 一致；显式 false 关闭则跳过，观察补扫不受影响）
				if (getSettings().enableReasoningJourney !== false) backfillOne(ev, "reasoning");
			}
			if (textEnqueued) log(`P1-13 重启补扫 ${sid}: 补入队 ${textEnqueued} 条结论`);
			if (reasoningEnqueued) log(`P1-13 重启补扫 ${sid}: 补入队 ${reasoningEnqueued} 条推理提炼`);
		} catch (error) {
			log(`P1-13 结论补扫失败 ${sid}: ${error?.message ?? error}`);
		}
	}

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
	// P1-12：会话 TTL（turn/end 或最后事件后 sessionTtlMinutes 分钟无新事件 → 删除会话与心跳）。
	function pruneStaleSessions(now) {
		const ttlMs = Math.round(getSettings().sessionTtlMinutes || 10) * 60_000;
		let pruned = 0;
		for (const [sid, lastEvent] of sessionActivity) {
			if (now - lastEvent >= ttlMs) {
				sessionById.delete(sid);
				sessionActivity.delete(sid);
				beats.delete(sid);
				try { silentAbort.forgetSession(sid); } catch { /* 静默中断状态清理失败不阻塞（fail-open） */ }
				pruned++;
			}
		}
		return pruned;
	}
	// P1-12：心跳扫描，独立出可测函数（now 注入，禁真实 sleep）。只对活跃会话 append，死会话不写盘。
	function runHeartbeatSweep(now) {
		for (const [sid, b] of beats) {
			const session = sessionById.get(sid);
			// 无活跃会话（已 TTL 回收/主动清理）→ 删除心跳，不再 append（死会话不写盘）
			if (!session) { beats.delete(sid); continue; }
			if (now - b.lastBeat < HEARTBEAT_IDLE_MS) continue;
			b.lastBeat = now;
			b.count = 0;
			beatNow(session, b);
		}
	}
	const timer = setInterval(() => {
		try {
			const now = Date.now();
			pruneStaleSessions(now);
			runHeartbeatSweep(now);
			// 静默中断（D7/G2）：冷却到期复用本 30s 扫描，不另起定时器；异常 fail-open
			silentAbort.onSweep(now);
		} catch (error) {
			log(`心跳扫描异常（忽略）: ${error?.message ?? error}`);
		}
	}, HEARTBEAT_SCAN_MS);
	timer.unref?.();
	// P1-12：retention 清扫独立于 30s 心跳定时器（独立 1h 定时器 + 启动一次）。
	const retentionTimer = setInterval(() => {
		try {
			if (Date.now() - lastSweep < RETENTION_SWEEP_MS) return;
			lastSweep = Date.now();
			const removed = fold.retentionSweep(getSettings().retentionDays, getSettings().ledgerRetentionDays || 0);
			if (removed?.length) log(`retention 清理 ${removed.length} 个过期归档`);
		} catch (error) {
			log(`retention 清扫异常（忽略）: ${error?.message ?? error}`);
		}
	}, HEARTBEAT_SCAN_MS);
	retentionTimer.unref?.();
	Promise.resolve()
		.then(() => fold.retentionSweep(getSettings().retentionDays, getSettings().ledgerRetentionDays || 0))
		.catch(() => { /* 启动清理失败不阻塞 */ });

	// ── session/event 观察（P1 入口；listener 异步副作用全部容错）──
	ctx.on("session/event", (session, event) => {
		try {
			const type = event?.type;
			const sid = session?.id;
			if (!sid) return;
			sessionById.set(sid, session);
			// P1-12：任何事件（含 turn/end）都刷新活跃度，供 TTL 清扫
			sessionActivity.set(sid, Date.now());
			// P1-13：会话首个事件触发一次性补扫（幂等；按观察/结论水位跳过已处理 step）
			backfillSession(sid);
			const data = event?.data ?? {};
			const turn = data.turn ?? null;
			const step = data.step ?? null;
			if (type === "assistant/message") {
				const msg = data.message ?? {};
				if (msg?.source?.plugin === PLUGIN_ID) return; // 自注入防回环
				beatTick(session, turn, step);
				// 静默中断旁路（§7-②）：记录每会话末条 assistant 消息元信息（stopReason/textLen/末块类型），
				// 不动既有 stall 喂数；U1：stopReason 从 source.replayState.response 启发式读取，取不到 "unknown"。
				try {
					const contentBlocks = Array.isArray(msg?.content) ? msg.content : [];
					const lastBlock = contentBlocks.length > 0 ? contentBlocks[contentBlocks.length - 1] : null;
					silentAbort.onAssistantMessage(sid, {
						turn, step,
						textLen: blocksToText(msg?.content).length,
						stopReason: readStopReason(data),
						lastBlockType: typeof lastBlock?.type === "string" ? lastBlock.type : null
					});
				} catch (error) {
					log(`静默中断旁路记录异常（忽略）: ${error?.message ?? error}`);
				}
				if (!getSettings().enableJourney) return;
				const content = msg?.content;
				const text = blocksToText(content);
				const reasoningLen = blocksToReasoning(content).trim().length;
				const hasArtifact = contentHasArtifact(content);
				const hasText = text.trim().length > 0;
				// P0-8：观察旁路（不依赖总结产物即可见 step 活动状）——每步都喂，barren 判定由 stall 负责
				try {
					stall.onObservation(sid, { turn, step, ts: Date.now(), hasText, textLen: text.length, reasoningLen, hasArtifact });
				} catch (error) {
					log(`stall.onObservation 异常（忽略）: ${error?.message ?? error}`);
				}
				// P0-2：reasoning-only/纯产物 step 也写观察账本（独立通道，不污染正式结论 entry）
				if ((hasText || reasoningLen > 0 || hasArtifact) && Number.isFinite(step)) {
					try {
						store.appendObservation(sid, { turn, step, hasText, textLen: text.length, reasoningLen, hasArtifact });
						// P0-2/P1-13：live 观察写入同时推进观察水位，保证重启补扫幂等（step≤水位即跳过）
						store.saveObservationWatermark(sid, { lastStepSeq: step });
					} catch (error) {
						log(`观察账本写入失败 session=${sid} step=${step}: ${error?.message ?? error}`);
					}
				}
				// text/reasoning 双通道分流（live 与 P1-13 补扫共用 dispatchStepChannels，禁止分叉）；
				// 纯 reasoning step 不入 text 队列、改入 reasoning 队列；enableReasoningJourney=false 时 reasoning 不入队
				dispatchStepChannels(sid, msg, turn, step);
			} else if (type === "user/message") {
				// 内核 user/message 直挂 message（source 在 data.source）；历史/其他来源可能包裹在 data.message。
				const source = data?.source ?? data?.message?.source ?? null;
				if (source?.plugin) return; // 插件来源（含本插件注入/静默中断续跑）不算真人消息（G3 防回环）
				stall.onUserMessage(sid); // 真人消息：停滞计数与级动作状态全归零（§5.5）
				try { silentAbort.onUserMessage(sid); } catch (error) { log(`静默中断真人复位异常（忽略）: ${error?.message ?? error}`); }
			} else if (type === "turn/start") {
				// 静默中断（D2-②）：冷却窗内新 turn 让位；RESUMED 后登记续跑 turn（G5 计数起点）
				try { silentAbort.onTurnStart(sid, Number.isFinite(turn) ? turn : null); } catch (error) { log(`静默中断 turn/start 异常（忽略）: ${error?.message ?? error}`); }
			} else if (type === "turn/end") {
				// 静默中断主判据（D7）：turn/end 到达即判定，interrupt 类进冷却、不立即续
				try { silentAbort.onTurnEnd(sid, Number.isFinite(turn) ? turn : null, data?.reason ?? null, Date.now()); } catch (error) { log(`静默中断 turn/end 异常（忽略）: ${error?.message ?? error}`); }
			} else if (type === "tool/call") {
				// 静默中断（G5）：续跑 turn 内 tool/call 进展计数
				try { silentAbort.onToolCall(sid, Number.isFinite(turn) ? turn : null); } catch (error) { log(`静默中断 tool/call 计数异常（忽略）: ${error?.message ?? error}`); }
			} else if (type === "step/start") {
				// 静默中断（G5）：续跑 turn 内 step 进展计数
				try { silentAbort.onStepStart(sid, Number.isFinite(turn) ? turn : null, Number.isFinite(step) ? step : null); } catch (error) { log(`静默中断 step 计数异常（忽略）: ${error?.message ?? error}`); }
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
				// P2-21②：enableInjection=false 时封住投递通道——警示文本也不经 deliver 追加
				//（避免"绕开关"：禁用后仍向 agent 注入本插件文本）。enableJourney=false 时监控未跑，
				// 无警示累积，warningText 亦为 null，透传语义不变。
				return deliver(payload, next, !s.enableInjection ? null : warningText);
			}
			// ── 间隔控制：每 injectionStepInterval 步才注入一次；停滞告警 + enableOnStall 强制放行 ──
			const interval = Math.max(1, Math.min(20, Math.trunc(s.injectionStepInterval) || 1));
			const hasStallWarning = !!warningText;
			const forceByStall = hasStallWarning && s.injectionEnableOnStall !== false;
			const lastStep = lastInjectStep.get(sid);
			const gatePass = lastStep == null || !Number.isFinite(step)
				? true // 首次注入或 step 未知：放行
				: (step - lastStep >= interval) || forceByStall;
			if (!gatePass) {
				// 间隔未到：跳过注入（不读账本、不组装 payload）；告警若有也跳过（让它下次或自然消失）
				return deliver(payload, next, null);
			}
			let entries = [];
			let milestones = [];
			let reasoningEntries = [];
			let wm = null;
			try {
				entries = store.readEntries(sid);
				milestones = store.readMilestones(sid);
				// 步骤5：reasoning 独立账本单独读取，仅用于注入独立分区；enableReasoningJourney=false 时不读。
				reasoningEntries = s.enableReasoningJourney !== false ? store.readReasoningEntries(sid) : [];
				wm = store.loadWatermark(sid);
			} catch (error) {
				log(`账本读取失败（跳过注入）: ${error?.message ?? error}`);
				return deliver(payload, next, warningText);
			}
			if (entries.length === 0 && milestones.length === 0 && reasoningEntries.length === 0) {
				return deliver(payload, next, warningText); // 空账本：无内容可注入，头部行无意义
			}
			const built = buildInjectionPayload({
				entries,
				milestones,
				reasoningEntries,
				watermark: wm,
				currentTurn: turn,
				currentStep: step,
				excludeRecentSteps: s.excludeRecentSteps,
				recentN: s.recentN,
				reasoningRecentN: s.reasoningRecentN,
				tokenBudget: s.injectionTokenBudget,
				objectiveLimit: s.injectionObjectiveLimit,
				deadEndLimit: s.injectionDeadEndLimit
			});
			// 降级（预算吃紧、只保留最近要点）不再算失败：照常注入、只额外触发折叠；
			// 只有连一条压缩要点都放不下才发注入跳过事件。
			lastOverBudget.set(sid, !built.ok || built.degraded === true);
			if (!built.ok) {
				emitForModule(EVT.INJECTION_SKIPPED, { sessionId: sid, turn, step, suppressReason: built.suppressReason });
				triggerFold(sid, true); // 超预算 → 立即触发里程碑折叠
				return deliver(payload, next, warningText);
			}
			if (built.degraded === true) triggerFold(sid, true); // 预算吃紧 → 折叠旧内容以防持续降级
			lastInjectStep.set(sid, Number.isFinite(step) ? step : Date.now()); // 成功注入 → 推进水位；step 未知时兜底用时间戳
			const text = warningText ? `${warningText}\n\n${built.text}` : built.text;
			return deliver(payload, next, text);
		} catch (error) {
			log(`pre-step 注入异常（fail-open 放行）: ${error?.message ?? error}`);
			return next();
		}
	});

	// ── 设置路由（P0）：GET 返回 schema；POST 合并校验后保存 ──
	const webServer = ctx.webServer;
	const timeline = createTimeline({ store, ledgerRoot, getSessionQuery, log });
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
								cotAnchor: !!getCotAnchor(),
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

	// ── timeline 路由（v0.2.0 步骤2）：只读聚合，四来源归并；任何分支不抛未捕获异常 ──
	if (webServer && typeof webServer.register === "function") {
		webServer.register({
			kind: "exact",
			path: TIMELINE_SESSIONS_ROUTE,
			async handler(req, res) {
				try {
					if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed" }); return; }
					const view = await timeline.listSessionsView();
					sendJson(res, 200, { ok: true, ...view });
				} catch (error) {
					log(`timeline/sessions 路由异常: ${error?.message ?? error}`);
					sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
				}
			}
		});
		webServer.register({
			kind: "exact",
			path: TIMELINE_ROUTE,
			async handler(req, res) {
				try {
					if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed" }); return; }
					let params;
					try { params = new URL(req.url ?? "", "http://local"); } catch { params = null; }
					const sessionId = params?.searchParams.get("sessionId") ?? "";
					if (!sessionId) { sendJson(res, 400, { ok: false, error: "缺少 sessionId 查询参数" }); return; }
					const limit = params.searchParams.get("limit");
					const result = await timeline.timelineFor(sessionId, limit);
					if (result.notFound) {
						sendJson(res, 404, { ok: false, error: "该会话没有语义账本", sessionId });
						return;
					}
					sendJson(res, 200, { ok: true, ...result });
				} catch (error) {
					log(`timeline 路由异常: ${error?.message ?? error}`);
					sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
				}
			}
		});
	}

	// 卸载清理：心跳 + retention 定时器 + 静默中断状态（ctx.on 监听器由 cordis fiber 自动释放）。
	const dispose = () => {
		clearInterval(timer);
		clearInterval(retentionTimer);
		try { silentAbort.destroy(); } catch { /* 卸载清理失败不阻塞 */ }
	};
	// P1-12 测试钩子（时钟推进单测，禁止真实 sleep）：函数本体保留 dispose 契约，属性挂可测入口。
	dispose.pruneStaleSessions = pruneStaleSessions;
	dispose.getDebugState = () => {
		const s = summarizer.stats();
		return {
			sessionCount: sessionById.size,
			activityCount: sessionActivity.size,
			beatCount: beats.size,
			// 步骤3测试钩子：双通道累计入队/在队计数，用于断言纯 reasoning step 只入 reasoning 队列
			summaryEnqueued: {
				text: s.byChannel?.text?.enqueued ?? 0,
				reasoning: s.byChannel?.reasoning?.enqueued ?? 0
			},
			summaryQueued: {
				text: s.byChannel?.text?.queued ?? 0,
				reasoning: s.byChannel?.reasoning?.queued ?? 0
			}
		};
	};
	return dispose;
}
