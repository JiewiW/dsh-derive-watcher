/**
 * dsh-derive-watcher — summarizer（计划书 §5.1）。
 *
 * 双通道（sourceKind 必须显式传入，禁止隐式默认）：
 *  - "text"：助手正式输出块 → 正式结论账本（KINDS），维持原有全部语义；
 *  - "reasoning"：type==="reasoning" 思考块聚合 → 独立推理提炼账本（REASONING_KINDS）。
 *    推理提炼永远是“过程性信息”，不是已确认事实/最终答案（独立 prompt 强制约束）。
 *
 * 通道隔离（互不污染、互不熔断、互不挤兑）：
 *  - 队列/seen 去重/水位/熔断计数/降级统计 均按通道独立；
 *  - 候选窗口只读本通道历史（text=recentN，reasoning=reasoningRecentN）；
 *  - 两通道共用 maxConcurrency 并发闸，调度采用“text 优先的轮转”：
 *    上次服务 text 则下一拍先看 reasoning，反之亦然；某通道空时另一通道照常连续推进。
 *    并发=1（默认）时两通道严格交替，reasoning 积压不可能饿死 text。
 *
 * 其余不变：flash 钉定、30s 超时、草稿/自检畸形各重试 1 次、fail-open、
 * 队列上限 8（每通道各 8）溢出丢最旧记 gap、水位每会话每通道单调推进。
 *
 * LLM 通路可注入：callLlm({system, prompt, sessionId, purpose, timeoutMs}) → text|null。
 */
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { EVT } from "./events.js";
import { KINDS, REASONING_KINDS } from "./journey-store.js";
import {
	SELFCHECK_SYSTEM_PROMPT, buildSelfcheckPrompt, parseSelfcheckJson,
	lexicalCheck, decideNovelty, signatureOf, embeddingCheck
} from "./novelty.js";

export const QUEUE_CAP = 8;
export const DEFAULT_TIMEOUT_MS = 30000;

/** 合法通道字面量（与 journey-store CHANNELS 对齐）。 */
export const SOURCE_KINDS = ["text", "reasoning"];

/** P2-21①：seen 簿键的唯一同构来源——带通道前缀，messageId 存在用之，否则退化 turn/step 键。 */
export function enqueueKeyOf(sessionId, j) {
	const job = j ?? {};
	const channel = job.sourceKind === "reasoning" ? "reasoning" : "text";
	return `${channel}:${sessionId}/${job.messageId ?? `${job.turn ?? "?"}/${job.step ?? "?"}`}`;
}

export const DRAFT_SYSTEM_PROMPT = [
	"你是会话旅程记录器。阅读一段助手消息文本，提炼其中值得跨步骤长期记住的结论（发现/决定/死胡同/假设/计划/事实）。",
	"只输出一个 JSON 对象，格式：",
	'{"entries":[{"kind":"finding|decision|dead-end|hypothesis|plan|fact","summary":"一句话结论","detail":"补充细节，可为空串","artifacts":["文件或产物路径"],"supersedes":["被取代的早期结论 id"],"confidence":0.0}]}',
	'没有值得记录的内容时输出 {"entries":[]}。禁止输出其它文字。'
].join("\n");

export function buildDraftPrompt({ turn, step, text }) {
	const clipped = typeof text === "string" ? text.slice(0, 8000) : "";
	return `【turn】${turn ?? "?"}\n【step】${step ?? "?"}\n【助手消息】\n${clipped}\n\n请输出 JSON。`;
}

/**
 * reasoning 通道专用 system prompt：只提炼推理过程中的决策/假设/自我修正/放弃方案/下一步计划，
 * 明确禁止事实结论/final answer；kind 仅可取 REASONING_KINDS。
 */
