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

test("gap：不增不减；连续 3 → summarizer-degraded + 停滞暂停；暂停期间 duplicate 不升级；new 恢复", () => {
	const { events, controller } = harness();
	assert.equal(controller.onGap("s1", { turn: 1, step: 1 }).consecutiveGap, 1);
	controller.onGap("s1", { turn: 1, step: 2 });
	const r3 = controller.onGap("s1", { turn: 1, step: 3 });
	assert.equal(r3.paused, true);
	const dg = events.filter((e) => e.n === EVT.SUMMARIZER_DEGRADED);
	assert.equal(dg.length, 1);
	assert.ok(dg[0].p.suppressReason.includes("gap"));
	assert.equal(controller.onGap("s1", {}).consecutiveGap, 4, "第 4 次 gap 不再重复发事件");
	assert.equal(events.filter((e) => e.n === EVT.SUMMARIZER_DEGRADED).length, 1);
	// 暂停期间语义 duplicate：不升级
	const r = controller.onEntries("s1", [semDup(4)]);
	assert.equal(r.level, 0);
	assert.equal(r.paused, true);
	assert.equal(stalls(events).length, 0);
	// new → 解除暂停、计数归零
	controller.onEntries("s1", [newEntry(5)]);
	assert.equal(controller.getSnapshot("s1").paused, false);
	assert.equal(controller.getSnapshot("s1").stallCount, 0);
	assert.equal(controller.getSnapshot("s1").consecutiveGap, 0);
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
