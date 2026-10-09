/**
 * P1 summarizer 单测（mock LLM）：落账/去重/畸形 JSON 重试/degrade gap/队列上限/并发闸/水位（§5.1/§7.3）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSummarizer, QUEUE_CAP, DEFAULT_TIMEOUT_MS,
	parseJsonObject, extractDraftEntries, buildDraftPrompt, makeLlmCall
} from "../lib/summarizer.js";
import { createJourneyStore } from "../lib/journey-store.js";
import { EVT } from "../lib/events.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";

const draftJson = (summary, extra = {}) =>
	JSON.stringify({ entries: [{ kind: "finding", summary, detail: "", artifacts: [], supersedes: [], confidence: 0.8, ...extra }] });

function harness(callLlm, settingsOverrides = {}) {
	const root = mkdtempSync(join(tmpdir(), "dsw-sum-"));
	const events = [];
	const store = createJourneyStore({ root, emit: (n, p) => events.push({ n, p }), log: () => {} });
	let settings = { ...DEFAULT_SETTINGS, ...settingsOverrides };
	const gaps = [];
	const summarized = [];
	const summarizer = createSummarizer({
		store, emit: (n, p) => events.push({ n, p }), log: () => {},
		getSettings: () => settings, callLlm,
		onSummarized: (sid, info) => summarized.push({ sid, ...info }),
		onGap: (sid, meta) => gaps.push({ sid, ...meta })
	});
	return {
		root, store, events, summarizer, gaps, summarized,
		setSettings: (s) => { settings = { ...settings, ...s }; },
		cleanup: () => rmSync(root, { recursive: true, force: true })
	};
}

const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const awaitDrain = async (h, processed, tries = 200) => {
	for (let i = 0; i < tries && h.summarizer.stats().processed < processed; i++) await settle(1);
};

test("常量：QUEUE_CAP=8、DEFAULT_TIMEOUT_MS=30000", () => {
	assert.equal(QUEUE_CAP, 8);
	assert.equal(DEFAULT_TIMEOUT_MS, 30000);
});

test("parseJsonObject / extractDraftEntries：围栏、噪声、非法条目丢弃", () => {
	assert.deepEqual(parseJsonObject('```json\n{"entries":[]}\n```'), { entries: [] });
	assert.equal(parseJsonObject("垃圾文本"), null);
	const drafts = extractDraftEntries('前置 {"entries":[{"kind":"finding","summary":" 有效 "},{"kind":"bogus","summary":"x"},{"kind":"fact","summary":""},{"kind":"fact"}]} 后置');
	assert.equal(drafts.length, 1);
	assert.equal(drafts[0].summary, "有效");
	assert.equal(buildDraftPrompt({ turn: 2, step: 3, text: "正文" }).includes("正文"), true);
});

test("正常总结：落账 new + 水位推进 + onSummarized", async () => {
	const h = harness(async () => draftJson("全新结论文本"));
	try {
		const q = h.summarizer.enqueue("s1", { messageId: "m1", turn: 1, step: 1, text: "助手消息内容" });
		assert.equal(q.queued, true);
		await awaitDrain(h, 1);
		const entries = h.store.readEntries("s1");
		assert.equal(entries.length, 1);
		assert.equal(entries[0].novelty, "new");
		assert.equal(entries[0].sourceMessageId, "m1");
		assert.equal(h.store.loadWatermark("s1").lastMessageId, "m1");
		assert.equal(h.store.loadWatermark("s1").lastStepSeq, 1);
		assert.equal(h.summarizer.stats().processed, 1);
		assert.equal(h.summarized.length, 1);
		assert.equal(h.summarized[0].messageId, "m1");
	} finally { h.cleanup(); }
});

test("入队去重与空文本拒绝", async () => {
	const h = harness(async () => draftJson("x"));
	try {
		assert.equal(h.summarizer.enqueue("s1", { messageId: "m1", turn: 1, step: 1, text: "内容" }).queued, true);
		const dup = h.summarizer.enqueue("s1", { messageId: "m1", turn: 1, step: 2, text: "内容" });
		assert.equal(dup.queued, false);
		assert.ok(dup.reason.includes("去重"));
		assert.equal(h.summarizer.enqueue("s1", { messageId: "m2", text: "   " }).queued, false);
		assert.equal(h.summarizer.stats().enqueued, 1);
	} finally { h.cleanup(); }
});

test("词法重复：同文判 duplicate（semantic_duplicate=false, duplicate_of 指向首条）", async () => {
	let call = 0;
	const h = harness(async () => (++call === 1 ? draftJson("数据库连接池耗尽导致请求堆积") : draftJson("数据库连接池耗尽导致请求堆积")));
	try {
		h.summarizer.enqueue("s1", { messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { messageId: "m2", turn: 1, step: 2, text: "b" });
		await awaitDrain(h, 2);
		const entries = h.store.readEntries("s1");
		assert.equal(entries[1].novelty, "duplicate");
		assert.equal(entries[1].semantic_duplicate, false);
		assert.equal(entries[1].duplicate_of, entries[0].id);
	} finally { h.cleanup(); }
});

test("语义重复（schema-selfcheck）：词法未命中 + selfcheck 命中 → duplicate(semantic_duplicate=true)", async () => {
	let call = 0;
	const h = harness(async ({ purpose }) => {
		if (String(purpose).includes("selfcheck")) return '{"novelty":"duplicate","duplicate_of":"j_0001"}';
		// 两条 draft 需零 3-gram 重叠，否则词法层先命中、selfcheck 永不触发
		return ++call === 1
			? draftJson("前端路由守卫死循环导致页面白屏")
			: draftJson("改写后的同义结论：首屏渲染管线异常");
	});
	try {
		h.summarizer.enqueue("s1", { messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { messageId: "m2", turn: 1, step: 2, text: "b" });
		await awaitDrain(h, 2);
		const entries = h.store.readEntries("s1");
		assert.equal(entries[1].novelty, "duplicate");
		assert.equal(entries[1].semantic_duplicate, true);
		assert.equal(entries[1].duplicate_of, "j_0001");
	} finally { h.cleanup(); }
});

test("畸形 JSON 重试 1 次后成功：stats.retried=1", async () => {
	let call = 0;
	const h = harness(async () => (++call === 1 ? "完全不是 JSON" : draftJson("重试后成功的新结论")));
	try {
		h.summarizer.enqueue("s1", { messageId: "m1", turn: 1, step: 1, text: "a" });
		await awaitDrain(h, 1);
		assert.equal(h.summarizer.stats().retried, 1);
		assert.equal(h.summarizer.stats().processed, 1);
		assert.equal(h.store.readEntries("s1").length, 1);
	} finally { h.cleanup(); }
});

test("两次畸形 → degrade：gap 落盘 + SUMMARIZER_DEGRADED + onGap + 不推水位", async () => {
	const h = harness(async () => "仍然不是 JSON");
	try {
		h.summarizer.enqueue("s1", { messageId: "m1", turn: 1, step: 1, text: "a" });
		await awaitDrain(h, 0);
		await settle();
		assert.equal(h.summarizer.stats().degraded, 1);
		assert.equal(h.summarizer.stats().processed, 0);
		assert.equal(h.store.loadWatermark("s1"), null);
		const lines = h.store.readAllLines("s1");
		assert.equal(lines[lines.length - 1].type, "gap");
		assert.ok(h.events.some((e) => e.n === EVT.SUMMARIZER_DEGRADED));
		assert.equal(h.gaps.length, 1);
	} finally { h.cleanup(); }
});

test("队列上限 8：溢出丢最旧 + gap + 事件；其余照常处理", async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	let seq = 0;
	const h = harness(async () => { await gate; return draftJson(`溢出测试唯一结论${++seq}`); });
	try {
		for (let i = 1; i <= 10; i++) h.summarizer.enqueue("s1", { messageId: `m${i}`, turn: 1, step: i, text: `消息${i}` });
		assert.equal(h.summarizer.stats().dropped, 1, "第 10 条入队时应挤掉最旧的 m2");
		assert.equal(h.summarizer.stats().queued, 8);
		assert.ok(h.events.some((e) => e.n === EVT.SUMMARIZER_DEGRADED && String(e.p.suppressReason).includes("队列溢出")));
		const lines = h.store.readAllLines("s1");
		assert.equal(lines[lines.length - 1].type, "gap");
		release();
		await awaitDrain(h, 9);
		assert.equal(h.summarizer.stats().processed, 9);
		assert.equal(h.store.readEntries("s1").length, 9);
		assert.equal(h.store.loadWatermark("s1").lastMessageId, "m10");
		assert.equal(h.store.loadWatermark("s1").lastStepSeq, 10);
	} finally { release?.(); h.cleanup(); }
});

test("并发闸默认 1：两个任务串行", async () => {
	let inFlight = 0, maxInFlight = 0, seq = 0;
	const h = harness(async () => {
		inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
		await settle(2);
		inFlight--;
		return draftJson(`串行唯一结论${++seq}`);
	});
	try {
		h.summarizer.enqueue("s1", { messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { messageId: "m2", turn: 1, step: 2, text: "b" });
		await awaitDrain(h, 2);
		assert.equal(maxInFlight, 1);
		assert.equal(h.store.readEntries("s1").length, 2);
	} finally { h.cleanup(); }
});

test("并发闸 maxConcurrency=2：两个任务并行", async () => {
	let inFlight = 0, maxInFlight = 0, seq = 0;
	const h = harness(async () => {
		inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
		await settle(2);
		inFlight--;
		return draftJson(`并行唯一结论${++seq}`);
	});
	h.setSettings({ maxConcurrency: 2 });
	try {
		h.summarizer.enqueue("s1", { messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { messageId: "m2", turn: 1, step: 2, text: "b" });
		await awaitDrain(h, 2);
		assert.equal(maxInFlight, 2);
	} finally { h.cleanup(); }
});

test("makeLlmCall：llm 缺失/异常 → null（fail-open）", async () => {
	const c1 = makeLlmCall({ llm: null, provider: "", model: "", source: { kind: "plugin:dsh-derive-watcher", plugin: "dsh-derive-watcher" } });
	assert.equal(await c1({ prompt: "x" }), null);
	const c2 = makeLlmCall({ llm: { stream: () => { throw new Error("boom"); } }, provider: "", model: "", source: null });
	assert.equal(await c2({ prompt: "x" }), null);
});

test("makeLlmCall：超时中止返回 null", async () => {
	const never = { stream: () => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } }) };
	const c = makeLlmCall({ llm: never, provider: "", model: "", source: null });
	const t0 = Date.now();
	assert.equal(await c({ prompt: "x", timeoutMs: 20 }), null);
	assert.ok(Date.now() - t0 < 2000, "应在超时后立即返回而非等待 30s");
});

test("makeLlmCall：flash 钉定（provider/model 留空传 undefined）+ text 块组装", async () => {
	let captured = null;
	const fakeLlm = {
		stream: (opts) => {
			captured = opts;
			return (async function* () {
				yield { type: "text-delta", index: 0, text: "你好" };
				yield { type: "text-delta", index: 0, text: "世界" };
			})();
		}
	};
	const c = makeLlmCall({ llm: fakeLlm, provider: "", model: "", source: { kind: "plugin:dsh-derive-watcher", plugin: "dsh-derive-watcher" } });
	const out = await c({ system: "sys", prompt: "p", sessionId: "s1", purpose: "semantic-watcher/draft" });
	assert.equal(out, "你好世界"); // BlockAssembler 合并相邻 text-delta 为单块
	assert.equal(captured.provider, undefined);
	assert.equal(captured.model, undefined);
	assert.equal(captured.sessionId, "s1");
	assert.equal(captured.purpose, "semantic-watcher/draft");
	assert.equal(captured.signal instanceof AbortSignal, true);
});
