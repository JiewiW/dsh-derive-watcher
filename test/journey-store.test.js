/**
 * P1 journey-store 单测：JSONL/MD、闭标签转写、长度守恒、corruption、水位、归档、retention（§4/§7.3）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	KINDS, REASONING_KINDS, CHANNELS, OBSERVATION_KINDS, escapeClosingTags, restoreClosingTags, hasTranscriptionMarker,
	createJourneyStore, backfillFromSessionMessages, validateEntry
} from "../lib/journey-store.js";

function freshStore(overrides = {}) {
	const root = mkdtempSync(join(tmpdir(), "dsw-journey-"));
	const events = [];
	const store = createJourneyStore({
		root, emit: (name, payload) => events.push({ name, payload }), log: () => {}, ...overrides
	});
	return { root, store, events, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("KINDS 六类", () => {
	assert.deepEqual([...KINDS], ["finding", "decision", "dead-end", "hypothesis", "plan", "fact"]);
});

test("闭标签转写：往返还原、落盘无字面闭标签", () => {
	const s = "a</parameter>b</function>c";
	const escaped = escapeClosingTags(s);
	assert.ok(hasTranscriptionMarker(escaped));
	assert.ok(!hasTranscriptionMarker(s));
	assert.equal(restoreClosingTags(escaped), s);
});

test("appendEntry：JSONL 每行可 parse、MD 镜像存在、id 递增", () => {
	const { store, cleanup } = freshStore();
	try {
		const r1 = store.appendEntry("s1", { turn: 1, step: 1, sourceMessageId: "m1", kind: "finding", summary: "结论一", novelty: "new" });
		assert.equal(r1.ok, true);
		assert.equal(r1.entry.id, "j_0001");
		assert.equal(existsSync(store.paths.jsonl("s1")), true);
		const lines = readFileSync(store.paths.jsonl("s1"), "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.doesNotThrow(() => JSON.parse(lines[0]));
		assert.equal(existsSync(store.paths.md("s1")), true);
		assert.ok(readFileSync(store.paths.md("s1"), "utf8").includes("结论一"));
		const r2 = store.appendEntry("s1", { turn: 1, step: 2, sourceMessageId: "m2", kind: "decision", summary: "结论二", novelty: "new" });
		assert.equal(r2.entry.id, "j_0002");
		assert.equal(store.readEntries("s1").length, 2);
	} finally { cleanup(); }
});

test("escapeClosingTags：落盘转写、读取还原（§4.3）", () => {
	const { store, cleanup } = freshStore();
	try {
		const secret = "调用工具时输出 </parameter> 与 </function> 结束符";
		const r = store.appendEntry("s1", { turn: 1, step: 1, sourceMessageId: "m1", kind: "fact", summary: secret, novelty: "new" });
		assert.equal(r.ok, true);
		const raw = readFileSync(store.paths.jsonl("s1"), "utf8");
		assert.ok(!raw.includes("</parameter>"), "原始落盘不得含字面参数闭标签");
		assert.ok(raw.includes("SLASH_PARAMETER_ESCAPED"));
		assert.equal(store.readEntries("s1")[0].summary, secret);
	} finally { cleanup(); }
});

test("长度守恒失败 → ok:false + store-corruption(stage=append) + 停止该条写入", () => {
	const root = mkdtempSync(join(tmpdir(), "dsw-journey-"));
	try {
		const events = [];
		const targetFds = new Set();
		const target = join(root, "journey", "s1.jsonl");
		const store = createJourneyStore({
			root, emit: (n, p) => events.push({ n, p }), log: () => {},
			fsImpl: {
				mkdirSync: (...a) => realFs.mkdirSync(...a),
				appendFileSync: (...a) => realFs.appendFileSync(...a),
				readFileSync: (...a) => realFs.readFileSync(...a),
				writeFileSync: (...a) => realFs.writeFileSync(...a),
				statSync: (...a) => realFs.statSync(...a),
				readdirSync: (...a) => realFs.readdirSync(...a),
				unlinkSync: (...a) => realFs.unlinkSync(...a),
				// 实现走 openSync/writeSync 路径：按 fd 注入坏字节触发长度守恒失败
				openSync: (p, ...a) => {
					const fd = realFs.openSync(p, ...a);
					if (String(p) === String(target)) targetFds.add(fd);
					return fd;
				},
				writeSync: (fd, data, ...a) => {
					const n = realFs.writeSync(fd, data, ...a);
					if (targetFds.has(fd)) realFs.appendFileSync(fd, "GARBAGE");
					return n;
				},
				closeSync: (fd) => { targetFds.delete(fd); return realFs.closeSync(fd); }
			}
		});
		const r = store.appendEntry("s1", { turn: 1, step: 1, sourceMessageId: "m1", kind: "finding", summary: "结论", novelty: "new" });
		assert.equal(r.ok, false);
		const c = events.find((e) => e.n === "semantic-watcher/store-corruption");
		assert.ok(c, "应发 store-corruption");
		assert.equal(c.p.stage, "append");
		assert.ok(String(c.p.reason).includes("长度守恒"));
		// 后续读账本：坏行不可 parse → read 阶段 corruption，不静默
		store.readEntries("s1");
		assert.ok(events.some((e) => e.n === "semantic-watcher/store-corruption" && e.p.stage === "read"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("validateEntry 失败 → corruption(stage=validate) 且不落盘", () => {
	const { store, events, cleanup } = freshStore();
	try {
		const r = store.appendEntry("s1", { turn: 1, step: 1, kind: "bogus-kind", summary: "x", novelty: "new" });
		assert.equal(r.ok, false);
		assert.ok(events.some((e) => e.name === "semantic-watcher/store-corruption" && e.payload.stage === "validate"));
		assert.equal(existsSync(store.paths.jsonl("s1")), false);
	} finally { cleanup(); }
});

test("appendGap / appendMilestone / readMilestones", () => {
	const { store, cleanup } = freshStore();
	try {
		store.appendGap("s1", { reason: "测试 gap", turn: 1, step: 2 });
		const lines = store.readAllLines("s1");
		assert.equal(lines[lines.length - 1].type, "gap");
		// reasoning 通道的 gap 写独立账本：readGaps 必须两本都读，否则 timeline 只剩事件卡
		store.appendGap("s1", { reason: "队列溢出丢弃最旧", grade: "overflow", turn: 2, step: 5 }, "reasoning");
		const gaps = store.readGaps("s1");
		assert.equal(gaps.length, 2, "text 与 reasoning 两本账本的 gap 都要返回");
		assert.equal(gaps[1].channel, "reasoning");
		assert.equal(gaps[1].grade, "overflow");
		const m = store.appendMilestone("s1", {
			id: "j_0009", turn: 1, step: 3, sourceMessageId: null, kind: "finding",
			summary: "里程碑", detail: "", artifacts: [], supersedes: [], confidence: null, covers: ["j_0001"]
		});
		assert.ok(m);
		const miles = store.readMilestones("s1");
		assert.equal(miles.length, 1);
		assert.equal(miles[0].milestone, true);
		assert.equal(miles[0].covers[0], "j_0001");
		assert.equal(existsSync(store.paths.milestones("s1")), true);
	} finally { cleanup(); }
});

test("watermark 保存/读取/缺失回 null", () => {
	const { store, cleanup } = freshStore();
	try {
		store.saveWatermark("s1", { lastMessageId: "m9", lastStepSeq: 12 });
		const wm = store.loadWatermark("s1");
		assert.equal(wm.lastMessageId, "m9");
		assert.equal(wm.lastStepSeq, 12);
		assert.equal(store.loadWatermark("nope"), null);
	} finally { cleanup(); }
});

test("archiveEntries：原文移入归档、主账本重写、未命中报错", () => {
	const { store, cleanup } = freshStore();
	try {
		for (let i = 1; i <= 3; i++) store.appendEntry("s1", { turn: 1, step: i, sourceMessageId: `m${i}`, kind: "finding", summary: `结论${i}`, novelty: "new" });
		const entries = store.readEntries("s1");
		const r = store.archiveEntries("s1", [entries[0], entries[2]], "t1");
		assert.equal(r.ok, true);
		assert.equal(r.archived, 2);
		const rest = store.readEntries("s1");
		assert.equal(rest.length, 1);
		assert.equal(rest[0].id, entries[1].id);
		const files = readdirSync(store.paths.archiveDir);
		assert.equal(files.length, 1);
		assert.equal(readFileSync(join(store.paths.archiveDir, files[0]), "utf8").trim().split("\n").length, 2);
		const r2 = store.archiveEntries("s1", [{ id: "j_9999" }], "t2");
		assert.equal(r2.ok, false);
	} finally { cleanup(); }
});

test("retentionClean：按 mtime 清理过期归档", () => {
	const { store, cleanup } = freshStore();
	try {
		for (let i = 1; i <= 3; i++) store.appendEntry("s1", { turn: 1, step: i, sourceMessageId: `m${i}`, kind: "finding", summary: `结论${i}`, novelty: "new" });
		const entries = store.readEntries("s1");
		store.archiveEntries("s1", [entries[0]], "t1");
		const files = readdirSync(store.paths.archiveDir);
		const old = new Date(Date.now() - 40 * 86400000);
		for (const f of files) utimesSync(join(store.paths.archiveDir, f), old, old);
		const removed = store.retentionClean(30);
		assert.deepEqual(removed.sort(), [...files].sort());
		assert.equal(readdirSync(store.paths.archiveDir).length, 0);
	} finally { cleanup(); }
});

test("P2-21③ retentionCleanLedger：ledgerRetentionDays>0 清理过期的会话主账本/gap；0 不清理", () => {
	const { store, cleanup } = freshStore();
	try {
		for (let i = 1; i <= 3; i++) store.appendEntry("s1", { turn: 1, step: i, sourceMessageId: `m${i}`, kind: "finding", summary: `结论${i}`, novelty: "new" });
		store.appendGap("s1", { reason: "测试 gap", step: 4 });
		const s1jsonl = join(store.paths.journeyDir, "s1.jsonl");
		const s2jsonl = join(store.paths.journeyDir, "s2.jsonl");
		writeFileSync(s2jsonl, JSON.stringify({ type: "gap", rrr: 1 }) + "\n");
		// 0 = 不清理主账本
		assert.equal(store.retentionCleanLedger(0).length, 0);
		assert.ok(existsSync(s1jsonl));
		// 把 s1.jsonl 置旧 → 清理；s2 仍新 → 保留
		const old = new Date(Date.now() - 40 * 86400000);
		utimesSync(s1jsonl, old, old);
		const removed = store.retentionCleanLedger(30);
		assert.ok(removed.includes("s1.jsonl"), `应清理 s1.jsonl，实际 ${JSON.stringify(removed)}`);
		assert.ok(!removed.includes("s2.jsonl"), "新账本保留");
		assert.ok(!existsSync(s1jsonl), "s1 主账本已删除");
	} finally { cleanup(); }
});

test("nextEntryId 重启恢复：新实例从主账本+里程碑+归档取最大", () => {
	const { root, store, cleanup } = freshStore();
	try {
		store.appendEntry("s1", { turn: 1, step: 1, sourceMessageId: "m1", kind: "finding", summary: "a", novelty: "new" });
		store.appendEntry("s1", { turn: 1, step: 2, sourceMessageId: "m2", kind: "finding", summary: "b", novelty: "new" });
		store.appendMilestone("s1", { id: "j_0009", turn: 1, step: 3, kind: "finding", summary: "m", detail: "", artifacts: [], supersedes: [], confidence: null, covers: ["j_0001"] });
		const store2 = createJourneyStore({ root, log: () => {} });
		const r = store2.appendEntry("s1", { turn: 1, step: 4, sourceMessageId: "m4", kind: "finding", summary: "c", novelty: "new" });
		assert.ok(Number(r.entry.id.slice(2)) >= 10, `重启后 id 应跳过里程碑最大号，实际 ${r.entry.id}`);
	} finally { cleanup(); }
});

test("backfillFromSessionMessages：assistant/message 过滤 + 水位后补扫", () => {
	const messages = [
		{ type: "session", data: {} },
		{ type: "assistant/message", data: { message: { id: "m1", turn: 1, step: 1, content: [{ type: "text", text: "第一条" }] } } },
		{ type: "assistant/message", data: { message: { id: "m2", turn: 1, step: 3, content: [{ type: "text", text: "第二条" }] } } },
		{ type: "user/message", data: { message: { content: "真人" } } }
	];
	assert.equal(backfillFromSessionMessages(messages, null).length, 2);
	assert.equal(backfillFromSessionMessages(messages, { lastMessageId: "m1", lastStepSeq: 1 }).length, 1);
	assert.equal(backfillFromSessionMessages(messages, { lastMessageId: "m2", lastStepSeq: 3 }).length, 0);
	const seen = backfillFromSessionMessages(messages, { lastMessageId: "m2", lastStepSeq: 3 }, new Set(["m2"]));
	assert.equal(seen.length, 0);
});

// ── P0-2：观察独立通道 ──────────────────────────────────────────────────
test("appendObservation：写 observation 独立文件、不入主账本、MD 不镜像", () => {
	const { store, cleanup } = freshStore();
	try {
		const ok = store.appendObservation("s1", { turn: 1, step: 5, hasText: false, textLen: 0, reasoningLen: 12000, hasArtifact: false });
		assert.equal(ok, true);
		assert.equal(existsSync(store.paths.observation("s1")), true);
		assert.equal(existsSync(store.paths.jsonl("s1")), false, "观察不得污染主结论账本");
		assert.equal(existsSync(store.paths.md("s1")), false, "观察不得生成 MD 镜像");
		const obs = store.readObservations("s1");
		assert.equal(obs.length, 1);
		assert.equal(obs[0].kind, "reasoning-observation");
		assert.equal(obs[0].step, 5);
		assert.equal(obs[0].hasText, false);
		assert.equal(obs[0].reasoningLen, 12000);
	} finally { cleanup(); }
});

test("观察水位与总结水位拆分、读写独立文件", () => {
	const { store, cleanup } = freshStore();
	try {
		assert.equal(store.saveObservationWatermark("s1", { lastStepSeq: 7, lastTs: 1700000000000 }), true);
		const owm = store.loadObservationWatermark("s1");
		assert.equal(owm.lastStepSeq, 7);
		assert.equal(owm.lastTs, 1700000000000);
		// 观察水位不影响总结水位
		const wm = store.loadWatermark("s1");
		assert.equal(wm, null, "观察水位写入后总结水位仍应为 null（通道拆分）");
		assert.equal(store.loadObservationWatermark("nope"), null);
	} finally { cleanup(); }
});

test("P2-21⑥：loadWatermark 坏字段/缺失统一返 null", () => {
	const { store, root, cleanup } = freshStore();
	try {
		// 缺失文件 → null
		assert.equal(store.loadWatermark("missing"), null);
		// 显式写坏文件（lastStepSeq 非法字符串、lastMessageId 非字符串）→ null（不再坏字段返 0）
		mkdirSync(join(root, "watermark"), { recursive: true });
		writeFileSync(join(root, "watermark", "bad.json"), JSON.stringify({ sessionId: "s1", lastMessageId: 42, lastStepSeq: "abc", ts: null }));
		assert.equal(store.loadWatermark("bad"), null);
		// 仅尺寸/时间字段非法、实质序为 null → 按 null 处理
		const validRw = store.saveWatermark("ok", { lastMessageId: "m1", lastStepSeq: 3 });
		assert.equal(validRw, true);
		assert.equal(store.loadWatermark("ok").lastStepSeq, 3);
	} finally { cleanup(); }
});

// ── reasoning 独立通道（步骤1：物理隔离 + 独立水位/计数 + reasoning-stall）──────────
test("REASONING_KINDS 五类 + CHANNELS 两通道", () => {
	assert.deepEqual([...REASONING_KINDS], ["r-decision", "r-hypothesis", "r-self-correction", "r-dead-end", "r-plan"]);
	assert.deepEqual([...CHANNELS], ["text", "reasoning"]);
	assert.ok(OBSERVATION_KINDS.includes("reasoning-stall"));
	// 推理 kind 与正式 kind 集合不相交
	for (const k of REASONING_KINDS) assert.ok(!KINDS.includes(k), `${k} 不得出现在正式 KINDS`);
});

test("reasoning entry 与 text entry 物理隔离：互不出现在对方 readEntries", () => {
	const { store, cleanup } = freshStore();
	try {
		const rt = store.appendEntry("s1", { turn: 1, step: 1, sourceMessageId: "m1", kind: "finding", summary: "正式结论" }, "text");
		const rr = store.appendEntry("s1", { turn: 1, step: 1, sourceMessageId: "m1", kind: "r-decision", summary: "推理决策" }, "reasoning");
		assert.equal(rt.ok, true);
		assert.equal(rr.ok, true);
		// 物理文件分离
		assert.equal(existsSync(store.paths.jsonl("s1")), true);
		assert.equal(existsSync(store.paths.reasoningJsonl("s1")), true);
		assert.notEqual(store.paths.jsonl("s1"), store.paths.reasoningJsonl("s1"));
		// text 通道只读 text
		const textEntries = store.readEntries("s1");
		assert.equal(textEntries.length, 1);
		assert.equal(textEntries[0].kind, "finding");
		assert.equal(textEntries[0].channel, "text");
		// reasoning 通道只读 reasoning
		const reasoningEntries = store.readReasoningEntries("s1");
		assert.equal(reasoningEntries.length, 1);
		assert.equal(reasoningEntries[0].kind, "r-decision");
		assert.equal(reasoningEntries[0].channel, "reasoning");
		assert.equal(reasoningEntries[0].summary, "推理决策");
		// 物理落盘文件内容互不串
		const rawText = readFileSync(store.paths.jsonl("s1"), "utf8");
		const rawReasoning = readFileSync(store.paths.reasoningJsonl("s1"), "utf8");
		assert.ok(!rawText.includes("r-decision"), "text 账本不得含 reasoning entry");
		assert.ok(!rawReasoning.includes('"kind":"finding"'), "reasoning 账本不得含 text entry");
	} finally { cleanup(); }
});

test("两通道水位独立：写 reasoning 水位不影响 text 水位，反之亦然", () => {
	const { store, cleanup } = freshStore();
	try {
		store.saveWatermark("s1", { lastMessageId: "rm1", lastStepSeq: 5 }, "reasoning");
		assert.equal(store.loadWatermark("s1", "text"), null, "reasoning 水位写入后 text 水位仍为 null");
		const rwm = store.loadWatermark("s1", "reasoning");
		assert.equal(rwm.lastMessageId, "rm1");
		assert.equal(rwm.lastStepSeq, 5);
		// 物理水位文件分离
		assert.equal(existsSync(store.paths.reasoningWatermark("s1")), true);
		assert.equal(existsSync(store.paths.watermark("s1")), false);
		// 再写 text 水位
		store.saveWatermark("s1", { lastMessageId: "tm9", lastStepSeq: 9 }, "text");
		assert.equal(store.loadWatermark("s1", "text").lastMessageId, "tm9");
		assert.equal(store.loadWatermark("s1", "reasoning").lastMessageId, "rm1", "text 水位写入不得覆盖 reasoning 水位");
	} finally { cleanup(); }
});

test("两通道 entry id 独立计数：同会话各自从 j_0001 起且不串号", () => {
	const { store, cleanup } = freshStore();
	try {
		const t1 = store.appendEntry("s1", { turn: 1, step: 1, kind: "finding", summary: "t1" }, "text");
		const r1 = store.appendEntry("s1", { turn: 1, step: 1, kind: "r-plan", summary: "r1" }, "reasoning");
		const t2 = store.appendEntry("s1", { turn: 1, step: 2, kind: "fact", summary: "t2" }, "text");
		const r2 = store.appendEntry("s1", { turn: 1, step: 2, kind: "r-hypothesis", summary: "r2" }, "reasoning");
		assert.deepEqual([t1.entry.id, t2.entry.id], ["j_0001", "j_0002"]);
		assert.deepEqual([r1.entry.id, r2.entry.id], ["j_0001", "j_0002"], "reasoning 通道独立计数");
	} finally { cleanup(); }
});

test("跨通道 kind 校验：reasoning kind 进 text 通道 / 正式 kind 进 reasoning 通道 / 非法 channel 均拒绝", () => {
	const { store, events, cleanup } = freshStore();
	try {
		// reasoning kind 混入 text 通道 → 拒绝且不落盘
		const bad1 = store.appendEntry("s1", { turn: 1, step: 1, kind: "r-decision", summary: "x" }, "text");
		assert.equal(bad1.ok, false);
		// 正式 kind 混入 reasoning 通道 → 拒绝
		const bad2 = store.appendEntry("s1", { turn: 1, step: 1, kind: "finding", summary: "x" }, "reasoning");
		assert.equal(bad2.ok, false);
		// 非法 channel → 拒绝
		const bad3 = store.appendEntry("s1", { turn: 1, step: 1, kind: "finding", summary: "x" }, "bogus");
		assert.equal(bad3.ok, false);
		// validateEntry 直接校验
		assert.equal(validateEntry({ id: "j_0001", kind: "r-plan", summary: "x" }, "reasoning").length, 0);
		assert.ok(validateEntry({ id: "j_0001", kind: "finding", summary: "x" }, "reasoning").some((e) => e.includes("kind 非法")));
		assert.ok(events.some((e) => e.name === "semantic-watcher/store-corruption" && e.payload.stage === "validate"));
		// 两类账本均无残留
		assert.equal(store.readEntries("s1").length, 0);
		assert.equal(store.readReasoningEntries("s1").length, 0);
	} finally { cleanup(); }
});

test("reasoning-stall observation：显式 kind + message 落 observation 账本，不入任何结论账本", () => {
	const { store, cleanup } = freshStore();
	try {
		const ok = store.appendObservation("s1", {
			turn: 1, step: 8, hasText: false, textLen: 0, reasoningLen: 9000, hasArtifact: false,
			kind: "reasoning-stall", message: "推理长时间未产出正式结论"
		});
		assert.equal(ok, true);
		// 默认 kind 仍为 reasoning-observation
		const ok2 = store.appendObservation("s1", { turn: 1, step: 9, hasText: false, reasoningLen: 100 });
		const obs = store.readObservations("s1");
		assert.equal(obs.length, 2);
		assert.equal(obs[0].kind, "reasoning-stall");
		assert.equal(obs[0].message, "推理长时间未产出正式结论");
		assert.equal(obs[1].kind, "reasoning-observation", "未显式传 kind 时默认常规观察");
		// 观察不污染任一结论通道
		assert.equal(store.readEntries("s1").length, 0);
		assert.equal(store.readReasoningEntries("s1").length, 0);
	} finally { cleanup(); }
});

test("reasoning 通道重启恢复 id 计数（只扫 reasoning 账本）", () => {
	const { root, store, cleanup } = freshStore();
	try {
		store.appendEntry("s1", { turn: 1, step: 1, kind: "r-decision", summary: "r1" }, "reasoning");
		store.appendEntry("s1", { turn: 1, step: 2, kind: "r-plan", summary: "r2" }, "reasoning");
		const store2 = createJourneyStore({ root, log: () => {} });
		const next = store2.appendEntry("s1", { turn: 1, step: 3, kind: "r-dead-end", summary: "r3" }, "reasoning");
		assert.equal(next.entry.id, "j_0003", "重启后 reasoning 通道应从 reasoning 账本恢复到 j_0003");
		// 新实例 text 通道计数不受 reasoning 账本影响
		const tNext = store2.appendEntry("s1", { turn: 1, step: 1, kind: "finding", summary: "t1" }, "text");
		assert.equal(tNext.entry.id, "j_0001", "text 通道无账本时应从 j_0001 起");
	} finally { cleanup(); }
});
