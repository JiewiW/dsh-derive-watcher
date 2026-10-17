/**
 * P0 设置单测：clamp/联动/倒挂/首发守卫/持久化损坏回退（§5.6/§7.3）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS, SETTINGS_SCHEMA, coerceSetting, validateSettings,
	applyRuntimeSettings, firstRunGuards, makeSettingsStore
} from "../lib/settings.js";

test("DEFAULT_SETTINGS：33 键全量与首发态", () => {
	assert.equal(Object.keys(DEFAULT_SETTINGS).length, 33);
	assert.equal(DEFAULT_SETTINGS.enableJourney, true);
	assert.equal(DEFAULT_SETTINGS.enableInjection, false);
	assert.equal(DEFAULT_SETTINGS.enableStall3Reject, false);
	assert.equal(DEFAULT_SETTINGS.enableStall2Deny, false); // 偏离计划书默认 true：首发 enableInjection=false 下 true 会触发联动校验错误（交付说明已记）
	assert.equal(DEFAULT_SETTINGS.maxConcurrency, 1);
	assert.equal(DEFAULT_SETTINGS.injectionTokenBudget, 1200);
	assert.equal(DEFAULT_SETTINGS.recentN, 8);
	assert.equal(DEFAULT_SETTINGS.injectionObjectiveLimit, 3); // 目标区只注入最近 3 条，防无界累积吃穿预算
	assert.equal(DEFAULT_SETTINGS.injectionDeadEndLimit, 3);
	assert.equal(DEFAULT_SETTINGS.enableReasoningJourney, true);
	assert.equal(DEFAULT_SETTINGS.reasoningRecentN, 8);
	assert.equal(DEFAULT_SETTINGS.reasoningStallWatchSteps, 6);
	assert.equal(DEFAULT_SETTINGS.reasoningStallWatchWindowSec, 300);
	assert.equal(DEFAULT_SETTINGS.enableMilestoneFold, true);
	assert.equal(DEFAULT_SETTINGS.noveltyMode, "schema-selfcheck");
	assert.equal(DEFAULT_SETTINGS.lexicalThreshold, 0.8); // 改进②：词法相似度阈值（小数键）
	assert.equal(DEFAULT_SETTINGS.enableLexicalStallCount, false); // 改进①：词法重复计入升级关
	assert.equal(DEFAULT_SETTINGS.lexicalStallSteps, 0); // 改进⑤：独立词法复读警告阈值（0=关）
	assert.equal(DEFAULT_SETTINGS.stall1Steps, 3);
	assert.equal(DEFAULT_SETTINGS.stall2Steps, 6);
	assert.equal(DEFAULT_SETTINGS.stall3Steps, 10);
	assert.equal(DEFAULT_SETTINGS.retentionDays, 30);
	assert.equal(DEFAULT_SETTINGS.escapeClosingTags, true);
	assert.ok(DEFAULT_SETTINGS.stall1Steps < DEFAULT_SETTINGS.stall2Steps && DEFAULT_SETTINGS.stall2Steps < DEFAULT_SETTINGS.stall3Steps);
});

test("SETTINGS_SCHEMA 覆盖全部键（GET 返回 schema 的内容保证）", () => {
	assert.equal(SETTINGS_SCHEMA.length, 33);
	for (const key of Object.keys(DEFAULT_SETTINGS)) {
		assert.ok(SETTINGS_SCHEMA.some((c) => c.key === key), `schema 缺键 ${key}`);
	}
});

test("coerceSetting：数值越界 clamp 记 warning", () => {
	const hi = coerceSetting("maxConcurrency", 5);
	assert.equal(hi.value, 2);
	assert.ok(hi.warnings.length > 0);
	assert.equal(coerceSetting("recentN", 2).value, 4);
	assert.equal(coerceSetting("injectionTokenBudget", 9999).value, 1500);
});

test("coerceSetting：非法数值回退默认并记 warning", () => {
	const bad = coerceSetting("maxConcurrency", "abc");
	assert.equal(bad.value, 1);
	assert.ok(bad.warnings[0].includes("回退默认"));
	assert.equal(coerceSetting("maxConcurrency", true).value, 1);
});

test("reasoning 四键：越界 clamp / 非法回退 / 布尔收敛", () => {
	assert.equal(coerceSetting("reasoningRecentN", 2).value, 4);
	assert.equal(coerceSetting("reasoningRecentN", 50).value, 16);
	assert.equal(coerceSetting("reasoningStallWatchSteps", 1).value, 2);
	assert.equal(coerceSetting("reasoningStallWatchSteps", 99).value, 50);
	assert.equal(coerceSetting("reasoningStallWatchWindowSec", 10).value, 60);
	assert.equal(coerceSetting("reasoningStallWatchWindowSec", 99999).value, 3600);
	assert.equal(coerceSetting("reasoningRecentN", 12).value, 12);
	assert.equal(coerceSetting("reasoningStallWatchSteps", 8).value, 8);
	assert.equal(coerceSetting("reasoningStallWatchWindowSec", 600).value, 600);
	assert.equal(coerceSetting("reasoningRecentN", "x").value, 8);
	assert.equal(coerceSetting("reasoningStallWatchSteps", "y").value, 6);
	assert.equal(coerceSetting("reasoningStallWatchWindowSec", NaN).value, 300);
	assert.equal(coerceSetting("enableReasoningJourney", false).value, false);
	assert.equal(coerceSetting("enableReasoningJourney", "true").value, true);
	assert.equal(coerceSetting("enableReasoningJourney", 0).value, false);
});

test("validateSettings：reasoning stall 键不挂 enableInjection 联动（仅提示）", () => {
	const r = validateSettings({
		...DEFAULT_SETTINGS,
		enableInjection: false,
		enableJourney: true,
		reasoningStallWatchSteps: 10,
		reasoningStallWatchWindowSec: 900
	});
	assert.equal(r.errors.length, 0, "reasoning stall 键不应要求 enableInjection：" + r.errors.join(";"));
	const off = validateSettings({ ...DEFAULT_SETTINGS, enableReasoningJourney: false });
	assert.equal(off.errors.length, 0);
});

test("coerceSetting：小数键 lexicalThreshold 不四舍五入（改进②）", () => {
	assert.equal(coerceSetting("lexicalThreshold", 0.83).value, 0.83);
	assert.equal(coerceSetting("lexicalThreshold", 0.5).value, 0.5);
	assert.equal(coerceSetting("lexicalThreshold", 1.5).value, 0.95, "超上限 clamp");
	assert.equal(coerceSetting("lexicalThreshold", "abc").value, 0.8, "非法回退默认");
	assert.ok(coerceSetting("lexicalThreshold", "abc").warnings.length > 0);
});

test("coerceSetting：boolean 与 text", () => {
	assert.equal(coerceSetting("enableInjection", "true").value, true);
	assert.equal(coerceSetting("enableInjection", false).value, false);
	assert.equal(coerceSetting("enableInjection", undefined).value, false);
	assert.equal(coerceSetting("summaryProvider", "  deepseek  ").value, "deepseek");
});

test("validateSettings：联动违规", () => {
	assert.ok(validateSettings({ ...DEFAULT_SETTINGS, enableInjection: true, enableJourney: false }).errors.length > 0);
	assert.ok(validateSettings({ ...DEFAULT_SETTINGS, enableStall2Deny: true, enableInjection: false }).errors.length > 0);
	assert.ok(validateSettings({ ...DEFAULT_SETTINGS, enableStall3Reject: true, enableInjection: false }).errors.length > 0);
	const ok = validateSettings({ ...DEFAULT_SETTINGS, enableInjection: true, enableJourney: true });
	assert.equal(ok.errors.length, 0);
});

test("validateSettings：阈值倒挂拒绝（error 文本含倒挂）", () => {
	const r = validateSettings({ ...DEFAULT_SETTINGS, stall1Steps: 6, stall2Steps: 3 });
	assert.ok(r.errors.join("").includes("倒挂"));
	assert.equal(validateSettings({ ...DEFAULT_SETTINGS }).errors.length, 0);
});

test("applyRuntimeSettings：errors 非空保持 current（拒绝保存）", () => {
	const r = applyRuntimeSettings({ ...DEFAULT_SETTINGS }, { stall1Steps: 10, stall2Steps: 6 });
	assert.ok(r.errors.length > 0);
	assert.deepEqual(r.settings, DEFAULT_SETTINGS);
});

test("applyRuntimeSettings：合法更新 + clamp + noveltyMode 非法收敛", () => {
	const r2 = applyRuntimeSettings({ ...DEFAULT_SETTINGS }, { injectionTokenBudget: 700 });
	assert.equal(r2.errors.length, 0);
	assert.equal(r2.settings.injectionTokenBudget, 800);
	const r3 = applyRuntimeSettings({ ...DEFAULT_SETTINGS }, { noveltyMode: "garbage" });
	assert.equal(r3.settings.noveltyMode, "schema-selfcheck");
	const r4 = applyRuntimeSettings({ ...DEFAULT_SETTINGS }, { noveltyMode: "embedding" });
	assert.equal(r4.settings.noveltyMode, "embedding");
	const r5 = applyRuntimeSettings({ ...DEFAULT_SETTINGS }, { noveltyMode: "semantic-only" });
	assert.equal(r5.settings.noveltyMode, "semantic-only"); // 改进③：纯语义模式合法
});

test("firstRunGuards：钉定 enableInjection=false / enableStall3Reject=false", () => {
	const s = firstRunGuards({ ...DEFAULT_SETTINGS, enableInjection: true, enableStall3Reject: true });
	assert.equal(s.enableInjection, false);
	assert.equal(s.enableStall3Reject, false);
});

test("makeSettingsStore：保存/读取往返/损坏回退 null", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsw-settings-"));
	try {
		const store = makeSettingsStore(dir);
		assert.ok(!existsSync(store.path));
		store.save({ ...DEFAULT_SETTINGS, recentN: 6 });
		assert.ok(existsSync(store.path));
		const loaded = store.load();
		assert.equal(loaded.settings.recentN, 6);
		assert.ok(Array.isArray(loaded.warnings));
		writeFileSync(store.path, "{broken json", "utf8");
		assert.equal(store.load(), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
