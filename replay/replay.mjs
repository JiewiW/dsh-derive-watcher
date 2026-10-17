#!/usr/bin/env node
/**
 * dsh-derive-watcher — 离线回放脚手架。
 *
 * 输入：dsh-session-log-extract 技能 dump 产出的明文 JSONL（replay/transcripts/<sessionId>.jsonl）。
 * 行为：把 assistant/message 事件按序喂给本插件的 lib 模块（journey-store → summarizer → stall），
 *       在隔离账本根里观察 JSONL 行数增长、novelty 判定、词法/语义重复与 stall 状态机。
 *
 * 用法：
 *   node replay/replay.mjs [--session <id>]... [--mock-llm] [--live] [--root <账本根>] [--check]
 *
 * 默认 --mock-llm（离线确定性，绝不调真实 LLM）；--live 需显式指定且仅限影子期核验，
 * 禁止在真实 goal 会话触发 stall-3（enableStall3Reject 首发恒 false）。
 * 默认账本根 = replay/replay-ledger/（绝不写真实 ~/.dsh/storages/semantic-watcher/）。
 * --check 校验 expected-ranges.json 中验收方预登记的预期步区间（未登记则跳过）。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJourneyStore } from "../lib/journey-store.js";
import { createSummarizer } from "../lib/summarizer.js";
import { createStallController } from "../lib/stall.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const hasFlag = (n) => args.includes(n);
const opt = (n) => {
	const i = args.indexOf(n);
	return i >= 0 ? args[i + 1] : undefined;
};

const ledgerRoot = resolve(opt("--root") ?? join(HERE, "replay-ledger"));
const mockLlm = !hasFlag("--live");
const doCheck = hasFlag("--check");
mkdirSync(ledgerRoot, { recursive: true });

// enableStall2Deny=true（覆盖首发默认 false）：回放需演练 stall-2 的 L2 fail-open 通路
// （getL2 恒 null → execution-unavailable）；enableStall3Reject 保持默认 false：
// stall-3 只告警+写种子，绝不触碰 L2（禁真实 goal 会话触发 stall-3）。
const settings = { ...DEFAULT_SETTINGS, enableJourney: true, enableInjection: false, enableStall2Deny: true };

function blocksToText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

// P0-2：reasoning 独立观察通道（只吃 reasoning 块文本）
function blocksToReasoning(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "reasoning" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

// P0-8：产物判据（tool-call / image / file 块视为产出）
function contentHasArtifact(content) {
	if (!Array.isArray(content)) return false;
	return content.some((b) => b && (b.type === "tool-call" || b.type === "image" || b.type === "file"));
}

/** 期望步区间（验收方预登记于 expected-ranges.json；本脚手架只读取校验，不填写不修改）。 */
function loadExpectedRanges() {
	const p = join(HERE, "expected-ranges.json");
	if (!existsSync(p)) return { sessions: {} };
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch (error) {
		console.warn(`[replay] expected-ranges.json 解析失败（按未登记处理）: ${error?.message ?? error}`);
		return { sessions: {} };
	}
}

