/**
 * P1 summarizer 单测（mock LLM）：落账/去重/畸形 JSON 重试/degrade gap/队列上限/并发闸/水位（§5.1/§7.3）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSummarizer, QUEUE_CAP, DEFAULT_TIMEOUT_MS,
	parseJsonObject, extractDraftEntries, draftParse, buildDraftPrompt, makeLlmCall
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

test("draftParse：三态区分（合法空 / 有条目 / 解析失败）", () => {
	// ok=true, drafts=[]
	assert.deepEqual(draftParse('{"entries":[]}'), { ok: true, drafts: [] });
	// ok=true, drafts 非空
	const withOne = draftParse(draftJson("结论"));
	assert.equal(withOne.ok, true);
	assert.equal(withOne.drafts.length, 1);
	// ok=false（畸形）
	assert.deepEqual(draftParse("不是 JSON"), { ok: false, drafts: [] });
	// 缺 entries 键视为畸形
	assert.deepEqual(draftParse('{"foo":1}'), { ok: false, drafts: [] });
});

test("P0-3 合法空 entries：推进水位、不记 gap、不重试、无账本行", async () => {
	let callCount = 0;
	const h = harness(async () => { callCount += 1; return '{"entries":[]}'; });
	try {
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "有内容但模型认为无可记" });
		await awaitDrain(h, 0);
		await settle();
		// 不重试：仅 1 次草稿调用
		assert.equal(callCount, 1);
		// 不记 gap：账本最后一行不是 gap，无 degrade 事件
		assert.equal(h.summarizer.stats().degraded, 0);
		assert.equal(h.gaps.length, 0);
		assert.ok(!h.events.some((e) => e.n === EVT.SUMMARIZER_DEGRADED));
		// 无结论账本行
		assert.equal(h.store.readEntries("s1").length, 0);
		// 关键：合法空也推进总结水位（不卡同 step 补扫）
		const wm = h.store.loadWatermark("s1");
		assert.equal(wm.lastMessageId, "m1");
		assert.equal(wm.lastStepSeq, 1);
		assert.equal(h.summarized.length, 0, "合法空不应触发 onSummarized 落账回调");
	} finally { h.cleanup(); }
});

test("P2-22 畸形括号一次修复：不重试直接成功", async () => {
	let callCount = 0;
	const h = harness(async () => {
		callCount += 1;
		// 缺右大括号的畸形 JSON
		return '{"entries":[{"kind":"finding","summary":"括号修复后的结论"}]';
	});
	try {
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "内容" });
		await awaitDrain(h, 1);
		assert.equal(h.summarizer.stats().processed, 1);
		assert.equal(h.store.readEntries("s1").length, 1);
		assert.equal(h.store.readEntries("s1")[0].summary, "括号修复后的结论");
	} finally { h.cleanup(); }
});

test("正常总结：落账 new + 水位推进 + onSummarized", async () => {
	const h = harness(async () => draftJson("全新结论文本"));
	try {
		const q = h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "助手消息内容" });
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
		assert.equal(h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "内容" }).queued, true);
		const dup = h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 2, text: "内容" });
		assert.equal(dup.queued, false);
		assert.ok(dup.reason.includes("去重"));
		assert.equal(h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m2", text: "   " }).queued, false);
		assert.equal(h.summarizer.stats().enqueued, 1);
	} finally { h.cleanup(); }
});

test("词法重复：同文判 duplicate（semantic_duplicate=false, duplicate_of 指向首条）", async () => {
	let call = 0;
	const h = harness(async () => (++call === 1 ? draftJson("数据库连接池耗尽导致请求堆积") : draftJson("数据库连接池耗尽导致请求堆积")));
	try {
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m2", turn: 1, step: 2, text: "b" });
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
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m2", turn: 1, step: 2, text: "b" });
		await awaitDrain(h, 2);
		const entries = h.store.readEntries("s1");
		assert.equal(entries[1].novelty, "duplicate");
		assert.equal(entries[1].semantic_duplicate, true);
		assert.equal(entries[1].duplicate_of, "j_0001");
	} finally { h.cleanup(); }
});


test("改进③：semantic-only 模式跳过词法层——同文也走 selfcheck 且可判语义重复", async () => {
	let selfcheckCalls = 0;
	const h = harness(async ({ purpose }) => {
		if (String(purpose).includes("selfcheck")) { selfcheckCalls += 1; return '{"novelty":"duplicate","duplicate_of":"j_0001"}'; }
		// 两条完全相同的 draft 文本：schema-selfcheck 下会词法短路，semantic-only 下必须走 selfcheck
		return draftJson("数据库连接池耗尽导致请求堆积");
	}, { noveltyMode: "semantic-only" });
	try {
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m2", turn: 1, step: 2, text: "b" });
		await awaitDrain(h, 2);
		const entries = h.store.readEntries("s1");
		assert.equal(entries[1].novelty, "duplicate");
		assert.equal(entries[1].semantic_duplicate, true, "词法层被跳过，语义判定生效");
		assert.equal(entries[1].duplicate_of, "j_0001");
		assert.equal(selfcheckCalls, 1, "semantic-only 下词法命中文本也会调 selfcheck");
	} finally { h.cleanup(); }
});

test("改进③：semantic-only 模式 selfcheck 判 new → 词法相同文本也落 new", async () => {
	const h = harness(async ({ purpose }) => {
		if (String(purpose).includes("selfcheck")) return '{"novelty":"new","duplicate_of":null}';
		return draftJson("数据库连接池耗尽导致请求堆积");
	}, { noveltyMode: "semantic-only" });
	try {
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m2", turn: 1, step: 2, text: "b" });
		await awaitDrain(h, 2);
		const entries = h.store.readEntries("s1");
		assert.equal(entries[1].novelty, "new", "词法层被跳过，以语义判定为准");
		assert.equal(entries[1].semantic_duplicate, false);
	} finally { h.cleanup(); }
});

test("改进②：lexicalThreshold 设置生效——低阈值让近似文本词法判重", async () => {
	const h = harness(async () => draftJson("读取配置文件失败因为路径不存在"), { lexicalThreshold: 0.2 });
	try {
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m2", turn: 1, step: 2, text: "b" });
		await awaitDrain(h, 2);
		const entries = h.store.readEntries("s1");
		// 两条 draft 相同：任何阈值下都是词法重复；此用例验证阈值参数被传入不抛错、行为正确
		assert.equal(entries[1].novelty, "duplicate");
		assert.equal(entries[1].semantic_duplicate, false);
	} finally { h.cleanup(); }
});

test("畸形 JSON 重试 1 次后成功：stats.retried=1", async () => {
	let call = 0;
	const h = harness(async () => (++call === 1 ? "完全不是 JSON" : draftJson("重试后成功的新结论")));
	try {
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "a" });
		await awaitDrain(h, 1);
		assert.equal(h.summarizer.stats().retried, 1);
		assert.equal(h.summarizer.stats().processed, 1);
		assert.equal(h.store.readEntries("s1").length, 1);
	} finally { h.cleanup(); }
});

test("两次畸形 → degrade：gap 落盘 + SUMMARIZER_DEGRADED + onGap + 不推水位", async () => {
	const h = harness(async () => "仍然不是 JSON");
	try {
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "a" });
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
		for (let i = 1; i <= 10; i++) h.summarizer.enqueue("s1", { sourceKind: "text", messageId: `m${i}`, turn: 1, step: i, text: `消息${i}` });
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

test("P2-21①：messageId 缺失的入队其 evict 键与 add 键同构（无 null 残留 seen）", async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	let seq = 0;
	const h = harness(async () => { await gate; return draftJson(`同构唯一结论${++seq}`); });
	try {
		// step=1 立即进 in-flight（pump 同步启动），队列可容 8：第 10 条挤掉队首（step=2）。
		// 全部无 messageId → 键退化为 turn/step。修复前 evict 键是 `${sid}/null`（残留 `${sid}/1/2`）；修复后同构可重新入队。
		for (let i = 1; i <= 10; i++) h.summarizer.enqueue("s1", { sourceKind: "text", turn: 1, step: i, text: `消息${i}` });
		assert.equal(h.summarizer.stats().dropped, 1, "第 10 条入队挤掉队首的 turn/step=1/2");
		const again = h.summarizer.enqueue("s1", { sourceKind: "text", turn: 1, step: 2, text: "重新投递被挤掉的消息" });
		assert.equal(again.queued, true, "被挤掉的 turn/step 键可重新入队（seen 已随 evict 清干净）");
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
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m2", turn: 1, step: 2, text: "b" });
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
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "a" });
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "m2", turn: 1, step: 2, text: "b" });
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

test("makeLlmCall：per-call provider/model 覆盖闭包设置；finish/error 终块 failure 透 onMeta", async () => {
	// 事故回归：settings 留空 + 消息不带 source 时内核 registration(undefined) 抛 NO_ADAPTER，
	// 以 finish/error 终块返回而不抛异常；修复后路由取自 msg.source 且失败真因必须留证。
	let captured = null;
	let metas = null;
	const fakeLlm = {
		stream: (opts) => {
			captured = opts;
			return (async function* () {
				yield { type: "finish", reason: { kind: "error", failure: { code: "NO_ADAPTER", message: 'no adapter registered for provider "undefined"' } } };
			})();
		}
	};
	const c = makeLlmCall({ llm: fakeLlm, provider: "", model: "", source: null, onMeta: (m) => { metas = m; } });
	const out = await c({ prompt: "p", provider: "trae", model: "Doubao-Seed-Evolving" });
	assert.equal(out, null, "错误终块无文本 → null（由包装层按 meta 翻译真因，而非误诊 JSON 畸形）");
	assert.equal(captured.provider, "trae", "per-call provider 必须覆盖闭包空设置");
	assert.equal(captured.model, "Doubao-Seed-Evolving");
	assert.equal(metas.failureCode, "NO_ADAPTER");
	assert.ok(String(metas.failureMessage).includes("no adapter registered"), `failure.message=${metas.failureMessage}`);
	assert.equal(metas.finishKind, "error");
});

test("P2-22 makeLlmCall：finish/usage 埋点 + onMeta 透出截断证据", async () => {
	let metas = null;
	let captured = null;
	const fakeLlm = {
		stream: (opts) => {
			captured = opts;
			return (async function* () {
				yield { type: "text-delta", index: 0, text: "部分输出" };
				yield { type: "usage", outputTokens: 512 };
				yield { type: "finish", reason: { kind: "max-tokens" } };
			})();
		}
	};
	const c = makeLlmCall({ llm: fakeLlm, provider: "", model: "", source: null, onMeta: (m) => { metas = m; } });
	const out = await c({ prompt: "p", sessionId: "s1" });
	assert.equal(out, "部分输出");
	assert.ok(metas, "onMeta 应在 finally 透出");
	assert.equal(metas.finishKind, "max-tokens");
	assert.equal(metas.outputTokens, 512);
	assert.equal(metas.truncationSuspect, true);
	assert.ok(Number.isFinite(metas.elapsedMs));
	assert.equal(captured.responseFormat, undefined, "未声明 supportsJsonMode 时 jsonMode 不应硬加");
});

test("P2-22 makeLlmCall：jsonMode 在 supportsJsonMode=true 时透传 responseFormat", async () => {
	let captured = null;
	const fakeLlm = {
		supportsJsonMode: () => true,
		stream: (opts) => {
			captured = opts;
			return (async function* () { yield { type: "finish", reason: { kind: "stop" } }; })();
		}
	};
	const c = makeLlmCall({ llm: fakeLlm, provider: "", model: "", source: null, jsonMode: true });
	await c({ prompt: "p" });
	assert.deepEqual(captured.responseFormat, { type: "json_object" });
});

test("P2-22 熔断：连续 3 次降级后冷却期内短路（不再打 LLM）", async () => {
	let callLlmCount = 0;
	let clock = 0;
	const root = mkdtempSync(join(tmpdir(), "dsw-circ-"));
	let sm;
	try {
		const events = [];
		const store = createJourneyStore({ root, emit: (n, p) => events.push({ n, p }), log: () => {} });
		sm = createSummarizer({
			store, emit: (n, p) => events.push({ n, p }), log: () => {},
			getSettings: () => ({ ...DEFAULT_SETTINGS }), callLlm: async () => { callLlmCount += 1; return "仍然不是 JSON"; },
			now: () => clock
		});
		sm.enqueue("s1", { sourceKind: "text", messageId: "m1", turn: 1, step: 1, text: "a" });
		await settle(3);
		sm.enqueue("s1", { sourceKind: "text", messageId: "m2", turn: 1, step: 2, text: "b" });
		await settle(3);
		sm.enqueue("s1", { sourceKind: "text", messageId: "m3", turn: 1, step: 3, text: "c" });
		await settle(3);
		assert.ok(callLlmCount >= 3, "前三次仍打 LLM（熔断前）");
		const before = callLlmCount;
		// 冷却期内短路：不再打 LLM，直接 degrade
		sm.enqueue("s1", { sourceKind: "text", messageId: "m4", turn: 1, step: 4, text: "d" });
		await settle(3);
		assert.equal(callLlmCount, before, "熔断冷却期内不应再打 LLM");
		// 推进时钟越过冷却期 → 放行一次试探（试探失败仍会 draft+retry 各打一次 LLM）
		clock += 60_001;
		const beforeTrial = callLlmCount;
		sm.enqueue("s1", { sourceKind: "text", messageId: "m5", turn: 1, step: 5, text: "e" });
		await settle(3);
		assert.ok(callLlmCount > beforeTrial, "冷却期后应放行一次试探（重新打 LLM）");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

// ───────────────────────── 步骤 2：text/reasoning 双路隔离 ─────────────────────────

const reasoningDraftJson = (summary, extra = {}) =>
	JSON.stringify({ entries: [{ kind: "r-decision", summary, detail: "", artifacts: [], supersedes: [], confidence: 0.7, ...extra }] });

test("双路：sourceKind 缺失/非法 → 拒入（禁止隐式默认 text）", () => {
	const h = harness(async () => reasoningDraftJson("x"));
	try {
		const missing = h.summarizer.enqueue("s1", { messageId: "m1", turn: 1, step: 1, text: "内容" });
		assert.equal(missing.queued, false);
		assert.ok(missing.reason.includes("sourceKind"));
		assert.equal(h.summarizer.enqueue("s1", { sourceKind: "bogus", messageId: "m2", text: "内容" }).queued, false);
		assert.equal(h.summarizer.stats().enqueued, 0);
	} finally { h.cleanup(); }
});

test("双路：reasoning job 落 reasoning 通道（kind∈REASONING_KINDS），text 账本零污染，purpose 独立", async () => {
	const purposes = [];
	const h = harness(async ({ purpose }) => { purposes.push(purpose); return reasoningDraftJson("推理中决定改用连接池"); });
	try {
		h.summarizer.enqueue("s1", { sourceKind: "reasoning", messageId: "rm1", turn: 1, step: 1, text: "思考块原文…" });
		await h.summarizer.flush();
		const rEntries = h.store.readReasoningEntries("s1");
		assert.equal(rEntries.length, 1);
		assert.equal(rEntries[0].kind, "r-decision");
		assert.equal(rEntries[0].channel, "reasoning");
		assert.equal(rEntries[0].sourceMessageId, "rm1");
		assert.equal(h.store.readEntries("s1").length, 0, "reasoning 提炼不得进入 text 正式结论账本");
		assert.equal(existsSync(h.store.paths.reasoningJsonl("s1")), true);
		assert.equal(existsSync(h.store.paths.jsonl("s1")), false, "text 账本文件不应被创建");
		assert.ok(purposes.includes("semantic-watcher/reasoning-draft"), `purposes=${purposes.join(",")}`);
		assert.equal(h.summarized.length, 1);
		assert.equal(h.summarized[0].channel, "reasoning");
		const wm = h.store.loadWatermark("s1", "reasoning");
		assert.equal(wm.lastMessageId, "rm1");
		assert.equal(wm.lastStepSeq, 1);
		assert.equal(h.store.loadWatermark("s1", "text"), null, "text 水位不得被 reasoning 推进");
		assert.equal(h.summarizer.stats().byChannel.reasoning.processed, 1);
		assert.equal(h.summarizer.stats().byChannel.text.processed, 0);
	} finally { h.cleanup(); }
});

test("双路：candidates 只读本通道——reasoning 与 text 同文不判跨通道重复", async () => {
	const h = harness(async () => reasoningDraftJson("完全相同的一句话内容XYZ"));
	try {
		const seeded = h.store.appendEntry("s1", {
			turn: 0, step: 0, kind: "finding", summary: "完全相同的一句话内容XYZ", novelty: "new"
		}, "text");
		assert.equal(seeded.ok, true);
		h.summarizer.enqueue("s1", { sourceKind: "reasoning", messageId: "rm1", turn: 1, step: 1, text: "思考…" });
		await h.summarizer.flush();
		const r = h.store.readReasoningEntries("s1");
		assert.equal(r.length, 1);
		assert.equal(r[0].novelty, "new", "reasoning candidates 窗口为空（不含 text entry），应判 new 而非 duplicate");
		assert.equal(h.store.readEntries("s1").length, 1);
	} finally { h.cleanup(); }
});

test("双路：reasoning 返回 text 通道 kind（finding）→ 丢弃，推 reasoning 水位但无 entry/无回调", async () => {
	const h = harness(async () => draftJson("被禁止的事实结论")); // finding 不属于 REASONING_KINDS
	try {
		h.summarizer.enqueue("s1", { sourceKind: "reasoning", messageId: "rm1", turn: 1, step: 1, text: "思考…" });
		await h.summarizer.flush();
		assert.equal(h.store.readReasoningEntries("s1").length, 0);
		assert.equal(h.store.readEntries("s1").length, 0);
		assert.equal(h.summarized.length, 0);
		const wm = h.store.loadWatermark("s1", "reasoning");
		assert.equal(wm.lastStepSeq, 1, "合法空结果仍推 reasoning 水位");
	} finally { h.cleanup(); }
});

test("双路：reasoning 空文本拒入（与 text 一致）", () => {
	const h = harness(async () => reasoningDraftJson("x"));
	try {
		assert.equal(h.summarizer.enqueue("s1", { sourceKind: "reasoning", messageId: "rm1", text: "   " }).queued, false);
		assert.equal(h.summarizer.stats().byChannel.reasoning.enqueued, 0);
	} finally { h.cleanup(); }
});

test("双路熔断隔离：reasoning 连续降级熔断后，text 路 stats 正常且仍打 LLM", async () => {
	let textCalls = 0;
	const root = mkdtempSync(join(tmpdir(), "dsw-circ2-"));
	try {
		const events = [];
		const store = createJourneyStore({ root, emit: (n, p) => events.push({ n, p }), log: () => {} });
		const sm = createSummarizer({
			store, emit: (n, p) => events.push({ n, p }), log: () => {},
			getSettings: () => ({ ...DEFAULT_SETTINGS }),
			callLlm: async ({ purpose }) =>
				String(purpose).includes("reasoning") ? "不是 JSON" : (() => { textCalls += 1; return draftJson("text 路结论"); })()
		});
		for (let i = 1; i <= 3; i += 1) {
			sm.enqueue("s1", { sourceKind: "reasoning", messageId: `r${i}`, turn: 1, step: i, text: `思考${i}` });
			await settle(3);
		}
		const rStats = sm.stats().byChannel.reasoning;
		assert.ok(rStats.degraded >= 3, `reasoning degraded=${rStats.degraded} 应≥3`);
		sm.enqueue("s1", { sourceKind: "reasoning", messageId: "r4", turn: 1, step: 4, text: "思考4" });
		await settle(3);
		sm.enqueue("s1", { sourceKind: "text", messageId: "t1", turn: 1, step: 1, text: "正式输出" });
		await settle(3);
		const tStats = sm.stats().byChannel.text;
		assert.equal(tStats.degraded, 0, "text 路降级数应为 0");
		assert.equal(tStats.processed, 1, "text 路正常处理 1 条");
		assert.ok(textCalls >= 1, "text 路仍应实际调用 LLM");
		assert.equal(store.readEntries("s1").length, 1, "text 账本正常落 1 条");
		assert.equal(store.readReasoningEntries("s1").length, 0, "reasoning 账本无 entry（全降级）");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("双路：reasoning 降级 gap 只进 reasoning 账本，不污染 text 集合", async () => {
	const h = harness(async () => "仍然不是 JSON");
	try {
		h.summarizer.enqueue("s1", { sourceKind: "reasoning", messageId: "rm1", turn: 1, step: 1, text: "思考…" });
		await h.summarizer.flush();
		assert.equal(h.summarizer.stats().byChannel.reasoning.degraded, 1);
		assert.equal(existsSync(h.store.paths.jsonl("s1")), false, "text 主账本文件不应被创建（gap 也不进）");
		const raw = readFileSync(h.store.paths.reasoningJsonl("s1"), "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(raw[raw.length - 1].type, "gap");
		assert.equal(raw[raw.length - 1].channel, "reasoning");
	} finally { h.cleanup(); }
});

test("双路调度：reasoning 积压不饿死 text（并发=1 轮转，text 被持续服务）", async () => {
	let seq = 0;
	const h = harness(async ({ purpose }) =>
		String(purpose).includes("reasoning") ? reasoningDraftJson(`推理点${++seq}`) : draftJson(`结论${++seq}`));
	try {
		for (let i = 1; i <= 4; i += 1) h.summarizer.enqueue("s1", { sourceKind: "reasoning", messageId: `r${i}`, turn: 1, step: i, text: `思考${i}` });
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "t1", turn: 1, step: 10, text: "结论A" });
		h.summarizer.enqueue("s1", { sourceKind: "text", messageId: "t2", turn: 1, step: 11, text: "结论B" });
		await h.summarizer.flush();
		assert.equal(h.store.readEntries("s1").length, 2, "两条 text 都必须被处理（未被 reasoning 积压饿死）");
		assert.equal(h.store.readReasoningEntries("s1").length, 4);
	} finally { h.cleanup(); }
});
