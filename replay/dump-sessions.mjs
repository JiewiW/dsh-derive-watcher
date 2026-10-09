#!/usr/bin/env node
// 三事故会话 transcript dump 脚本（离线回放脚手架 · 数据源准备）
//
// 产物：replay/transcripts/<sessionId>.jsonl
// 数据源：dsh-session-log-extract 技能（宿主机默认 ~/.dsh/skills/dsh-session-log-extract/extract-session-log.mjs，
//   环境变量 DSH_SESSION_LOG_EXTRACT 可覆盖脚本路径）
//   用法：node extract-session-log.mjs dump <sessionId> [out]
//   projectKey 由该脚本按 process.cwd() 推导（无参数覆盖），因此必须在会话所属的项目根下运行：
//     项目根取环境变量 DSH_SESSION_PROJECT_ROOT（未设置时用当前 cwd）。
//   dump 产物落在 cwd（缺省 <sessionId>.jsonl），本脚本 dump 后搬运到 replay/transcripts/ 并清理。
// 核验（增长型标量）：产物存在、字节数>0、行数>0、首行 JSON 且 type==="session"。
//
// ⚠ 预期步区间由验收方预登记（expected-ranges.json），本脚本不填写、不修改。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "transcripts");
// 技能脚本路径：默认宿主机 ~/.dsh/skills/…，环境变量 DSH_SESSION_LOG_EXTRACT 可覆盖。
const SKILL = process.env.DSH_SESSION_LOG_EXTRACT || join(homedir(), ".dsh", "skills", "dsh-session-log-extract", "extract-session-log.mjs");
// 会话所属项目根：技能脚本按 cwd 推导 projectKey；环境变量 DSH_SESSION_PROJECT_ROOT 可覆盖。
const HOST_ROOT = process.env.DSH_SESSION_PROJECT_ROOT || process.cwd();

// 三事故会话（验收方指定，顺序不得变更；cwd 统一取 HOST_ROOT，projectKey 由技能脚本从 cwd 推导）
// ⚠ session-4f4ead96 原轨迹已被清理（验收方预登记文件查证），按处置以
//    replay.mjs 内置合成流内循环样例替代，本脚本对其仅核验缺失并跳过（不算失败）。
const SYNTHETIC_IDS = new Set(["session-4f4ead96"]);
const sessions = [
	{ id: "session-4f4ead96" },
	{ id: "session-a915fee0" }, // 事故会话（目录名模糊匹配由技能脚本处理）
	{ id: "session-554d7536-2b99-4f09-a6ee-3b5621a09056" }
];

mkdirSync(OUT_DIR, { recursive: true });
let okCount = 0, expectedMissing = 0;
for (const { id: sid } of sessions) {
	const target = join(OUT_DIR, `${sid}.jsonl`);
	if (existsSync(target)) rmSync(target, { force: true });
	if (SYNTHETIC_IDS.has(sid)) {
		console.log(`[dump] ⚠ ${sid}: 原轨迹缺失（验收方预登记文件处置），由 replay.mjs 合成样例替代——跳过 dump`);
		expectedMissing += 1;
		continue;
	}
	console.log(`[dump] ${sid} (cwd=${HOST_ROOT}) …`);
	const r = spawnSync(process.execPath, [SKILL, "dump", sid], { cwd: HOST_ROOT, encoding: "utf8", timeout: 9000 });
	const tmpOut = join(HOST_ROOT, `${sid}.jsonl`);
	const produced = existsSync(tmpOut);
	if (produced) {
		copyFileSync(tmpOut, target);
		unlinkSync(tmpOut);
	}
	const bytes = produced ? statSync(target).size : 0;
	let lines = 0, firstLineOk = false;
	if (produced) {
		const text = readFileSync(target, "utf8");
		const arr = text.split("\n").filter((l) => l.trim().length > 0);
		lines = arr.length;
		try { firstLineOk = JSON.parse(arr[0])?.type === "session"; } catch { firstLineOk = false; }
	}
	const status = r.status;
	if (produced && bytes > 0 && lines > 0 && firstLineOk) {
		okCount += 1;
		console.log(`[dump] ✓ ${sid}: ${lines} 行 / ${bytes} 字节 / 首行 session ✓`);
	} else {
		console.log(`[dump] ✗ ${sid}: produced=${produced} bytes=${bytes} lines=${lines} firstLineOk=${firstLineOk} status=${status} stderr=${(r.stderr || "").slice(0, 220)}`);
	}
}
console.log(`[dump] 完成：${okCount} 个 dump 成功 + ${expectedMissing} 个按预登记处置走合成样例 / 共 ${sessions.length} 会话`);
process.exit(okCount + expectedMissing === sessions.length ? 0 : 1);
