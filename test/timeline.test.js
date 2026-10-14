/**
 * v0.2.0 步骤2：timeline HTTP API 测试（使用临时 node:http 端口，不依赖固定端口或运行实例）。
 *
 * 覆盖：①四来源归并与排序；②intervention item 字段；③listEvents 抛错 → 200+空事件源+warning；
 * ④脏 JSONL 行跳过；⑤sessions 在有/无 sessionQuery 两种环境的并集；参数校验（400/404/405/limit 钳制）；
 * 事件双形态（listEvents 轻量记录 → readSession 回退补 data；listEvents 直接带 data 不回退）。
 * 临时服务器测完必 close；设置文件快照/还原（沿用 assemble.test.js 范式）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { DEFAULT_SETTINGS, SETTINGS_FILE } from "../lib/settings.js";
import { TIMELINE_DEFAULT_LIMIT, TIMELINE_MAX_LIMIT, toMillis } from "../lib/timeline.js";

const SETTINGS_DIR = join(homedir(), ".dsh", "storages", "semantic-watcher");
const SETTINGS_PATH = join(SETTINGS_DIR, SETTINGS_FILE ?? "settings.json");
const hadSettings = existsSync(SETTINGS_PATH);
const originalSettings = hadSettings ? readFileSync(SETTINGS_PATH, "utf8") : null;

const tempRoot = mkdtempSync(join(tmpdir(), "dsw-timeline-"));
mkdirSync(join(tempRoot, "journey"), { recursive: true });
mkdirSync(join(tempRoot, "observation"), { recursive: true });
writeFileSync(join(SETTINGS_DIR, SETTINGS_FILE ?? "settings.json"), JSON.stringify({
	...DEFAULT_SETTINGS, enableInjection: false, enableJourney: true, storagePath: tempRoot
}, null, 2));

const iso = (sec) => `2025-10-09T00:00:${String(sec).padStart(2, "0")}.000Z`;

// journey 主账本：2 条有效 entry + 1 条脏行（必须被跳过）+ 1 条 gap 行（type≠entry，被 kindFilter 过滤）
writeFileSync(join(tempRoot, "journey", "s1.jsonl"), [
	JSON.stringify({ id: "j_0001", type: "entry", ts: iso("01"), turn: 1, step: 3, kind: "finding", summary: "第一个发现", detail: "细节一", novelty: "new" }),
	"{ 这不是合法 JSON",
	JSON.stringify({ id: "j_0002", type: "entry", ts: iso("05"), turn: 2, step: 7, kind: "decision", summary: "第二个决策", detail: "", novelty: "duplicate", semantic_duplicate: true, duplicate_of: "j_0001" }),
	JSON.stringify({ type: "gap", ts: iso("05"), sessionId: "s1" })
].join("\n") + "\n");
writeFileSync(join(tempRoot, "journey", "s1.milestones.jsonl"), JSON.stringify({
	id: "j_0009", type: "entry", milestone: true, ts: iso("03"), turn: 2, step: 7, kind: "finding",
	summary: "阶段里程碑", detail: "", covers: ["j_0001", "j_0002"]
}) + "\n");
writeFileSync(join(tempRoot, "observation", "s1.jsonl"), [
	JSON.stringify({ type: "observation", kind: "reasoning-observation", sessionId: "s1", ts: iso("02"), turn: 1, step: 4, hasText: true, textLen: 20, reasoningLen: 0, hasArtifact: false }),
	JSON.stringify({ type: "observation", kind: "reasoning-observation", sessionId: "s1", ts: iso("04"), turn: 1, step: 5, hasText: false, textLen: 0, reasoningLen: 240, hasArtifact: true })
].join("\n") + "\n");

// 会话事件：intervention 载荷字段用真实 emitIntervention 形态；handoff ts 取 05.5 验证毫秒级交错
const WATCHER_EVENTS_FULL = [
	{ seq: 1, type: "semantic-watcher/stall", time: Date.parse(iso("00")), data: { sessionId: "s1", turn: 2, step: 7, evidenceSeq: 2, level: 2, stallCount: 6, ts: iso("00") } },
	{ seq: 2, type: "assistant/message", time: Date.parse(iso("01")), data: { message: { content: [] } } },
	{ seq: 3, type: "semantic-watcher/handoff-written", time: Date.parse("2025-10-09T00:00:05.500Z"), data: { sessionId: "s1", turn: 3, step: 9, level: 3, ts: "2025-10-09T00:00:05.500Z", path: "/some/dir/s1-2025.handoff.md", seedPath: null } },
	{ seq: 4, type: "semantic-watcher/intervention", time: Date.parse(iso("06")), data: { sessionId: "s1", turn: 2, step: 7, evidenceSeq: 2, level: 2, stallCount: 6, ts: iso("06"), action: "deny-read", accepted: true, code: "semantic-stall-2", ttlSteps: 4, expiresAtStep: 50 } }
];
const WATCHER_RECORDS_LITE = WATCHER_EVENTS_FULL.map((e) => ({ sessionId: "s1", seq: e.seq, type: e.type, time: e.time, surface: "current" }));

const readSessionCalls = { s1: 0 };
function makeQuery(overrides = {}) {
	const q = {
		listSessions: async () => [
			{ header: { id: "s1", createdAt: 1000, cwd: "/workspace/demo" }, live: true, persisted: true },
			{ header: { id: "s9", createdAt: 2000 }, live: false, persisted: true }
		],
		listEvents: async (sid) => sid === "s1" ? WATCHER_RECORDS_LITE : [],
		readSession: async (sid) => { readSessionCalls[sid] = (readSessionCalls[sid] ?? 0) + 1; return sid === "s1" ? { session: { id: sid }, events: WATCHER_EVENTS_FULL } : { session: { id: sid }, events: [] }; },
		readTitleSnapshots: async (ids) => ids.map(() => ({ status: "fulfilled", value: { session: { createdAt: 1000 }, title: "演示会话标题" } })),
		...overrides
	};
	return q;
}

function makeCtx(services) {
	const routes = [];
	const map = new Map(Object.entries(services ?? {}));
	return {
		routes,
		get: (name) => { if (!map.has(name)) throw new Error(`no such service: ${name}`); return map.get(name); },
		on: () => {},
		webServer: { register: (r) => routes.push(r) }
	};
}

function findRoute(routes, path) { return routes.find((r) => r.path === path); }

// ── 主链路：真 node:http 临时端口 + fetch ──
const mainCtx = makeCtx({ sessionQuery: makeQuery(), llm: { stream: async function* () {} } });
const mainDispose = apply(mainCtx, undefined);
const server = createServer((req, res) => {
	const pathname = new URL(req.url, "http://x").pathname;
	const route = findRoute(mainCtx.routes, pathname);
	if (!route) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "no route" })); return; }
	Promise.resolve(route.handler(req, res)).catch((e) => { res.writeHead(500); res.end(String(e?.message ?? e)); });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const getJson = async (path) => {
	const r = await fetch(`${BASE}${path}`);
	return { status: r.status, body: await r.json() };
};

after(() => {
	mainDispose();
	server.closeAllConnections?.();
	server.close();
	if (hadSettings) writeFileSync(SETTINGS_PATH, originalSettings);
	else rmSync(SETTINGS_PATH, { force: true });
	rmSync(tempRoot, { recursive: true, force: true });
});

test("toMillis：ISO 字符串与毫秒数字双形态归一", () => {
	assert.equal(toMillis(iso("05")), Date.parse(iso("05")));
	assert.equal(toMillis(1760000000000), 1760000000000);
	assert.equal(toMillis("乱码"), null);
	assert.equal(toMillis(undefined), null);
});

test("GET timeline：五来源归并、ts 降序、脏行跳过、intervention 卡片字段", async () => {
	const { status, body } = await getJson("/plugins/derive-watcher/timeline?sessionId=s1");
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.counts.journey, 2, "脏行被跳过、gap 行不入 journey");
	assert.equal(body.counts.gap, 1, "gap 行独立计入 gap 来源");
	assert.equal(body.counts.milestone, 1);
	assert.equal(body.counts.observation, 2);
	assert.equal(body.counts.intervention, 1);
	assert.equal(body.counts["watcher-event"], 2, "stall 与 handoff-written");
	const sources = body.items.map((i) => i.source);
	assert.deepEqual(sources, ["intervention", "watcher-event", "journey", "gap", "observation", "milestone", "observation", "journey", "watcher-event"], "ts 降序交错：6>5.5>5（同 ts 比 turn/step：journey step7 在前，无 turn/step 的老 gap 在后）>4>3>2>1>0");
	// 无 grade/reason 的老 gap 行：标题回退「原因未知」，摘要为空串而非 undefined
	const gapItem = body.items.find((i) => i.source === "gap");
	assert.equal(gapItem.kind, "summary-gap");
	assert.equal(gapItem.grade, null);
	assert.equal(gapItem.title, "总结跳过（原因未知）");
	assert.equal(gapItem.summary, "");
	const iv = body.items[0];
	assert.equal(iv.id, `evt:semantic-watcher/intervention:${WATCHER_RECORDS_LITE[3].seq}`);
	assert.equal(iv.kind, "deny-read");
	assert.equal(iv.accepted, true);
	assert.equal(iv.level ?? iv.data.level, 2);
	assert.ok(iv.title.includes("已临时禁止读取文件等工具") && iv.title.includes("已生效"), `标题：${iv.title}`);
	assert.ok(iv.summary.includes("第 50 步后解除") && iv.summary.includes("TTL 4 步"), `摘要：${iv.summary}`);
	assert.equal(iv.data.code, "semantic-stall-2");
	assert.equal(iv.data.expiresAtStep, 50);
	// readSession 回退发生过（listEvents 轻量记录无 data）
	assert.equal(readSessionCalls.s1 >= 1, true, "listEvents 无 data → readSession 回退补全");
	// 里程碑标题与 handoff 只显示 basename
	const ms = body.items.find((i) => i.source === "milestone");
	assert.ok(ms.title.includes("阶段里程碑") && ms.summary.includes("覆盖 2 条"));
	const ho = body.items.find((i) => i.kind === "handoff-written");
	assert.ok(ho.summary.includes("s1-2025.handoff.md"), `handoff 摘要含 basename：${ho.summary}`);
	const dup = body.items.find((i) => i.id === "j_0002");
	assert.equal(dup.novelty, "duplicate");
	assert.equal(dup.duplicate_of, "j_0001");
});

test("GET timeline：limit 钳制与非法值回退 200", async () => {
	const small = await getJson("/plugins/derive-watcher/timeline?sessionId=s1&limit=3");
	assert.equal(small.status, 200);
	assert.equal(small.body.items.length, 3);
	assert.equal(small.body.limit, 3);
	const big = await getJson("/plugins/derive-watcher/timeline?sessionId=s1&limit=99999");
	assert.equal(big.body.limit, TIMELINE_MAX_LIMIT);
	const junk = await getJson("/plugins/derive-watcher/timeline?sessionId=s1&limit=abc");
	assert.equal(junk.body.limit, TIMELINE_DEFAULT_LIMIT);
});

test("GET timeline：缺 sessionId → 400；账本不存在 → 404；非 GET → 405", async () => {
	const miss = await getJson("/plugins/derive-watcher/timeline");
	assert.equal(miss.status, 400);
	assert.ok(miss.body.error.includes("sessionId"));
	const ghost = await getJson("/plugins/derive-watcher/timeline?sessionId=ghost");
	assert.equal(ghost.status, 404);
	assert.ok(ghost.body.error.includes("没有语义账本"));
	const res = await fetch(`${BASE}/plugins/derive-watcher/timeline?sessionId=s1`, { method: "POST", body: "{}" });
	assert.equal(res.status, 405);
});

test("GET timeline/sessions：有 sessionQuery → 账本 ∪ 会话并集 + 标题补全 + live 信息", async () => {
	const { status, body } = await getJson("/plugins/derive-watcher/timeline/sessions");
	assert.equal(status, 200);
	const s1 = body.sessions.find((s) => s.sessionId === "s1");
	const s9 = body.sessions.find((s) => s.sessionId === "s9");
	assert.equal(s1.hasLedger, true);
	assert.equal(s1.live, true);
	assert.equal(s1.title, "演示会话标题");
	assert.equal(s9.hasLedger, false, "s9 只在会话列表，无账本");
	assert.ok(body.sessions.indexOf(s9) < body.sessions.indexOf(s1), "createdAt 新→旧");
});

test("sessions 无 sessionQuery 环境：降级扫账本目录，并集仍含 s1", async () => {
	const ctx2 = makeCtx({}); // ctx.get 一律抛 → getSessionQuery()=null
	const dispose2 = apply(ctx2, undefined);
	try {
		const route = findRoute(ctx2.routes, "/plugins/derive-watcher/timeline/sessions");
		assert.ok(route, "无 sessionQuery 时路由照常注册");
		const res = fakeRes();
		await route.handler({ method: "GET", url: "/plugins/derive-watcher/timeline/sessions" }, res);
		assert.equal(res.status, 200);
		assert.ok(res.body.sessions.some((s) => s.sessionId === "s1" && s.hasLedger === true));
		assert.ok(res.body.warnings.includes("session-query-unavailable"));
	} finally { dispose2(); }
});

test("listEvents 抛错 → 200 + 事件源为空 + warning session-events-unavailable", async () => {
	const q = makeQuery({ listEvents: async () => { throw new Error("engine down"); } });
	const ctx3 = makeCtx({ sessionQuery: q, llm: { stream: async function* () {} } });
	const dispose3 = apply(ctx3, undefined);
	try {
		const route = findRoute(ctx3.routes, "/plugins/derive-watcher/timeline");
		const res = fakeRes();
		await route.handler({ method: "GET", url: "/plugins/derive-watcher/timeline?sessionId=s1" }, res);
		assert.equal(res.status, 200);
		assert.equal(res.body.counts["watcher-event"], undefined, "事件来源空");
		assert.equal(res.body.counts.journey, 2, "其余来源不受影响");
		assert.ok(res.body.warnings.includes("session-events-unavailable"));
	} finally { dispose3(); }
});

test("listEvents 直接带 data 形态：不走 readSession 回退、无 warning", async () => {
	const before = readSessionCalls.s1 ?? 0;
	const q = makeQuery({ listEvents: async (sid) => sid === "s1" ? WATCHER_EVENTS_FULL : [] });
	const ctx4 = makeCtx({ sessionQuery: q, llm: { stream: async function* () {} } });
	const dispose4 = apply(ctx4, undefined);
	try {
		const route = findRoute(ctx4.routes, "/plugins/derive-watcher/timeline");
		const res = fakeRes();
		await route.handler({ method: "GET", url: "/plugins/derive-watcher/timeline?sessionId=s1" }, res);
		assert.equal(res.status, 200);
		assert.equal(res.body.counts.intervention, 1);
		assert.equal((readSessionCalls.s1 ?? 0), before, "带 data 时不触发 readSession");
		assert.deepEqual(res.body.warnings, []);
	} finally { dispose4(); }
});

test("同 ts 并列：intervention 排在 journey 之前（稳定优先级）", async () => {
	const tieTs = "2025-10-09T00:00:07.000Z";
	writeFileSync(join(tempRoot, "journey", "tie.jsonl"), JSON.stringify({ id: "j_t1", type: "entry", ts: tieTs, turn: 1, step: 1, kind: "fact", summary: "并列条目", novelty: "new" }) + "\n");
	const q = makeQuery({
		listEvents: async (sid) => sid === "tie" ? [{ sessionId: "tie", seq: 1, type: "semantic-watcher/intervention", time: Date.parse(tieTs), data: { sessionId: "tie", ts: tieTs, turn: 1, step: 1, action: "deny-read", accepted: true, code: "semantic-stall-2", level: 2, evidenceSeq: 1, ttlSteps: 4, expiresAtStep: 9 } }] : [],
		readSession: async (sid) => ({ session: { id: sid }, events: [] })
	});
	const ctx5 = makeCtx({ sessionQuery: q, llm: { stream: async function* () {} } });
	const dispose5 = apply(ctx5, undefined);
	try {
		const route = findRoute(ctx5.routes, "/plugins/derive-watcher/timeline");
		const res = fakeRes();
		await route.handler({ method: "GET", url: "/plugins/derive-watcher/timeline?sessionId=tie" }, res);
		assert.equal(res.status, 200);
		assert.equal(res.body.items[0].source, "intervention");
		assert.equal(res.body.items[1].source, "journey");
		assert.equal(res.body.items[0].turn, 1);
	} finally { dispose5(); }
});

function fakeRes() {
	const res = {};
	res.status = null; res.body = null;
	res.writeHead = (code) => { res.status = code; return res; };
	res.end = (text) => { if (text) res.body = JSON.parse(text); return res; };
	return res;
}
