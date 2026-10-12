/**
 * P3 stall 状态机单测（§5.5/§2.2/§7.3）：计数、gap 暂停、词法/语义背离、重置边界、
 * 阈值倒挂由 settings 层测、L2 denyToolCategory/rejectStep 契约、fail-open。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStallController } from "../lib/stall.js";
import { EVT } from "../lib/events.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function harness(overrides = {}) {
	const events = [];
	const controller = createStallController({
		emit: (n, p) => events.push({ n, p }),
		log: () => {},
		getSettings: () => ({ ...DEFAULT_SETTINGS, ...(overrides.settings ?? {}) }),
		getL2: overrides.getL2 ?? null,
		writeHandoff: overrides.writeHandoff ?? null
	});
	return { events, controller };
}

const lexDup = (step) => ({ id: `j_${String(step).padStart(4, "0")}`, turn: 1, step, novelty: "duplicate", semantic_duplicate: false, duplicate_of: "j_0001" });
const semDup = (step) => ({ id: `j_${String(step).padStart(4, "0")}`, turn: 1, step, novelty: "duplicate", semantic_duplicate: true, duplicate_of: "j_0001" });
const newEntry = (step) => ({ id: `j_${String(step).padStart(4, "0")}`, turn: 1, step, novelty: "new", semantic_duplicate: false, duplicate_of: null });
const stalls = (events) => events.filter((e) => e.n === EVT.STALL);
const unavailable = (events) => events.filter((e) => e.n === EVT.EXECUTION_UNAVAILABLE);

test("纯词法 duplicate 只记账 + lexical-repeat，不升级", () => {
	const { events, controller } = harness();
	const r = controller.onEntries("s1", [lexDup(1), lexDup(2), lexDup(3)]);
	assert.equal(events.filter((e) => e.n === EVT.LEXICAL_REPEAT).length, 3);
	assert.equal(stalls(events).length, 0, "t1=3 但纯词法不计入升级");
	assert.equal(r.level, 0);
	assert.equal(controller.getSnapshot("s1").stallCount, 3);
});

test("语义 duplicate 达 t1 → stall level=1 事件一次", () => {
	const { events, controller } = harness();
	const r = controller.onEntries("s1", [semDup(1), semDup(2), semDup(3)]);
	assert.equal(r.level, 1);
	assert.ok(r.warningText.includes("stall-1"));
	assert.ok(r.escalated);
	const s = stalls(events);
	assert.equal(s.length, 1);
	assert.equal(s[0].p.level, 1);
	assert.equal(s[0].p.evidenceSeq, 1);
	assert.equal(s[0].p.code, null);
	// 第 4 条重复：已 actioned，不再发
	controller.onEntries("s1", [semDup(4)]);
	assert.equal(stalls(events).length, 1);
});

test("语义 duplicate 达 t2 → level=2 + L2 denyToolCategory(read, semantic-stall-2, ttl=4)", async () => {
	const denyCalls = [];
	const { events, controller } = harness({
		settings: { enableStall2Deny: true },
		getL2: () => ({ denyToolCategory: async (...args) => { denyCalls.push(args); return { accepted: true, expiresAtStep: 99 }; } })
	});
	controller.onEntries("s1", [semDup(1), semDup(2), semDup(3)]); // level 1
	const r = controller.onEntries("s1", [semDup(4), semDup(5), semDup(6)]); // level 2
	assert.equal(r.level, 2);
	const s = stalls(events).map((e) => e.p);
	assert.equal(s[1].level, 2);
	assert.equal(s[1].code, "semantic-stall-2");
	await settle();
	assert.equal(denyCalls.length, 1);
	assert.equal(denyCalls[0][0], "s1");
	assert.equal(denyCalls[0][1], "read");
	assert.equal(denyCalls[0][2].code, "semantic-stall-2");
	assert.equal(denyCalls[0][2].ttlSteps, 4, "ttl = stall3-stall2 = 10-6");
	assert.equal(denyCalls[0][2].evidenceSeq, 2);
	assert.equal(unavailable(events).length, 0, "L2 正常受理不降级");
});

test("enableStall2Deny=false：level=2 只注入不发 deny", async () => {
	const denyCalls = [];
	const { events, controller } = harness({
		settings: { enableStall2Deny: false },
		getL2: () => ({ denyToolCategory: async (...a) => { denyCalls.push(a); return { accepted: true }; } })
	});
	controller.onEntries("s1", [semDup(1), semDup(2), semDup(3)]);
	controller.onEntries("s1", [semDup(4), semDup(5), semDup(6)]);
	await settle();
	assert.equal(denyCalls.length, 0);
	assert.equal(unavailable(events).length, 0);
});

test("L2 denyToolCategory 抛异常 → fail-open + execution-unavailable", async () => {
	const { events, controller } = harness({
		settings: { enableStall2Deny: true },
		getL2: () => ({ denyToolCategory: async () => { throw new Error("governor down"); } })
	});
	controller.onEntries("s1", [semDup(1), semDup(2), semDup(3)]);
	controller.onEntries("s1", [semDup(4), semDup(5), semDup(6)]);
	await settle();
	const u = unavailable(events);
	assert.equal(u.length, 1);
	assert.ok(u[0].p.suppressReason.includes("denyToolCategory"));
});

test("L2 未就绪（getL2=null）→ level=2 fail-open 降级仅注入", async () => {
	const { events, controller } = harness({ settings: { enableStall2Deny: true } });
	controller.onEntries("s1", [semDup(1), semDup(2), semDup(3)]);
	controller.onEntries("s1", [semDup(4), semDup(5), semDup(6)]);
	await settle();
	assert.ok(unavailable(events)[0].p.suppressReason.includes("未就绪"));
});

test("语义 duplicate 达 t3 → level=3 + writeHandoff + handoff-written；enableStall3Reject 默认 false 不调 rejectStep", async () => {
	const handoffCalls = [];
	const { events, controller } = harness({
		writeHandoff: async (sid, meta) => { handoffCalls.push({ sid, ...meta }); return { path: "h.md", seedPath: "s.json" }; }
	});
	const r = controller.onEntries("s1", [
		semDup(1), semDup(2), semDup(3), semDup(4), semDup(5), semDup(6),
		semDup(7), semDup(8), semDup(9), semDup(10)
	]);
	assert.equal(r.level, 3);
	await settle();
	assert.equal(handoffCalls.length, 1);
	assert.equal(handoffCalls[0].evidenceSeq, 3, "evidenceSeq 随 level1/2/3 递增");
	const hw = events.filter((e) => e.n === EVT.HANDOFF_WRITTEN);
	assert.equal(hw.length, 1);
	assert.equal(hw[0].p.path, "h.md");
	assert.equal(hw[0].p.seedPath, "s.json");
	const s = stalls(events).map((e) => e.p);
	assert.equal(s[2].code, "semantic-stall");
	assert.equal(events.some((e) => e.n === EVT.EXECUTION_UNAVAILABLE), false, "默认只告警，无 rejectStep 调用也就无降级");
});

test("enableStall3Reject=true → rejectStep(sessionId, {code:'semantic-stall', evidenceSeq})", async () => {
	const rejectCalls = [];
	const { controller } = harness({
		settings: { enableStall3Reject: true },
		getL2: () => ({ rejectStep: async (...args) => { rejectCalls.push(args); return { accepted: false, pending: true }; } }),
		writeHandoff: async () => ({ path: "h.md", seedPath: null })
	});
	controller.onEntries("s1", [semDup(1), semDup(2), semDup(3)]);
	controller.onEntries("s1", [semDup(4), semDup(5), semDup(6)]);
	controller.onEntries("s1", [semDup(7), semDup(8), semDup(9), semDup(10)]);
	await settle();
	assert.equal(rejectCalls.length, 1);
	assert.equal(rejectCalls[0][0], "s1");
	assert.equal(rejectCalls[0][1].code, "semantic-stall");
	assert.equal(typeof rejectCalls[0][1].evidenceSeq, "number");
});

test("rejectStep 异常 → fail-open execution-unavailable", async () => {
	const { events, controller } = harness({
		settings: { enableStall3Reject: true },
		getL2: () => ({ rejectStep: async () => { throw new Error("down"); } }),
		writeHandoff: async () => ({ path: "h.md", seedPath: null })
	});
	controller.onEntries("s1", [semDup(1), semDup(2), semDup(3)]);
	controller.onEntries("s1", [semDup(4), semDup(5), semDup(6)]);
	controller.onEntries("s1", [semDup(7), semDup(8), semDup(9), semDup(10)]);
	await settle();
	assert.ok(unavailable(events).some((e) => e.p.suppressReason.includes("rejectStep")));
});

test("writeHandoff 缺失 → stall-3 降级仅告警（execution-unavailable）", async () => {
	const { events, controller } = harness({});
	controller.onEntries("s1", [semDup(1), semDup(2), semDup(3)]);
	controller.onEntries("s1", [semDup(4), semDup(5), semDup(6)]);
	controller.onEntries("s1", [semDup(7), semDup(8), semDup(9), semDup(10)]);
	await settle();
	assert.ok(unavailable(events).some((e) => e.p.suppressReason.includes("writeHandoff")));
});

test("gap：连续 3 记 degraded 但不再冻结暂停（P0-8）；gap 期间 duplicate 正常升级；new 归零", () => {
	const { events, controller } = harness();
	assert.equal(controller.onGap("s1", { turn: 1, step: 1 }).consecutiveGap, 1);
	controller.onGap("s1", { turn: 1, step: 2 });
	const r3 = controller.onGap("s1", { turn: 1, step: 3 });
	assert.equal(r3.consecutiveGap, 3);
	assert.equal(r3.paused, false, "P0-8：gap 不再置 paused");
	const dg = events.filter((e) => e.n === EVT.SUMMARIZER_DEGRADED);
	assert.equal(dg.length, 1);
	assert.ok(dg[0].p.suppressReason.includes("gap"));
	assert.ok(!dg[0].p.suppressReason.includes("暂停"), "degraded 文案不再称暂停");
	assert.equal(controller.onGap("s1", {}).consecutiveGap, 4, "连续 gap 继续计数");
	assert.equal(events.filter((e) => e.n === EVT.SUMMARIZER_DEGRADED).length, 1, "仅触发一次 degraded");
	// gap 期 duplicate 不冻结：正常升级到 level 1
	const r = controller.onEntries("s1", [semDup(4), semDup(5), semDup(6)]);
	assert.equal(r.level, 1, "gap 期间语义 duplicate 仍正常升级");
	assert.equal(stalls(events).length, 1);
	// new → 计数归零
	controller.onEntries("s1", [newEntry(5)]);
	assert.equal(controller.getSnapshot("s1").stallCount, 0);
	assert.equal(controller.getSnapshot("s1").consecutiveGap, 0);
});

test("P0-8：onObservation 连续 K 个无 text/产物 step 且墙钟跨 T → stall-1（窗口计时可注入，禁真实 sleep）", () => {
	let clocks = 0;
	const controlledNow = () => 1_700_000_000_000 + clocks * 1000; // 每 tick 前进 1 秒
	const controller = createStallController({
		emit: () => {},
		log: () => {},
		getSettings: () => ({ ...DEFAULT_SETTINGS, stallWatchSteps: 3, stallWatchWindowSec: 300 }),
		now: controlledNow
	});
	const barren = (step) => ({ turn: 1, step, ts: controlledNow(), hasText: false, textLen: 0, reasoningLen: 0, hasArtifact: false });
	// 3 个 barren step（无 text/产物），墙钟跨度不足 300s → 不触发
	controller.onObservation("s1", barren(1)); clocks += 1;
	controller.onObservation("s1", barren(2)); clocks += 1;
	const early = controller.onObservation("s1", barren(3)); clocks += 299;
	assert.equal(early.level, 0, "墙钟未达 T 不触发");
	// 再推墙钟到 ≥300s 跨度 → 触发 stall-1
	clocks += 300;
	const fired = controller.onObservation("s1", barren(4));
	assert.equal(fired.level, 1);
	assert.equal(fired.fired, true);
	// 幂等：同窗口内不再重复发（wall-clock 判定已 fired）
	clocks += 10;
	const again = controller.onObservation("s1", barren(5));
	assert.equal(again.level, 0);
	// 有产出 step → 窗口复位，可重新累计（barren 重新从 0 计）
	clocks += 1;
	controller.onObservation("s1", { turn: 1, step: 6, ts: controlledNow(), hasText: true, textLen: 20, reasoningLen: 0, hasArtifact: false });
	// 复位后重新累计 3 个 barren 且跨度 ≥300s → 再次触发
	const b7 = barren(7); clocks += 300; controller.onObservation("s1", b7);
	const b8 = barren(8); clocks += 300; controller.onObservation("s1", b8);
	clocks += 300;
	const refired = controller.onObservation("s1", barren(9));
	assert.equal(refired.level, 1, "产出复位后重新累计可再次触发");
});

test("P0-8：reasoning-only step（无 text 无产物但 reasoningLen>0）不算 barren，不清窗口、不触发 stall-1", () => {
	const controller = createStallController({
		emit: () => {},
		log: () => {},
		getSettings: () => ({ ...DEFAULT_SETTINGS, stallWatchSteps: 2, stallWatchWindowSec: 60 }),
		now: () => 1_700_000_000_000
	});
	// reasoning-only：有 reasoning 输出 → 活跃，不清 barren 窗口
	controller.onObservation("s1", { turn: 1, step: 1, ts: 1_700_000_001_000, hasText: false, textLen: 0, reasoningLen: 240, hasArtifact: false });
	// 含 text 的 step 也活跃
	controller.onObservation("s1", { turn: 1, step: 2, ts: 1_700_000_002_000, hasText: true, textLen: 10, reasoningLen: 0, hasArtifact: false });
	// 纯产物 step 活跃
	controller.onObservation("s1", { turn: 1, step: 3, ts: 1_700_000_003_000, hasText: false, textLen: 0, reasoningLen: 0, hasArtifact: true });
	// 连续 2 个纯 barren（无 text/产物/reasoning），但墙钟跨度不足 60s → 不触发
	controller.onObservation("s1", { turn: 1, step: 4, ts: 1_700_000_004_000, hasText: false, textLen: 0, reasoningLen: 0, hasArtifact: false });
	controller.onObservation("s1", { turn: 1, step: 5, ts: 1_700_000_005_000, hasText: false, textLen: 0, reasoningLen: 0, hasArtifact: false });
	// 此时 runCount=2 (=K) 但跨度仅 1s(<T) → 不触发
	const r = controller.onObservation("s1", { turn: 1, step: 6, ts: 1_700_000_006_000, hasText: false, textLen: 0, reasoningLen: 0, hasArtifact: false });
	assert.equal(r.level, 0);
});

test("new 归零但级动作状态不清：1+3+3 次重复只升一次 level1", () => {
	const { events, controller } = harness();
	controller.onEntries("s1", [semDup(1), semDup(2)]); // count 2
	controller.onEntries("s1", [newEntry(3)]); // 归零，actioned[1] 仍 false
	controller.onEntries("s1", [semDup(4), semDup(5), semDup(6)]); // count 3 → level 1
	assert.equal(stalls(events).length, 1);
	// actioned[1]=true 后再凑 3 条也不重复发
	controller.onEntries("s1", [newEntry(7)]);
	controller.onEntries("s1", [semDup(8), semDup(9), semDup(10)]);
	assert.equal(stalls(events).length, 1);
});

test("真人 user 消息归零并清级动作状态", () => {
	const { events, controller } = harness();
	controller.onEntries("s1", [semDup(1), semDup(2), semDup(3)]); // level 1 actioned
	assert.equal(controller.getSnapshot("s1").actioned[1], true);
	controller.onUserMessage("s1");
	const st = controller.getSnapshot("s1");
	assert.equal(st.stallCount, 0);
	assert.equal(st.actioned[1], false);
	assert.equal(st.lastLevel, 0);
	// 清级后再次达到阈值 → 重新升级
	controller.onEntries("s1", [semDup(4), semDup(5), semDup(6)]);
	assert.equal(stalls(events).length, 2);
});

test("turn 边界不归零（onEntries 连续跨 turn 计数持续）", () => {
	const { controller } = harness();
	controller.onEntries("s1", [semDup(1), { ...semDup(2), turn: 2 }]);
	assert.equal(controller.getSnapshot("s1").stallCount, 2);
});

test("阈值设置非法回退 3/6/10；倒挂由 settings 层拒绝，这里容忍回退", () => {
	const { controller } = harness({ settings: { stall1Steps: "abc", stall2Steps: NaN, stall3Steps: undefined } });
	assert.deepEqual(controller.thresholds(), { t1: 3, t2: 6, t3: 10 });
});

test("onUserMessage 后 gap 计数也清零", () => {
	const { controller } = harness();
	controller.onGap("s1", {});
	controller.onGap("s1", {});
	controller.onUserMessage("s1");
	assert.equal(controller.getSnapshot("s1").consecutiveGap, 0);
	assert.equal(controller.getSnapshot("s1").paused, false);
});
