/**
 * dsh-derive-watcher — summarizer（计划书 §5.1）。
 *
 * - assistant/message 落盘入队，按 sourceMessageId 去重；
 * - flash 钉定：summaryProvider/summaryModel 留空跟随宿主（由 LLM 通路决定）；
 * - 并发闸 maxConcurrency 默认 1（上限 2）；单次调用 30s 超时（独立 AbortController）；
 * - 草稿/自检畸形 JSON 各重试 1 次，仍失败 fail-open：跳过、账本记 gap、发 summarizer-degraded；
 * - 队列上限 8，溢出丢最旧并写 gap（gap 不产出 entry、不参与停滞判定）；
 * - 水位：每会话最后成功总结的 messageId/stepSeq（store.saveWatermark），重启按水位补扫。
 *
 * LLM 通路可注入：callLlm({system, prompt, sessionId, purpose, timeoutMs}) → text|null。
 * 默认实现走 ctx.get("llm").stream + BlockAssembler（与 dsh-cot-anchor runRefinement 同构）。
 */
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { EVT } from "./events.js";
import { KINDS } from "./journey-store.js";
import {
	SELFCHECK_SYSTEM_PROMPT, buildSelfcheckPrompt, parseSelfcheckJson,
	lexicalCheck, decideNovelty, signatureOf, embeddingCheck
} from "./novelty.js";

export const QUEUE_CAP = 8;
export const DEFAULT_TIMEOUT_MS = 30000;

/** P2-21①：seen 簿键的唯一同构来源——messageId 存在用之，否则退化 turn/step 键（与 evict 键一致）。 */
export function enqueueKeyOf(sessionId, j) {
	const job = j ?? {};
	return `${sessionId}/${job.messageId ?? `${job.turn ?? "?"}/${job.step ?? "?"}`}`;
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
 * 合法 entries 为对象但其中有效条目筛选后为空（如全部 kind 非法）按 ok=true+空处理。
 */
export function draftParse(text) {
	const parsed = parseJsonObject(text);
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
		return { ok: false, drafts: [] };
	}
	return { ok: true, drafts: extractDraftEntries(text) };
}

