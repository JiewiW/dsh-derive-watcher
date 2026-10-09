/**
 * P2 fold 单测（§5.3/§7.3）：折叠阈值、保护界、里程碑落账、归档、dead-end 零丢失、
 * supersedes 链跨折叠保留、蒸馏失败 fail-open、retention 清理事件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFold, FOLD_SYSTEM_PROMPT, buildFoldPrompt, extractMilestones } from "../lib/fold.js";
import { createJourneyStore } from "../lib/journey-store.js";
import { EVT } from "../lib/events.js";

const milestonesJson = (list) =>
	JSON.stringify({ milestones: list.map((m) => ({ kind: "finding", summary: m, detail: "合并细节", artifacts: [], ...{ kind: "finding" } })) });

function harness(callLlm) {
	const root = mkdtempSync(join(tmpdir(), "dsw-fold-"));
	const events = [];
	const store = createJourneyStore({ root, emit: (n, p) => events.push({ n, p }), log: () => {} });
	const fold = createFold({ store, emit: (n, p) => events.push({ n, p }), log: () => {}, callLlm });
	return { root, store, events, fold, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 造 n 条 entry：j_0002 是 plan（open objective），j_0005 是 dead-end，其余 finding。 */
function seedEntries(store, sid, n) {
	for (let i = 1; i <= n; i++) {
		const kind = i === 2 ? "plan" : i === 5 ? "dead-end" : "finding";
		store.appendEntry(sid, {
			turn: 1, step: i, sourceMessageId: `m${i}`, kind,
			summary: `第${i}步结论摘要，内容各不相同${"x".repeat(i)}`,
			detail: "", artifacts: [], supersedes: i === 3 ? ["ext-1"] : [], novelty: "new"
		});
	}
}

test("常量与 prompt 组装", () => {
	assert.ok(FOLD_SYSTEM_PROMPT.includes("里程碑"));
	assert.ok(buildFoldPrompt([{ id: "j_0001", kind: "finding", step: 1, supersedes: [], summary: "s", detail: "d" }]).includes("j_0001"));
	assert.equal(extractMilestones('{"milestones":[{"kind":"finding","summary":"m"}]}').length, 1);
	assert.equal(extractMilestones("不是 JSON").length, 0);
});

test("selectBatch：保护最近 recentN + 全部 dead-end + open objectives", () => {
	const { store, fold, cleanup } = harness(async () => milestonesJson(["里程碑一"]));
	try {
		seedEntries(store, "s1", 10);
		const entries = store.readEntries("s1");
		const batch = fold.selectBatch(entries, 4);
		const ids = new Set(batch.map((e) => e.id));
		assert.equal(batch.length, 4, "10 条 - 最近4 - plan(j_0002) - dead-end(j_0005) = 4");
		assert.ok(!ids.has("j_0007") && !ids.has("j_0008") && !ids.has("j_0009") && !ids.has("j_0010"), "最近 4 条受保护");
		assert.ok(!ids.has("j_0002"), "open objective（plan）受保护");
		assert.ok(!ids.has("j_0005"), "dead-end 受保护");
	} finally { cleanup(); }
});

test("maybeFold：未达阈值不折叠", async () => {
	const { store, fold, cleanup } = harness(async () => milestonesJson(["m"]));
	try {
		seedEntries(store, "s1", 12);
		const r = await fold.maybeFold("s1", { recentN: 4 });
		assert.equal(r.folded, false);
		assert.ok(r.reason.includes("未达"));
		assert.equal(store.readEntries("s1").length, 12);
	} finally { cleanup(); }
});

test("maybeFold 主流程：里程碑落账 + 归档 + dead-end 零丢失 + supersedes 链保留 + 事件", async () => {
	const { store, events, fold, cleanup } = harness(async () => milestonesJson(["里程碑甲", "里程碑乙"]));
	try {
		seedEntries(store, "s1", 13); // 13 > 4×3 触发
		const r = await fold.maybeFold("s1", { recentN: 4 });
		assert.equal(r.folded, true);
		assert.equal(r.milestoneIds.length, 2);
		// 保护界：最近4(j_0010..13) + plan(j_0002) + dead-end(j_0005) 之外 7 条被折叠
		assert.equal(r.foldedIds.length, 7);
		assert.ok(!r.foldedIds.includes("j_0005"), "dead-end 不被折叠");
		assert.ok(!r.foldedIds.includes("j_0002"), "open objective 不被折叠");
		// 主账本收缩
		const rest = store.readEntries("s1");
		assert.equal(rest.length, 6);
		assert.ok(rest.some((e) => e.kind === "dead-end"), "dead-end 零丢失");
		assert.ok(rest.some((e) => e.kind === "plan"), "open objective 不丢");
		// 里程碑账本
		const miles = store.readMilestones("s1");
		assert.equal(miles.length, 2);
		assert.equal(miles[0].milestone, true);
		assert.ok(miles[0].covers.includes(r.foldedIds[0]));
		assert.ok(miles[0].supersedes.includes("ext-1"), "supersedes 链跨折叠保留（排除 covers 内 id）");
		// 归档
		assert.equal(existsSync(r.archive), true);
		assert.equal(readFileSync(r.archive, "utf8").trim().split("\n").length, 7);
		// 事件
		const fm = events.find((e) => e.n === EVT.FOLD_MILESTONE);
		assert.ok(fm, "应发 fold-milestone");
		assert.equal(fm.p.archived, 7);
		assert.equal(fm.p.milestoneIds.length, 2);
	} finally { cleanup(); }
});

test("蒸馏失败（两次畸形 JSON）→ fail-open 保留原文不折叠", async () => {
	const { store, events, fold, cleanup } = harness(async () => "还是不是 JSON");
	try {
		seedEntries(store, "s1", 13);
		const r = await fold.maybeFold("s1", { recentN: 4 });
		assert.equal(r.folded, false);
		assert.ok(r.reason.includes("蒸馏失败"));
		assert.equal(store.readEntries("s1").length, 13, "原文零丢失");
		assert.equal(store.readMilestones("s1").length, 0);
		assert.equal(existsSync(store.paths.archiveDir), false);
		assert.equal(events.some((e) => e.n === EVT.FOLD_MILESTONE), false);
	} finally { cleanup(); }
});

test("retentionSweep：过期归档清理 + retention-cleaned 事件；第二次无删除", async () => {
	const { store, events, fold, cleanup } = harness(async () => milestonesJson(["m"]));
	try {
		seedEntries(store, "s1", 13);
		const r = await fold.maybeFold("s1", { recentN: 4 });
		assert.equal(r.folded, true);
		const old = new Date(Date.now() - 40 * 86400000);
		for (const f of readdirSync(store.paths.archiveDir)) utimesSync(join(store.paths.archiveDir, f), old, old);
		const removed = fold.retentionSweep(30);
		assert.equal(removed.length, 1);
		assert.ok(events.some((e) => e.n === EVT.RETENTION_CLEANED && e.p.count === 1));
		assert.equal(fold.retentionSweep(30).length, 0);
		// 里程碑与主账本不受清理影响（mock 蒸馏仅产 1 个里程碑）
		assert.equal(store.readMilestones("s1").length, 1);
		assert.ok(existsSync(store.paths.milestones("s1")));
	} finally { cleanup(); }
});

test("overBudget=true 绕过阈值直接尝试折叠", async () => {
	const { store, fold, cleanup } = harness(async () => milestonesJson(["m"]));
	try {
		seedEntries(store, "s1", 6);
		const r = await fold.maybeFold("s1", { recentN: 4, overBudget: true });
		assert.equal(r.folded, true);
	} finally { cleanup(); }
});
