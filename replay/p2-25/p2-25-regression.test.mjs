/**
 * P2-25 事务四线失效端到端回归测试 —— 统一事件夹具 + 6 条断言（绿阶段，11 个 test）。
 *
 * 归属：dsh-derive-watcher/replay/p2-25/（跨插件集落点，replay 框架承载事故回放）。
 * 全绿入口：npm run test:p225（= node --test replay/p2-25/p2-25-regression.test.mjs）。
 * 默认闸门 npm test（test/*.test.js）为纯 watcher 单测，本回放不并入。
 *
 * 红线：断言改造只动本目录测试与夹具；① 只读 import 安装副本内核并做行为级回放，
 * 不改内核一字；⑥ 经真实 watcher apply 喂事件，唯一产品前提是 FIX-01（lib/index.js
 * user/message 双形状分支）。时钟一律注入（stall 的 now 注入），无真实 sleep；
 * 异步排空只用 summarizer.flush() 与 setImmediate 轮询，不使用任何定时器。
 *
 * 六断言与 P0 对应：
 *   ① P0-1：真实内核 turn() 回放，abort-turn 后只走一个 draining step 即终止，
 *      工具结果 additionalContexts 不再驱动额外 step。
 *   ② P0-2/P0-8：真实键名 stallWatchSteps/stallWatchWindowSec（3/300）；reasoning-only
 *      step 计入观察账本；注入时钟推进 300s 触发 wall-clock stall-1；结论通道单列
 *      （reasoning-only 不入结论队列，此为期望行为，断言通过）。
 *   ③ P0-5：事故 6 笔拦截实参全判放行（6 个 test）。
 *   ④ P0-5：两次插件自 deny 不产生 G2-B。
 *   ⑤ P0-3：顶层 {"entries":[]} 合法空 → gaps=0、无 gap 事件、水位推进；嵌套/畸形负对照才记 gap。
 *   ⑥ FIX-01/P0：真实 apply 下 {source:{plugin:"x"}} 直挂 user/message 不清零 stall；
 *      负对照 {source:{surface:"gui"}} 必须清零。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	buildToolResult, buildToolCall, buildAssistantMessage, buildUserMessage,
	GOVERNOR_PLUGIN_ID
} from "./fixtures/event-shapes.mjs";
import { INCIDENT_INTERCEPTIONS } from "./fixtures/incident-args.mjs";

// ── 三插件 lib 入口（跨仓库相对引用；node 从本文件所在目录解析）──
const HERE = dirname(fileURLToPath(import.meta.url));
const __u = (p) => pathToFileURL(p).href;
const { apply: applyWatcher } = await import(__u(join(HERE, "../../lib/index.js")));
const { createStallController } = await import(__u(join(HERE, "../../lib/stall.js")));
const { createJourneyStore } = await import(__u(join(HERE, "../../lib/journey-store.js")));
const { createSummarizer } = await import(__u(join(HERE, "../../lib/summarizer.js")));
const { DEFAULT_SETTINGS, SETTINGS_SCHEMA } = await import(__u(join(HERE, "../../lib/settings.js")));
const { EVT } = await import(__u(join(HERE, "../../lib/events.js")));
const governorLib = await import(__u(join(HERE, "../../../dsh-step-governor/lib/index.js")));

// ── 安装副本内核（只读；断言①从中提取真实 turn() 做行为回放，禁止修改）──
const KERNEL = join(
	HERE, "..", "..", "..", "node_modules", ".pnpm",
	"@deepseek-ai+dsh-agent-loop_7e5ca28af2e60efa3c326774d17a5fab",
	"node_modules", "@deepseek-ai", "dsh-agent-loop", "lib", "index.js"
);

// ── 断言② wall-clock stall-1 契约：K=3、T=300s（settings.js:41-42 现值）──
const STALL1_K_COUNT = 3;
const STALL1_T_SEC = 300;

const noopLog = () => {};
const stallEvents = (events) => events.filter((e) => typeof e.n === "string" && e.n.toLowerCase().includes("stall"));

/** 有界 setImmediate 轮询等待谓词成立（非定时器、非真实 sleep；模拟 LLM 即时返回，微任务级排空）。 */
async function waitUntil(predicate, tries = 500) {
	for (let i = 0; i < tries; i += 1) {
		if (predicate()) return true;
		await new Promise((resolve) => setImmediate(resolve));
	}
	return predicate();
}