export const REASONING_SYSTEM_PROMPT = [
	"你是会话推理过程记录器。阅读一段模型的推理（thinking）原文，只提炼推理过程中值得跨步骤留存的过程性信息：",
	"推理中的决策、提出的假设/猜测、自我修正（推翻或更正前判）、放弃的方案/走不通的路、下一步计划。",
	"严禁把推理内容当作已确认事实或最终答案；这些只是中间思考，禁止输出事实结论（finding/fact）或 final answer。",
	"只输出一个 JSON 对象，格式：",
	'{"entries":[{"kind":"r-decision|r-hypothesis|r-self-correction|r-dead-end|r-plan","summary":"一句话过程性提炼","detail":"补充细节，可为空串","artifacts":[],"supersedes":[],"confidence":0.0}]}',
	"kind 含义：r-decision=推理中做出的决策；r-hypothesis=提出的假设/猜测；r-self-correction=自我修正/推翻前判；r-dead-end=放弃的方案或走不通的路；r-plan=下一步计划。",
	'没有值得记录的过程性信息时输出 {"entries":[]}。禁止输出其它文字。'
].join("\n");

/** reasoning 通道草稿 prompt：与 text 同构但标注为推理块，8000 字截断。 */
export function buildReasoningPrompt({ turn, step, text }) {
	const clipped = typeof text === "string" ? text.slice(0, 8000) : "";
	return `【turn】${turn ?? "?"}\n【step】${step ?? "?"}\n【模型推理原文（非正式输出）】\n${clipped}\n\n请输出 JSON。`;
}

/**
 * 松散 JSON 提取：接受围栏包裹或裸对象。P2-22：初始解析失败时尝试一次括号配对修复
 * （补缺失尾部右括号/消除尾部孤括号后重试），避免一个缺失右大括号就误判畸形触发 retry/gap。
 */
export function parseJsonObject(text) {
	if (typeof text !== "string") return null;
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const rawBody = fenced ? fenced[1] : text;
	const start = rawBody.indexOf("{");
	const end = rawBody.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	const candidate = rawBody.slice(start, end + 1);
	let obj = null;
	try {
		obj = JSON.parse(candidate);
	} catch {
		obj = repairJson(candidate);
	}
	return obj !== null && typeof obj === "object" ? obj : null;
}

/**
 * P2-22：括号配对修复（只做一次、只补尾部）。
 * 策略：按缺尾的常见形态，在 candidate 后追加 0..N 个 `}` 或 `]`/`}` 组合，取首个能成功解析者
 * （应对单个/多个缺失右括号、以及 `{"entries":[...` 这类同时丢 `]} ` 的截断）。仍失败则返回 null。
 */
function repairJson(candidate) {
	// 覆盖缺单个/多个右大括号、缺 `]}`（数组未闭合）两种常见截断形态。
	const tails = [];
	for (let n = 1; n <= 4; n += 1) tails.push("}".repeat(n));
	tails.push("]}", "}])", "]}");
	for (const tail of tails) {
		try {
			const repaired = JSON.parse(candidate + tail);
			if (repaired !== null && typeof repaired === "object") return repaired;
		} catch { /* 继续尝试 */ }
	}
	return null;
}

/**
 * 草稿解析（P0-3）：区分三种结果——
 *  - ok=true, drafts 非空  → 解析成功且有有效条目；
 *  - ok=true, drafts=[]    → 解析成功且 entries 为空数组（正常空结果，push 水位、不记 gap、不重试）；
 *  - ok=false, drafts=[]   → 解析失败/畸形（才重试/记 gap）。
 * channel 决定合法 kind 集合（text=KINDS，reasoning=REASONING_KINDS）。
 */
export function draftParse(text, channel = "text") {
	const parsed = parseJsonObject(text);
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
		return { ok: false, drafts: [] };
	}
	return { ok: true, drafts: extractDraftEntries(text, channel) };
}

