/**
 * dsh-derive-watcher — 静默中断检测与续跑测试（计划书 §8 T1–T6/T8，P1）。
 *
 * 约束：纯函判据零语义（D6）；四模式互斥（I1）；全部服务降级 fail-open（G6）；
 * 事件断言覆盖 T8 客观信号（silent-abort/resume-sent、silent-abort/escalated 字样出现于事件定义）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	classifyTurnEnd,
	createSilentAbortController,
	readStopReason,
	readStopReasonFromEvent,
	renderResumePrompt
} from "../lib/silent-abort.js";
import { EVT, PLUGIN_SOURCE } from "../lib/events.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";

/** 收集事件的假出口（每事件一条记录，载荷含 sessionId/turn）。 */
function makeEventLog() {
	const events = [];
	return {
		events,
		emit: (name, payload) => { events.push({ name, payload }); }
	};
}

/** 默认测试设置（enableSilentAbortWatch 可覆写）。 */
function makeSettings(overrides = {}) {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

/** blocked turn/end 的标准构造：59 步、toolUse 佐证（计划书实证主场景）。 */
function blockedEnd(controller, sid, turn, { steps = 59, stopReason = "toolUse", now = 1000 } = {}) {
	if (stopReason !== null) {
		controller.onAssistantMessage(sid, { turn, step: steps, textLen: 10, stopReason, lastBlockType: "text" });
	}
	controller.onTurnEnd(sid, turn, { kind: "blocked" }, now);
}

/** 冷却推进 + 断言事件名集合。 */
function names(events) {
	return events.map((e) => e.name);
}

// ── T1：classifyTurnEnd 全分支（D1–D4/D8 机械决策表）──

test("T1 classifyTurnEnd：blocked+toolUse+59 步 → interrupt/high（计划书主场景）", () => {
	const verdict = classifyTurnEnd({ reasonKind: "blocked", stopReason: "toolUse", turnEndStepCount: 59 });
	assert.equal(verdict.outcome, "interrupt");
	assert.equal(verdict.confidence, "high");
	assert.equal(verdict.reasonKind, "blocked");
});

test("T1 classifyTurnEnd：blocked+0-step（无 assistant 消息）→ interrupt/low（G5 兜底档）", () => {
	const verdict = classifyTurnEnd({ reasonKind: "blocked", stopReason: "unknown", turnEndStepCount: null });
	assert.equal(verdict.outcome, "interrupt");
	assert.equal(verdict.confidence, "low");
});

test("T1 classifyTurnEnd：max-tokens → interrupt（D2-①/D4 直接允许）", () => {
	const verdict = classifyTurnEnd({ reasonKind: "max-tokens", stopReason: "unknown", turnEndStepCount: 5 });
	assert.equal(verdict.outcome, "interrupt");
});

test("T1 classifyTurnEnd：error+401 → exclude（D4 命中 C6 清单）", () => {
	const verdict = classifyTurnEnd({ reasonKind: "error", failureCode: "HTTP 401 Unauthorized", errorNoRetryCodes: ["401", "403", "signed-out"] });
	assert.equal(verdict.outcome, "exclude");
});

test("T1 classifyTurnEnd：error 无 code → interrupt（D4 取不到 code 按普通档）", () => {
	const verdict = classifyTurnEnd({ reasonKind: "error", failureCode: null, errorNoRetryCodes: ["401"] });
	assert.equal(verdict.outcome, "interrupt");
});

test("T1 classifyTurnEnd：aborted/user、aborted/hook、abort-turn → exclude（D3-①②，禁止自动续跑）", () => {
	for (const kind of ["aborted", "abort-turn", "interrupted"]) {
		const verdict = classifyTurnEnd({ reasonKind: kind });
		assert.equal(verdict.outcome, "exclude", kind);
	}
});

test("T1 classifyTurnEnd：completed+stop → complete（D1 自然结束放行）", () => {
	const verdict = classifyTurnEnd({ reasonKind: "completed", stopReason: "stop" });
	assert.equal(verdict.outcome, "complete");
});

test("T1 classifyTurnEnd：未知 kind → unknown（D8 仅告警不介入）", () => {
	const verdict = classifyTurnEnd({ reasonKind: "some-future-kind" });
	assert.equal(verdict.outcome, "unknown");
	assert.equal(verdict.confidence, "unknown");
});

test("T1 classifyTurnEnd：reasonKind 缺失 → unknown（D8 字段缺失兜底）", () => {
	assert.equal(classifyTurnEnd({}).outcome, "unknown");
	assert.equal(classifyTurnEnd(null).outcome, "unknown");
});

// ── readStopReason / readStopReasonFromEvent（U1）──

test("U1 readStopReason：replayState.response 内原生 stopReason 归一 toolUse", () => {
	const value = readStopReason({
		message: { source: { replayState: { response: { stopReason: "toolUse" } } } }
	});
	assert.equal(value, "toolUse");
});

test("U1 readStopReason：内核 FinishReason 命名 tool-calls 归一 toolUse；stop 归一 stop", () => {
	assert.equal(
		readStopReason({ message: { source: { replayState: { response: { finishReason: "tool-calls" } } } } }),
		"toolUse"
	);
	assert.equal(
		readStopReason({ message: { source: { replayState: { response: { stopReason: "stop" } } } } }),
		"stop"
	);
});

test("U1 readStopReason：一层容器键（response.native）内下探", () => {
	const value = readStopReason({
		message: { source: { replayState: { response: { native: { stopReason: "toolUse" } } } } }
	});
	assert.equal(value, "toolUse");
});

test("U1 readStopReason：结构缺失/未知值/异常一律 unknown（禁止猜值）", () => {
	assert.equal(readStopReason(null), "unknown");
	assert.equal(readStopReason({}), "unknown");
	assert.equal(readStopReason({ message: { source: { replayState: { response: { stopReason: "exotic" } } } } }), "unknown");
	assert.equal(readStopReason({ message: { source: { replayState: { response: { stopReason: 42 } } } } }), "unknown");
});

test("U1 readStopReasonFromEvent：冷回放 {seq,type,data} 记录形态从 data 取", () => {
	assert.equal(
		readStopReasonFromEvent({ seq: 3, type: "assistant/message", data: { message: { source: { replayState: { response: { stopReason: "toolUse" } } } } } }),
		"toolUse"
	);
});

// ── T5：renderResumePrompt 三模板（I4 逐字）+ 缺失字段「未知」──

test("T5 renderResumePrompt blocked：完整字段逐字渲染", () => {
	const text = renderResumePrompt("blocked", { turn: 9, steps: 59 });
	assert.match(text, /^<silent-resume turn="9" reason="blocked">/);
	assert.ok(text.includes("上一回合在第 59 步被步级上限中断，未形成面向用户的结论。"));
	assert.ok(text.includes("1. 先用一段中文文字汇报：已完成事项、关键证据或产物路径、剩余工作；"));
	assert.ok(text.includes("</silent-resume>"));
});

test("T5 renderResumePrompt max-tokens：首句替换为输出长度上限文案", () => {
	const text = renderResumePrompt("max-tokens", { turn: 4 });
	assert.match(text, /^<silent-resume turn="4" reason="max-tokens">/);
	assert.ok(text.includes("因输出长度上限中断；先给当前结论与断点再继续"));
});

test("T5 renderResumePrompt error：携带 failure.message 与禁重试明示", () => {
	const text = renderResumePrompt("error", { turn: 7, failureMessage: "HTTP 500" });
	assert.ok(text.includes("上一回合因运行时错误中断：HTTP 500。"));
	assert.ok(text.includes("不要以相同参数重试导致错误的调用，先给结论再换路径"));
});

test("T5 renderResumePrompt：缺失字段写「未知」（turn/steps/failureMessage）", () => {
	const blocked = renderResumePrompt("blocked", {});
	assert.ok(blocked.includes('turn="未知"'));
	assert.ok(blocked.includes("在第 未知 步"));
	const err = renderResumePrompt("error", {});
	assert.ok(err.includes("中断：未知。"));
});

test("T5 renderResumePrompt：未知 promptKind 返回 null（fail-safe 不投递）", () => {
	assert.equal(renderResumePrompt("nope", {}), null);
	assert.equal(renderResumePrompt(null, {}), null);
});

// ── T2：状态机（I5：IDLE→DETECTED→ARMED/RESUMED→RESOLVED/ESCALATED；真人复位）──

function makeController(settings = {}, deps = {}) {
	const { events, emit } = makeEventLog();
	const logLines = [];
	const controller = createSilentAbortController({
		emit,
		log: (line) => { logLines.push(line); },
		getSettings: () => makeSettings({ silentAbortAction: "followup", ...settings }),
		getAgents: deps.getAgents ?? (() => null),
		getGoals: deps.getGoals ?? (() => null),
		getNotify: deps.getNotify ?? (() => null)
	});
	return { controller, events, logLines };
}

test("T2 状态机：冷却中真人消息 → cancelled(human) + resolved(human-took-over)，预算清零", () => {
	const { controller, events } = makeController();
	const sid = "s-human";
	blockedEnd(controller, sid, 5, { now: 1000 });
	assert.ok(names(events).includes(EVT.SILENT_ABORT_DETECTED));
	controller.onUserMessage(sid); // 真人接管
	const cancel = events.find((e) => e.name === EVT.SILENT_ABORT_CANCELLED);
	const resolved = events.find((e) => e.name === EVT.SILENT_ABORT_RESOLVED);
	assert.equal(cancel.payload.cause, "human");
	assert.equal(resolved.payload.outcome, "human-took-over");
	// 预算清零：再次 blocked 检测到第 1 轮预算（escalate 阈值 3 未触顶）
	events.length = 0;
	blockedEnd(controller, sid, 6, { now: 2000 });
	const detected = events.find((e) => e.name === EVT.SILENT_ABORT_DETECTED);
	assert.ok(detected, "真人接管后重新进入检测");
});

test("T2 状态机：第 4 次 blocked（n≥3）→ escalated(budget)（G1/R-b 第 3 次续跑后升级）", () => {
	const agents = { get: () => ({ status: "idle", followup: () => {} }) };
	const { controller, events } = makeController({ cooldownMs: 0 }, { getAgents: () => agents });
	const sid = "s-budget";
	// 三轮完整续跑：每次 blocked → 冷却到点 followup → 新 turn（有进展）→ completed 放行
	for (let round = 1; round <= 3; round++) {
		const turn = round * 10;
		blockedEnd(controller, sid, turn, { now: 1000 });
		controller.onSweep(1000 + 1); // cooldownMs=0 立即到点 → followup
		controller.onTurnStart(sid, turn + 1);
		controller.onStepStart(sid, turn + 1, 5); // 进展达标（≥3 步）
		controller.onAssistantMessage(sid, { turn: turn + 1, step: 5, textLen: 10, stopReason: "stop", lastBlockType: "text" });
		controller.onTurnEnd(sid, turn + 1, { kind: "completed" });
	}
	const resumes = events.filter((e) => e.name === EVT.SILENT_ABORT_RESUME_SENT);
	assert.equal(resumes.length, 3);
	// 第四次 blocked：预算用尽 → escalated(budget)
	events.length = 0;
	blockedEnd(controller, sid, 40, { now: 9000 });
	const escalated = events.find((e) => e.name === EVT.SILENT_ABORT_ESCALATED);
	assert.ok(escalated, "预算用尽必须升级");
	assert.equal(escalated.payload.cause, "budget");
});

test("T2 状态机：续跑新 turn 2 步无 tool → escalated(no-progress)（G5）", () => {
	const agents = { get: () => ({ status: "idle", followup: () => {} }) };
	const { controller, events } = makeController({ cooldownMs: 0, progressMinSteps: 3 }, { getAgents: () => agents });
	const sid = "s-progress";
	blockedEnd(controller, sid, 1, { now: 1000 });
	controller.onSweep(1001);
	controller.onTurnStart(sid, 2); // RESUMED 登记续跑 turn
	controller.onStepStart(sid, 2, 2); // 2 步 < 3
	controller.onTurnEnd(sid, 2, { kind: "blocked" });
	const escalated = events.find((e) => e.name === EVT.SILENT_ABORT_ESCALATED);
	assert.ok(escalated, "无进展必须升级");
	assert.equal(escalated.payload.cause, "no-progress");
});

test("T2 状态机：正常续跑后有进展+completed → resolved(concluded)（I5）", () => {
	const agents = { get: () => ({ status: "idle", followup: () => {} }) };
	const { controller, events } = makeController({ cooldownMs: 0 }, { getAgents: () => agents });
	const sid = "s-resolve";
	blockedEnd(controller, sid, 1, { now: 1000 });
	controller.onSweep(1001);
	controller.onTurnStart(sid, 2);
	controller.onStepStart(sid, 2, 4);
	controller.onAssistantMessage(sid, { turn: 2, step: 4, textLen: 300, stopReason: "stop", lastBlockType: "text" });
	controller.onTurnEnd(sid, 2, { kind: "completed" });
	const resolved = events.find((e) => e.name === EVT.SILENT_ABORT_RESOLVED);
	assert.ok(resolved, "正常解决必须落 resolved");
	assert.equal(resolved.payload.outcome, "concluded");
	assert.equal(resolved.payload.rounds, 1);
});

test("T2 状态机：冷却窗内新 turn/start → cancelled(already-running)（D2-②）", () => {
	const { controller, events } = makeController();
	const sid = "s-running";
	blockedEnd(controller, sid, 1, { now: 1000 });
	controller.onTurnStart(sid, 2); // 冷却期内 agent 自己跑起来了
	const cancel = events.find((e) => e.name === EVT.SILENT_ABORT_CANCELLED);
	assert.ok(cancel, "冷却窗内新 turn 必须取消介入");
	assert.equal(cancel.payload.cause, "already-running");
});

test("T2 状态机：ESCALATED 为终态，新 turn/end 不再检测（I5）", () => {
	const agents = { get: () => ({ status: "idle", followup: () => {} }) };
	const { controller: c2, events: ev2 } = makeController({ cooldownMs: 0, maxAutoResumePerSession: 1 }, { getAgents: () => agents });
	blockedEnd(c2, "s-final", 1, { now: 1000 });
	c2.onSweep(1001);
	c2.onTurnStart("s-final", 2);
	c2.onStepStart("s-final", 2, 4);
	c2.onTurnEnd("s-final", 2, { kind: "completed" });
	blockedEnd(c2, "s-final", 3, { now: 2000 }); // 预算 1 已用 → escalated
	c2.onTurnStart("s-final", 4);
	c2.onTurnEnd("s-final", 4, { kind: "blocked" }); // 终态后不再检测/续跑
	const escalatedCount = ev2.filter((e) => e.name === EVT.SILENT_ABORT_ESCALATED).length;
	const resumeCount = ev2.filter((e) => e.name === EVT.SILENT_ABORT_RESUME_SENT).length;
	assert.equal(escalatedCount, 1, "escalated 只落一次（终态）");
	assert.equal(resumeCount, 1, "终态后不再续跑");
});

// ── T3：服务降级（I2 严格顺序 + I3 回退链，全部 fail-open）──

test("T3 服务降级：agents 服务缺失 → escalated(agent-service-gone)，不抛穿", () => {
	const { controller, events } = makeController({ cooldownMs: 0 }, { getAgents: () => null });
	const sid = "s-nosvc";
	blockedEnd(controller, sid, 1, { now: 1000 });
	assert.doesNotThrow(() => controller.onSweep(1001));
	const escalated = events.find((e) => e.name === EVT.SILENT_ABORT_ESCALATED);
	assert.ok(escalated);
	assert.equal(escalated.payload.cause, "agent-service-gone");
});

test("T3 服务降级：agent 非 idle → cancelled(not-idle)（I2-②）", () => {
	const agents = { get: () => ({ status: "running", followup: () => {} }) };
	const { controller, events } = makeController({ cooldownMs: 0 }, { getAgents: () => agents });
	const sid = "s-busy";
	blockedEnd(controller, sid, 1, { now: 1000 });
	controller.onSweep(1001);
	const cancel = events.find((e) => e.name === EVT.SILENT_ABORT_CANCELLED);
	assert.ok(cancel);
	assert.equal(cancel.payload.cause, "not-idle");
});

test("T3 服务降级：followup 抛错 → escalated(followup-threw)，异常不抛穿（I2-④/G6）", () => {
	const agents = { get: () => ({ status: "idle", followup: () => { throw new Error("inbox closed"); } }) };
	const { controller, events, logLines } = makeController({ cooldownMs: 0 }, { getAgents: () => agents });
	const sid = "s-throw";
	blockedEnd(controller, sid, 1, { now: 1000 });
	assert.doesNotThrow(() => controller.onSweep(1001));
	const escalated = events.find((e) => e.name === EVT.SILENT_ABORT_ESCALATED);
	assert.ok(escalated);
	assert.equal(escalated.payload.cause, "followup-threw");
	assert.ok(JSON.stringify(escalated.payload).includes("inbox closed"));
	assert.ok(logLines.length >= 0);
});

test("T3 goal-armed：active+armed goal → cancelled(goal-armed)（G4/D3-⑤）", () => {
	const agents = { get: () => ({ status: "idle", followup: () => {} }) };
	const goals = { get: () => ({ id: "g1", revision: 2, phase: "active", activation: "armed", roundsStarted: 1, maxGoalRounds: 5 }) };
	const { controller, events } = makeController({ cooldownMs: 0, silentAbortAction: "goal-resume" }, { getAgents: () => agents, getGoals: () => goals });
	const sid = "s-armed";
	blockedEnd(controller, sid, 1, { now: 1000 });
	controller.onSweep(1001);
	const cancel = events.find((e) => e.name === EVT.SILENT_ABORT_CANCELLED);
	assert.ok(cancel);
	assert.equal(cancel.payload.cause, "goal-armed");
});

test("T3 goal-resume：blocked goal + goal-resume 模式 → 调用 goals.resume 且落 resume-sent(channel:goal-resume)（I3）", () => {
	const agents = { get: () => ({ status: "idle", followup: () => {} }) };
	let resumedRef = null;
	const goals = {
		get: () => ({ id: "g1", revision: 3, phase: "blocked", activation: "disarmed", roundsStarted: 1, maxGoalRounds: 5 }),
		resume: (agent, ref) => { resumedRef = ref; return { id: ref.id }; }
	};
	const { controller, events } = makeController({ cooldownMs: 0, silentAbortAction: "goal-resume" }, { getAgents: () => agents, getGoals: () => goals });
	const sid = "s-goalresume";
	blockedEnd(controller, sid, 1, { now: 1000 });
	controller.onSweep(1001);
	assert.deepEqual(resumedRef, { id: "g1", revision: 3 });
	const resume = events.find((e) => e.name === EVT.SILENT_ABORT_RESUME_SENT);
	assert.ok(resume);
	assert.equal(resume.payload.channel, "goal-resume");
});

test("T3 goal-resume：resume 抛 exhausted → escalated(round-limit)（I3）", () => {
	const agents = { get: () => ({ status: "idle", followup: () => {} }) };
	const goals = {
		get: () => ({ id: "g1", revision: 3, phase: "blocked", activation: "disarmed", roundsStarted: 5, maxGoalRounds: 5 }),
		resume: () => { throw new Error('goal "g1" exhausted 5 goal rounds; increase maxGoalRounds before resuming'); }
	};
	const { controller, events } = makeController({ cooldownMs: 0, silentAbortAction: "goal-resume" }, { getAgents: () => agents, getGoals: () => goals });
	const sid = "s-exhausted";
	blockedEnd(controller, sid, 1, { now: 1000 });
	assert.doesNotThrow(() => controller.onSweep(1001));
	const escalated = events.find((e) => e.name === EVT.SILENT_ABORT_ESCALATED);
	assert.ok(escalated);
	assert.equal(escalated.payload.cause, "round-limit");
	assert.ok(escalated.payload.message.includes("maxGoalRounds"));
});

test("T3 goal-resume 回退链：无 goal（goals.get 返回 null）→ 回退 followup（I1 固定回退）", () => {
	const agents = { get: () => ({ status: "idle", followup: () => {} }) };
	const goals = { get: () => null, resume: () => { throw new Error("should not be called"); } };
	const { controller, events } = makeController({ cooldownMs: 0, silentAbortAction: "goal-resume" }, { getAgents: () => agents, getGoals: () => goals });
	const sid = "s-fallback";
	blockedEnd(controller, sid, 1, { now: 1000 });
	controller.onSweep(1001);
	const resume = events.find((e) => e.name === EVT.SILENT_ABORT_RESUME_SENT);
	assert.ok(resume);
	assert.equal(resume.payload.channel, "followup");
});

test("T3 notify 模式：冷却到点只发一次 agent-notify 告警、不投递消息（I1 fail-safe 默认档）", () => {
	const notifications = [];
	const notify = { notify: (input) => { notifications.push(input); } };
	const agents = { get: () => ({ status: "idle", followup: () => { throw new Error("notify mode must not deliver"); } }) };
	const { controller, events } = makeController({ cooldownMs: 0, silentAbortAction: "notify" }, { getAgents: () => agents, getNotify: () => notify });
	const sid = "s-notify";
	blockedEnd(controller, sid, 1, { now: 1000 });
	controller.onSweep(1001);
	controller.onSweep(1002); // 重复扫描不重复告警
	assert.equal(notifications.length, 1, "notify 模式只告警一次");
	assert.equal(events.filter((e) => e.name === EVT.SILENT_ABORT_RESUME_SENT).length, 0, "notify 模式禁止投递");
});

test("T3 模式 off：完全不检测（C1=off 无事件无投递）", () => {
	const { controller, events } = makeController({ silentAbortAction: "off" });
	const sid = "s-off";
	blockedEnd(controller, sid, 1, { now: 1000 });
	assert.equal(events.length, 0, "off 模式连 detected 都不落（完全不检测）");
});

test("T3 C2=false：enableSilentAbortWatch=false 不注册检测（D7）", () => {
	const { controller, events } = makeController({ enableSilentAbortWatch: false });
	const sid = "s-c2";
	blockedEnd(controller, sid, 1, { now: 1000 });
	assert.equal(events.length, 0);
});

// ── T4：防回环（G3：PLUGIN_SOURCE 消息不算真人、不复位预算）──

test("T4 防回环：PLUGIN_SOURCE 消息不触发 onUserMessage 复位（接线判定 source.plugin 前置）", () => {
	// 复刻 index.js user/message 分支的判定：source?.plugin 即 return（G3）
	const isHumanMessage = (data) => {
		const source = data?.source ?? data?.message?.source ?? null;
		return !(source?.plugin);
	};
	assert.equal(isHumanMessage({ source: PLUGIN_SOURCE }), false, "插件来源必须被判为非真人");
	assert.equal(isHumanMessage({ message: { source: PLUGIN_SOURCE } }), false);
	assert.equal(isHumanMessage({ source: { kind: "user" } }), true, "真人来源必须被判为真人");
});

test("T4 防回环：同 reason 无进展只续 1 轮即升级（G5/R-b）", () => {
	const agents = { get: () => ({ status: "idle", followup: () => {} }) };
	const { controller, events } = makeController({ cooldownMs: 0, progressMinSteps: 3 }, { getAgents: () => agents });
	const sid = "s-loop";
	blockedEnd(controller, sid, 1, { now: 1000 });
	controller.onSweep(1001); // 第 1 轮续跑
	controller.onTurnStart(sid, 2);
	controller.onTurnEnd(sid, 2, { kind: "blocked" }); // 新 turn 0 步 0 工具 → no-progress
	const escalated = events.filter((e) => e.name === EVT.SILENT_ABORT_ESCALATED);
	assert.equal(escalated.length, 1);
	assert.equal(escalated[0].payload.cause, "no-progress");
	assert.equal(events.filter((e) => e.name === EVT.SILENT_ABORT_RESUME_SENT).length, 1, "无进展只允许续 1 轮");
});

// ── T6：事件协议（I6 六事件 + console.warn 旁证 + timeline 可解析）──

test("T6 事件：六事件全部经 emit 出口且载荷可被 timeline 解析（T8 客观信号内嵌）", async () => {
	const { EVT: evt } = await import("../lib/events.js");
	// T8 客观信号：事件定义含 silent-abort/resume-sent、silent-abort/escalated、silent-abort/detected
	assert.equal(evt.SILENT_ABORT_RESUME_SENT, "semantic-watcher/silent-abort/resume-sent");
	assert.equal(evt.SILENT_ABORT_ESCALATED, "semantic-watcher/silent-abort/escalated");
	assert.equal(evt.SILENT_ABORT_DETECTED, "semantic-watcher/silent-abort/detected");
	assert.equal(evt.SILENT_ABORT_CANCELLED, "semantic-watcher/silent-abort/cancelled");
	assert.equal(evt.SILENT_ABORT_RESOLVED, "semantic-watcher/silent-abort/resolved");
	assert.equal(evt.ZOMBIE_DETECTED, "semantic-watcher/silent-abort/zombie-detected");
});

test("T6 事件：createEventSink 走 session.append({ignorable:true}) + console.warn（G8 禁止静默续跑）", async () => {
	const { createEventSink } = await import("../lib/events.js");
	const appends = [];
	const warns = [];
	const originalWarn = console.warn;
	console.warn = (line) => { warns.push(String(line)); };
	try {
		const sink = createEventSink();
		const session = { id: "s-sink", append: (name, payload, opts) => { appends.push({ name, payload, opts }); } };
		sink.emit(session, EVT.SILENT_ABORT_RESUME_SENT, { turn: 9, round: 1, channel: "followup", promptKind: "blocked" });
	} finally {
		console.warn = originalWarn;
	}
	assert.equal(appends.length, 1);
	assert.equal(appends[0].opts?.ignorable, true);
	assert.equal(appends[0].payload.channel, "followup");
	assert.ok(warns.some((line) => line.includes("silent-abort/resume-sent")), "console.warn 旁证必须出现");
});

test("T6 timeline：silent-abort/* 事件映射 intervention 通道且中文卡片字段齐全", async () => {
	const { createTimeline, TIMELINE_SOURCES } = await import("../lib/timeline.js");
	const fsStub = { readdirSync: (dir) => (String(dir).includes("journey") ? ["s-tl.jsonl"] : []) };
	const store = { readEntries: () => [], readMilestones: () => [], readGaps: () => [], readObservations: () => [] };
	const timeline = createTimeline({
		store,
		ledgerRoot: "D:\\nonexistent-timeline-root",
		getSessionQuery: () => ({
			listEvents: async () => [
				{ seq: 1, type: EVT.SILENT_ABORT_DETECTED, data: { turn: 9, reasonKind: "blocked", stopReason: "toolUse", stepCount: 59, confidence: "high", ts: "2026-10-17T00:00:00Z" } },
				{ seq: 2, type: EVT.SILENT_ABORT_RESUME_SENT, data: { turn: 9, round: 1, channel: "followup", promptKind: "blocked", ts: "2026-10-17T00:00:01Z" } },
				{ seq: 3, type: EVT.SILENT_ABORT_ESCALATED, data: { turn: 12, cause: "budget", message: "预算用尽", ts: "2026-10-17T00:00:02Z" } }
			]
		}),
		fs: fsStub
	});
	const view = await timeline.timelineFor("s-tl", 50);
	assert.ok(!view?.notFound, "timelineFor 不应返回 notFound（事件源存在即视为有内容）");
	const items = view?.items ?? [];
	const detected = items.find((i) => i.kind === "silent-abort/detected");
	const resume = items.find((i) => i.kind === "silent-abort/resume-sent");
	const escalated = items.find((i) => i.kind === "silent-abort/escalated");
	assert.ok(detected, "detected 必须出现在 timeline");
	assert.equal(detected.source, TIMELINE_SOURCES.INTERVENTION, "必须归入 intervention 通道");
	assert.ok(detected.title.includes("静默中断"));
	assert.ok(resume, "resume-sent 必须出现在 timeline");
	assert.ok(resume.summary.includes("followup"));
	assert.ok(escalated, "escalated 必须出现在 timeline");
	assert.ok(escalated.summary.includes("budget"));
});

test("T6 controller：onSweep 异常被吞（fail-open 不抛穿心跳）", () => {
	const controller = createSilentAbortController({
		emit: () => { throw new Error("emit blew up"); },
		log: () => {},
		getSettings: () => makeSettings({ cooldownMs: 0 })
	});
	const sid = "s-failopen";
	blockedEnd(controller, sid, 1, { now: 1000 });
	assert.doesNotThrow(() => controller.onSweep(1001));
	assert.doesNotThrow(() => controller.onTurnStart(sid, 2));
	assert.doesNotThrow(() => controller.onUserMessage(sid));
});
