/**
 * dsh-derive-watcher — 静默中断检测与原窗口续跑（计划书 §2–§5/§7，P1 范围）。
 *
 * 职责：
 *  - 纯判据函数（可单测）：classifyTurnEnd（D1–D4/D8 机械决策表）、
 *    readStopReason / readStopReasonFromEvent（U1 佐证归一）、renderResumePrompt（I4 三模板）。
 *  - createSilentAbortController：会话状态机（I5）+ 冷却扫描（G2/D7，复用既有 30s 心跳）+
 *    四模式投递（I1/I2/I3，互斥穷尽）+ 预算/进展/服务缺失安全闸（G1/G5/G6）。
 *
 * 内核事实（实现前核查冻结，计划书 §9）：
 *  - U3：agent-loop 落盘 turn/end 的 reason.kind 全集为
 *    {blocked, completed, aborted, error, max-tokens, abort-turn}
 *    （dsh-agent-loop/lib/index.js:1081/1100/1191/1331/1337）；
 *    归档侧 "interrupted" 由 aborted/abort-turn 投影（dsh-session-query/lib/index.js:563 turnEndText）。
 *  - U1：内核无 stopReason 字段；终态记录为 FinishReason（stop/tool-calls/max-tokens/aborted/error，
 *    dsh-llm/lib/types/types.d.ts FinishReasonMap:131）。落盘 assistant/message 的
 *    source.replayState.response 携带适配器私有原生停止原因（ReplayEnvelope.response，types.d.ts:396）。
 *    本模块按真实路径启发式读取、不写死单一路径；取不到一律 "unknown" 降级，禁止猜值。
 *  - U4：agent/status 事件载荷为 ({agent, status})（dsh-goal-round-driver/lib/index.js:431）；
 *    本控制器只读 agent.status，不订阅该事件。
 *  - U5：followup 消息在 pre-step 首次尝试时 session.append("user/message", message, {surfaceOp:"append"})
 *    （dsh-agent-loop/lib/index.js:1381），source=PLUGIN_SOURCE 可被 index.js user/message 分支
 *    （source?.plugin 即 return）识别为插件来源——G3 真人优先成立前提。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { EVT, PLUGIN_ID, PLUGIN_SOURCE } from "./events.js";
import { SILENT_ABORT_ACTIONS } from "./settings.js";

/** 中断类 reason.kind（D2-①：命中才可能进入检测）。 */
const INTERRUPT_KINDS = Object.freeze(["blocked", "max-tokens", "error"]);
/** 排除类 reason.kind（D3-①②：aborted 真人/hook 停、abort-turn 粘性终止、interrupted 归档投影）。 */
const EXCLUDE_KINDS = Object.freeze(["aborted", "abort-turn", "interrupted"]);
/** 自然结束 reason.kind（agent-loop :1100）。 */
const COMPLETED_KIND = "completed";
/** 已知 reason.kind 全集（U3 冻结；其余一律按 D8 未识别兜底）。 */
const KNOWN_KINDS = Object.freeze([...INTERRUPT_KINDS, ...EXCLUDE_KINDS, COMPLETED_KIND]);

/**
 * D2 置信度 high 的步数下限（计划书 D2："该 turn ≥3 步"；与 C5 的 G5 口径独立）。
 */
const HIGH_CONFIDENCE_MIN_STEPS = 3;

/** replayState.response 内直接查找的停止原因键（U1：适配器私有，多命名并存）。 */
const RESPONSE_FINISH_KEYS = Object.freeze([
	"stopReason", "finishReason", "nativeStopReason", "finish_reason", "stop_reason"
]);
/** replayState.response 内一层的容器键（U1：部分适配器再包一层）。 */
const RESPONSE_CONTAINER_KEYS = Object.freeze(["response", "native", "raw", "meta"]);

/** readStopReason 的归一返回值（D1/D2 口径）：未知/缺失一律 "unknown"。 */
export const STOP_REASON_UNKNOWN = "unknown";

/** I4 模板键（=中断 reason.kind 子集）；缺失字段占位符。 */
const PROMPT_UNKNOWN_TEXT = "未知";

/**
 * U1 归一：任意原始值 → "stop" | "toolUse" | null。
 * 内核 FinishReason 用 "stop"/"tool-calls"，日志侧 replayState.response.stopReason 用 "stop"/"toolUse"，
 * 两种命名都归一到计划书口径（toolUse 强佐证 / stop 合法放行）。
 * @param {unknown} raw - 原始停止原因值。
 * @returns {"stop"|"toolUse"|null} 可判定的归一值；不可判定返回 null。
 */
