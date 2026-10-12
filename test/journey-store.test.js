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
	KINDS, OBSERVATION_KINDS, escapeClosingTags, restoreClosingTags, hasTranscriptionMarker,
	createJourneyStore, backfillFromSessionMessages
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