/** 解析草稿输出：非法条目（kind 不在本通道合法集合 / summary 空）静默丢弃，返回有效 drafts。 */
export function extractDraftEntries(text, channel = "text") {
	const allowedKinds = channel === "reasoning" ? REASONING_KINDS : KINDS;
	const parsed = parseJsonObject(text);
	if (!parsed || !Array.isArray(parsed.entries)) return [];
	const out = [];
	for (const raw of parsed.entries) {
		if (!raw || typeof raw !== "object") continue;
		const kind = allowedKinds.includes(raw.kind) ? raw.kind : null;
		const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
		if (!kind || !summary) continue;
		out.push({
			kind,
			summary,
			detail: typeof raw.detail === "string" ? raw.detail : "",
			artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.filter((a) => typeof a === "string") : [],
			supersedes: Array.isArray(raw.supersedes) ? raw.supersedes.filter((x) => typeof x === "string") : [],
			confidence: typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : null
		});
	}
	return out;
}

/**
 * 默认 LLM 调用（flash 钉定由 provider/model 传参决定，留空跟随宿主）。
 * 独立 AbortController + timeoutMs 超时；失败/空回复返回 null（fail-open 由上层处理）。
 * P2-22①④⑥：jsonMode 支持时透传 JSON-mode；onMeta 回调透出 finish_reason/usage/单次耗时（截断证据埋点）。
 */
export function makeLlmCall({ llm, provider, model, source, jsonMode = false, onMeta = null }) {
	return async function callLlm({ system, prompt, sessionId, purpose = "semantic-watcher", timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal, provider: callProvider = null, model: callModel = null } = {}) {
		if (!llm || typeof llm.stream !== "function") return null;
		// 路由优先级：单次调用显式传入（取自被总结消息的 source）> 构造闭包设置（settings）> undefined 跟随宿主
		const effectiveProvider = callProvider || provider || undefined;
		const effectiveModel = callModel || model || undefined;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let fallbackTimer = null;
		const startedAt = Date.now();
		const meta = { purpose, provider: effectiveProvider, model: effectiveModel, startedAt, finishedAt: null, elapsedMs: null, finishReason: null, finishKind: null, outputTokens: null, truncationSuspect: false, aborted: false, failureCode: null, failureMessage: null };
		let emittedMeta = false;
		const emitMeta = () => {
			if (!emittedMeta && typeof onMeta === "function") {
				emittedMeta = true;
				try { onMeta(meta); } catch { /* 埋点回调异常不阻塞 */ }
			}
		};
		try {
			const streamOptions = {
				provider: effectiveProvider,
				model: effectiveModel,
				messages: [createUserMessage({ content: [{ type: "text", text: String(prompt ?? "") }], source })],
				system: system ?? "",
				maxTokens: 2048,
				sessionId,
				purpose,
				signal: externalSignal ?? controller.signal
			};
			// P2-22①：仅当适配器显式声明支持 JSON-mode 时才透传，避免不兼容适配器报错
			const supportsJson = typeof llm.supportsJsonMode === "function" ? !!llm.supportsJsonMode() : false;
			if (jsonMode && supportsJson) {
				streamOptions.responseFormat = { type: "json_object" };
			} else if (jsonMode && !supportsJson) {
				meta.jsonModeSkipped = true;
			}
			const stream = llm.stream(streamOptions);
			const consume = (async () => {
				const assembler = new BlockAssembler();
				for await (const chunk of stream) {
					assembler.push(chunk);
					// P2-22④：捕获 finish/usage 块做截断埋点（宿主包 emit type:"finish" / "usage"）
					if (chunk && typeof chunk === "object") {
						if (chunk.type === "finish") {
							meta.finishReason = chunk.reason;
							meta.finishKind = chunk.reason?.kind ?? chunk.reason ?? null;
							meta.truncationSuspect = chunk.reason?.kind === "max-tokens";
							// 内核适配器错误不抛异常，而以 finish/error 终块返回（adapterFailureChunk），必须在此留证，
							// 否则空文本会被上层统一误诊为"JSON 畸形"（NO_ADAPTER 事故教训）
							if (chunk.reason?.kind === "error") {
								meta.failureCode = chunk.reason.failure?.code ?? null;
								meta.failureMessage = chunk.reason.failure?.message ?? null;
							} else if (chunk.reason?.kind === "aborted") {
								meta.aborted = true;
							}
						} else if (chunk.type === "usage") {
							meta.outputTokens = chunk.outputTokens ?? chunk.output_tokens ?? null;
						}
					}
				}
				return assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join("\n");
			})();
			consume.catch(() => {}); // 超时胜出后 consume 仍可能 reject，避免 unhandledRejection
			// 兜底 race：即便底层流不响应 abort，超时也能按 null 返回（§5.1 30s 硬上限）
			const text = await Promise.race([
				consume,
				new Promise((resolve) => { fallbackTimer = setTimeout(() => resolve(null), timeoutMs); })
			]);
			meta.finishedAt = Date.now();
			meta.elapsedMs = meta.finishedAt - startedAt;
			return typeof text === "string" && text.trim() !== "" ? text : null;
		} catch {
			meta.elapsedMs = Date.now() - startedAt;
			return null;
		} finally {
			clearTimeout(timer);
			if (fallbackTimer) clearTimeout(fallbackTimer);
			emitMeta(); // 无论成败都透出 meta（duration/finish/usage 证据）
		}
	};
}