// 验收方预登记处置：session-4f4ead96 原轨迹已被清理，
// 以合成流替代回放。§5.5 定谳：纯词法 duplicate 只记账+lexical-repeat，不触发 stall 升级；
// 只有 semantic_duplicate=true 才计入升级 ⇒ 合成流分两阶段：
//   阶段 A：10 条同文循环 → j_0001 new + 9 条纯词法 duplicate（LEXICAL_REPEAT ×9，零升级）；
//   归零步：真人 user 消息（stall 状态与级动作状态清零）+ 3 条真新结论（new 保持归零）；
//   阶段 B：10 条词法互异但语义同结论的变体（mock selfcheck 判 duplicate）→ 恰好 S0+3/6/10
//           触发 stall-1/2/3（±2 容差内精确命中）；stall-3 只写种子（enableStall3Reject=false）。
const SYNTHETIC_SESSIONS = new Set(["session-4f4ead96"]);
const SYNTH_VARIANTS = [
	"【合成样例】变体一：多次尝试仍无突破，任务停留在等待外部输入的状态。",
	"【合成样例】变体二：这轮改动没有产生任何效果，情形与之前完全一致。",
	"【合成样例】变体三：尝试了新的路径，但结果不变，依旧原地踏步。",
	"【合成样例】变体四：重试之后输出仍然相同，没有获得新的进展。",
	"【合成样例】变体五：反复执行同一操作，问题状态未发生任何改变。",
	"【合成样例】变体六：当前局面与前几步毫无差异，继续空转等待中。",
	"【合成样例】变体七：虽然换了措辞，但实质结论仍是没有任何进展。",
	"【合成样例】变体八：又一次尝试以失败告终，系统状态维持原样。",
	"【合成样例】变体九：操作持续进行，但各项指标始终没有变化。",
	"【合成样例】变体十：所有努力都未奏效，任务依然卡在原地。"
];
function syntheticLoopTranscript() {
	const LOOP_TEXT = "【合成样例】当前步骤未取得新进展，输出与上一步相同：等待外部输入中。";
	const NEW_TEXTS = [
		"【合成样例】收到真人指示：先复核文件读取路径，再决定下一步动作。",
		"【合成样例】已完成路径复核，确认配置文件位于项目根目录。",
		"【合成样例】路径确认无误，准备继续执行本轮任务。"
	];
	const events = [{ type: "session", sessionId: "session-4f4ead96", synthetic: true, note: "验收方预登记处置：原轨迹缺失，以合成流替代" }];
	let step = 0;
	const turn = 1;
	const pushAssistant = (text) => {
		step += 1;
		events.push({ type: "assistant/message", data: { turn, step, message: { id: `syn-${step}`, content: [{ type: "text", text }] } } });
	};
	for (let i = 0; i < 10; i++) pushAssistant(LOOP_TEXT); // 阶段 A：纯词法重复，验证不升级口径
	events.push({ type: "user/message", data: { turn: 2, step: step + 1, message: { content: [{ type: "text", text: "真人插话：请换个办法继续。" }] } } }); // 归零验证步
	for (const t of NEW_TEXTS) pushAssistant(t); // new → 计数归零保持
	for (const t of SYNTH_VARIANTS) pushAssistant(t); // 阶段 B：语义重复 → stall-1@+3 / stall-2@+6 / stall-3@+10
	return events;
}

