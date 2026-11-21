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
	applyRuntimeSettings, applyRuntimeSettingsLenient, firstRunGuards, makeSettingsStore
} from "../lib/settings.js";

test("DEFAULT_SETTINGS：44 键全量与首发态（含小结模型/超时三键）", () => {
	assert.equal(Object.keys(DEFAULT_SETTINGS).length, 44);
	assert.equal(DEFAULT_SETTINGS.enableJourney, true);
	assert.equal(DEFAULT_SETTINGS.enableInjection, true);
	assert.equal(DEFAULT_SETTINGS.enableStall3Reject, false);
	assert.equal(DEFAULT_SETTINGS.enableStall2Deny, true); // 首发态已改为默认 true（注入通道开启，联动成立）
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
	// 静默中断分组（C1–C8，键名与默认值逐字照计划书 §6 表）
	assert.equal(DEFAULT_SETTINGS.silentAbortAction, "notify"); // C1 默认 fail-safe：仅告警不自动续跑
	assert.equal(DEFAULT_SETTINGS.enableSilentAbortWatch, true);
	assert.equal(DEFAULT_SETTINGS.maxAutoResumePerSession, 3);
	assert.equal(DEFAULT_SETTINGS.cooldownMs, 15000);
	assert.equal(DEFAULT_SETTINGS.progressMinSteps, 3);
	assert.deepEqual(DEFAULT_SETTINGS.errorNoRetryCodes, ["401", "403", "signed-out"]);
	assert.equal(DEFAULT_SETTINGS.concludingTextMinLen, 200);
	assert.equal(DEFAULT_SETTINGS.zombieSilentMs, 120000);
	assert.ok(DEFAULT_SETTINGS.stall1Steps < DEFAULT_SETTINGS.stall2Steps && DEFAULT_SETTINGS.stall2Steps < DEFAULT_SETTINGS.stall3Steps);
});

test("SETTINGS_SCHEMA 覆盖全部键（GET 返回 schema 的内容保证）", () => {
	assert.equal(SETTINGS_SCHEMA.length, 44);
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
		enableInjection: false, enableStall2Deny: false, enableStall2SoftCut: false, enableStall3Reject: false,
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
	assert.equal(coerceSetting("enableInjection", undefined).value, true);
	assert.equal(coerceSetting("summaryProvider", "  deepseek  ").value, "deepseek");
});

test("coerceSetting：静默中断分组（C1 四档枚举 + C6 数组键）", () => {
	// C1：合法四档直通；非法回退 notify；缺省回退默认
	assert.equal(coerceSetting("silentAbortAction", "followup").value, "followup");
	assert.equal(coerceSetting("silentAbortAction", "goal-resume").value, "goal-resume");
	const bad = coerceSetting("silentAbortAction", "turbo");
	assert.equal(bad.value, "notify");
	assert.ok(bad.warnings.length > 0);
	assert.equal(coerceSetting("silentAbortAction", undefined).value, "notify");
	// C6：数组原样过滤；字符串逗号拆分；空串回退默认；非法类型回退默认
	assert.deepEqual(coerceSetting("errorNoRetryCodes", ["401", "x"]).value, ["401", "x"]);
	assert.deepEqual(coerceSetting("errorNoRetryCodes", "401, 403,,signed-out").value, ["401", "403", "signed-out"]);
	assert.deepEqual(coerceSetting("errorNoRetryCodes", "   ").value, DEFAULT_SETTINGS.errorNoRetryCodes);
	assert.deepEqual(coerceSetting("errorNoRetryCodes", 42).value, DEFAULT_SETTINGS.errorNoRetryCodes);
});

test("validateSettings：C1 非法档告警（不产生 error）", () => {
	const badMode = validateSettings({ ...DEFAULT_SETTINGS, silentAbortAction: "turbo" });
	assert.ok(badMode.warnings.some((w) => w.includes("silentAbortAction")));
	assert.equal(badMode.errors.length, 0);
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

test("firstRunGuards：仅钉定 enableStall3Reject=false，注入与 stall-2 保持默认", () => {
	const s = firstRunGuards({ ...DEFAULT_SETTINGS, enableInjection: true, enableStall3Reject: true });
	assert.equal(s.enableInjection, true);
	assert.equal(s.enableStall2Deny, true);
	assert.equal(s.enableStall2SoftCut, true);
	assert.equal(s.enableStall3Reject, false);
});

// ── 逐项降级（加载路径）────────────────────────────────────────────────
// 回归背景：此前联动违规会让整份配置回退默认值，连 storagePath 一起丢，
// 导致账本路径静默漂移到默认目录。降级必须只动违规的那一项。

test("applyRuntimeSettingsLenient：联动违规只降级从属项，storagePath 等无关配置必须保住", () => {
	const r = applyRuntimeSettingsLenient(DEFAULT_SETTINGS, {
		...DEFAULT_SETTINGS, enableInjection: false, enableJourney: true, storagePath: "/tmp/my-ledger"
	});
	assert.equal(r.errors.length, 0, "加载路径不应残留 error");
	assert.equal(r.settings.storagePath, "/tmp/my-ledger", "storagePath 不得被连带清空");
	assert.equal(r.settings.enableInjection, false, "保留用户显式表达的 false");
	assert.equal(r.settings.enableStall2Deny, false, "仅降级依赖注入的从属项");
	assert.equal(r.repairs.length, 1);
	assert.ok(r.warnings.some((w) => w.includes("配置降级")), "降级必须留告警");
});

test("applyRuntimeSettingsLenient：多跳联动逐级收敛，不打开用户已关的上游", () => {
	const r = applyRuntimeSettingsLenient(DEFAULT_SETTINGS, {
		...DEFAULT_SETTINGS,
		enableJourney: false, enableInjection: true,
		enableStall2Deny: true, enableStall3Reject: true, storagePath: "/keep"
	});
	assert.equal(r.errors.length, 0);
	assert.equal(r.settings.enableJourney, false, "上游保持用户设定");
	assert.equal(r.settings.enableInjection, false, "下游逐级关闭而非打开上游");
	assert.equal(r.settings.enableStall2Deny, false);
	assert.equal(r.settings.enableStall3Reject, false);
	assert.equal(r.settings.storagePath, "/keep");
});

test("applyRuntimeSettingsLenient：阈值倒挂回退三键，其余配置保留", () => {
	const r = applyRuntimeSettingsLenient(DEFAULT_SETTINGS, {
		...DEFAULT_SETTINGS, stall1Steps: 6, stall2Steps: 3, stall3Steps: 10, storagePath: "/keep2"
	});
	assert.equal(r.errors.length, 0);
	assert.deepEqual([r.settings.stall1Steps, r.settings.stall2Steps, r.settings.stall3Steps], [3, 6, 10]);
	assert.equal(r.settings.storagePath, "/keep2");
});

test("applyRuntimeSettingsLenient：合法配置不产生 repairs", () => {
	const r = applyRuntimeSettingsLenient(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, storagePath: "/ok" });
	assert.equal(r.errors.length, 0);
	assert.equal(r.repairs.length, 0);
	assert.equal(r.settings.storagePath, "/ok");
});

test("applyRuntimeSettings（严格）：POST 保存路径仍整份拒绝，不做静默降级", () => {
	const r = applyRuntimeSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, enableInjection: false, storagePath: "/lost" });
	assert.ok(r.errors.length > 0, "显式保存必须报错而不是悄悄改配置");
	assert.equal(r.settings.storagePath, "", "严格版维持原语义：整体保持 current");
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