function normalizeStopKind(raw) {
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (value === "toolUse" || value === "tool-calls" || value === "toolCalls") return "toolUse";
	if (value === "stop") return "stop";
	return null;
}

/**
 * U1 启发式：从适配器私有 response 对象提取归一停止原因（限深递归，禁止深遍历）。
 * @param {unknown} response - replayState.response（结构适配器私有）。
 * @param {number} depth - 当前递归深度（容器键最多下探一层）。
 * @returns {"stop"|"toolUse"|null} 归一值；取不到返回 null。
 */
function extractFinishFromResponse(response, depth) {
	if (response === null || typeof response !== "object" || Array.isArray(response)) return null;
	for (const key of RESPONSE_FINISH_KEYS) {
		const normalized = normalizeStopKind(response[key]);
		if (normalized) return normalized;
	}
	if (depth >= 1) return null;
	for (const key of RESPONSE_CONTAINER_KEYS) {
		const normalized = extractFinishFromResponse(response[key], depth + 1);
		if (normalized) return normalized;
	}
	return null;
}

/**
 * U1：从 assistant/message 事件（live 或冷回放 data）读取归一停止原因。
 * 读 replayState.response（ReplayEnvelope，dsh-llm types.d.ts:396）按启发式键名提取；
 * 任何结构异常/缺失/不可识别值一律返回 "unknown"（禁止猜值）。
 * @param {{message?:{source?:{replayState?:{response?:unknown}}}}|null|undefined} event - assistant/message 的 data。
 * @returns {"stop"|"toolUse"|"unknown"} 归一停止原因。
 */
export function readStopReason(event) {
	try {
		const source = event?.message?.source ?? event?.source ?? null;
		const envelope = source?.replayState ?? null;
		if (envelope !== null && typeof envelope === "object") {
			const normalized = extractFinishFromResponse(envelope.response, 0);
			if (normalized) return normalized;
		}
	} catch { /* 结构异常按 unknown 降级（U1） */ }
	return STOP_REASON_UNKNOWN;
}

/**
 * U1 冷回放形态：事件对象为 {seq,type,time,data}，data 才是载荷。
 * @param {{data?:object}|object} event - 回放事件记录。
 * @returns {"stop"|"toolUse"|"unknown"} 归一停止原因。
 */
export function readStopReasonFromEvent(event) {
	return readStopReason(event?.data ?? event);
}

/**
 * D2 置信度：stopReason==="toolUse"（模型想继续却被收尾）或该 turn ≥3 步 → high；否则 low（0-step 等）。
 * @param {{stopReason?:string|null, stepCount?:number|null}} summary - 检测摘要。
 * @returns {"high"|"low"} 置信度。
 */
function confidenceOf(summary) {
	if (summary.stopReason === "toolUse") return "high";
	if (Number.isFinite(summary.stepCount) && summary.stepCount >= HIGH_CONFIDENCE_MIN_STEPS) return "high";
	return "low";
}

/**
 * D1–D4/D8：对一次 turn/end 的机械分类（纯函数，零语义判定）。
 * 决策表（互斥穷尽，端点无双命中）：
 *  - kind 缺失/未识别 → unknown（D8 落 detected(confidence:"unknown") 仅告警）；
 *  - stopReason==="stop" → complete（D1 OR：佐证为合法停止即放行）；
 *  - completed → complete（D1）；
 *  - aborted / abort-turn / interrupted → exclude（D3-①②）；
 *  - error 且 failure.code 命中 C6 清单 → exclude（D4）；error 其余 → interrupt（code 缺失按 low 仅告警）；
 *  - blocked / max-tokens → interrupt（D2-①）。
 * @param {{reasonKind?:string|null, stopReason?:string|null, stepCount?:number|null, failureCode?:string|null, errorNoRetryCodes?:string[]|null}} summary
 *   turn/end 检测摘要（reasonKind 必填，其余可缺）。
 * @returns {{outcome:"interrupt"|"exclude"|"complete"|"unknown", confidence:"high"|"low"|"unknown", reasonKind:(string|null)}}
 *   outcome=interrupt 进入冷却检测；exclude/unknown 仅落 detected 事件不介入；complete 静默放行。
 */
