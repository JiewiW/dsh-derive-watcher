/**
 * cot-anchor 软切接线单测（stall-2 分支）：requestSoftCut 调用形状、日志、
 * intervention 事件、fail-open 降级、与 denyToolCategory 的独立性。
 *
 * 覆盖场景：
 *  A enableStall2SoftCut=true + 服务就绪 → requestSoftCut 受理 → L2 soft-cut requested 日志 +
 *    intervention(action=soft-cut-request, accepted=true, code=semantic-stall-2, delivery=pending-next-soft-cut)；
 *  B 服务返回 accepted=false → 抛「软切未受理」→ execution-unavailable；
 *  C 服务缺失（getCotAnchor=null）→ execution-unavailable「cot-anchor 服务未就绪」；
 *  D 服务 requestSoftCut 抛异常 → execution-unavailable「requestSoftCut 不可用」；
 *  E entry.summary 作为 fullVisibleText 透传；非字符串/空串传 null；
 *  F 与 enableStall2Deny 相互独立、可同时开启（deny 与 soft-cut 各触发一次）；
 *  G enableStall2SoftCut=false → 不调 requestSoftCut；
 *  H st.actioned[2] 幂等：stall-2 后再次 duplicate 不重复请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStallController } from "../lib/stall.js";
import { EVT } from "../lib/events.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** 与 stall.test.js 同形的 harness，额外支持 getCotAnchor 注入。 */
function harness(overrides = {}) {
	const events = [];
	const logs = [];
	const controller = createStallController({
		emit: (n, p) => events.push({ n, p }),
		log: (line) => logs.push(line),
		getSettings: () => ({ ...DEFAULT_SETTINGS, ...(overrides.settings ?? {}) }),
		getL2: overrides.getL2 ?? null,
		getCotAnchor: overrides.getCotAnchor ?? null,
		writeHandoff: overrides.writeHandoff ?? null
	});
	return { events, logs, controller };
}

const semDup = (step) => ({ id: `j_${String(step).padStart(4, "0")}`, turn: 1, step, novelty: "duplicate", semantic_duplicate: true, duplicate_of: "j_0001", summary: `第 ${step} 条重复结论` });
const stalls = (events) => events.filter((e) => e.n === EVT.STALL);
const unavailable = (events) => events.filter((e) => e.n === EVT.EXECUTION_UNAVAILABLE);
const interventions = (events) => events.filter((e) => e.n === EVT.INTERVENTION);

/** 跑到 stall-2：默认阈值 t1=3/t2=6/t3=10，先 3 条升 level 1，再 3 条升 level 2。 */
const runToLevel2 = (controller, sessionId = "s1") => {
	controller.onEntries(sessionId, [semDup(1), semDup(2), semDup(3)]);
	return controller.onEntries(sessionId, [semDup(4), semDup(5), semDup(6)]);
};

test("A：enableStall2SoftCut + 服务就绪 → requestSoftCut 受理 + intervention(soft-cut-request)", async () => {
	const calls = [];
	const { events, logs, controller } = harness({
		settings: { enableStall2SoftCut: true },
		getCotAnchor: () => ({
			requestSoftCut: async (payload) => {
				calls.push(payload);
				return { accepted: true, delivery: "pending-next-soft-cut", ttlMs: 30000, requestedAt: 1700000000000 };
			}
		})
	});
	const r = runToLevel2(controller);
	assert.equal(r.level, 2);
	await settle();
	// 调用形状：sessionId/turn/step/reason/evidenceSeq/fullVisibleText 六键齐发
	assert.equal(calls.length, 1);
	assert.equal(calls[0].sessionId, "s1");
	assert.equal(calls[0].turn, 1);
	assert.equal(calls[0].step, 6);
	assert.equal(calls[0].reason, "semantic-stall-2");
	assert.equal(calls[0].evidenceSeq, 2);
	assert.equal(calls[0].fullVisibleText, "第 6 条重复结论", "entry.summary 作为最近文本透传");
	// 日志串（V4 取证锚点）
	assert.ok(logs.some((line) => line.includes("[dsh-derive-watcher] L2 soft-cut requested")
		&& line.includes("session=s1") && line.includes("delivery=pending-next-soft-cut")), logs.join("\n"));
	// intervention 事件
	const iv = interventions(events);
	assert.equal(iv.length, 1);
	assert.equal(iv[0].p.action, "soft-cut-request");
	assert.equal(iv[0].p.accepted, true);
	assert.equal(iv[0].p.code, "semantic-stall-2");
	assert.equal(iv[0].p.reason ?? null, null, "cot-anchor 受理响应无 reason 字段时不编造（INTERVENTION_STRING_FIELDS 只写真实字符串）");
	assert.equal(iv[0].p.delivery, "pending-next-soft-cut");
	assert.equal(iv[0].p.evidenceSeq, 2);
	assert.equal(unavailable(events).length, 0, "受理成功不降级");
	// stall 事件本身不受影响
	assert.equal(stalls(events).length, 2);
	assert.equal(stalls(events)[1].p.code, "semantic-stall-2");
});