function mkTmpRoot(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

// ════════════════════════════════════════════════════════════════════
// 断言① abort-turn 在工具结果挂 additionalContexts 时仍终止 turn（P0-1，行为级回放）
// ════════════════════════════════════════════════════════════════════

// 事故真实负载（字符数取自原文标注 537/887；内容头取原文首句），复刻
// 宿主仓 tests/agent-loop-p5-replay-step36.mjs（该脚本 16 passed）。
const SEQ357 = {
	role: "user", type: "injection", plugin: "step-governor-ecosystem",
	tag: "command-exec-discipline", seq: 357, chars: 537,
	content: "⓪ 命令执行纪律（最高优先，高于一切）：跑任何命令都不许盲等，且必须核验结果……"
};
const SEQ358 = {
	role: "user", type: "injection", plugin: "cot-anchor",
	tag: "cot-anchor-conclusions", seq: 358, chars: 887,
	content: "COT anchor — conclusions established before the last tool call. Do not re-derive……"
};
// step37 之后每步 post-execute 继续挂的纪律注入（旧门因此无限续命，P5 draining 必须丢弃它）。
const PER_STEP_INJECTION = {
	role: "user", type: "injection", plugin: "step-governor-ecosystem",
	tag: "command-exec-discipline", content: "每步重复的命令执行纪律注入"
};

/** 从安装副本内核提取真实 turn() 函数体（AsyncFunction 构造，只读复刻，不改内核一字）。 */
function extractRealTurn() {
	const src = readFileSync(KERNEL, "utf8");
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
	const helperMatch = src.match(/function p5DescribeAbortContexts\(contexts\) \{[\s\S]*?\n\}/);
	assert.ok(helperMatch, "安装副本内核必须含 p5DescribeAbortContexts（P5 归因描述符）");
	const helper = eval("(" + helperMatch[0] + ")");
	// 与 step36 回放脚本同构的提取边界：async turn() { … } 到 async step(decision) 之前。
	const start = src.indexOf("async turn() {");
	assert.notEqual(start, -1, "安装副本内核必须含 async turn()");
	const braceOpen = src.indexOf("{", start);
	const tail = src.indexOf("async step(decision)", braceOpen);
	const closeMarker = src.lastIndexOf("\n\t}\n\t", tail);
	const body = src.slice(braceOpen + 1, closeMarker + "\n\t".length);
	const turnFn = new AsyncFunction(
		"ToolCallRecovery", "abortedCancelCause", "LlmError", "errorChain",
		"DSH_ABORT_TURN_HARD_BREAK", "p5DescribeAbortContexts", body
	);
	return { turnFn, helper };
}

class ToolCallRecoveryStub { observe() {} results() { return []; } }

/** 事故桩驱动：与 agent-loop-p5-replay-step36.mjs makeDriver 同构。 */
function makeDriver() {
	const inbox = {
		nextStep: [], nextTurn: [],
		get hasPending() { return this.nextTurn.length > 0 || this.nextStep.length > 0; },
		splice(t, s, d, ins) { (t === "next-turn" ? this.nextTurn : this.nextStep).splice(s, d, ...(ins ?? [])); }
	};
	const events = [];
	let seq = 0;
	const stepsRun = [];
	const phase = {
		kind: "running", abort: new AbortController(), turn: 0, step: 35,
		abortTurn: undefined,
		softCutBudget: { heuristic: 6, confirmedRepeat: 0, pseudoTool: 0, total: 6 },
		p5AbortDraining: false, p5AbortSticky: null
	};
	let stopping = 0;
	const accept = (c) => inbox.splice("next-step", inbox.nextStep.length, 0, [c]);
	const agent = {
		id: "replay", phase, inbox,
		throwError: (e) => { throw e; },
		ctx: { on() { return () => {}; } },
		session: { append(t, d, x) { events.push({ type: t, data: d ?? {}, extra: x ?? {} }); return { seq: ++seq }; } },
		dispatch: {
			async waterfall(hook, _p, fb) { return fb(); },
			async serial(h) { if (h === "agent/turn-stopping") stopping += 1; },
			emit(t, d) { events.push({ type: t, data: d ?? {}, emitted: true }); }
		},
		async preStep() { inbox.nextStep.splice(0); return { kind: "continue", messages: [{}] }; },
		async step() {
			const n = phase.step;
			stepsRun.push(n);
			if (n === 36) {
				// 事故 seq346：heuristic 预算耗尽升级 abort-turn；工具结果挂 seq357/358
				// （内核 executeToolCalls 对 result.additionalContexts 逐条 acceptContext，lib/index.js:679）。
				phase.abortTurn = { reason: "soft-cut-budget-exhausted", detail: { cutClass: "heuristic" } };
				accept(SEQ357); accept(SEQ358);
			} else if (n >= 37 && n < 39) {
				// draining step 内新挂的注入：P5 必须在收尾时丢弃，不得再驱动 step38。
				accept(PER_STEP_INJECTION);
			}
			return null;
		}
	};
	return {
		agent, phase, inbox, events, stepsRun,
		stopping: () => stopping,
		lastOf(t) { const a = events.filter((e) => e.type === t); return a.length ? a[a.length - 1].data : null; },
		endReason() { const e = [...events].reverse().find((x) => x.type === "turn/end"); return e ? e.data.reason : null; }
	};
}

test("assertion-① abort-turn 不被工具结果 additionalContexts 架空（真实内核行为回放）", async () => {
	// 行为契约（P0-1）：step36 工具结果挂 seq357/358 → abort-turn 授予恰好一个 draining step；
	// draining 后内核顶部无条件收尾（安装副本 lib/index.js:1126-1129 粘性 break），
	// step37 新挂的 PER_STEP_INJECTION 作为 droppedContexts 丢弃，不再驱动 step38/39。
	const { turnFn, helper } = extractRealTurn();
	const d = makeDriver();
	await turnFn.call(
		d.agent, ToolCallRecoveryStub, () => undefined, class LlmError {},
		(e) => String(e), false, helper
	);

	assert.deepEqual(d.stepsRun, [36, 37], "step 止于 draining 一步（36→37），不得增长到 38/39");
	assert.equal(d.endReason().kind, "abort-turn", "turn/end reason.kind=abort-turn（内核自终止）");
	assert.equal(d.endReason().reason, "soft-cut-budget-exhausted", "turn/end reason=soft-cut-budget-exhausted");

	const drain = d.lastOf("agent/abort-turn-draining");
	assert.ok(drain, "必须发出 agent/abort-turn-draining（授予 draining step）");
	assert.equal(drain.pendingContexts, 2, "授予时 pendingContexts=2（seq357+seq358）");
	assert.deepEqual(
		drain.contexts.map((c) => c.tag),
		["command-exec-discipline", "cot-anchor-conclusions"],
		"draining 归因 tag 正确（seq357/358）"
	);

	const fin = d.lastOf("agent/abort-turn-final");
	assert.ok(fin, "必须发出 agent/abort-turn-final");
	assert.equal(fin.via, "draining", "final via=draining（非 hard-break）");
	assert.equal(fin.droppedContexts, 1, "step37 新挂的 additionalContext 被丢弃（droppedContexts=1），不驱动额外 step");
	assert.equal(d.stopping(), 1, "turn-stopping 恰好发出 1 次");
});

// ════════════════════════════════════════════════════════════════════
// 断言② reasoning-only step 计入观察账本 + wall-clock stall-1（P0-2/P0-8，行为级）
// ════════════════════════════════════════════════════════════════════
test("assertion-② reasoning-only 计入观察账本 + 注入时钟推进 300s 触发 wall-clock stall-1；结论通道单列通过", async () => {
	const root = mkTmpRoot("dsw-p225-two-");
	try {
		const events = [];
		const store = createJourneyStore({ root, emit: (n, p) => events.push({ n, p }), log: noopLog });

		// ── 子断言 A：真实键名（lib/settings.js:41-42；schema 同名两行）──
		assert.equal(DEFAULT_SETTINGS.stallWatchSteps, STALL1_K_COUNT, "stallWatchSteps 默认 3（真实键名）");
		assert.equal(DEFAULT_SETTINGS.stallWatchWindowSec, STALL1_T_SEC, "stallWatchWindowSec 默认 300 秒（真实键名）");
		const schemaKeys = SETTINGS_SCHEMA.map((row) => row.key);
		assert.ok(schemaKeys.includes("stallWatchSteps") && schemaKeys.includes("stallWatchWindowSec"),
			"schema 必须含 stallWatchSteps/stallWatchWindowSec 两行");

		// ── 子断言 B：reasoning-only step（无 text、reasoningLen>0）计入观察账本并推进观察水位 ──
		// 与 lib/index.js:474-478 live 路径同构：appendObservation + saveObservationWatermark。
		store.appendObservation("s2", { turn: 1, step: 1, hasText: false, textLen: 0, reasoningLen: 128, hasArtifact: false });
		store.saveObservationWatermark("s2", { lastStepSeq: 1 });
		const observations = store.readObservations("s2");
		assert.equal(observations.length, 1, "reasoning-only step 必须写入观察账本");
		assert.equal(observations[0].reasoningLen, 128, "观察记录保留 reasoningLen");
		assert.equal(observations[0].hasText, false, "观察记录标注 hasText=false");
		assert.equal(store.loadObservationWatermark("s2").lastStepSeq, 1, "观察水位推进到 step1");

		// ── 子断言 C：注入时钟推进 300 秒，3 个 barren step 触发 wall-clock stall-1 ──
		// now 注入（stall.js:25）；obs.ts 显式递增，全程无真实 sleep/定时器。
		let clockMs = 1_000_000;
		const watchEvents = [];
		const controller = createStallController({
			emit: (n, p) => watchEvents.push({ n, p }),
			log: noopLog,
			getSettings: () => DEFAULT_SETTINGS,
			getL2: null,
			writeHandoff: null,
			now: () => clockMs
		});
		const barrenObs = (step) => ({ turn: 1, step, ts: clockMs, hasText: false, textLen: 0, reasoningLen: 0, hasArtifact: false });
		let r1 = controller.onObservation("s2", barrenObs(2)); // 第 1 个 barren，开窗
		assert.equal(r1.fired, false, "第 1 个 barren step 不触发");
		clockMs += 150_000;
		const r2 = controller.onObservation("s2", barrenObs(3)); // 跨度 150s < 300s
		assert.equal(r2.fired, false, "K 未足或跨度不足时不触发");
		clockMs += 150_000;
		const r3 = controller.onObservation("s2", barrenObs(4)); // 跨度 300s、count=3
		assert.equal(r3.fired, true, "第 3 个 barren 且跨度满 300s 必须触发 wall-clock stall-1");
		const watchStalls = stallEvents(watchEvents);
		assert.equal(watchStalls.length, 1, "恰好发出一次 stall 事件（watch 单次 run 幂等）");
		assert.equal(watchStalls[0].p.level, 1, "wall-clock 观察通道发出 level=1");
		assert.equal(watchStalls[0].p.stallCount, STALL1_K_COUNT, "载荷 stallCount=3");
		assert.ok(watchStalls[0].p.spanMs >= STALL1_T_SEC * 1000, "载荷 spanMs≥300000");
		// 注：任务书称载荷含 barrenRun；实现（lib/stall.js:111-115）载荷字段为 stallCount，
		// barrenRun 仅出现在 :115 的日志文案中，故行为断言以 stallCount/spanMs 为准。

		// ── 子断言 D（结论通道单列，期望通过）：reasoning-only/空文本不入正式结论队列 ──
		// lib/index.js:483 `if (!hasText) return;` + summarizer.enqueue 空文本拒收，
		// 是期望的通道分离行为：reasoning 只进观察账本，不污染结论 entry。
		const summarizer = createSummarizer({
			store, emit: (n, p) => events.push({ n, p }), log: noopLog,
			getSettings: () => DEFAULT_SETTINGS,
			callLlm: async () => JSON.stringify({ entries: [] }),
			onSummarized: () => {}, onGap: () => {}
		});
		const enq = summarizer.enqueue("s2", { messageId: "m-reasoning", turn: 1, step: 1, text: "   " });
		assert.equal(enq.queued, false, "纯 reasoning/空文本不入结论队列（结论通道单列，通过）");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ════════════════════════════════════════════════════════════════════
// 断言③ 正常 read/grep/pwsh 切片浏览零误杀（事故 6 笔拦截实参全判放行，P0-5）
// ════════════════════════════════════════════════════════════════════
for (const inc of INCIDENT_INTERCEPTIONS) {
	test(`assertion-③ 事故拦截实参 ${inc.id}（${inc.name}→${inc.blockedCode}）判放行`, () => {
		const state = governorLib.createSessionState();
		const callId = `inc_${inc.id}`;
		governorLib.noteEvent(state, buildToolCall({ turn: inc.turn, step: inc.step, callId, name: inc.name, arguments: inc.args }));
		governorLib.noteEvent(state, buildToolResult({ turn: inc.turn, step: inc.step, callId, name: inc.name, arguments: inc.args, content: `ok:${inc.id}` }));
		const g2 = governorLib.evaluateG2(state, governorLib.targetKey(inc.name, inc.args));
		assert.ok(g2 == null || g2.kind !== "block", `${inc.id} 应判放行（G2 判定=${JSON.stringify(g2)}）, 误拦截码=${inc.blockedCode}`);
	});
}

// ════════════════════════════════════════════════════════════════════
// 断言④ 两次插件自 deny 不产生 G2-B 拦截（P0-5）
// ════════════════════════════════════════════════════════════════════
test("assertion-④ 两次插件自 deny 不产生 G2-B 拦截", () => {
	const state = governorLib.createSessionState();
	for (let i = 1; i <= 2; i += 1) {
		const callId = `rd_${i}`;
		governorLib.noteEvent(state, buildToolCall({ turn: 1, step: i, callId, name: "read", arguments: { file_path: "/t/a.js" } }));
		governorLib.noteEvent(state, buildToolResult({
			turn: 1, step: i, callId, name: "read",
			arguments: { file_path: "/t/a.js" },
			isError: true,
			error: { message: "denied", info: { plugin: GOVERNOR_PLUGIN_ID, rule: "self-deny", code: "deny" } }
		}));
	}
	const key = governorLib.targetKey("read", { file_path: "/t/a.js" });
	const g2 = governorLib.evaluateG2(state, key);
	assert.ok(g2 == null || g2.kind !== "block", `自 deny 不应累积成 G2-B（G2 判定=${JSON.stringify(g2)}）`);
});

// ════════════════════════════════════════════════════════════════════
// 断言⑤ 合法顶层 {"entries":[]} 不 gap、水位推进；嵌套/畸形负对照才记 gap（P0-3）
// ════════════════════════════════════════════════════════════════════
test("assertion-⑤ 合法空 entries 不 gap 且推进水位；嵌套畸形才记 gap", async () => {
	// ── 正例：顶层 {"entries":[]}（summarizer.draftParse 只认顶层 parsed.entries，lib/summarizer.js:90-96）──
	const rootOk = mkTmpRoot("dsw-p225-five-ok-");
	try {
		const events = [];
		const gaps = [];
		const store = createJourneyStore({ root: rootOk, emit: (n, p) => events.push({ n, p }), log: noopLog });
		const summarizer = createSummarizer({
			store,
			emit: (n, p) => events.push({ n, p }),
			log: noopLog,
			getSettings: () => DEFAULT_SETTINGS,
			callLlm: async () => JSON.stringify({ entries: [] }), // 合法顶层空 entries
			onSummarized: () => {},
			onGap: (sid, meta) => gaps.push({ sid, ...meta })
		});
		summarizer.enqueue("s5", { sourceKind: "text", messageId: "m1", turn: 1, step: 2, text: "有助手内容但无新结论的一步" });
		await summarizer.flush(); // setImmediate 排空，不使用定时器

		assert.equal(gaps.length, 0, "合法空 entries 不得记 onGap");
		assert.equal(store.readAllLines("s5").filter((l) => l.type === "gap").length, 0, "账本无 gap 行");
		assert.ok(!events.some((e) => e.n === EVT.SUMMARIZER_DEGRADED), "事件流不得含 summarizer-degraded");
		assert.equal(store.loadWatermark("s5").lastStepSeq, 2, "合法空 entries 必须推进结论水位到 step2");
		assert.equal(summarizer.stats().degraded, 0, "degraded 计数为 0");
	} finally {
		rmSync(rootOk, { recursive: true, force: true });
	}

	// ── 负对照：嵌套/畸形 {"draft":{"entries":[]}} → 草稿解析失败、重试 1 次仍畸形 → 恰好 1 条 gap ──
	const rootBad = mkTmpRoot("dsw-p225-five-bad-");
	try {
		const badEvents = [];
		const badGaps = [];
		const badStore = createJourneyStore({ root: rootBad, emit: (n, p) => badEvents.push({ n, p }), log: noopLog });
		const badSummarizer = createSummarizer({
			store: badStore,
			emit: (n, p) => badEvents.push({ n, p }),
			log: noopLog,
			getSettings: () => DEFAULT_SETTINGS,
			callLlm: async () => JSON.stringify({ draft: { entries: [] } }), // 嵌套：顶层无 entries 数组 → 畸形
			onSummarized: () => {},
			onGap: (sid, meta) => badGaps.push({ sid, ...meta })
		});
		badSummarizer.enqueue("s5", { sourceKind: "text", messageId: "m2", turn: 1, step: 1, text: "另一条助手内容" });
		await badSummarizer.flush();

		assert.equal(badGaps.length, 1, "畸形草稿（重试 1 次后仍无效）必须恰好记 1 次 gap");
		assert.equal(badStore.readAllLines("s5").filter((l) => l.type === "gap").length, 1, "账本恰好 1 条 gap 行");
		assert.ok(badEvents.some((e) => e.n === EVT.SUMMARIZER_DEGRADED), "畸形必须发 summarizer-degraded 事件");
		assert.equal(badSummarizer.stats().retried, 1, "畸形草稿重试恰好 1 次");
	} finally {
		rmSync(rootBad, { recursive: true, force: true });
	}
});

// ════════════════════════════════════════════════════════════════════
// 断言⑥ source.plugin 直挂 user/message 不清零 stall；gui 真人形状负对照清零（FIX-01，行为级）
// ════════════════════════════════════════════════════════════════════

// 四条彼此词法不相似的中文结论（MinHash Jaccard 远低于 0.8 词法阈），
// selfcheck 恒判与首条 j_0001 语义重复 → 第 2/3/4 条依次计 semantic stall 1/2/3。
const DRAFT_SUMMARIES = [
	"内核退出闸门必须对 abort-turn 无条件终止本轮循环",
	"观察账本需要独立记录纯推理步骤的推理字符长度",
	"总结器遇到合法空数组时应推进水位而不是记录缺口",
	"插件来源的用户消息不得清零停滞计数器与级动作状态",
	"命令执行后必须核验退出码与真实产物而非只看无报错",
	"长任务等待必须按固定短间隔轮询并观测增长型标量",
	"外部记忆源以纯链接模式接入不转抄对方文件内容"
];

/** mock 宿主 llm：llm.stream 异步迭代产出 text-delta 块（形状见 test/summarizer.test.js:291-301）。 */
function makeReplayLlm() {
	const llm = {
		draftCount: 0,
		supportsJsonMode: () => false,
		stream(opts) {
			const purpose = opts?.purpose ?? "";
			return (async function* generate() {
				let text;
				if (purpose.startsWith("semantic-watcher/draft")) {
					const i = llm.draftCount;
					llm.draftCount += 1;
					const summary = DRAFT_SUMMARIES[Math.min(i, DRAFT_SUMMARIES.length - 1)];
					text = JSON.stringify({ entries: [{ kind: "finding", summary, detail: "", artifacts: [], confidence: 0.8 }] });
				} else {
					// selfcheck/selfcheck-retry 及其它 purpose：恒判与首条语义重复
					text = JSON.stringify({ novelty: "duplicate", duplicate_of: "j_0001" });
				}
				yield { type: "text-delta", index: 0, text };
			})();
		}
	};
	return llm;
}

/**
 * 建联真实 watcher apply（独立临时 USERPROFILE 隔离 settingsDir/账本，不碰真实 storages）。
 * 返回 fire(event) 直挂 session/event 处理器；stall 事件经 mock session.append 收集。
 */
async function setupWatcherInstance(sessionId) {
	const profile = mkTmpRoot("dsw-p225-six-");
	const prevUserProfile = process.env.USERPROFILE;
	process.env.USERPROFILE = profile; // os.homedir() 在 Windows 读 USERPROFILE；apply 内即时取 homedir()
	const appends = [];
	const llm = makeReplayLlm();
	const handlers = new Map();
	const session = {
		id: sessionId,
		append(name, payload) { appends.push({ name, p: payload }); return { seq: appends.length }; }
	};
	const ctx = {
		on: (name, handler) => { handlers.set(name, handler); return () => {}; },
		get: (key) => (key === "llm" ? llm : null) // sessionQuery 缺失 → 补扫 fail-open 直接返回
	};
	let dispose;
	try {
		dispose = applyWatcher(ctx);
	} finally {
		process.env.USERPROFILE = prevUserProfile;
	}
	const fire = (event) => handlers.get("session/event")(session, event);
	const stalls = () => appends.filter((a) => a.name === EVT.STALL).map((a) => a.p);
	return {
		llm, fire, stalls,
		async cleanup() {
			try { dispose?.(); } catch { /* 定时器已 unref */ }
			rmSync(profile, { recursive: true, force: true });
		}
	};
}

/** 发 4 条 model assistant/message（1 条 new + 3 条语义重复）→ stall level:1。 */
async function driveToStall1(harness) {
	for (let step = 1; step <= 4; step += 1) {
		harness.fire(buildAssistantMessage({
			turn: 1, step,
			text: `助手正文第 ${step} 段：${DRAFT_SUMMARIES[step - 1]}`
		}));
		assert.ok(await waitUntil(() => harness.llm.draftCount >= step), `step${step} 草稿应被处理`);
	}
	assert.ok(await waitUntil(() => harness.stalls().some((p) => p.level === 1)), "4 条消息（new+3 语义重复）后必须出现 stall level:1");
}

test("assertion-⑥ plugin 直挂形状不清零 stall（升级 level:2）；gui 形状负对照清零（重发 level:1）", async () => {
	// 内核 user/message 事件 data 即 message 本体（安装副本 lib/index.js:1351，
	// session.append("user/message", message)），source 在 data.source，无 message 包裹。
	// FIX-01 后 watcher 分支（lib/index.js:487-492）读 data?.source ?? data?.message?.source。

	// ── 形状一：{source:{plugin:"x"}} 直挂 → 必须早返回、不清零 ──
	const pluginHarness = await setupWatcherInstance("s6-plugin");
	try {
		await driveToStall1(pluginHarness);
		pluginHarness.fire(buildUserMessage({ source: { plugin: "x" }, text: "插件系统注入的续跑消息" }));
		// 未清零：再 3 条语义重复，计数 4/5/6 续计 → 第 6 条升级 level:2。
		for (let step = 5; step <= 7; step += 1) {
			pluginHarness.fire(buildAssistantMessage({
				turn: 1, step,
				text: `助手正文第 ${step} 段：${DRAFT_SUMMARIES[step - 1]}`
			}));
			assert.ok(await waitUntil(() => pluginHarness.llm.draftCount >= step), `plugin 形状 step${step} 草稿应被处理`);
		}
		assert.ok(await waitUntil(() => pluginHarness.stalls().some((p) => p.level === 2)),
			"plugin user/message 不清零：续计到 6 必须升级 stall level:2");
		assert.deepEqual(pluginHarness.stalls().map((p) => p.level), [1, 2],
			"plugin 形状 stall 序列必须为 [1,2]（中间无清零重置）");
	} finally {
		await pluginHarness.cleanup();
	}

	// ── 形状二（负对照）：{source:{surface:"gui"}} 无 plugin → 真人消息，必须清零一次 ──
	const guiHarness = await setupWatcherInstance("s6-gui");
	try {
		await driveToStall1(guiHarness);
		guiHarness.fire(buildUserMessage({ source: { surface: "gui" }, text: "真人介入：换个方向" }));
		// 已清零：再 3 条语义重复从 0 计到 3 → 重新发 level:1（而非 level:2）。
		for (let step = 5; step <= 7; step += 1) {
			guiHarness.fire(buildAssistantMessage({
				turn: 1, step,
				text: `助手正文第 ${step} 段：${DRAFT_SUMMARIES[step - 1]}`
			}));
			assert.ok(await waitUntil(() => guiHarness.llm.draftCount >= step), `gui 形状 step${step} 草稿应被处理`);
		}
		assert.ok(await waitUntil(() => guiHarness.stalls().filter((p) => p.level === 1).length >= 2),
			"gui user/message 清零后：再 3 条重复必须重新发 level:1");
		const guiStalls = guiHarness.stalls();
		assert.ok(!guiStalls.some((p) => p.level === 2), "gui 形状清零后不得出现 level:2");
		assert.deepEqual(guiStalls.map((p) => p.level), [1, 1], "gui 形状 stall 序列必须为 [1,1]（清零后重新计满）");
		assert.equal(guiStalls[guiStalls.length - 1].stallCount, 3, "第二次 level:1 的 stallCount 重新计为 3");
	} finally {
		await guiHarness.cleanup();
	}
});