export function classifyTurnEnd(summary = {}) {
	const reasonKind = typeof summary?.reasonKind === "string" && summary.reasonKind ? summary.reasonKind : null;
	if (reasonKind === null || !KNOWN_KINDS.includes(reasonKind)) {
		return { outcome: "unknown", confidence: "unknown", reasonKind };
	}
	if (summary.stopReason === "stop") {
		return { outcome: "complete", confidence: "high", reasonKind };
	}
	if (reasonKind === COMPLETED_KIND) {
		return { outcome: "complete", confidence: "high", reasonKind };
	}
	if (EXCLUDE_KINDS.includes(reasonKind)) {
		return { outcome: "exclude", confidence: "unknown", reasonKind };
	}
	if (reasonKind === "error") {
		const failureCode = typeof summary.failureCode === "string" ? summary.failureCode : null;
		const noRetryCodes = Array.isArray(summary.errorNoRetryCodes) ? summary.errorNoRetryCodes : [];
		if (failureCode !== null && noRetryCodes.some((code) => typeof code === "string" && code && failureCode.includes(code))) {
			return { outcome: "exclude", confidence: "unknown", reasonKind };
		}
		return { outcome: "interrupt", confidence: confidenceOf(summary), reasonKind };
	}
	return { outcome: "interrupt", confidence: confidenceOf(summary), reasonKind };
}

/**
 * I4：渲染续跑指令（三模板逐字照计划书；字段缺失写「未知」，禁止编造）。
 * @param {("blocked"|"max-tokens"|"error"|null|undefined)} promptKind - 模板键（=中断 reason.kind）。
 * @param {{turn?:number|null, steps?:number|null, failureMessage?:string|null}} [vars] - 模板变量。
 * @returns {(string|null)} 指令文本；promptKind 未知返回 null（调用方 fail-safe 跳过投递）。
 */
export function renderResumePrompt(promptKind, vars = {}) {
	const turnText = vars.turn == null ? PROMPT_UNKNOWN_TEXT : String(vars.turn);
	if (promptKind === "blocked") {
		const stepText = vars.steps == null ? PROMPT_UNKNOWN_TEXT : String(vars.steps);
		return [
			`<silent-resume turn="${turnText}" reason="blocked">`,
			`上一回合在第 ${stepText} 步被步级上限中断，未形成面向用户的结论。本回合：`,
			"1. 先用一段中文文字汇报：已完成事项、关键证据或产物路径、剩余工作；",
			"2. 再继续推进；若再次接近步限，优先输出阶段性结论，不要发起新的工具调用。",
			"</silent-resume>"
		].join("\n");
	}
	if (promptKind === "max-tokens") {
		return [
			`<silent-resume turn="${turnText}" reason="max-tokens">`,
			"上一回合因输出长度上限中断；先给当前结论与断点再继续。本回合：",
			"1. 先用一段中文文字汇报：已完成事项、关键证据或产物路径、剩余工作；",
			"2. 再继续推进；若再次接近步限，优先输出阶段性结论，不要发起新的工具调用。",
			"</silent-resume>"
		].join("\n");
	}
	if (promptKind === "error") {
		const failureText = vars.failureMessage == null || vars.failureMessage === "" ? PROMPT_UNKNOWN_TEXT : String(vars.failureMessage);
		return [
			`<silent-resume turn="${turnText}" reason="error">`,
			`上一回合因运行时错误中断：${failureText}。本回合：`,
			"1. 先用一段中文文字汇报：已完成事项、关键证据或产物路径、剩余工作；",
			"2. 再继续推进；不要以相同参数重试导致错误的调用，先给结论再换路径。",
			"</silent-resume>"
		].join("\n");
	}
	return null;
}

/** 新会话状态机条目（I5：IDLE 初始态）。 */
function newEntry() {
	return {
		phase: "idle",
		turn: null,
		reasonKind: null,
		confidence: null,
		stepCount: null,
		failureMessage: null,
		detectedAt: null,
		resumedRounds: 0,
		resumeTurn: null,
		promptKind: null,
		lastResumeKind: null,
		progress: { steps: 0, toolCalls: 0 },
		notified: false,
		channel: null
	};
}

/**
 * 非负数值收敛：非法回退 fallback（设置键由 settings.js 校验，这里只兜底运行期形态）。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 回退值。
 * @returns {number} 有限非负数值。
 */