test("B：requestSoftCut 返回 accepted=false → 软切未受理 → execution-unavailable", async () => {
	const { events, controller } = harness({
		settings: { enableStall2SoftCut: true },
		getCotAnchor: () => ({ requestSoftCut: async () => ({ accepted: false, reason: "disabled" }) })
	});
	runToLevel2(controller);
	await settle();
	const u = unavailable(events);
	assert.equal(u.length, 1);
	assert.ok(u[0].p.suppressReason.includes("软切未受理: disabled"), u[0].p.suppressReason);
	assert.ok(u[0].p.suppressReason.includes("stall-2 软切降级为仅注入"));
	assert.equal(interventions(events).length, 0, "未受理不发 intervention");
});

test("C：getCotAnchor=null（服务缺失）→ cot-anchor 服务未就绪", async () => {
	const { events, controller } = harness({
		settings: { enableStall2SoftCut: true },
		getCotAnchor: null
	});
	runToLevel2(controller);
	await settle();
	const u = unavailable(events);
	assert.equal(u.length, 1);
	assert.ok(u[0].p.suppressReason.includes("cot-anchor 服务未就绪"), u[0].p.suppressReason);
	// 主流程：stall-2 事件照发
	assert.equal(stalls(events)[1].p.level, 2);
});

test("D：requestSoftCut 抛异常 → requestSoftCut 不可用（fail-open）", async () => {
	const { events, controller } = harness({
		settings: { enableStall2SoftCut: true },
		getCotAnchor: () => ({ requestSoftCut: async () => { throw new Error("anchor exploded"); } })
	});
	runToLevel2(controller);
	await settle();
	const u = unavailable(events);
	assert.equal(u.length, 1);
	assert.ok(u[0].p.suppressReason.includes("requestSoftCut 不可用"), u[0].p.suppressReason);
	assert.ok(u[0].p.suppressReason.includes("anchor exploded"), u[0].p.suppressReason);
});

test("E：entry.summary 缺失/非字符串/空串 → fullVisibleText 传 null（不捏造）", async () => {
	const cases = [
		{ label: "缺 summary 字段", entry: { turn: 1, step: 6, novelty: "duplicate", semantic_duplicate: true }, expect: null },
		{ label: "summary 非字符串", entry: { turn: 1, step: 6, novelty: "duplicate", semantic_duplicate: true, summary: 42 }, expect: null },
		{ label: "summary 空串", entry: { turn: 1, step: 6, novelty: "duplicate", semantic_duplicate: true, summary: "   " }, expect: null }
	];
	for (const item of cases) {
		const calls = [];
		const { controller } = harness({
			settings: { enableStall2SoftCut: true },
			getCotAnchor: () => ({ requestSoftCut: async (p) => { calls.push(p); return { accepted: true, delivery: "pending-next-soft-cut" }; } })
		});
		controller.onEntries("s1", [semDup(1), semDup(2), semDup(3)]);
		controller.onEntries("s1", [semDup(4), semDup(5), { ...item.entry }]);
		await settle();
		assert.equal(calls.length, 1, item.label);
		assert.equal(calls[0].fullVisibleText, item.expect, item.label);
	}
});

test("F：与 enableStall2Deny 相互独立、可同时开启（deny 与 soft-cut 各一次）", async () => {
	const denyCalls = [];
	const softCutCalls = [];
	const { events, controller } = harness({
		settings: { enableStall2Deny: true, enableStall2SoftCut: true },
		getL2: () => ({ denyToolCategory: async (...a) => { denyCalls.push(a); return { accepted: true, expiresAtStep: 99 }; } }),
		getCotAnchor: () => ({ requestSoftCut: async (p) => { softCutCalls.push(p); return { accepted: true, delivery: "pending-next-soft-cut" }; } })
	});
	runToLevel2(controller);
	await settle();
	assert.equal(denyCalls.length, 1);
	assert.equal(softCutCalls.length, 1);
	// 两条干预事件并存：deny-read 与 soft-cut-request
	const actions = interventions(events).map((e) => e.p.action).sort();
	assert.deepEqual(actions, ["deny-read", "soft-cut-request"]);
	assert.equal(unavailable(events).length, 0);
});

test("G：enableStall2SoftCut=false → 不调 requestSoftCut、无 intervention", async () => {
	const calls = [];
	const { events, controller } = harness({
		settings: { enableStall2SoftCut: false },
		getCotAnchor: () => ({ requestSoftCut: async (p) => { calls.push(p); return { accepted: true }; } })
	});
	runToLevel2(controller);
	await settle();
	assert.equal(calls.length, 0);
	assert.equal(interventions(events).length, 0);
	assert.equal(unavailable(events).length, 0, "未开启不降级");
});

test("H：st.actioned[2] 幂等——stall-2 后继续 duplicate 不重复请求", async () => {
	const calls = [];
	const { controller } = harness({
		settings: { enableStall2SoftCut: true },
		getCotAnchor: () => ({ requestSoftCut: async (p) => { calls.push(p); return { accepted: true, delivery: "pending-next-soft-cut" }; } })
	});
	runToLevel2(controller);
	controller.onEntries("s1", [semDup(7)]);
	await settle();
	assert.equal(calls.length, 1, "level 2 已 actioned，第 7 条重复不再触发");
});

test("I：getCotAnchor 返回无 requestSoftCut 方法的对象 → 服务未就绪", async () => {
	const { events, controller } = harness({
		settings: { enableStall2SoftCut: true },
		getCotAnchor: () => ({ probe: () => "present" })
	});
	runToLevel2(controller);
	await settle();
	const u = unavailable(events);
	assert.equal(u.length, 1);
	assert.ok(u[0].p.suppressReason.includes("cot-anchor 服务未就绪"), u[0].p.suppressReason);
});
