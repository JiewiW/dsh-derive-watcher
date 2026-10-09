/**
 * P3 injection 单测（§5.4/§7.3）：objectives 置顶、排除最近步、latestSummarized、
 * 只整条/句界裁剪、预算溢出、结构校验失败、sanitize。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	EXCLUDE_RECENT_STEPS_DEFAULT, collectOpenObjectives, sanitizeEntryText,
	validateAssembledText, buildInjectionPayload
} from "../lib/injection.js";

const e = (i, kind = "finding", extra = {}) => ({
	id: `j_${String(i).padStart(4, "0")}`, turn: 1, step: i, kind,
	summary: `结论${i}的摘要文本`, detail: "", artifacts: [], supersedes: [],
	novelty: "new", semantic_duplicate: false, ...extra
});

test("EXCLUDE_RECENT_STEPS_DEFAULT=2（处于 1–3 区间）", () => {
	assert.equal(EXCLUDE_RECENT_STEPS_DEFAULT, 2);
});

test("collectOpenObjectives：仅 plan/hypothesis、排除被取代与被 covers 沉淀、新→旧", () => {
	const entries = [
		e(1, "plan"), e(2, "plan"), e(3, "finding", { supersedes: ["j_0001"] }), e(4, "hypothesis")
	];
	const milestones = [{ id: "j_0009", covers: ["j_0004"], supersedes: [] }];
	const open = collectOpenObjectives(entries, milestones);
	assert.deepEqual(open.map((x) => x.id), ["j_0002"], "j_0001 被取代、j_0004 被 covers、finding 不算");
});

test("sanitizeEntryText：去转写记号、围栏换标记、ASCII 括号换全角", () => {
	const s = sanitizeEntryText("调用 <SLASH_PARAMETER_ESCAPED> 结束 ```code``` 与 (括号) [方]");
	assert.ok(!s.includes("<SLASH_"));
	assert.ok(!s.includes("```"));
	assert.ok(s.includes("(代码块)"));
	assert.ok(s.includes("（括号）"));
	assert.ok(s.includes("【方】"));
});

test("validateAssembledText：配平通过、不配平/残留记号/奇数围栏失败", () => {
	assert.equal(validateAssembledText("普通中文文本（全角括号）").ok, true);
	assert.equal(validateAssembledText("缺一个（括号").ok, false);
	assert.equal(validateAssembledText("残留 <SLASH_PARAMETER_ESCAPED> 记号").ok, false);
	assert.equal(validateAssembledText("奇数 ``` 围栏").ok, false);
	assert.equal(validateAssembledText("").ok, false);
});

test("buildInjectionPayload：objectives 置顶", () => {
	const built = buildInjectionPayload({
		entries: [e(1, "plan"), e(2), e(3)],
		watermark: { lastStepSeq: 3 }, currentTurn: 1, currentStep: 5
	});
	assert.equal(built.ok, true);
	assert.equal(built.sections.objectives, 1);
	assert.ok(built.text.indexOf("j_0001") < built.text.indexOf("j_0002"), "plan 行在最近结论之前");
	assert.ok(built.latestSummarized);
});

test("buildInjectionPayload：排除最近 2 步结论（step≥current-1 不入注入）", () => {
	const built = buildInjectionPayload({
		entries: [e(8), e(9), e(10)],
		watermark: { lastStepSeq: 10 }, currentTurn: 1, currentStep: 10,
		excludeRecentSteps: 2, recentN: 8, tokenBudget: 1200
	});
	assert.equal(built.ok, true);
	assert.ok(built.text.includes("j_0008"));
	assert.ok(!built.text.includes("j_0010"), "step 10 被排除");
	assert.ok(!built.text.includes("j_0009"), "step 9 被排除");
	assert.equal(built.sections.recent, 1);
});

test("buildInjectionPayload：水位落后 → latestSummarized:false + 头部警示", () => {
	const fresh = buildInjectionPayload({
		entries: [e(8)], watermark: { lastStepSeq: 9 }, currentTurn: 1, currentStep: 10
	});
	assert.equal(fresh.latestSummarized, true);
	const stale = buildInjectionPayload({
		entries: [e(8)], watermark: { lastStepSeq: 7 }, currentTurn: 1, currentStep: 10
	});
	assert.equal(stale.latestSummarized, false);
	assert.ok(/水位|latestSummarized|陈旧/.test(stale.text), "头部应有陈旧水位警示");
});

test("buildInjectionPayload：预算紧张时句界裁剪里程碑正文、整条剔最旧最近结论；objectives/dead-end 标题保留", () => {
	const milestone = {
		id: "j_0001", turn: 1, step: 1, milestone: true, kind: "finding",
		summary: "里程碑摘要", detail: "这是第一句细节。这是第二句细节。".repeat(6) + "这是第三句细节。",
		covers: ["j_0000"], supersedes: []
	};
	const built = buildInjectionPayload({
		entries: [e(2, "dead-end", { summary: "路径A不可行的原因说明" }), e(3), e(4)],
		milestones: [milestone],
		watermark: { lastStepSeq: 4 }, currentTurn: 1, currentStep: 6,
		excludeRecentSteps: 2, recentN: 8, tokenBudget: 140
	});
	assert.equal(built.ok, true);
	assert.ok(built.tokenEstimate <= 140, `预算内实际 ${built.tokenEstimate}`);
	assert.ok(built.trimmed.length + built.dropped.length >= 1, "应有裁剪动作");
	assert.ok(built.text.includes("j_0001"), "里程碑标题行保留");
	assert.ok(built.text.includes("j_0002"), "dead-end 标题行保留");
	assert.ok(!built.text.includes("这是第三句细节"), "里程碑正文被句界裁剪");
});

test("buildInjectionPayload：不可裁剪项超预算 → ok:false + suppressReason 预算溢出", () => {
	const plans = [];
	for (let i = 1; i <= 20; i++) plans.push(e(i, "plan", { summary: `目标${i}：`.padEnd(20, "很长的目标描述") }));
	const built = buildInjectionPayload({
		entries: plans, watermark: { lastStepSeq: 20 }, currentTurn: 1, currentStep: 30, tokenBudget: 100
	});
	assert.equal(built.ok, false);
	assert.ok(built.suppressReason.includes("预算溢出"));
});

test("buildInjectionPayload：结构校验失败（花括号不配平）→ ok:false", () => {
	const built = buildInjectionPayload({
		entries: [e(1, "finding", { summary: "函数 { 开始未闭合" })],
		watermark: { lastStepSeq: 1 }, currentTurn: 1, currentStep: 5
	});
	assert.equal(built.ok, false);
	assert.ok(built.suppressReason.includes("结构校验"));
});

test("buildInjectionPayload：dead-end 标题行永不剔除", () => {
	const dead = e(2, "dead-end", { summary: "路径A不可行的原因说明" });
	const built = buildInjectionPayload({
		entries: [dead, e(3)], watermark: { lastStepSeq: 9 }, currentTurn: 1, currentStep: 9, tokenBudget: 80
	});
	assert.equal(built.ok, true);
	assert.ok(built.text.includes("j_0002"), "dead-end 标题保留");
});
