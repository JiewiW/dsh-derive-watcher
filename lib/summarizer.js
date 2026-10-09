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

/** 松散 JSON 提取：接受围栏包裹或裸对象。 */
export function parseJsonObject(text) {
	if (typeof text !== "string") return null;
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const raw = fenced ? fenced[1] : text;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const obj = JSON.parse(raw.slice(start, end + 1));
		return obj !== null && typeof obj === "object" ? obj : null;
	} catch {
		return null;
	}
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
 */
export function makeLlmCall({ llm, provider, model, source }) {
	return async function callLlm({ system, prompt, sessionId, purpose = "semantic-watcher", timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal } = {}) {
		if (!llm || typeof llm.stream !== "function") return null;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let fallbackTimer = null;
		try {
			const stream = llm.stream({
				provider: provider || undefined,
				model: model || undefined,
				messages: [createUserMessage({ content: [{ type: "text", text: String(prompt ?? "") }], source })],
				system: system ?? "",
				maxTokens: 2048,
				sessionId,
				purpose,
				signal: externalSignal ?? controller.signal
			});
			const consume = (async () => {
				const assembler = new BlockAssembler();
				for await (const chunk of stream) assembler.push(chunk);
				return assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join("\n");
			})();
			consume.catch(() => {}); // 超时胜出后 consume 仍可能 reject，避免 unhandledRejection
			// 兜底 race：即便底层流不响应 abort，超时也能按 null 返回（§5.1 30s 硬上限）
			const text = await Promise.race([
				consume,
				new Promise((resolve) => { fallbackTimer = setTimeout(() => resolve(null), timeoutMs); })
			]);
			return typeof text === "string" && text.trim() !== "" ? text : null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
			if (fallbackTimer) clearTimeout(fallbackTimer);
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
	timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
	const queue = [];
	const seen = new Set();
	const inflight = new Set();
	const watermarkSeq = new Map(); // sessionId -> 已落水位 lastStepSeq（单调推进，防并发乱序回退）
	let active = 0;
	let tail = Promise.resolve(); // 兼容保留：flush 已改用 inflight 排空
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

	function degrade(sessionId, reason, meta) {
		stats.degraded += 1;
		try { store.appendGap(sessionId, { reason, messageId: meta?.messageId ?? null, turn: meta?.turn ?? null, step: meta?.step ?? null }); } catch { /* gap 落盘失败不阻塞 */ }
		emit(EVT.SUMMARIZER_DEGRADED, {
			sessionId, turn: meta?.turn ?? null, step: meta?.step ?? null,
			suppressReason: reason
		});
		try { onGap?.(sessionId, meta ?? {}); } catch { /* 回调异常不阻塞 */ }
	}

	function enqueue(sessionId, job) {
		const j = job ?? {};
		if (typeof j.text !== "string" || j.text.trim() === "") return { queued: false, reason: "空文本不入队" };
		const key = `${sessionId}/${j.messageId ?? `${j.turn ?? "?"}/${j.step ?? "?"}`}`;
		if (seen.has(key)) return { queued: false, reason: "sourceMessageId 去重命中" };
		seen.add(key);
		if (queue.length >= QUEUE_CAP) {
			const evicted = queue.shift();
			seen.delete(`${evicted.sessionId}/${evicted.messageId}`);
			stats.dropped += 1;
			try { store.appendGap(evicted.sessionId, { reason: "队列溢出丢弃最旧", messageId: evicted.messageId, turn: evicted.turn, step: evicted.step }); } catch { /* ignore */ }
			emit(EVT.SUMMARIZER_DEGRADED, {
				sessionId: evicted.sessionId, turn: evicted.turn ?? null, step: evicted.step ?? null,
				queueCap: QUEUE_CAP, suppressReason: "总结队列溢出（上限 8），丢弃最旧待总结消息并记 gap"
			});
		}
		queue.push({ sessionId, messageId: j.messageId ?? null, turn: j.turn ?? null, step: j.step ?? null, text: j.text });
		stats.enqueued += 1;
		pump();
		return { queued: true, queueLength: queue.length };
	}

	async function run(job) {
		const { sessionId, messageId, turn, step, text } = job;
		let entries = [];
		try { entries = store.readEntries(sessionId); } catch { entries = []; }
		const windowEntries = entries.slice(-(recentNOf() * 2));
		const candidates = windowEntries
			.filter((e) => typeof e.summary === "string" && e.summary)
			.map((e) => ({ id: e.id, summary: e.summary, signature: signatureOf(e.summary), embedding: e.embedding ?? null }));

		// 1) 草稿（畸形 JSON 重试 1 次）
		let drafts = extractDraftEntries(await callLlm({
			system: DRAFT_SYSTEM_PROMPT, prompt: buildDraftPrompt({ turn, step, text }),
			sessionId, purpose: "semantic-watcher/draft", timeoutMs
		}));
		if (!drafts.length) {
			stats.retried += 1;
			drafts = extractDraftEntries(await callLlm({
				system: DRAFT_SYSTEM_PROMPT,
				prompt: buildDraftPrompt({ turn, step, text }) + "\n（上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。）",
				sessionId, purpose: "semantic-watcher/draft-retry", timeoutMs
			}));
			if (!drafts.length) return degrade(sessionId, "总结草稿 JSON 畸形（重试 1 次后仍无效），跳过并记 gap", { messageId, turn, step });
		}

		// 2) 新颖性判定 + 3) 落账
		const appended = [];
		for (const draft of drafts) {
			const lexical = lexicalCheck(draft.summary, candidates);
			let semantic = null;
			if (!lexical.lexicalDuplicate && candidates.length > 0 && (modeOf() === "schema-selfcheck" || modeOf() === "both")) {
				let sc = parseSelfcheckJson(await callLlm({
					system: SELFCHECK_SYSTEM_PROMPT,
					prompt: buildSelfcheckPrompt(draft.summary, windowEntries.slice(-recentNOf())),
					sessionId, purpose: "semantic-watcher/selfcheck", timeoutMs
				}));
				if (!sc) {
					stats.retried += 1;
					sc = parseSelfcheckJson(await callLlm({
						system: SELFCHECK_SYSTEM_PROMPT,
						prompt: buildSelfcheckPrompt(draft.summary, windowEntries.slice(-recentNOf())) + "\n（上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。）",
						sessionId, purpose: "semantic-watcher/selfcheck-retry", timeoutMs
					}));
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

		if (appended.length) {
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
			stats.processed += 1;
			try { onSummarized?.(sessionId, { entries: appended, messageId, turn, step }); } catch (error) {
				log(`[dsh-derive-watcher] onSummarized 回调异常: ${error?.message ?? error}`);
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