function nonNegativeNumber(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 静默中断控制器：会话状态机 + 冷却扫描 + 四模式投递（计划书 I1–I5/G1–G6）。
 *
 * 全部入口 fail-open（G6/D8）：异常只落事件与告警日志，禁止抛穿调用方主流程。
 * @param {object} deps - 依赖注入。
 * @param {(name:string, payload:object)=>void} deps.emit - 事件出口（index.js emitForModule，走 session.append+console.warn）。
 * @param {(line:string)=>void} deps.log - 结构化日志。
 * @param {()=>object} deps.getSettings - 运行时设置（C1–C9 逐字键名）。
 * @param {()=>({get?:(sessionId:string)=>object}|null)} [deps.getAgents] - agents 服务弱探测。
 * @param {()=>({get?:(agent:object)=>object, resume?:(agent:object, ref:object)=>object}|null)} [deps.getGoals] - goals 服务弱探测。
 * @param {()=>({notify?:(input:object)=>void}|null)} [deps.getNotify] - agent-notify 服务弱探测。
 * @returns {object} 控制器（onAssistantMessage/onTurnStart/onTurnEnd/onToolCall/onStepStart/onUserMessage/onSweep/forgetSession/destroy）。
 */
export function createSilentAbortController({
	emit = () => {},
	log = (line) => console.warn(line),
	getSettings = () => ({}),
	getAgents = () => null,
	getGoals = () => null,
	getNotify = () => null
} = {}) {
	/** sessionId → 状态机条目（I5）。 */
	const states = new Map();
	/** sessionId → 末条 assistant/message 元信息（旁路记录，不动既有 stall 喂数）。 */
	const lastMessageBySession = new Map();

	const entryOf = (sid) => {
		let entry = states.get(sid);
		if (!entry) {
			entry = newEntry();
			states.set(sid, entry);
		}
		return entry;
	};

	function emitEvent(name, sid, payload) {
		try {
			emit(name, { sessionId: sid, ...payload });
		} catch (error) {
			try { log(`静默中断事件出口异常（fail-open）event=${name}: ${error?.message ?? error}`); } catch { /* ignore */ }
		}
	}

	function settingsOf() {
		try { return getSettings() ?? {}; } catch { return {}; }
	}

	function notifyHuman(sid, title, body, severity) {
		try {
			const service = getNotify();
			if (service && typeof service.notify === "function") {
				service.notify({ title, body, severity, sessionId: sid });
				return;
			}
			log(`agent-notify 缺失（fail-open）：${title} ${body}`);
		} catch (error) {
			log(`agent-notify 通知失败（fail-open）：${error?.message ?? error}`);
		}
	}

	/** G5：续跑 turn 进展是否达标（step/start ≥ C5 或 ≥1 个 tool/call，OR）。 */
	function progressMet(entry, settings) {
		const minSteps = nonNegativeNumber(settings.progressMinSteps, 3);
		return (Number.isFinite(entry.progress.steps) && entry.progress.steps >= minSteps) || entry.progress.toolCalls >= 1;
	}

	function resetEntry(entry) {
		const rounds = entry.resumedRounds;
		Object.assign(entry, newEntry());
		entry.resumedRounds = rounds; // G1：预算跨冷却不重置，真人接管才清零
	}

	function clearSession(sid) {
		states.delete(sid);
		lastMessageBySession.delete(sid);
	}

	function escalate(sid, entry, cause, message, turn = entry.turn) {
		entry.phase = "escalated";
		if (turn != null) entry.turn = turn;
		emitEvent(EVT.SILENT_ABORT_ESCALATED, sid, { turn: entry.turn, cause, message: message ?? null });
		notifyHuman(sid, "静默中断自动续跑已升级人工处理", message ?? `原因：${cause ?? "未知"}`, "error");
	}

	function cancelEntry(sid, entry, cause) {
		emitEvent(EVT.SILENT_ABORT_CANCELLED, sid, { turn: entry.turn, cause });
		resetEntry(entry);
	}

	function resolveEntry(sid, entry, outcome, turn = entry.turn) {
		emitEvent(EVT.SILENT_ABORT_RESOLVED, sid, { turn, rounds: entry.resumedRounds, outcome });
		resetEntry(entry);
	}

	function markResumed(entry) {
		entry.resumedRounds += 1;
		entry.phase = "resumed";
		entry.resumeTurn = null; // 等配对 turn/start 登记（onTurnStart）
		entry.lastResumeKind = entry.reasonKind;
		entry.progress = { steps: 0, toolCalls: 0 };
	}

	/** I6 detected 事件（D3/D8 的 exclude/unknown 也落，仅不介入）。 */
	function emitDetected(sid, turn, verdict, summary) {
		emitEvent(EVT.SILENT_ABORT_DETECTED, sid, {
			turn,
			reasonKind: verdict.reasonKind,
			stopReason: summary.stopReason ?? STOP_REASON_UNKNOWN,
			stepCount: summary.turnEndStepCount,
			lastTextLen: summary.lastTextLen,
			concludingTextReached: summary.concludingTextReached === true,
			confidence: verdict.confidence
		});
	}

	/** I2-①：agents 服务探测（缺失→escalated(agent-service-gone)）。 */
	function resolveAgent(sid, entry) {
		const agents = getAgents();
		if (!agents || typeof agents.get !== "function") {
			escalate(sid, entry, "agent-service-gone", "agents 服务不可用，无法在原窗口续跑", entry.turn);
			return null;
		}
		let agent = null;
		try {
			agent = agents.get(sid) ?? null;
		} catch (error) {
			log(`agents.get 失败（fail-open）sid=${sid}: ${error?.message ?? error}`);
		}
		if (!agent || typeof agent.followup !== "function") {
			escalate(sid, entry, "agent-gone", "该会话没有 live agent，无法续跑", entry.turn);
			return null;
		}
		return agent;
	}

	/** D3-④：inbox next-turn 已有排队消息则让位（结构不可探测时 fail-open 不拦）。 */
	function inboxPending(agent) {
		try {
			const inbox = agent?.inbox ?? null;
			if (!inbox) return false;
			const pending = inbox.nextTurn ?? inbox.pending ?? null;
			return Array.isArray(pending) && pending.length > 0;
		} catch {
			return false;
		}
	}

	/** G4：goals 弱探测（失败/缺失返回 null，不拦）。 */
	function tryGetGoal(agent) {
		const goals = getGoals();
		if (!goals || typeof goals.get !== "function") return null;
		try {
			return goals.get(agent) ?? null;
		} catch (error) {
			log(`goals.get 失败（fail-open）: ${error?.message ?? error}`);
			return null;
		}
	}

	/** I3：goal-resume 通道（blocked/paused goal → goals.resume；抛错→escalated(round-limit)）。 */
	function deliverGoalResume(sid, entry, agent, goal) {
		const goals = getGoals();
		try {
			goals.resume(agent, { id: goal.id, revision: goal.revision });
		} catch (error) {
			const detail = error?.message ?? String(error);
			escalate(sid, entry, "round-limit", `goal resume 失败（${detail}）；请提高 maxGoalRounds 后人工 resume`, entry.turn);
			return;
		}
		emitEvent(EVT.SILENT_ABORT_RESUME_SENT, sid, {
			turn: entry.turn,
			round: entry.resumedRounds + 1,
			channel: "goal-resume",
			promptKind: entry.promptKind ?? null
		});
		markResumed(entry);
	}

	/** I2：原窗口 followup 投递（严格顺序；抛错落 escalated(followup-threw) 不重抛）。 */
	function deliverFollowup(sid, entry, agent) {
		const text = renderResumePrompt(entry.promptKind, {
			turn: entry.turn,
			steps: entry.stepCount,
			failureMessage: entry.failureMessage
		});
		if (typeof text !== "string") {
			log(`静默中断：未知模板键 ${String(entry.promptKind)}，跳过投递（fail-safe）`);
			resetEntry(entry);
			return;
		}
		let message = null;
		try {
			message = createUserMessage({ content: [{ type: "text", text }], source: PLUGIN_SOURCE });
		} catch (error) {
			escalate(sid, entry, "followup-threw", `续跑消息构造失败：${error?.message ?? error}`, entry.turn);
			return;
		}
		try {
			agent.followup(message);
		} catch (error) {
			escalate(sid, entry, "followup-threw", `followup 投递失败：${error?.message ?? error}`, entry.turn);
			return;
		}
		emitEvent(EVT.SILENT_ABORT_RESUME_SENT, sid, {
			turn: entry.turn,
			round: entry.resumedRounds + 1,
			channel: "followup",
			promptKind: entry.promptKind
		});
		markResumed(entry);
	}

	/** I1/I2/I3：冷却到点后的模式分发（互斥穷尽；回退链固定）。 */
	function deliverResume(sid, entry, mode) {
		const agent = resolveAgent(sid, entry);
		if (!agent) return;
		if (agent.status !== "idle") {
			cancelEntry(sid, entry, "not-idle");
			return;
		}
		if (inboxPending(agent)) {
			cancelEntry(sid, entry, "inbox-pending");
			return;
		}
		const goal = tryGetGoal(agent);
		if (goal && goal.phase === "active" && goal.activation === "armed") {
			cancelEntry(sid, entry, "goal-armed");
			return;
		}
		if (mode === "goal-resume" && goal && (goal.phase === "blocked" || goal.phase === "paused")) {
			deliverGoalResume(sid, entry, agent, goal);
			return;
		}
		deliverFollowup(sid, entry, agent);
	}

	/** notify 模式：冷却到点后只发一次 agent-notify 告警（不发消息，I1）。 */
	function notifyOnce(sid, entry) {
		if (entry.notified) return;
		entry.notified = true;
		notifyHuman(
			sid,
			`检测到静默中断（turn ${entry.turn ?? PROMPT_UNKNOWN_TEXT}）`,
			`原因 ${entry.reasonKind ?? PROMPT_UNKNOWN_TEXT}；当前模式仅告警不自动续跑，需要介入请在设置中切换「静默中断动作模式」`,
			"warn"
		);
	}

	/** 事件出口内的设置摘要组装（onTurnEnd 专用）。 */
	function buildSummary(sid, turn, reason, settings) {
		const meta = lastMessageBySession.get(sid) ?? null;
		const sameTurn = meta !== null && meta.turn === turn;
		const lastTextLen = sameTurn && Number.isFinite(meta.textLen) ? meta.textLen : null;
		const minLen = nonNegativeNumber(settings.concludingTextMinLen, 200);
		const failure = reason?.error ?? null;
		return {
			reasonKind: typeof reason?.kind === "string" ? reason.kind : null,
			stopReason: sameTurn ? (meta.stopReason ?? STOP_REASON_UNKNOWN) : STOP_REASON_UNKNOWN,
			turnEndStepCount: sameTurn && Number.isFinite(meta.step) ? meta.step : null,
			lastTextLen,
			concludingTextReached: lastTextLen !== null && lastTextLen >= minLen,
			failureCode: typeof failure?.code === "string" ? failure.code : null,
			failureMessage: typeof failure?.message === "string" ? failure.message : null,
			errorNoRetryCodes: Array.isArray(settings.errorNoRetryCodes) ? settings.errorNoRetryCodes : []
		};
	}

	return {
		/** 旁路记录每会话末条 assistant/message 元信息（index.js 接线；不动既有 stall 喂数）。 */
		onAssistantMessage(sid, meta) {
			if (!sid) return;
			lastMessageBySession.set(sid, {
				turn: Number.isFinite(meta?.turn) ? meta.turn : null,
				step: Number.isFinite(meta?.step) ? meta.step : null,
				textLen: Number.isFinite(meta?.textLen) ? meta.textLen : null,
				stopReason: typeof meta?.stopReason === "string" ? meta.stopReason : STOP_REASON_UNKNOWN,
				lastBlockType: typeof meta?.lastBlockType === "string" ? meta.lastBlockType : null,
				ts: Date.now()
			});
		},
		/** turn/start：D2-② 冷却窗内出现新 turn 让位；RESUMED 后登记续跑 turn（G5 计数起点）。 */
		onTurnStart(sid, turn) {
			const entry = states.get(sid);
			if (!entry) return;
			if (entry.phase === "detected") {
				cancelEntry(sid, entry, "already-running");
				return;
			}
			if (entry.phase === "resumed" && entry.resumeTurn === null && turn != null && turn !== entry.turn) {
				entry.resumeTurn = turn;
			}
		},
		/** D7 主判据入口：turn/end 到达即判定（interrupt→进冷却，不立即续）。 */
		onTurnEnd(sid, turn, reason, now = Date.now()) {
			const settings = settingsOf();
			if (settings.enableSilentAbortWatch === false) return;
			const mode = SILENT_ABORT_ACTIONS.includes(settings.silentAbortAction) ? settings.silentAbortAction : "notify";
			if (mode === "off") return; // I1：off 不检测（连 detected 事件都不落）
			const entry = states.get(sid) ?? null;
			const summary = buildSummary(sid, turn, reason, settings);
			if (entry !== null && entry.phase === "resumed" && entry.resumeTurn === turn) {
				const verdict = classifyTurnEnd(summary);
				if (!progressMet(entry, settings)) {
					escalate(sid, entry, "no-progress", `续跑 turn 进展不足（${entry.progress.steps} 步、${entry.progress.toolCalls} 个工具调用，低于 progressMinSteps=${settings.progressMinSteps}）`, turn);
					return;
				}
				if (verdict.outcome === "complete") {
					resolveEntry(sid, entry, "concluded", turn);
					return;
				}
				resetEntry(entry); // exclude/unknown/interrupt：回 IDLE，interrupt 落入下方标准检测
			}
			if (entry !== null && entry.phase === "escalated") return; // 终态：真人发消息前不再检测（I5）
			const verdict = classifyTurnEnd(summary);
			if (verdict.outcome === "complete") return; // D1：自然结束静默放行
			if (verdict.outcome !== "interrupt") {
				emitDetected(sid, turn, verdict, summary); // D3/D8：仅落事件不介入
				resetEntry(entryOf(sid));
				return;
			}
			const fresh = entryOf(sid);
			if (fresh.resumedRounds >= nonNegativeNumber(settings.maxAutoResumePerSession, 3)) {
				escalate(sid, fresh, "budget", `自动续跑次数已用尽（maxAutoResumePerSession=${settings.maxAutoResumePerSession}）`, turn);
				return;
			}
			fresh.phase = "detected";
			fresh.turn = turn;
			fresh.reasonKind = verdict.reasonKind;
			fresh.confidence = verdict.confidence;
			fresh.stepCount = summary.turnEndStepCount;
			fresh.failureMessage = summary.failureMessage;
			fresh.detectedAt = now;
			fresh.promptKind = verdict.reasonKind;
			fresh.notified = false;
			emitDetected(sid, turn, verdict, summary);
		},
		/** G5：续跑 turn 内 tool/call 计数。 */
		onToolCall(sid, turn) {
			const entry = states.get(sid);
			if (!entry || entry.phase !== "resumed") return;
			if (entry.resumeTurn != null && entry.resumeTurn !== turn) return;
			entry.progress.toolCalls += 1;
		},
		/** G5：续跑 turn 内 step/start 计数（取最大步号）。 */
		onStepStart(sid, turn, step) {
			const entry = states.get(sid);
			if (!entry || entry.phase !== "resumed") return;
			if (entry.resumeTurn === null && turn != null && turn !== entry.turn) entry.resumeTurn = turn;
			if (entry.resumeTurn !== turn) return;
			if (Number.isFinite(step) && step > entry.progress.steps) entry.progress.steps = step;
		},
		/** G3/I5：真人消息（index.js 已滤 PLUGIN_SOURCE）→ CANCELLED + RESOLVED(human-took-over)，预算清零。 */
		onUserMessage(sid) {
			const entry = states.get(sid);
			if (!entry) return;
			if (entry.phase !== "idle") {
				emitEvent(EVT.SILENT_ABORT_CANCELLED, sid, { turn: entry.turn, cause: "human" });
				emitEvent(EVT.SILENT_ABORT_RESOLVED, sid, { turn: entry.turn, rounds: entry.resumedRounds, outcome: "human-took-over" });
			}
			clearSession(sid);
		},
		/** D7/G2：心跳扫描入口（复用既有 30s 定时器，不另起 timer）；now 注入可测。 */
		onSweep(now = Date.now()) {
			const settings = settingsOf();
			if (settings.enableSilentAbortWatch === false) return;
			const cooldownMs = nonNegativeNumber(settings.cooldownMs, 15000);
			const mode = SILENT_ABORT_ACTIONS.includes(settings.silentAbortAction) ? settings.silentAbortAction : "notify";
			for (const [sid, entry] of states) {
				try {
					if (entry.phase !== "detected") continue;
					if (now - entry.detectedAt < cooldownMs) continue;
					if (mode === "notify") {
						notifyOnce(sid, entry);
						continue;
					}
					deliverResume(sid, entry, mode);
				} catch (error) {
					log(`静默中断扫描异常（fail-open）sid=${sid}: ${error?.message ?? error}`);
				}
			}
		},
		/** 会话 TTL 回收联动（pruneStaleSessions 调用），防 Map 泄漏。 */
		forgetSession(sid) {
			clearSession(sid);
		},
		/** 卸载清理。 */
		destroy() {
			states.clear();
			lastMessageBySession.clear();
		}
	};
}
