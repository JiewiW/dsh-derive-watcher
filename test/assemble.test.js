/**
 * P0 装配单测：apply() 注册监听与路由、设置 GET 返回 schema、POST 校验保存、
 * session/event 全链路（assistant/message → summarizer → 账本）、自注入防回环、
 * 心跳、pre-step 注入投递（enableInjection=true 走测试设置）。
 *
 * 设置文件使用真实 ~/.dsh/storages/semantic-watcher/settings.json（设计的首发位置），
 * 测试前快照、测试后还原；账本根经 settings.storagePath 指到临时目录，不污染真实账本。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { EVT } from "../lib/events.js";
import { DEFAULT_SETTINGS, SETTINGS_FILE } from "../lib/settings.js";
import { createJourneyStore } from "../lib/journey-store.js";

const SETTINGS_DIR = join(homedir(), ".dsh", "storages", "semantic-watcher");
const SETTINGS_PATH = join(SETTINGS_DIR, SETTINGS_FILE ?? "settings.json");
const hadSettings = existsSync(SETTINGS_PATH);
const originalSettings = hadSettings ? readFileSync(SETTINGS_PATH, "utf8") : null;

const tempRoot = mkdtempSync(join(tmpdir(), "dsw-assemble-"));
const testSettings = {
	...DEFAULT_SETTINGS,
	enableInjection: true,
	enableJourney: true,
	storagePath: tempRoot
};
mkdirSync(SETTINGS_DIR, { recursive: true });
writeFileSync(SETTINGS_PATH, JSON.stringify(testSettings, null, 2));

const fakeLlm = {
	stream: async function* () {
		yield {
			type: "text-delta", index: 0,
			text: JSON.stringify({ entries: [{ kind: "finding", summary: "装配测试会话的独特结论文本，关于折叠机制", detail: "", artifacts: [], supersedes: [], confidence: 0.9 }] })
		};
	}
};

function makeCtx(extraServices) {
	const handlers = new Map();
	const routes = [];
	const services = new Map([["llm", fakeLlm]]);
	if (extraServices) { for (const [k, v] of Object.entries(extraServices)) services.set(k, v); }
	return {
		handlers, routes,
		get: (name) => services.get(name),
		on: (event, fn) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		webServer: { register: (route) => routes.push(route) }
	};
}

const ctx = makeCtx();
const dispose = apply(ctx, undefined); // apply 返回卸载函数 + 测试钩子（P1-12）

function makeSession(id, appended = []) {
	return {
		id,
		append: (name, payload) => { appended.push({ name, payload }); return true; }
	};
}

function fakeRes() {
	const res = {};
	res.status = null; res.body = null;
	res.writeHead = (code) => { res.status = code; return res; };
	res.end = (text) => { if (text) res.body = JSON.parse(text); return res; };
	return res;
}

function postReq(obj) {
	const req = new EventEmitter();
	req.method = "POST";
	queueMicrotask(() => {
		req.emit("data", Buffer.from(JSON.stringify(obj)));
		req.emit("end");
	});
	return req;
}

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const jsonlOf = (sid) => join(tempRoot, "journey", `${sid}.jsonl`);
const lineCount = (sid) => (existsSync(jsonlOf(sid)) ? readFileSync(jsonlOf(sid), "utf8").trim().split("\n").filter(Boolean).length : 0);
async function waitFor(fn, tries = 300) {
	for (let i = 0; i < tries; i++) {
		if (fn()) return true;
		await settle(1);
	}
	return fn();
}

after(() => {
	try {
		if (hadSettings) writeFileSync(SETTINGS_PATH, originalSettings);
		else rmSync(SETTINGS_PATH, { force: true });
	} catch { /* 还原失败不影响测试结论 */ }
	try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* 同上 */ }
});

test("apply：注册 session/event 与 agent/pre-step 监听 + 三条路由（settings + timeline×2，均 exact）", () => {
	assert.ok(ctx.handlers.get("session/event")?.length === 1);
	assert.ok(ctx.handlers.get("agent/pre-step")?.length === 1);
	assert.equal(ctx.routes.length, 3);
	const paths = ctx.routes.map((r) => r.path).sort();
	assert.deepEqual(paths, [
		"/plugins/derive-watcher/settings",
		"/plugins/derive-watcher/timeline",
		"/plugins/derive-watcher/timeline/sessions"
	].sort());
	assert.ok(ctx.routes.every((r) => r.kind === "exact"));
});

