/**
 * P0 基础工具单测：textutil + events（§7.3）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, normalizeForNgram, charTrigrams, trimToSentence } from "../lib/textutil.js";
import { EVT, PLUGIN_ID, SUPPRESSED_EVENTS, basePayload, createEventSink } from "../lib/events.js";

test("estimateTokens：CJK 1token/字，拉丁 4字符/token", () => {
	assert.equal(estimateTokens("中文中文字符"), 6);
	assert.equal(estimateTokens("abcdefgh"), 2);
	assert.equal(estimateTokens(""), 0);
});

test("normalizeForNgram：NFKC + 小写 + 仅留 ASCII 字母数字与 CJK", () => {
	const n = normalizeForNgram("Ｈｅｌｌｏ，世界！");
	assert.ok(n.includes("hello"));
	assert.ok(n.includes("世界"));
	assert.ok(!n.includes("，"));
});

test("charTrigrams：不足 3 字符退化为单元素集合", () => {
	assert.equal(charTrigrams(normalizeForNgram("ab")).size, 1);
	assert.equal(charTrigrams(normalizeForNgram("abcd")).size, 2);
});

test("trimToSentence：句界累积、不截句中、首句放不下返回 null", () => {
	const text = "第一句话。第二句话！第三句话？";
	assert.equal(trimToSentence(text, 5), null);
	const t = trimToSentence(text, 9);
	assert.ok(t.startsWith("第一句话。"), "应从句首累积");
	assert.ok(t.length <= 9);
	assert.equal(trimToSentence(text, 100), text);
});

test("EVT 冻结映射（§5.8 全部事件名）", () => {
	assert.equal(PLUGIN_ID, "dsh-derive-watcher");
	assert.equal(EVT.STALL, "semantic-watcher/stall");
	assert.equal(EVT.STORE_CORRUPTION, "semantic-watcher/store-corruption");
	assert.equal(EVT.INJECTION_SKIPPED, "semantic-watcher/injection-skipped");
	assert.equal(EVT.EXECUTION_UNAVAILABLE, "semantic-watcher/execution-unavailable");
	assert.equal(EVT.LEXICAL_REPEAT, "semantic-watcher/lexical-repeat");
	assert.equal(EVT.SUMMARIZER_DEGRADED, "semantic-watcher/summarizer-degraded");
	assert.equal(EVT.HANDOFF_WRITTEN, "semantic-watcher/handoff-written");
	assert.equal(EVT.HEARTBEAT, "semantic-watcher/heartbeat");
	assert.equal(EVT.FOLD_MILESTONE, "semantic-watcher/fold-milestone");
	assert.equal(EVT.RETENTION_CLEANED, "semantic-watcher/retention-cleaned");
	assert.equal(EVT.INTERVENTION, "semantic-watcher/intervention");
});

test("SUPPRESSED_EVENTS 含三个抑制类事件", () => {
	assert.ok(SUPPRESSED_EVENTS.has("semantic-watcher/injection-skipped"));
	assert.ok(SUPPRESSED_EVENTS.has("semantic-watcher/execution-unavailable"));
	assert.ok(SUPPRESSED_EVENTS.has("semantic-watcher/summarizer-degraded"));
});

test("basePayload：sessionId/turn/step/evidenceSeq", () => {
	const p = basePayload("s1", 2, 3, 7);
	assert.equal(p.sessionId, "s1");
	assert.equal(p.turn, 2);
	assert.equal(p.step, 3);
	assert.equal(p.evidenceSeq, 7);
});

test("createEventSink：补 sessionId、非有限 turn/step 置 null、抑制类补 suppressReason、evidenceSeq 递增", () => {
	const sink = createEventSink({ log: () => {} });
	const r1 = sink.emit({ id: "s1" }, EVT.INJECTION_SKIPPED, { turn: "非数字", step: null });
	assert.equal(r1.payload.sessionId, "s1");
	assert.equal(r1.payload.turn, null);
	assert.equal(r1.payload.suppressReason, "unspecified");
	assert.ok(r1.payload.evidenceSeq >= 1);
	const r2 = sink.emit({ id: "s1" }, EVT.STALL, { evidenceSeq: 42 });
	assert.equal(r2.payload.evidenceSeq, 42);
	const r3 = sink.emit(null, EVT.STALL, {});
	assert.equal(r3.payload.sessionId, "*"); // §5.8 事件必带 sessionId：无会话时用 "*" 占位
});