/** 解析草稿输出：非法条目（kind 不在 KINDS / summary 空）静默丢弃，返回有效 drafts。 */
export function extractDraftEntries(text) {
	const parsed = parseJsonObject(text);
	if (!parsed || !Array.isArray(parsed.entries)) return [];
	const out = [];
	for (const raw of parsed.entries) {
		if (!raw || typeof raw !== "object") continue;
		const kind = KINDS.includes(raw.kind) ? raw.kind : null;
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
 * @param opts.onSummarized (sessionId, {entries, messageId, turn, step}) => void
 * @param opts.onGap        (sessionId, meta) => void
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
	const queue = [];
	const seen = new Set();
	const inflight = new Set();
	const watermarkSeq = new Map(); // sessionId -> 已落水位 lastStepSeq（单调推进，防并发乱序回退）
	let active = 0;
	let tail = Promise.resolve(); // 兼容保留：flush 已改用 inflight 排空
	// P2-22② 连续失败熔断：达阈值短路后续 LLM 调用，冷却后放行一次试探（半开）
	let consecutiveDnf = 0;      // 连续降级次数（有效回复即清零渐进恢复）
	let circuitOpenedAt = 0;     // 最近一次打开熔断的时刻（0=未触发）
	const CIRCUIT_BREAK_AT = 3;     // 连续失败 N 次触发熔断
	const CIRCUIT_TRIAL_MS = 60_000; // 冷却期后放行一次试探
	const circuitBlocked = () => consecutiveDnf >= CIRCUIT_BREAK_AT && (now() - circuitOpenedAt) < CIRCUIT_TRIAL_MS;
	const stats = { enqueued: 0, processed: 0, degraded: 0, dropped: 0, retried: 0, selfcheckSkipped: 0 };

	const concurrencyOf = () => {
		const mc = Number(getSettings().maxConcurrency);
		return Math.min(2, Math.max(1, Number.isFinite(mc) ? Math.round(mc) : 1));
	};
	const recentNOf = () => {
		const n = Number(getSettings().recentN);
		return Number.isFinite(n) ? Math.max(1, Math.round(n)) : 8;
	};
	const modeOf = () => {
		const m = getSettings().noveltyMode;
		return m === "embedding" || m === "both" ? m : "schema-selfcheck";
	};

	// P2-22③ degrade 原因分级：GRADE 决定降级性质，供统计/告警区分"适配器超时/解析失败/正常空"
	const GRADE = Object.freeze({ TIMEOUT: "timeout", PARSE_ERROR: "parse-error", EMPTY_OK: "empty-ok", NO_ADAPTER: "no-adapter", EMPTY: "empty", OTHER: "other" });
	function gradeOf(reason) {
		const r = String(reason ?? "");
		if (r.includes("超时") || r.includes("timeout") || r.includes("abort")) return GRADE.TIMEOUT;
		if (r.includes("JSON 畸形") || r.includes("解析") || r.includes("parse")) return GRADE.PARSE_ERROR;
		if (r.includes("空") || r.includes("empty") || r.includes("无内容")) return GRADE.EMPTY_OK;
		return GRADE.OTHER;
	}
	function bumpDegrade() {
		consecutiveDnf += 1;
		if (consecutiveDnf >= CIRCUIT_BREAK_AT && circuitOpenedAt === 0) circuitOpenedAt = now();
	}
	function resetDegrade() {
		if (consecutiveDnf > 0) consecutiveDnf = 0;
		circuitOpenedAt = 0;
	}
	function degrade(sessionId, reason, meta, explicitGrade = null) {
		stats.degraded += 1;
		bumpDegrade();
		const grade = explicitGrade || gradeOf(reason);
		try { store.appendGap(sessionId, { reason, grade, messageId: meta?.messageId ?? null, turn: meta?.turn ?? null, step: meta?.step ?? null }); } catch { /* gap 落盘失败不阻塞 */ }
		emit(EVT.SUMMARIZER_DEGRADED, {
			sessionId, turn: meta?.turn ?? null, step: meta?.step ?? null,
			grade, suppressReason: reason
		});
		try { onGap?.(sessionId, meta ?? {}); } catch { /* 回调异常不阻塞 */ }
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
		if (typeof j.text !== "string" || j.text.trim() === "") return { queued: false, reason: "空文本不入队" };
		// P2-21①：seen 簿的 add 键与 evict 键必须同构——messageId 缺失时都退化为 turn/step 键
		const key = enqueueKeyOf(sessionId, j);
		if (seen.has(key)) return { queued: false, reason: "sourceMessageId 去重命中" };
		seen.add(key);
		if (queue.length >= QUEUE_CAP) {
			const evicted = queue.shift();
			seen.delete(enqueueKeyOf(evicted.sessionId, evicted));
			stats.dropped += 1;
			try { store.appendGap(evicted.sessionId, { reason: "队列溢出丢弃最旧", messageId: evicted.messageId, turn: evicted.turn, step: evicted.step }); } catch { /* ignore */ }
			emit(EVT.SUMMARIZER_DEGRADED, {
				sessionId: evicted.sessionId, turn: evicted.turn ?? null, step: evicted.step ?? null,
				queueCap: QUEUE_CAP, suppressReason: "总结队列溢出（上限 8），丢弃最旧待总结消息并记 gap"
			});
		}
		queue.push({
			sessionId, messageId: j.messageId ?? null, turn: j.turn ?? null, step: j.step ?? null, text: j.text,
			provider: j.provider ?? null, model: j.model ?? null
		});
		stats.enqueued += 1;
		pump();
		return { queued: true, queueLength: queue.length };
	}

	async function run(job) {
		const { sessionId, messageId, turn, step, text } = job;
		// P2-22② 熔断短路：连续 N 次降级后，冷却期内直接跳过 LLM 记为一次降级（不再打 LLM）
		if (circuitBlocked()) {
			return degrade(sessionId, "连续降级触发熔断，跳过本次总结（冷却期内短路）", { messageId, turn, step });
		}
		let entries = [];
		try { entries = store.readEntries(sessionId); } catch { entries = []; }
		const windowEntries = entries.slice(-(recentNOf() * 2));
		const candidates = windowEntries
			.filter((e) => typeof e.summary === "string" && e.summary)
			.map((e) => ({ id: e.id, summary: e.summary, signature: signatureOf(e.summary), embedding: e.embedding ?? null }));

		// 1) 草稿：LLM 层失败（无适配器/超时/空回复）不重试，直接按真因记 gap；
		//    仅当 LLM 有文本但草稿不是合法 JSON 时才重试 1 次（合法空 entries=[] 视为正常空结果）
		const route = { provider: job.provider ?? null, model: job.model ?? null };
		const first = normalizeLlmResult(await callLlm({
			system: DRAFT_SYSTEM_PROMPT, prompt: buildDraftPrompt({ turn, step, text }),
			sessionId, purpose: "semantic-watcher/draft", timeoutMs, ...route
		}));
		if (!first.ok) return degrade(sessionId, first.reason, { messageId, turn, step }, first.grade);
		let { ok: draftOk, drafts } = draftParse(first.text);
		if (!draftOk) {
			stats.retried += 1;
			const second = normalizeLlmResult(await callLlm({
				system: DRAFT_SYSTEM_PROMPT,
				prompt: buildDraftPrompt({ turn, step, text }) + "\n（上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。）",
				sessionId, purpose: "semantic-watcher/draft-retry", timeoutMs, ...route
			}));
			if (!second.ok) return degrade(sessionId, second.reason, { messageId, turn, step }, second.grade);
			const retry = draftParse(second.text);
			draftOk = retry.ok;
			drafts = retry.drafts;
			if (!draftOk) return degrade(sessionId, "总结草稿 JSON 畸形（重试 1 次后仍无效），跳过并记 gap", { messageId, turn, step }, GRADE.PARSE_ERROR);
		}
		// P2-22② 有效回复（含合法空 entries=[]）→ 逐级渐进恢复熔断计数
		resetDegrade();

		// 2) 新颖性判定 + 3) 落账
		const appended = [];
		for (const draft of drafts) {
			const lexical = lexicalCheck(draft.summary, candidates);
			let semantic = null;
			if (!lexical.lexicalDuplicate && candidates.length > 0 && (modeOf() === "schema-selfcheck" || modeOf() === "both")) {
				const scFirst = await callLlm({
					system: SELFCHECK_SYSTEM_PROMPT,
					prompt: buildSelfcheckPrompt(draft.summary, windowEntries.slice(-recentNOf())),
					sessionId, purpose: "semantic-watcher/selfcheck", timeoutMs, ...route
				});
				let sc = parseSelfcheckJson(typeof scFirst === "string" ? scFirst : null);
				if (!sc) {
					stats.retried += 1;
					const scSecond = await callLlm({
						system: SELFCHECK_SYSTEM_PROMPT,
						prompt: buildSelfcheckPrompt(draft.summary, windowEntries.slice(-recentNOf())) + "\n（上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。）",
						sessionId, purpose: "semantic-watcher/selfcheck-retry", timeoutMs, ...route
					});
					sc = parseSelfcheckJson(typeof scSecond === "string" ? scSecond : null);
				}
				if (sc) semantic = { semanticDuplicate: sc.novelty === "duplicate", duplicateOf: sc.duplicate_of, similarity: null };
				else stats.selfcheckSkipped += 1; // fail-open：自检不可用按 new 处理
			}
			if (!lexical.lexicalDuplicate && semantic === null && (modeOf() === "embedding" || modeOf() === "both")) {
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
			});
			if (!r.ok) return { ok: false, reason: r.reason, corruption: true }; // store 已发 store-corruption；本消息不计成功、不推水位
			appended.push(r.entry);
			candidates.push({ id: r.entry.id, summary: r.entry.summary, signature: signatureOf(r.entry.summary), embedding: null });
		}

		// 3) 落账后推进水位。
		// P0-3：合法空结果（draftOk && 无 drafts）也推进总结水位（不记 gap、不重试），
		// 保证 watermark 单调推进、避免同 step 重复补扫。
		const watermarkAdvance = appended.length > 0 || (draftOk && drafts.length === 0);
		if (watermarkAdvance) {
			// 水位单调推进：并发完成乱序时不得回退（§5.1 水位语义）
			let prevSeq = watermarkSeq.get(sessionId);
			if (prevSeq === undefined) {
				const wm = store.loadWatermark(sessionId);
				prevSeq = wm && Number.isFinite(wm.lastStepSeq) ? wm.lastStepSeq : null;
			}
			if (prevSeq == null || (Number.isFinite(step) && step >= prevSeq)) {
				try {
					store.saveWatermark(sessionId, { lastMessageId: messageId, lastStepSeq: step });
					if (Number.isFinite(step)) watermarkSeq.set(sessionId, step);
				} catch (error) {
					log(`[dsh-derive-watcher] 水位保存失败 session=${sessionId}: ${error?.message ?? error}`);
				}
			}
			stats.processed += (appended.length > 0 ? 1 : 0);
			// P0-3：onSummarized 仅在有实际落账条目时触发（驱动 stall.onEntries/折叠）；
			// 合法空结果只推水位、不触发 onSummarized，避免空观测被当作结论处理。
			if (appended.length > 0) {
				try { onSummarized?.(sessionId, { entries: appended, messageId, turn, step, provider: job.provider ?? null, model: job.model ?? null }); } catch (error) {
					log(`[dsh-derive-watcher] onSummarized 回调异常: ${error?.message ?? error}`);
				}
			}
		}
		return { ok: true, count: appended.length };
	}

	function pump() {
		while (queue.length > 0 && active < concurrencyOf()) {
			const job = queue.shift();
			active += 1;
			const p = run(job)
				.catch((error) => {
					stats.degraded += 1;
					degrade(job.sessionId, `总结任务异常: ${error?.message ?? error}`, { messageId: job.messageId, turn: job.turn, step: job.step });
				})
				.finally(() => {
					inflight.delete(p);
					active -= 1;
					pump();
				});
			inflight.add(p);
		}
	}

	return {
		enqueue,
		/** 等待全部排空（测试/回放用）。 */
		flush: async () => {
			while (queue.length > 0 || inflight.size > 0) {
				await Promise.all([...inflight]);
				await new Promise((resolve) => setImmediate(resolve)); // 让 finally/pump 微任务跑完再复查
			}
		},
		stats: () => ({ ...stats, queued: queue.length, active })
	};
}