/**
 * @param {object} opts
 * @param opts.store  journey-store 实例
 * @param opts.emit   (name, payload) 事件出口
 * @param opts.getSettings  () => settings 快照
 * @param opts.callLlm      异步 LLM 文本调用（可注入假实现）
 * @param opts.embed        (text) => Promise<number[]|null>，可选
 * @param opts.onSummarized (sessionId, {entries, messageId, turn, step, channel}) => void
 * @param opts.onGap        (sessionId, meta) => void（meta 带 channel）
 * @param opts.now          () => number 墙钟毫秒（测试注入，禁真实 sleep）
 */
export function createSummarizer({
	store,
	emit = () => {},
	log = (line) => console.warn(line),
	getSettings = () => ({}),
	callLlm = async () => null,
	embed = null,
	onSummarized = null,
	onGap = null,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	now = Date.now
} = {}) {
	const inflight = new Set();
	let active = 0;

	/** 每通道独立运行态：队列/seen/熔断/统计全隔离。 */
	function makeLane(channel) {
		return {
			channel,
			queue: [],
			seen: new Set(),
			consecutiveDnf: 0,   // 连续降级次数（有效回复即清零渐进恢复）
			circuitOpenedAt: 0,  // 最近一次打开熔断的时刻（0=未触发）
			stats: { enqueued: 0, processed: 0, degraded: 0, dropped: 0, retried: 0, selfcheckSkipped: 0 }
		};
	}
	const lanes = { text: makeLane("text"), reasoning: makeLane("reasoning") };

	const watermarkSeq = new Map(); // `${channel}:${sessionId}` -> 已落水位 lastStepSeq（单调推进）
	let lastServedChannel = null;   // 轮转调度：上一拍服务的通道

	// P2-22② 熔断参数（每通道各一份计数）
	const CIRCUIT_BREAK_AT = 3;     // 连续失败 N 次触发熔断
	const CIRCUIT_TRIAL_MS = 60_000; // 冷却期后放行一次试探

	const concurrencyOf = () => {
		const mc = Number(getSettings().maxConcurrency);
		return Math.min(2, Math.max(1, Number.isFinite(mc) ? Math.round(mc) : 1));
	};
	const recentNOf = (channel) => {
		const key = channel === "reasoning" ? "reasoningRecentN" : "recentN";
		const n = Number(getSettings()[key]);
		return Number.isFinite(n) ? Math.max(1, Math.round(n)) : 8;
	};
	const modeOf = () => {
		const m = getSettings().noveltyMode;
		return m === "embedding" || m === "both" || m === "semantic-only" ? m : "schema-selfcheck";
	};
	const readChannelEntries = (channel, sessionId) =>
		(channel === "reasoning" ? store.readReasoningEntries(sessionId) : store.readEntries(sessionId));

	// P2-22③ degrade 原因分级：GRADE 决定降级性质，供统计/告警区分"适配器超时/解析失败/正常空"
	const GRADE = Object.freeze({ TIMEOUT: "timeout", PARSE_ERROR: "parse-error", EMPTY_OK: "empty-ok", NO_ADAPTER: "no-adapter", EMPTY: "empty", OTHER: "other" });
	function gradeOf(reason) {
		const r = String(reason ?? "");
		if (r.includes("超时") || r.includes("timeout") || r.includes("abort")) return GRADE.TIMEOUT;
		if (r.includes("JSON 畸形") || r.includes("解析") || r.includes("parse")) return GRADE.PARSE_ERROR;
		if (r.includes("空") || r.includes("empty") || r.includes("无内容")) return GRADE.EMPTY_OK;
		return GRADE.OTHER;
	}
	function bumpDegrade(lane) {
		lane.consecutiveDnf += 1;
		if (lane.consecutiveDnf >= CIRCUIT_BREAK_AT && lane.circuitOpenedAt === 0) lane.circuitOpenedAt = now();
	}
	function resetDegrade(lane) {
		if (lane.consecutiveDnf > 0) lane.consecutiveDnf = 0;
		lane.circuitOpenedAt = 0;
	}
	const circuitBlocked = (lane) =>
		lane.consecutiveDnf >= CIRCUIT_BREAK_AT && (now() - lane.circuitOpenedAt) < CIRCUIT_TRIAL_MS;

	function degrade(lane, sessionId, reason, meta, explicitGrade = null) {
		lane.stats.degraded += 1;
		bumpDegrade(lane);
		const grade = explicitGrade || gradeOf(reason);
		const gapMeta = { channel: lane.channel, reason, grade, messageId: meta?.messageId ?? null, turn: meta?.turn ?? null, step: meta?.step ?? null };
		try { store.appendGap(sessionId, gapMeta, lane.channel); } catch { /* gap 落盘失败不阻塞 */ }
		emit(EVT.SUMMARIZER_DEGRADED, {
			sessionId, channel: lane.channel, turn: meta?.turn ?? null, step: meta?.step ?? null,
			grade, suppressReason: reason
		});
		try { onGap?.(sessionId, gapMeta); } catch { /* 回调异常不阻塞 */ }
	}

	/** callLlm 结果归一：字符串=成功文本（测试假实现兼容）；{ok:false,grade,reason}=LLM 层失败；null=未知失败。 */
	function normalizeLlmResult(raw) {
		if (typeof raw === "string") return { ok: true, text: raw };
		if (raw && typeof raw === "object" && raw.ok === false) {
			return { ok: false, grade: raw.grade || GRADE.OTHER, reason: raw.reason || "总结器调用失败" };
		}
		return { ok: false, grade: GRADE.OTHER, reason: "总结器无返回（空）" };
	}

	function enqueue(sessionId, job) {
		const j = job ?? {};
		// 2.1：sourceKind 必须显式传 text|reasoning，缺失/非法直接拒入（禁止隐式默认吞错）。
		if (j.sourceKind !== "text" && j.sourceKind !== "reasoning") {
			return { queued: false, reason: "sourceKind 必须显式传 \"text\" 或 \"reasoning\"" };
		}
		const lane = lanes[j.sourceKind];
		if (typeof j.text !== "string" || j.text.trim() === "") return { queued: false, reason: "空文本不入队" };
		// P2-21①：seen 簿的 add 键与 evict 键必须同构（含通道前缀）——messageId 缺失时退化为 turn/step 键
		const key = enqueueKeyOf(sessionId, j);
		if (lane.seen.has(key)) return { queued: false, reason: "sourceMessageId 去重命中" };
		lane.seen.add(key);
		if (lane.queue.length >= QUEUE_CAP) {
			const evicted = lane.queue.shift();
			lane.seen.delete(enqueueKeyOf(evicted.sessionId, evicted));
			lane.stats.dropped += 1;
			try { store.appendGap(evicted.sessionId, { reason: "队列溢出丢弃最旧", messageId: evicted.messageId, turn: evicted.turn, step: evicted.step }, lane.channel); } catch { /* ignore */ }
			emit(EVT.SUMMARIZER_DEGRADED, {
				sessionId: evicted.sessionId, channel: lane.channel, turn: evicted.turn ?? null, step: evicted.step ?? null,
				queueCap: QUEUE_CAP, suppressReason: "总结队列溢出（上限 8），丢弃最旧待总结消息并记 gap"
			});
		}
		lane.queue.push({
			sessionId, sourceKind: lane.channel,
			messageId: j.messageId ?? null, turn: j.turn ?? null, step: j.step ?? null, text: j.text,
			provider: j.provider ?? null, model: j.model ?? null
		});
		lane.stats.enqueued += 1;
		pump();
		return { queued: true, queueLength: lane.queue.length };
	}

	async function run(job) {
		const { sessionId, messageId, turn, step, text, sourceKind: channel } = job;
		const lane = lanes[channel];
		// P2-22② 熔断短路：每通道独立计数，reasoning 熔断不影响 text。
		if (circuitBlocked(lane)) {
			return degrade(lane, sessionId, "连续降级触发熔断，跳过本次总结（冷却期内短路）", { messageId, turn, step });
		}
		let entries = [];
		try { entries = readChannelEntries(channel, sessionId); } catch { entries = []; }
		const windowN = recentNOf(channel);
		const windowEntries = entries.slice(-(windowN * 2));
		const candidates = windowEntries
			.filter((e) => typeof e.summary === "string" && e.summary)
			.map((e) => ({ id: e.id, summary: e.summary, signature: signatureOf(e.summary), embedding: e.embedding ?? null }));

		// 通道专属 prompt/purpose（埋点可区分 draft / reasoning-draft）
		const systemPrompt = channel === "reasoning" ? REASONING_SYSTEM_PROMPT : DRAFT_SYSTEM_PROMPT;
		const buildPrompt = channel === "reasoning" ? buildReasoningPrompt : buildDraftPrompt;
		const draftPurpose = channel === "reasoning" ? "semantic-watcher/reasoning-draft" : "semantic-watcher/draft";
		const retryPurpose = channel === "reasoning" ? "semantic-watcher/reasoning-draft-retry" : "semantic-watcher/draft-retry";
		const selfcheckPurpose = channel === "reasoning" ? "semantic-watcher/reasoning-selfcheck" : "semantic-watcher/selfcheck";
		const selfcheckRetryPurpose = channel === "reasoning" ? "semantic-watcher/reasoning-selfcheck-retry" : "semantic-watcher/selfcheck-retry";

		// 1) 草稿：LLM 层失败（无适配器/超时/空回复）不重试，直接按真因记 gap；
		//    仅当 LLM 有文本但草稿不是合法 JSON 时才重试 1 次（合法空 entries=[] 视为正常空结果）
		const route = { provider: job.provider ?? null, model: job.model ?? null };
		const first = normalizeLlmResult(await callLlm({
			system: systemPrompt, prompt: buildPrompt({ turn, step, text }),
			sessionId, purpose: draftPurpose, timeoutMs, ...route
		}));
		if (!first.ok) return degrade(lane, sessionId, first.reason, { messageId, turn, step }, first.grade);
		let { ok: draftOk, drafts } = draftParse(first.text, channel);
		if (!draftOk) {
			lane.stats.retried += 1;
			const second = normalizeLlmResult(await callLlm({
				system: systemPrompt,
				prompt: buildPrompt({ turn, step, text }) + "\n（上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。）",
				sessionId, purpose: retryPurpose, timeoutMs, ...route
			}));
			if (!second.ok) return degrade(lane, sessionId, second.reason, { messageId, turn, step }, second.grade);
			const retry = draftParse(second.text, channel);
			draftOk = retry.ok;
			drafts = retry.drafts;
			if (!draftOk) return degrade(lane, sessionId, "总结草稿 JSON 畸形（重试 1 次后仍无效），跳过并记 gap", { messageId, turn, step }, GRADE.PARSE_ERROR);
		}
		// P2-22② 有效回复（含合法空 entries=[]）→ 逐级渐进恢复本通道熔断计数
		resetDegrade(lane);

		// 2) 新颖性判定 + 3) 落账（candidates 只含本通道历史，duplicate_of 不跨通道）
		const appended = [];
		const mode = modeOf();
		const lexThRaw = Number(getSettings().lexicalThreshold);
		const lexThreshold = Number.isFinite(lexThRaw) && lexThRaw > 0 ? lexThRaw : JACCARD_THRESHOLD;
		for (const draft of drafts) {
			const lexical = mode === "semantic-only" ? null : lexicalCheck(draft.summary, candidates, lexThreshold);
			let semantic = null;
			if ((lexical === null || !lexical.lexicalDuplicate) && candidates.length > 0 && (mode === "schema-selfcheck" || mode === "both" || mode === "semantic-only")) {
				const scFirst = await callLlm({
					system: SELFCHECK_SYSTEM_PROMPT,
					prompt: buildSelfcheckPrompt(draft.summary, windowEntries.slice(-windowN)),
					sessionId, purpose: selfcheckPurpose, timeoutMs, ...route
				});
				let sc = parseSelfcheckJson(typeof scFirst === "string" ? scFirst : null);
				if (!sc) {
					lane.stats.retried += 1;
					const scSecond = await callLlm({
						system: SELFCHECK_SYSTEM_PROMPT,
						prompt: buildSelfcheckPrompt(draft.summary, windowEntries.slice(-windowN)) + "\n（上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。）",
						sessionId, purpose: selfcheckRetryPurpose, timeoutMs, ...route
					});
					sc = parseSelfcheckJson(typeof scSecond === "string" ? scSecond : null);
				}
				if (sc) semantic = { semanticDuplicate: sc.novelty === "duplicate", duplicateOf: sc.duplicate_of, similarity: null };
				else lane.stats.selfcheckSkipped += 1; // fail-open：自检不可用按 new 处理
			}
			if ((lexical === null || !lexical.lexicalDuplicate) && semantic === null && (mode === "embedding" || mode === "both")) {
				const emb = await embeddingCheck(draft.summary, candidates, embed);
				if (!emb.fallback) semantic = { semanticDuplicate: emb.semanticDuplicate, duplicateOf: emb.duplicateOf, similarity: emb.similarity ?? null };
				// fallback（无能力/失败）→ 维持回退，按 new 处理
			}
			const decision = decideNovelty(lexical, semantic);
			const r = store.appendEntry(sessionId, {
				turn, step, sourceMessageId: messageId,
				kind: draft.kind, summary: draft.summary, detail: draft.detail,
				artifacts: draft.artifacts, supersedes: draft.supersedes, confidence: draft.confidence,
				novelty: decision.novelty, semantic_duplicate: decision.semantic_duplicate, duplicate_of: decision.duplicate_of
			}, channel);
			if (!r.ok) return { ok: false, reason: r.reason, corruption: true }; // store 已发 store-corruption；本消息不计成功、不推水位
			appended.push(r.entry);
			candidates.push({ id: r.entry.id, summary: r.entry.summary, signature: signatureOf(r.entry.summary), embedding: null });
		}

		// 3) 落账后推进本通道水位（两通道水位物理独立、各自单调）。
		// P0-3：合法空结果（draftOk && 无 drafts）也推进总结水位（不记 gap、不重试），
		// 保证 watermark 单调推进、避免同 step 重复补扫。
		const watermarkAdvance = appended.length > 0 || (draftOk && drafts.length === 0);
		if (watermarkAdvance) {
			const wmKey = `${channel}:${sessionId}`;
			let prevSeq = watermarkSeq.get(wmKey);
			if (prevSeq === undefined) {
				const wm = store.loadWatermark(sessionId, channel);
				prevSeq = wm && Number.isFinite(wm.lastStepSeq) ? wm.lastStepSeq : null;
			}
			if (prevSeq == null || (Number.isFinite(step) && step >= prevSeq)) {
				try {
					store.saveWatermark(sessionId, { lastMessageId: messageId, lastStepSeq: step }, channel);
					if (Number.isFinite(step)) watermarkSeq.set(wmKey, step);
				} catch (error) {
					log(`[dsh-derive-watcher] 水位保存失败 channel=${channel} session=${sessionId}: ${error?.message ?? error}`);
				}
			}
			lane.stats.processed += (appended.length > 0 ? 1 : 0);
			// P0-3：onSummarized 仅在有实际落账条目时触发（驱动 stall.onEntries/折叠）；
			// 合法空结果只推水位、不触发 onSummarized。负载带 channel，调用方据此隔离 text stall-2/3。
			if (appended.length > 0) {
				try { onSummarized?.(sessionId, { entries: appended, messageId, turn, step, channel, provider: job.provider ?? null, model: job.model ?? null }); } catch (error) {
					log(`[dsh-derive-watcher] onSummarized 回调异常: ${error?.message ?? error}`);
				}
			}
		}
		return { ok: true, count: appended.length, channel };
	}

	/**
	 * 调度：text 优先的轮转。lastServedChannel 记录上一拍实际出队的通道，
	 * 下一拍优先尝试另一通道；该通道空则退回让另一通道连续推进。
	 * 因此 reasoning 长期积压时 text 仍至少每隔一拍被服务，杜绝饿死。
	 */
	function pickJob() {
		const firstTry = lastServedChannel === "text" ? "reasoning" : "text";
		const secondTry = firstTry === "text" ? "reasoning" : "text";
		for (const ch of [firstTry, secondTry]) {
			const lane = lanes[ch];
			if (lane.queue.length > 0) return { lane, job: lane.queue.shift() };
		}
		return null;
	}

	function pump() {
		while (inflight.size < concurrencyOf()) {
			const picked = pickJob();
			if (!picked) break;
			const { lane, job } = picked;
			lastServedChannel = lane.channel;
			active += 1;
			const p = run(job)
				.catch((error) => {
					lane.stats.degraded += 1;
					degrade(lane, job.sessionId, `总结任务异常: ${error?.message ?? error}`, { messageId: job.messageId, turn: job.turn, step: job.step });
				})
				.finally(() => {
					inflight.delete(p);
					active -= 1;
					pump();
				});
			inflight.add(p);
		}
	}

	const laneSnapshot = (lane) => ({ ...lane.stats, queued: lane.queue.length });
	return {
		enqueue,
		/** 等待全部排空（测试/回放用）。 */
		flush: async () => {
			while (lanes.text.queue.length + lanes.reasoning.queue.length > 0 || inflight.size > 0) {
				await Promise.all([...inflight]);
				await new Promise((resolve) => setImmediate(resolve)); // 让 finally/pump 微任务跑完再复查
			}
		},
		/** 顶层为两通道聚合统计（既有 text 用例不断言通道时仍成立），byChannel 提供分通道口径。 */
		stats: () => {
			const t = lanes.text.stats;
			const r = lanes.reasoning.stats;
			return {
				enqueued: t.enqueued + r.enqueued,
				processed: t.processed + r.processed,
				degraded: t.degraded + r.degraded,
				dropped: t.dropped + r.dropped,
				retried: t.retried + r.retried,
				selfcheckSkipped: t.selfcheckSkipped + r.selfcheckSkipped,
				queued: lanes.text.queue.length + lanes.reasoning.queue.length,
				active,
				byChannel: { text: laneSnapshot(lanes.text), reasoning: laneSnapshot(lanes.reasoning) }
			};
		}
	};
}
