/**
 * dsh-derive-watcher — 事件契约（计划书 §5.8）。
 *
 * 全部事件名以 semantic-watcher/ 为前缀；抑制/降级类事件必须携带 suppressReason。
 * 事件经 session.append(name, payload) 落入会话事件 JSONL（形式 {"type":name,"data":payload}），
 * 可被任何 ctx.on("session/event") 监听者与离线回放消费；
 * 同时始终输出一条结构化 console.warn 行作为进程级旁证（append 不可用时是唯一旁证）。
 */
export const PLUGIN_ID = "dsh-derive-watcher";

export const EVT = Object.freeze({
	STALL: "semantic-watcher/stall",
	STORE_CORRUPTION: "semantic-watcher/store-corruption",
	INJECTION_SKIPPED: "semantic-watcher/injection-skipped",
	EXECUTION_UNAVAILABLE: "semantic-watcher/execution-unavailable",
	LEXICAL_REPEAT: "semantic-watcher/lexical-repeat",
	SUMMARIZER_DEGRADED: "semantic-watcher/summarizer-degraded",
	HANDOFF_WRITTEN: "semantic-watcher/handoff-written",
	HEARTBEAT: "semantic-watcher/heartbeat",
	FOLD_MILESTONE: "semantic-watcher/fold-milestone",
	RETENTION_CLEANED: "semantic-watcher/retention-cleaned",
	/**
	 * 干预受理事件（v0.2.0）：stall-2 deny-read / stall-3 reject-step 被 step-governor
	 * 成功受理后发一条持久化记录（此前只有 console.log，无法在 UI 回看）。
	 * 必带 action（deny-read | reject-step）与 accepted；其余字段只取 L2 真实返回值，缺失即省略。
	 */
	INTERVENTION: "semantic-watcher/intervention"
});

/** 抑制/降级类事件：缺 suppressReason 时补 "unspecified"。 */
export const SUPPRESSED_EVENTS = new Set([
	EVT.INJECTION_SKIPPED,
	EVT.EXECUTION_UNAVAILABLE,
	EVT.SUMMARIZER_DEGRADED
]);

/**
 * 构造事件基础载荷。每事件必带 sessionId/turn/step/evidenceSeq（§5.8）。
 */
export function basePayload(sessionId, turn = null, step = null, evidenceSeq = null) {
	return {
		sessionId: sessionId ?? "*",
		turn: Number.isFinite(turn) ? turn : null,
		step: Number.isFinite(step) ? step : null,
		evidenceSeq: Number.isFinite(evidenceSeq) ? evidenceSeq : null
	};
}

/**
 * 事件出口。emit(session, name, payload)：
 *  1) 补齐基础字段与 ts；抑制类补 suppressReason；
 *  2) 尽力 session.append（失败不抛）；
 *  3) 结构化 log 行（进程级旁证）。
 * 返回 { appended, payload }。
 */
export function createEventSink({ log = (line) => console.warn(line) } = {}) {
	let fallbackSeq = 0;
	function emit(session, name, payload) {
		const p = { ...(payload ?? {}) };
		p.sessionId = p.sessionId ?? session?.id ?? "*";
		if (!Number.isFinite(p.turn)) p.turn = null;
		if (!Number.isFinite(p.step)) p.step = null;
		if (!Number.isFinite(p.evidenceSeq)) p.evidenceSeq = ++fallbackSeq;
		p.ts = p.ts ?? new Date().toISOString();
		if (SUPPRESSED_EVENTS.has(name) && typeof p.suppressReason !== "string") {
			p.suppressReason = "unspecified";
		}
		let appended = false;
		try {
			if (session && typeof session.append === "function") {
				session.append(name, p, { ignorable: true });
				appended = true;
			}
		} catch { /* fail-open：落不进会话日志不阻塞 */ }
		try {
			log(`[${PLUGIN_ID}] event=${name} ${JSON.stringify(p)}`);
		} catch { /* ignore */ }
		return { appended, payload: p };
	}
	return { emit };
}