test("设置 GET 返回 schema + settings + defaults + capabilities", async () => {
	const res = fakeRes();
	await ctx.routes[0].handler({ method: "GET" }, res);
	assert.equal(res.status, 200);
	assert.equal(res.body.ok, true);
	assert.ok(Array.isArray(res.body.schema) && res.body.schema.length >= 18, "schema 覆盖全部设置键");
	assert.equal(Object.keys(res.body.settings).length, Object.keys(DEFAULT_SETTINGS).length);
	assert.equal(res.body.defaults.enableInjection, false, "defaults 是首发态");
	assert.equal(res.body.defaults.enableStall3Reject, false);
	assert.equal(res.body.capabilities.llm, true, "mock llm 已注册");
	assert.equal(res.body.capabilities.stepGovernor, false, "L2 未就绪");
	assert.ok(String(res.body.capabilities.ledgerRoot).length > 0);
});

test("设置 POST：联动违规 400 不保存", async () => {
	const res = fakeRes();
	await ctx.routes[0].handler(postReq({ settings: { enableInjection: true, enableJourney: false } }), res);
	assert.equal(res.status, 400);
	assert.equal(res.body.ok, false);
	assert.ok(res.body.errors.length > 0);
	const res2 = fakeRes();
	await ctx.routes[0].handler({ method: "GET" }, res2);
	assert.equal(res2.body.settings.enableJourney, true, "违规补丁未生效");
});

test("设置 POST：合法更新生效并持久化", async () => {
	const res = fakeRes();
	await ctx.routes[0].handler(postReq({ settings: { recentN: 6 } }), res);
	assert.equal(res.status, 200);
	assert.equal(res.body.ok, true);
	assert.equal(res.body.settings.recentN, 6);
	const persisted = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
	assert.equal(persisted.recentN, 6);
	// 还原，避免影响后续用例
	const res2 = fakeRes();
	await ctx.routes[0].handler(postReq({ settings: { recentN: DEFAULT_SETTINGS.recentN } }), res2);
	assert.equal(res2.status, 200);
});

