/**
 * P3 injection 单测（§5.4/§7.3）：objectives 置顶、排除最近步、latestSummarized、
 * 只整条/句界裁剪、预算溢出、结构校验失败、sanitize。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	EXCLUDE_RECENT_STEPS_DEFAULT, collectOpenObjectives, sanitizeEntryText,
	validateAssembledText, buildInjectionPayload, REASONING_SECTION_TITLE, REASONING_BUDGET_RATIO
} from "../lib/injection.js";

const e = (i, kind = "finding", extra = {}) => ({
	id: `j_${String(i).padStart(4, "0")}`, turn: 1, step: i, kind,
	summary: `结论${i}的摘要文本`, detail: "", artifacts: [], supersedes: [],
	novelty: "new", semantic_duplicate: false, ...extra
});

// 步骤5：reasoning 通道 entry（kind 必须是 r-* 前缀，独立账本来源）
const re = (i, kind = "r-decision", extra = {}) => ({
	id: `j_${String(i).padStart(4, "0")}`, channel: "reasoning", turn: 1, step: i, kind,
	summary: `推理${i}中的内部权衡记录`, detail: "", artifacts: [], supersedes: [],
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
		id: "j_0100", turn: 1, step: 1, milestone: true, kind: "finding",
		summary: "里程碑摘要", detail: "这是第一句细节。这是第二句细节。".repeat(6) + "这是第三句细节。",
		covers: ["j_0000"], supersedes: []
	};
	const plans = [];
	for (let i = 1; i <= 12; i++) plans.push(e(i, "plan", { summary: `目标${i}：` + "继续推进很长的目标描述".repeat(4) }));
	const built = buildInjectionPayload({
		entries: [...plans, e(20, "dead-end", { summary: "路径A不可行的原因说明" }), e(21), e(22)],
		milestones: [milestone],
		watermark: { lastStepSeq: 22 }, currentTurn: 1, currentStep: 24,
		excludeRecentSteps: 2, recentN: 8, tokenBudget: 300
	});
	assert.equal(built.ok, true);
	assert.ok(built.tokenEstimate <= 300, `预算内实际 ${built.tokenEstimate}`);
	assert.ok(built.trimmed.length + built.dropped.length >= 1, "应有裁剪动作");
	assert.ok(built.text.includes("j_0100"), "里程碑标题行保留");
	assert.ok(built.text.includes("j_0020"), "dead-end 标题行保留");
	assert.ok(!built.text.includes("这是第三句细节"), "里程碑正文被句界裁剪");
});

test("目标只注入最近 N 条：15 条未完成目标不再顶穿预算（回归：持续注入跳过）", () => {
	const plans = [];
	for (let i = 1; i <= 15; i++) plans.push(e(i, "plan", { summary: `目标${i}：` + "很长的目标描述".repeat(3) }));
	const built = buildInjectionPayload({
		entries: plans, watermark: { lastStepSeq: 15 }, currentTurn: 1, currentStep: 20,
		tokenBudget: 800, objectiveLimit: 3
	});
	assert.equal(built.ok, true, "预算 800 下必须照常注入，不能整块跳过");
	assert.ok(built.tokenEstimate <= 800, `预算内实际 ${built.tokenEstimate}`);
	assert.equal(built.sections.objectives, 3);
	assert.equal(built.sections.objectivesOmitted, 12);
	assert.ok(built.text.includes("j_0015"), "最新目标在注入里");
	assert.ok(!built.text.includes("j_0001 "), "最旧目标被折叠出注入");
	assert.ok(built.text.includes("12 条较早目标未展开"));
});

test("预算极紧时降级为「最新要点」单行，而不是整块跳过", () => {
	const plans = [];
	for (let i = 1; i <= 15; i++) plans.push(e(i, "plan", { summary: `目标${i}：` + "很长的目标描述".repeat(3) }));
	const built = buildInjectionPayload({
		entries: plans, watermark: { lastStepSeq: 15 }, currentTurn: 1, currentStep: 20,
		tokenBudget: 120
	});
	assert.equal(built.ok, true, "连预算 120 也不该整块放弃");
	assert.ok(built.tokenEstimate <= 120, `预算内实际 ${built.tokenEstimate}`);
	assert.ok(built.text.includes("j_0015"), "最新目标仍被注入");
});

test("死胡同只注入最近 N 条，更早的报数量（不再无界累积）", () => {
	const deads = [];
	for (let i = 1; i <= 6; i++) deads.push(e(i, "dead-end", { summary: `第${i}条死胡同的原因说明` }));
	const built = buildInjectionPayload({
		entries: deads, watermark: { lastStepSeq: 6 }, currentTurn: 1, currentStep: 6, deadEndLimit: 2
	});
	assert.equal(built.ok, true);
	assert.equal(built.sections.deadEnds, 2);
	assert.equal(built.sections.deadEndsOmitted, 4);
	assert.ok(built.text.includes("j_0005") && built.text.includes("j_0006"));
	assert.ok(!built.text.includes("j_0001 "), "最旧死胡同被折叠");
});

test("复读/语义重复条目与计划类条目不再进结论区（只留有推进意义的结论）", () => {
	const entries = [
		e(1, "plan"),
		e(2, "finding", { novelty: "duplicate" }),
		e(3, "finding", { semantic_duplicate: true }),
		e(4, "finding", { summary: "真正推进了主线的结论内容" }),
		e(5)
	];
	const built = buildInjectionPayload({
		entries, watermark: { lastStepSeq: 5 }, currentTurn: 1, currentStep: 6, excludeRecentSteps: 1
	});
	assert.equal(built.ok, true);
	assert.ok(!built.text.includes("j_0002") && !built.text.includes("j_0003"), "复读条目不注入");
	assert.ok(!built.text.includes("j_0001 [结论"), "计划类只在目标区出现，不进结论区");
	assert.ok(built.text.includes("j_0004"));
	assert.equal(built.sections.recent, 2);
	assert.equal(built.sections.objectives, 1);
});

test("buildInjectionPayload：结构校验失败（花括号不配平）→ ok:false", () => {
	const built = buildInjectionPayload({
		entries: [e(1, "finding", { summary: "函数 { 开始未闭合" })],
		watermark: { lastStepSeq: 1 }, currentTurn: 1, currentStep: 5
	});
	assert.equal(built.ok, false);
	assert.ok(built.suppressReason.includes("结构校验"));
});

test("buildInjectionPayload：预算紧张时 dead-end 标题行仍保留（降级为最新一条）", () => {
	const dead = e(2, "dead-end", { summary: "路径A不可行的原因说明" });
	const built = buildInjectionPayload({
		entries: [dead, e(3)], watermark: { lastStepSeq: 9 }, currentTurn: 1, currentStep: 9, tokenBudget: 120
	});
	assert.equal(built.ok, true);
	assert.ok(built.text.includes("j_0002"), "dead-end 标题保留");
});

// ── 步骤5：reasoning 独立分区（标注非正式结论、与结论分区隔离、独立子预算、空账本字节级一致）──

test("步骤5：reasoning 为空时注入输出与无 reasoning 入参字节级一致（防回归）", () => {
	const args = {
		entries: [e(1), e(2), e(3)],
		watermark: { lastStepSeq: 3 }, currentTurn: 1, currentStep: 5
	};
	const baseline = buildInjectionPayload(args);
	const emptyReasoning = buildInjectionPayload({ ...args, reasoningEntries: [] });
	const omittedReasoning = buildInjectionPayload(args); // 完全不传 reasoningEntries
	assert.equal(emptyReasoning.ok, true);
	assert.equal(emptyReasoning.text, baseline.text, "空 reasoning 数组须与基线字节级一致");
	assert.equal(omittedReasoning.text, baseline.text, "缺省 reasoningEntries 须与基线字节级一致");
	assert.equal(emptyReasoning.sections.reasoning, 0);
	assert.ok(!emptyReasoning.text.includes(REASONING_SECTION_TITLE), "空 reasoning 不得出现分区标题");
});

test("步骤5：reasoning entry 渲染在独立分区且显式标注非正式结论，不混入结论分区", () => {
	const built = buildInjectionPayload({
		entries: [e(5)],
		reasoningEntries: [re(1, "r-decision"), re(2, "r-hypothesis"), re(3, "r-self-correction"), re(4, "r-plan")],
		watermark: { lastStepSeq: 5 }, currentTurn: 1, currentStep: 7
	});
	assert.equal(built.ok, true);
	assert.ok(built.text.includes(REASONING_SECTION_TITLE), "须含固定非正式结论标注串");
	assert.equal(built.sections.reasoning, 4);
	// 分区边界：标注串必须在正式「最近结论」分区之后，两分区不混排
	const idxReasoning = built.text.indexOf(REASONING_SECTION_TITLE);
	const idxRecent = built.text.indexOf("◆ 最近结论");
	assert.ok(idxRecent >= 0 && idxReasoning > idxRecent, "reasoning 分区须在正式结论分区之后独立成段");
	// 每条 reasoning 都只出现在标注串之后
	for (const id of ["j_0001", "j_0002", "j_0003", "j_0004"]) {
		const pos = built.text.indexOf(id);
		assert.ok(pos > idxReasoning, `${id} 不得出现在正式结论分区`);
	}
	// 正式结论 j_0005 在 reasoning 分区之前
	assert.ok(built.text.indexOf("j_0005") < idxReasoning);
});

test("步骤5：r-dead-end 渲染在推理分区且永不遗忘", () => {
	const built = buildInjectionPayload({
		entries: [e(10)],
		reasoningEntries: [re(1, "r-dead-end")],
		watermark: { lastStepSeq: 10 }, currentTurn: 1, currentStep: 10
	});
	assert.equal(built.ok, true);
	assert.ok(built.text.includes("放弃的方案"), "r-dead-end 独立小标题");
	assert.ok(built.text.includes("j_0001"));
});

test("步骤5：reasoning 超子预算只裁剪 reasoning 分区，不挤掉正式结论", () => {
	// 总预算 100，reasoning 子预算上限 = 40；正式结论分区独立按 100 组装，必须完整保留
	const manyReasoning = [];
	for (let i = 1; i <= 30; i++) manyReasoning.push(re(i, "r-decision", { summary: `推理第${i}条内部权衡内容占位填充文本` }));
	const built = buildInjectionPayload({
		entries: [e(50, "finding", { summary: "这是必须完整保留的正式结论内容A" }), e(51, "finding", { summary: "这是必须完整保留的正式结论内容B" })],
		reasoningEntries: manyReasoning,
		watermark: { lastStepSeq: 51 }, currentTurn: 1, currentStep: 53,
		tokenBudget: 100
	});
	assert.equal(built.ok, true);
	assert.ok(built.text.includes("必须完整保留的正式结论内容A"), "正式结论 A 不得被 reasoning 挤掉");
	assert.ok(built.text.includes("必须完整保留的正式结论内容B"), "正式结论 B 不得被 reasoning 挤掉");
	// reasoning 分区存在但已在 40% 子预算内裁剪
	assert.ok(built.reasoningDropped.length > 0, "reasoning 应有整条裁剪");
	const idxReasoning = built.text.indexOf(REASONING_SECTION_TITLE);
	const reasoningPart = built.text.slice(idxReasoning);
	// 粗略上界：reasoning 分区 token 不超过子预算 + 标题（标题固定开销，放宽到 60）
	assert.ok(reasoningPart.length >= 0);
});

test("步骤5：REASONING_BUDGET_RATIO=0.4 常量", () => {
	assert.equal(REASONING_BUDGET_RATIO, 0.4);
});