async function replayOne(sessionId) {
	// 合成样例会话（验收方预登记处置：原轨迹缺失）：按预登记文件处置声明生成
	const isSynthetic = SYNTHETIC_SESSIONS.has(sessionId);
	const rawLines = isSynthetic
		? syntheticLoopTranscript().map((e) => JSON.stringify(e))
		: (existsSync(join(HERE, "transcripts", `${sessionId}.jsonl`))
			? readFileSync(join(HERE, "transcripts", `${sessionId}.jsonl`), "utf8").split("\n")
			: null);
	if (!rawLines) {
		return { sessionId, skipped: true, reason: `缺少 dump 产物 ${join(HERE, "transcripts", sessionId + ".jsonl")}（先运行 replay/dump-sessions.mjs）` };
	}
	const lines = rawLines.filter((l) => l.trim().length > 0);
	const synthetic = isSynthetic;
	const transcriptDir = join(ledgerRoot, "journey");

	const events = []; // 旁路事件留痕
	const emit = (name, payload) => { events.push({ name, payload }); };
	const log = (line) => console.log(`[replay:${sessionId.slice(0, 18)}] ${line}`);

	const store = createJourneyStore({ root: ledgerRoot, escapeTags: true, emit, log });
	const stall = createStallController({
		emit,
		log,
		getSettings: () => settings,
		getL2: () => null, // 回放离线：L2 恒不可用 → fail-open（execution-unavailable）
		writeHandoff: (sid, meta) => {
			const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
			const dir = join(ledgerRoot, "handoff");
			mkdirSync(dir, { recursive: true });
			const seedPath = join(dir, `${sid}-${stamp}.seed.json`);
			writeFileSync(seedPath, JSON.stringify({ sessionId: sid, ...meta }, null, 2), "utf8");
			return { path: seedPath, seedPath };
		}
	});

	// mock LLM（确定性）：
	// - selfcheck（prompt 含【新总结】）：变体文本 = 循环文本的语义复述 → duplicate(指向 j_0001)；
	//   真人插话后的新结论 → new。按关键字判定，绝不调用真实 LLM。
	// - draft（prompt 含【助手消息】）：取消息前 60 字符为 finding 摘要。
	const mockCallLlm = async ({ prompt }) => {
		if (prompt.includes("【新总结】")) {
			const m = /【新总结】\n([\s\S]+?)\n\n请输出 JSON。/.exec(prompt);
			const s = m?.[1] ?? "";
			return s.includes("变体")
				? JSON.stringify({ novelty: "duplicate", duplicate_of: "j_0001" })
				: JSON.stringify({ novelty: "new", duplicate_of: null });
		}
		const m = /【助手消息】\n([\s\S]+)\n\n请输出 JSON。/.exec(prompt);
		const text = (m?.[1] ?? prompt).trim().slice(0, 60) || "回放消息摘要";
		return JSON.stringify({ entries: [{ kind: "finding", summary: text, detail: "", artifacts: [], supersedes: [], confidence: 0.6 }] });
	};
	const summarizer = createSummarizer({
		store,
		emit,
		log,
		getSettings: () => settings,
		callLlm: mockCallLlm,
		embed: null,
		onSummarized: (sid, meta) => { stall.onEntries(sid, meta.entries ?? []); },
		onGap: (sid) => { stall.onGap(sid); }
	});

	let enqueued = 0;
	let observations = 0;
	let watchStalls = 0;
	let clock = 0; // 模拟墙钟（P0-8 回放：逐步推进，禁用真实 sleep）
	for (const line of lines) {
		let ev;
		try { ev = JSON.parse(line); } catch { continue; }
		if (ev?.type === "assistant/message") {
			const content = ev.data?.message?.content;
			const text = blocksToText(content);
			const reasoningLen = blocksToReasoning(content).trim().length;
			const hasArtifact = contentHasArtifact(content);
			const hasText = text.trim().length > 0;
			const step = ev.data?.step ?? ev.data?.message?.step ?? null;
			clock += 1000; // 每个 step 推进 1s 模拟墙钟
			// P0-8：轻量观察事件喂 stall（reasoning 有量即活跃，不误判停滞）
			try { stall.onObservation(sessionId, { turn: ev.data?.turn ?? ev.data?.message?.turn ?? null, step, ts: clock, hasText, textLen: text.length, reasoningLen, hasArtifact }); } catch { /* 忽略 */ }
			// P0-2：reasoning 有量/有产物/有 text 的 step 均落观察（reasoning-only 也记，kind 独立不污染结论）
			if ((hasText || reasoningLen > 0 || hasArtifact) && Number.isFinite(step)) {
				try {
					store.appendObservation(sessionId, { turn: ev.data?.turn ?? ev.data?.message?.turn ?? null, step, ts: new Date(clock).toISOString(), hasText, textLen: text.length, reasoningLen, hasArtifact });
					store.saveObservationWatermark(sessionId, { lastStepSeq: step });
					observations++;
				} catch { /* 忽略 */ }
			}
			if (!hasText) continue;
			const messageId = ev.data?.message?.id ?? `am-${enqueued + 1}`;
			summarizer.enqueue(sessionId, {
				sourceKind: "text",
				messageId,
				turn: ev.data?.turn ?? ev.data?.message?.turn ?? null,
				step,
				text
			});
			enqueued++;
			// 逐条等待处理完成（模拟实时节奏）：避免同步紧循环灌满 8 槽队列触发溢出丢最旧，
			// 破坏预登记的步序对齐。队列溢出路径由单测覆盖，回放不走。
			await summarizer.flush();
		} else if (ev?.type === "user/message") {
			stall.onUserMessage(sessionId); // 真人消息：停滞状态与级动作状态归零
		}
	}
	await summarizer.flush();

	const entries = store.readEntries(sessionId);
	const allLines = store.readAllLines(sessionId);
	const gaps = allLines.filter((l) => l?.type === "gap").length;
	const wm = store.loadWatermark(sessionId);
	const obsWm = store.loadObservationWatermark ? store.loadObservationWatermark(sessionId) : null;
	const count = (name) => events.filter((e) => e.name === name).length;
	const stalls = events.filter((e) => e.name === "semantic-watcher/stall");
	const result = {
		sessionId,
		synthetic,
		transcriptLines: lines.length,
		enqueued,
		entries: entries.length,
		observations,
		reasoningObservations: store.readObservations ? store.readObservations(sessionId).filter((o) => o && o.kind === "reasoning-observation" && !o.hasText && o.reasoningLen > 0).length : 0,
		duplicate: entries.filter((e) => e.novelty === "duplicate" && e.semantic_duplicate === false).length,
		semanticDuplicate: entries.filter((e) => e.semantic_duplicate === true).length,
		lexicalRepeat: count("semantic-watcher/lexical-repeat"),
		stallEvents: stalls.length,
		stallLevels: stalls.map((s) => s.payload.level),
		maxStallLevel: stalls.reduce((mx, s) => Math.max(mx, s.payload.level ?? 0), 0),
		watchStalls: count("semantic-watcher/stall"), // P0-8：stall-1 亦经 STALL 事件
		gaps,
		degraded: count("semantic-watcher/summarizer-degraded"),
		corruption: count("semantic-watcher/store-corruption"),
		unavailable: count("semantic-watcher/execution-unavailable"),
		watermarkStepSeq: wm?.lastStepSeq ?? null,
		observationWatermarkStepSeq: obsWm?.lastStepSeq ?? null
	};

	if (doCheck) {
		const expected = loadExpectedRanges().sessions?.[sessionId];
		if (expected?.stepRange) {
			const [min, max] = expected.stepRange;
			result.check = stalls.every((s) => s.payload.step >= min && s.payload.step <= max)
				? `PASS（stall 步均落在 [${min}, ${max}]）`
				: `FAIL（stall 步超出验收方登记区间 [${min}, ${max}]）`;
		} else if (expected) {
			result.check = "SKIP（验收方尚未登记 stepRange）";
		} else {
			result.check = "SKIP（该会话未在 expected-ranges.json 登记）";
		}
	}
	return result;
}

const sessions = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--session" && args[i + 1]) sessions.push(args[++i]);
}
const targets = sessions.length
	? sessions
	: Object.keys(loadExpectedRanges().sessions ?? {});

console.log(`[replay] 模式=${mockLlm ? "mock-llm（离线）" : "LIVE"} 账本根=${ledgerRoot} 目标会话=${targets.length}`);
const results = [];
for (const sid of targets) {
	const r = await replayOne(sid);
	results.push(r);
	console.log(JSON.stringify(r, null, 2));
}
const ok = results.filter((r) => !r.skipped);
console.log(`[replay] 完成：${ok.length}/${targets.length} 会话重放，条目合计 ${ok.reduce((s, r) => s + r.entries, 0)}，stall 事件合计 ${ok.reduce((s, r) => s + r.stallEvents, 0)}，corruption 合计 ${ok.reduce((s, r) => s + r.corruption, 0)}`);