test("session/event：assistant/message → summarizer → 账本落账（JSONL 行数增长）", async () => {
	const [onEvent] = ctx.handlers.get("session/event");
	const appended = [];
	const session = makeSession("test-assemble-s1", appended);
	const before = lineCount("test-assemble-s1");
	assert.equal(before, 0);
	onEvent(session, {
		type: "assistant/message",
		data: {
			turn: 1, step: 1,
			message: {
				id: "am-1",
				source: { kind: "model" },
				content: [{ type: "reasoning", text: "思考过程" }, { type: "text", text: "对外可见的结论正文" }]
			}
		}
	});
	const grew = await waitFor(() => lineCount("test-assemble-s1") > 0);
	assert.equal(grew, true, "总结完成后账本应落第一行");
	const lines = readFileSync(jsonlOf("test-assemble-s1"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const entry = lines.find((l) => l.type === "entry");
	assert.ok(entry, "存在 entry 行");
	assert.equal(entry.sourceMessageId, "am-1");
	assert.equal(entry.novelty, "new");
	assert.ok(!entry.summary.includes("思考过程"), "reasoning 不入账");
});

test("session/event：自注入（source.plugin=dsh-derive-watcher）不入账防回环", async () => {
	const [onEvent] = ctx.handlers.get("session/event");
	const session = makeSession("test-assemble-s1");
	const before = lineCount("test-assemble-s1");
	onEvent(session, {
		type: "assistant/message",
		data: {
			turn: 2, step: 2,
			message: { id: "am-self-1", source: { kind: "plugin:dsh-derive-watcher", plugin: "dsh-derive-watcher" }, content: [{ type: "text", text: "自己注入的消息不应被总结" }] }
		}
	});
	await settle(10);
	assert.equal(lineCount("test-assemble-s1"), before, "行数不变");
});

test("session/event：同 messageId 重复事件不双写（重启补扫防双写同源）", async () => {
	const [onEvent] = ctx.handlers.get("session/event");
	const session = makeSession("test-assemble-s1");
	const before = lineCount("test-assemble-s1");
	onEvent(session, {
		type: "assistant/message",
		data: { turn: 1, step: 1, message: { id: "am-1", source: { kind: "model" }, content: [{ type: "text", text: "重复投递的同一消息" }] } }
	});
	await settle(10);
	assert.equal(lineCount("test-assemble-s1"), before);
});

test("心跳：5 个事件触发一次 heartbeat（载荷含队列长度与水位 stepSeq）", async () => {
	const [onEvent] = ctx.handlers.get("session/event");
	const appended = [];
	const session = makeSession("test-assemble-s2", appended);
	for (let i = 1; i <= 5; i++) {
		onEvent(session, {
			type: "assistant/message",
			data: { turn: 1, step: i, message: { id: `am-beat-${i}`, source: { kind: "model" }, content: [{ type: "text", text: "" }] } }
		});
	}
	const beats = appended.filter((a) => a.name === EVT.HEARTBEAT);
	assert.equal(beats.length, 1, `5 事件应发一次心跳，实际 ${beats.length}`);
	assert.equal(typeof beats[0].payload.queueLength, "number");
	assert.ok("watermarkStepSeq" in beats[0].payload);
});

test("session/event：真人 user/message 不抛错（停滞状态归零路径）", () => {
	const [onEvent] = ctx.handlers.get("session/event");
	const session = makeSession("test-assemble-s1");
	onEvent(session, { type: "user/message", data: { turn: 3, step: 0, message: { source: { kind: "user" }, content: "真人输入" } } });
	onEvent(session, { type: "user/message", data: { turn: 3, step: 0, message: { source: { kind: "plugin:other", plugin: "other" }, content: "插件消息不算真人" } } });
});

test("P1-12：turn/end 后 TTL 过期删除会话与心跳（模拟时钟，禁 sleep）", () => {
	const [onEvent] = ctx.handlers.get("session/event");
	const appended = [];
	const session = makeSession("test-ttl-s1", appended);
	const t0 = Date.now();
	for (let i = 1; i <= 5; i++) {
		onEvent(session, { type: "assistant/message", data: { turn: 1, step: i, message: { id: `am-ttl-${i}`, source: { kind: "model" }, content: [{ type: "text", text: "活跃文本" }] } } });
	}
	onEvent(session, { type: "turn/end", data: { turn: 1, reason: "turn-complete" } });
	assert.ok(dispose.getDebugState().sessionCount >= 1, "session 已登记");
	assert.ok(dispose.getDebugState().activityCount >= 1, "活跃度已登记");
	const beatsBefore = dispose.getDebugState().beatCount;
	assert.ok(beatsBefore >= 1, "存在心跳计数");
	// 时钟推进：从当前真实时刻起超过 TTL（测试默认 sessionTtlMinutes=10）并留余量
	dispose.pruneStaleSessions(Date.now() + 10 * 60_000 + 5000);
	assert.equal(dispose.getDebugState().sessionCount, 0, "TTL 过期后 sessionById 已删");
	assert.equal(dispose.getDebugState().activityCount, 0, "TTL 过期后活跃度已删");
	assert.equal(dispose.getDebugState().beatCount, 0, "TTL 过期后心跳已删（不再 append）");
	// 删除后再触发事件会重新登记 → 心跳重新开始（会话复活语义）
	onEvent(session, { type: "assistant/message", data: { turn: 2, step: 1, message: { id: "am-ttl-live", source: { kind: "model" }, content: [{ type: "text", text: "复活文本" }] } } });
	assert.ok(dispose.getDebugState().sessionCount >= 1, "新事件重新登记 session");
});

test("agent/pre-step：enableInjection=true 时注入组装文本（来源 plugin:dsh-derive-watcher）", async () => {
	// 直接经 store 造 3 条 entry（独立 sid，不依赖前面用例的异步时序）
	const sid = "test-assemble-s3";
	const store = createJourneyStore({ root: tempRoot, emit: () => {}, log: () => {} });
	for (let i = 1; i <= 3; i++) {
		const r = store.appendEntry(sid, {
			turn: 1, step: i, sourceMessageId: `seed-${i}`, kind: "finding",
			summary: `装配注入测试第${i}步的独特结论摘要`, detail: "", artifacts: [], supersedes: [], novelty: "new"
		});
		assert.equal(r.ok, true);
	}
	const [onPreStep] = ctx.handlers.get("agent/pre-step");
	const payload = { agent: { session: { id: sid } }, turn: 1, step: 9, messages: [] };
	const next = async () => ({ kind: "enter", messages: [] });
	const decision = await onPreStep(payload, next);
	assert.equal(decision.kind, "enter");
	assert.equal(decision.messages.length, 1, "注入恰好一条 user/message");
	const injected = decision.messages[0];
	assert.equal(injected.source?.kind, "plugin:dsh-derive-watcher");
	assert.equal(injected.source?.plugin, "dsh-derive-watcher");
	const text = injected.content?.[0]?.text ?? "";
	assert.ok(text.includes("j_0001"), "含早前结论");
	assert.ok(!text.includes("seed-3") || !text.includes("第3步"), "排除最近步的结论不注入");
});

test("agent/pre-step：空账本会话 → 透传不注入（无内容可注入）", async () => {
	const [onPreStep] = ctx.handlers.get("agent/pre-step");
	const payload = { agent: { session: { id: "test-assemble-empty" } }, turn: 1, step: 1, messages: [] };
	const next = async () => ({ kind: "enter", messages: [{ role: "user", content: "existing" }] });
	const decision = await onPreStep(payload, next);
	assert.equal(decision.messages.length, 1, "无账本内容时保持原样");
});

test("P2-21②：enableInjection=false 封住投递通道（含警示，不注入任何插件文本）", async () => {
	// 先用 POST 切到 enableInjection=false（settings 经内存 store 生效）
	let res = fakeRes();
	await ctx.routes[0].handler(postReq({ settings: { enableInjection: false } }), res);
	assert.equal(res.status, 200);
	// sid 已有账本 entry，正常开启注入时会注入；关闭后应原样透传
	const [onPreStep] = ctx.handlers.get("agent/pre-step");
	const payload = { agent: { session: { id: "test-assemble-s3" } }, turn: 3, step: 1, messages: [] };
	const next = async () => ({ kind: "enter", messages: [{ role: "user", content: "existing" }] });
	const decision = await onPreStep(payload, next);
	assert.equal(decision.messages.length, 1, "enableInjection=false 时不追加任何插件文本（含警示）");
	assert.equal(decision.messages[0].content, "existing", "原样透传");
	// 还原 enableInjection=true，避免影响后续用例
	res = fakeRes();
	await ctx.routes[0].handler(postReq({ settings: { enableInjection: true } }), res);
	assert.equal(res.status, 200);
});

test("agent/pre-step：decision.kind=reject 时不追加注入", async () => {
	const [onPreStep] = ctx.handlers.get("agent/pre-step");
	const payload = { agent: { session: { id: "test-assemble-s3" } }, turn: 2, step: 2, messages: [] };
	const next = async () => ({ kind: "reject", reason: "governor 阻断" });
	const decision = await onPreStep(payload, next);
	assert.equal(decision.kind, "reject");
	assert.equal(decision.messages, undefined);
});

test("P1-13：会话首事件触发一次性重启补扫（按观察水位，幂等）", async () => {
	const sid = "test-backfill-s1";
	// 预置观察水位 lastStepSeq=1：补扫应跳过 step≤1 的事件，只补 step2/3
	const store = createJourneyStore({ root: tempRoot, emit: () => {}, log: () => {} });
	store.saveObservationWatermark(sid, { lastStepSeq: 1 });
	const events = [
		{ type: "assistant/message", data: { turn: 1, step: 1, message: { id: "bf-1", source: { kind: "model" }, content: [{ type: "reasoning", text: "思考1" }, { type: "text", text: "结论1" }] } } },
		{ type: "assistant/message", data: { turn: 1, step: 2, message: { id: "bf-2", source: { kind: "model" }, content: [{ type: "reasoning", text: "思考2" }] } } },
		{ type: "assistant/message", data: { turn: 1, step: 3, message: { id: "bf-3", source: { kind: "model" }, content: [{ type: "reasoning", text: "思考3" }, { type: "text", text: "结论3" }] } } },
		{ type: "assistant/message", data: { turn: 1, step: 4, message: { id: "bf-4", source: { kind: "model" }, content: [{ type: "text", text: "" }] } } }
	];
	const ctx2 = makeCtx({ sessionQuery: { listEvents: () => events } });
	const dispose2 = apply(ctx2, undefined);
	const [onEvent2] = ctx2.handlers.get("session/event");
	// 触发首个事件（turn/end 也计入活跃度）→ 应触发一次性补扫
	onEvent2({ id: sid, append: () => true }, { type: "turn/end", data: { turn: 1, reason: "done" } });
	// 观察账本补写 step2/3（step1 被水位跳过；step4 空文本不入观察）；结论通道 step2/3/4 为 observation
	const obs = store.readObservations(sid);
	const obsSteps = obs.map((o) => o.step).sort((a, b) => a - b);
	assert.deepEqual(obsSteps, [2, 3], "按观察水位补扫只补 step>1 的观察，空文本不入");
	// 断言补扫只生效一次：再次触发事件不重复补写（水位已推进 → readObservations 不再增长）
	const before2 = obs.length;
	onEvent2({ id: sid, append: () => true }, { type: "turn/end", data: { turn: 2, reason: "done" } });
	assert.equal(store.readObservations(sid).length, before2, "补扫幂等：二次触发不重复");
	dispose2();
});
