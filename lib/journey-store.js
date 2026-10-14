/**
 * dsh-derive-watcher — journey-store（计划书 §4）。
 *
 * 布局（root 默认 ~/.dsh/storages/semantic-watcher/）：
 *   journey/<sessionId>.jsonl                主账本（entry 行 + gap 元行）
 *   journey/<sessionId>.md                   人读镜像
 *   journey/<sessionId>.milestones.jsonl     里程碑账本（折叠产出，不受 retention 清理）
 *   journey/archive/<sessionId>-<ts>.jsonl   折叠归档
 *   observation/<sessionId>.jsonl            观察账本（轻量观察事件，独立于主结论，P0-2）
 *   watermark/<sessionId>.json               总结水位 { lastMessageId, lastStepSeq, ts }
 *   watermark/<sessionId>.observation.json   观察水位 { lastStepSeq, lastTs, ts }（与总结水位拆分，P0-8）
 *
 * 完整性（§4.3）：
 *  - 闭标签转写：字面闭标签（参数/函数/工具调用结束符）写入前转写、读取时还原（escapeClosingTags）；
 *  - 长度守恒：append 后文件字节增量 === 序列化行字节数，且回读末行可 JSON.parse；
 *    任一失败 → 记 corruption，停止本条写入（不静默），调用方发 store-corruption 事件。
 */
import {
	mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync, openSync, writeSync, closeSync
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const KINDS = ["finding", "decision", "dead-end", "hypothesis", "plan", "fact"];
/** 观察类 entry 的 kind（P0-2：reasoning 观察走独立通道，不混入正式结论 KINDS）。 */
export const OBSERVATION_KINDS = ["reasoning-observation"];
export const ARCHIVE_DIR = "archive";
const WATERMARK_DIR = "watermark";
const OBSERVATION_DIR = "observation";

// ── 闭标签转写（§4.3）────────────────────────────────────────────────────
export const DEFAULT_CLOSE_TAGS = ["tool_call", "function", "parameter", "invoke", "tool"];
const markerFor = (tag) => `<SLASH_${tag.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_ESCAPED>`;
const RE_FOR = {};
for (const tag of DEFAULT_CLOSE_TAGS) RE_FOR[tag] = new RegExp(`</\\s*${tag}\\s*>`, "gi");

export function escapeClosingTags(text, tags = DEFAULT_CLOSE_TAGS) {
	if (typeof text !== "string") return text;
	let out = text;
	for (const tag of tags) out = out.replace(RE_FOR[tag], () => markerFor(tag));
	return out;
}

export function restoreClosingTags(text, tags = DEFAULT_CLOSE_TAGS) {
	if (typeof text !== "string") return text;
	let out = text;
	for (const tag of tags) {
		out = out.split(markerFor(tag)).join(`</${tag}>`);
	}
	return out;
}

/** 残留转写记号检测（注入组装校验用）。 */
export function hasTranscriptionMarker(text, tags = DEFAULT_CLOSE_TAGS) {
	if (typeof text !== "string") return false;
	return tags.some((tag) => text.includes(markerFor(tag)));
}

function contentHashOf(entry) {
	const basis = JSON.stringify([entry.sourceMessageId, entry.summary, entry.detail]);
	return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function pad4(n) {
	return String(n).padStart(4, "0");
}

/** entry 结构校验（§4.1 schema 必填域）。 */
export function validateEntry(entry) {
	const errs = [];
	if (!entry || typeof entry !== "object") return ["entry 非对象"];
	if (!/^j_\d{4,}$/.test(entry.id ?? "")) errs.push(`id 非法: ${JSON.stringify(entry.id)}`);
	if (!KINDS.includes(entry.kind)) errs.push(`kind 非法: ${JSON.stringify(entry.kind)}`);
	if (typeof entry.summary !== "string" || entry.summary.trim() === "") errs.push("summary 缺失");
	if (entry.novelty !== undefined && !["new", "duplicate"].includes(entry.novelty)) {
		errs.push(`novelty 非法: ${JSON.stringify(entry.novelty)}`);
	}
	return errs;
}

/**
 * 创建账本。emit(name,payload) 由调用方注入（发 store-corruption 等事件用）；
 * fsImpl 可注入假 fs 供单测。root 为账本根目录。
 */
export function createJourneyStore({
	root,
	escapeTags = true,
	emit = () => {},
	log = (line) => console.warn(line),
	fsImpl = {
		mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync,
		readdirSync, unlinkSync, openSync, writeSync, closeSync
	}
} = {}) {
	const fs = fsImpl;
	const journeyDir = () => join(root, "journey");
	const archiveDir = () => join(journeyDir(), ARCHIVE_DIR);
	const watermarkDir = () => join(root, WATERMARK_DIR);
	const observationDir = () => join(root, OBSERVATION_DIR);
	const jsonlPath = (sid) => join(journeyDir(), `${sid}.jsonl`);
	const mdPath = (sid) => join(journeyDir(), `${sid}.md`);
	const milestonesPath = (sid) => join(journeyDir(), `${sid}.milestones.jsonl`);
	const watermarkPath = (sid) => join(watermarkDir(), `${sid}.json`);
	const observationJsonlPath = (sid) => join(observationDir(), `${sid}.jsonl`);
	const observationWatermarkPath = (sid) => join(watermarkDir(), `${sid}.observation.json`);

	const idCounters = new Map(); // sessionId -> next number
	const dirEnsured = new Set();

	function ensureDir(dir) {
		if (dirEnsured.has(dir)) return;
		fs.mkdirSync(dir, { recursive: true });
		dirEnsured.add(dir);
	}

	function nextEntryId(sessionId) {
		if (!idCounters.has(sessionId)) {
			// 从现有账本恢复计数（重启不重号：主账本 + 里程碑 + 归档）
			let max = 0;
			for (const p of [jsonlPath(sessionId), milestonesPath(sessionId)]) {
				try {
					for (const line of fs.readFileSync(p, "utf8").split("\n")) {
						const m = line.match(/^"id":"(j_\d+)"/) ?? (() => {
							try { return /"id":"(j_\d+)"/.exec(line); } catch { return null; }
						})();
						if (m) max = Math.max(max, Number(m[1].slice(2)));
					}
				} catch { /* 不存在 */ }
			}
			try {
				for (const f of fs.readdirSync(archiveDir())) {
					if (!f.startsWith(sessionId)) continue;
					for (const line of fs.readFileSync(join(archiveDir(), f), "utf8").split("\n")) {
						const m = /"id":"(j_\d+)"/.exec(line);
						if (m) max = Math.max(max, Number(m[1].slice(2)));
					}
				}
			} catch { /* 无归档 */ }
			idCounters.set(sessionId, max + 1);
		}
		const n = idCounters.get(sessionId);
		idCounters.set(sessionId, n + 1);
		return `j_${pad4(n)}`;
	}

	/** 单条 JSONL 追加 + 长度守恒 + 回读校验。返回 {ok, error?, bytes?}。 */
	function appendJsonlLine(path, line) {
		let before = 0;
		try { before = fs.statSync(path).size; } catch { before = 0; }
		const payload = line + "\n";
		const expected = Buffer.byteLength(payload, "utf8");
		try {
			ensureDir(path.replace(/[\\/][^\\/]+$/, ""));
			const fd = fs.openSync(path, "a");
			fs.writeSync(fd, payload, null, "utf8");
			fs.closeSync(fd);
		} catch (error) {
			return { ok: false, error: `append 失败: ${error?.message ?? error}` };
		}
		let after = 0;
		try { after = fs.statSync(path).size; } catch { return { ok: false, error: "append 后无法 stat" }; }
		if (after - before !== expected) {
			return { ok: false, error: `长度守恒失败: 增量 ${after - before} != 期望 ${expected}` };
		}
		try {
			const content = fs.readFileSync(path, "utf8");
			const lastLine = content.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
			JSON.parse(lastLine);
		} catch (error) {
			return { ok: false, error: `回读解析失败: ${error?.message ?? error}` };
		}
		return { ok: true, bytes: expected };
	}

	function mdAppend(path, text) {
		try {
			ensureDir(path.replace(/[\\/][^\\/]+$/, ""));
			fs.appendFileSync(path, text, "utf8");
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 追加一条 entry。失败路径：结构非法 / 写入完整性失败 → 记 corruption、停止本条写入。
	 * 返回 { ok:true, entry } | { ok:false, reason }。
	 */
	function appendEntry(sessionId, partial) {
		const entry = {
			id: partial.id ?? nextEntryId(sessionId),
			ts: partial.ts ?? new Date().toISOString(),
			turn: partial.turn ?? null,
			step: partial.step ?? null,
			sourceMessageId: partial.sourceMessageId ?? null,
			kind: partial.kind,
			summary: escapeTags ? escapeClosingTags(String(partial.summary ?? "")) : String(partial.summary ?? ""),
			detail: escapeTags ? escapeClosingTags(String(partial.detail ?? "")) : String(partial.detail ?? ""),
			artifacts: Array.isArray(partial.artifacts) ? partial.artifacts : [],
			supersedes: Array.isArray(partial.supersedes) ? partial.supersedes : [],
			confidence: typeof partial.confidence === "number" ? partial.confidence : null,
			content_hash: partial.content_hash ?? null,
			novelty: partial.novelty ?? "new",
			semantic_duplicate: partial.semantic_duplicate === true,
			duplicate_of: partial.duplicate_of ?? null,
			type: "entry"
		};
		if (entry.content_hash === null) entry.content_hash = contentHashOf(entry);
		const errs = validateEntry(entry);
		if (errs.length > 0) {
			const reason = `entry 结构校验失败: ${errs.join("; ")}`;
			log(`[dsh-derive-watcher] corruption session=${sessionId} ${reason}`);
			emit("semantic-watcher/store-corruption", { sessionId, reason, stage: "validate" });
			return { ok: false, reason };
		}
		const line = JSON.stringify(entry);
		const r = appendJsonlLine(jsonlPath(sessionId), line);
		if (!r.ok) {
			log(`[dsh-derive-watcher] corruption session=${sessionId} ${r.error}`);
			emit("semantic-watcher/store-corruption", { sessionId, reason: r.error, stage: "append", entryId: entry.id });
			return { ok: false, reason: r.error };
		}
		const mdOk = mdAppend(mdPath(sessionId),
			`- ${entry.id} [${entry.kind}] (turn=${entry.turn ?? "-"} step=${entry.step ?? "-"} novelty=${entry.novelty}) ${entry.summary}\n` +
			(entry.detail ? `  ${entry.detail.replace(/\n/g, "\n  ")}\n` : ""));
		if (!mdOk) {
			emit("semantic-watcher/store-corruption", { sessionId, reason: "md 镜像写入失败", stage: "md", entryId: entry.id });
		}
		return { ok: true, entry };
	}

	/** gap 元行（不产出 entry、不参与停滞判定）。 */
	function appendGap(sessionId, gapInfo) {
		const gap = {
			type: "gap",
			ts: new Date().toISOString(),
			sessionId,
			...gapInfo
		};
		const r = appendJsonlLine(jsonlPath(sessionId), JSON.stringify(gap));
		if (!r.ok) emit("semantic-watcher/store-corruption", { sessionId, reason: r.error, stage: "gap" });
		return r.ok;
	}

	/** 里程碑追加（独立账本，不受 retention 清理）。 */
	function appendMilestone(sessionId, milestone) {
		const m = {
			...milestone,
			milestone: true,
			ts: milestone.ts ?? new Date().toISOString(),
			type: "entry"
		};
		const line = JSON.stringify(m);
		const r = appendJsonlLine(milestonesPath(sessionId), line);
		if (!r.ok) emit("semantic-watcher/store-corruption", { sessionId, reason: r.error, stage: "milestone" });
		return r.ok ? m : null;
	}

	function readLines(path, kindFilter) {
		let raw;
		try {
			raw = fs.readFileSync(path, "utf8");
		} catch {
			return [];
		}
		const out = [];
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue;
			try {
				const obj = JSON.parse(line);
				if (kindFilter && obj.type !== kindFilter) continue;
				out.push(obj);
			} catch {
				emit("semantic-watcher/store-corruption", { sessionId: "*", reason: `不可解析行于 ${path}`, stage: "read" });
			}
		}
		return out;
	}

	/** 主账本 entry（读取时还原闭标签转写）。 */
	function readEntries(sessionId) {
		return readLines(jsonlPath(sessionId), "entry").map((e) => ({
			...e,
			summary: restoreClosingTags(e.summary),
			detail: restoreClosingTags(e.detail)
		}));
	}

	/** 主账本全部行（entry + gap），诊断用。 */
	function readAllLines(sessionId) {
		return readLines(jsonlPath(sessionId));
	}

	/** 主账本 gap 行（总结跳过记录），timeline 呈现失败原因用。 */
	function readGaps(sessionId) {
		return readLines(jsonlPath(sessionId), "gap");
	}

	function readMilestones(sessionId) {
		return readLines(milestonesPath(sessionId), "entry").map((e) => ({
			...e,
			summary: restoreClosingTags(e.summary),
			detail: restoreClosingTags(e.detail)
		}));
	}

	/**
	 * 追加一条观察事件（P0-2，独立通道，不写主结论账本）。观察为轻量快照，无 summary/detail，
	 * 只记录 {sid,turn,step,ts,hasText,textLen,reasoningLen,hasArtifact}。kind∈OBSERVATION_KINDS。
	 */
	function appendObservation(sessionId, obs) {
		const line = JSON.stringify({
			type: "observation",
			kind: "reasoning-observation",
			ts: new Date().toISOString(),
			sessionId,
			turn: obs.turn ?? null,
			step: obs.step ?? null,
			hasText: obs.hasText === true,
			textLen: Number.isFinite(obs.textLen) ? obs.textLen : 0,
			reasoningLen: Number.isFinite(obs.reasoningLen) ? obs.reasoningLen : 0,
			hasArtifact: obs.hasArtifact === true
		});
		const r = appendJsonlLine(observationJsonlPath(sessionId), line);
		if (!r.ok) emit("semantic-watcher/store-corruption", { sessionId, reason: r.error, stage: "observation" });
		return r.ok;
	}

	/** 读取观察账本（轻量事件列表，时间序）。 */
	function readObservations(sessionId) {
		return readLines(observationJsonlPath(sessionId), "observation");
	}

	/**
	 * 折叠归档：把 entries（必须来自主账本）移入 archive/<sessionId>-<ts>.jsonl，
	 * 主账本重写为剩余行。原子性：先写归档成功再重写主账本；任一失败返回 {ok:false}
	 * 且不动主账本。supersedes 链信息随行保留。
	 */
	function archiveEntries(sessionId, entries, tsLabel) {
		if (!Array.isArray(entries) || entries.length === 0) return { ok: true, path: null };
		const ids = new Set(entries.map((e) => e.id));
		const main = jsonlPath(sessionId);
		let allLines;
		try {
			allLines = readLines(main);
		} catch (error) {
			return { ok: false, reason: `读取主账本失败: ${error?.message ?? error}` };
		}
		const stay = allLines.filter((l) => !(l.type === "entry" && ids.has(l.id)));
		if (stay.length === allLines.length) return { ok: false, reason: "没有任何行被归档（id 不在主账本）" };
		const archiveFile = join(archiveDir(), `${sessionId}-${tsLabel}.jsonl`);
		try {
			ensureDir(archiveDir());
			fs.writeFileSync(archiveFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
		} catch (error) {
			return { ok: false, reason: `写归档失败: ${error?.message ?? error}` };
		}
		try {
			fs.writeFileSync(main, stay.map((l) => JSON.stringify(l)).join("\n") + (stay.length > 0 ? "\n" : ""), "utf8");
		} catch (error) {
			// 主账本重写失败：归档已留痕，报 corruption
			emit("semantic-watcher/store-corruption", { sessionId, reason: `主账本重写失败（归档已写 ${archiveFile}）: ${error?.message ?? error}`, stage: "archive" });
			return { ok: false, reason: "主账本重写失败" };
		}
		return { ok: true, path: archiveFile, archived: entries.length, stayed: stay.length };
	}

	/** retention 清理：仅清 archive 下过期文件。返回被删文件列表。 */
	function retentionClean(retentionDays, now = Date.now()) {
		const removed = [];
		let files = [];
		try {
			files = fs.readdirSync(archiveDir());
		} catch {
			return removed;
		}
		const cutoff = now - retentionDays * 24 * 3600 * 1000;
		for (const f of files) {
			const p = join(archiveDir(), f);
			try {
				if (fs.statSync(p).mtimeMs < cutoff) {
					fs.unlinkSync(p);
					removed.push(f);
				}
			} catch { /* 单文件失败不阻塞 */ }
		}
		return removed;
	}

	/** P2-21③：主账本/gap 保留期清理——删除 mtime 早于 cutoff 的整个会话主账本（jsonl/md/milestones/gap 一并清空）。返回被删文件列表。 */
	function retentionCleanLedger(retentionDays, now = Date.now()) {
		if (!(retentionDays > 0)) return []; // 0/负 = 不清理主账本
		const removed = [];
		let files = [];
		try {
			files = fs.readdirSync(journeyDir());
		} catch {
			return removed;
		}
		const cutoff = now - retentionDays * 24 * 3600 * 1000;
		const legacySuffixes = [".jsonl", ".md", ".milestones.jsonl"];
		for (const f of files) {
			if (!legacySuffixes.some((s) => f.endsWith(s))) continue;
			const p = join(journeyDir(), f);
			try {
				if (fs.statSync(p).mtimeMs < cutoff) {
					fs.unlinkSync(p);
					removed.push(f);
				}
			} catch { /* 单文件失败不阻塞 */ }
		}
		return removed;
	}

	// ── 水位 ────────────────────────────────────────────────────────────────
	// P2-21⑥：结论水位口径统一 —— 文件缺失、非对象、或任一字段缺失/损坏一律返 null（不用 0 兜底）。
	function loadWatermark(sessionId) {
		try {
			const wm = JSON.parse(fs.readFileSync(watermarkPath(sessionId), "utf8"));
			if (wm && typeof wm === "object") {
				const seq = wm.lastStepSeq;
				const lastSeq = Number.isFinite(seq) ? seq : null;
				const lastMsg = typeof wm.lastMessageId === "string" ? wm.lastMessageId : null;
				if (lastSeq === null && lastMsg === null) return null;
				return { sessionId, lastMessageId: lastMsg, lastStepSeq: lastSeq, ts: wm.ts ?? null };
			}
			return null;
		} catch {
			return null;
		}
	}

	function saveWatermark(sessionId, { lastMessageId, lastStepSeq }) {
		try {
			ensureDir(watermarkDir());
			fs.writeFileSync(watermarkPath(sessionId), JSON.stringify({
				sessionId, lastMessageId: lastMessageId ?? null, lastStepSeq: lastStepSeq ?? 0, ts: new Date().toISOString()
			}, null, 2) + "\n", "utf8");
			return true;
		} catch (error) {
			emit("semantic-watcher/store-corruption", { sessionId, reason: `水位写入失败: ${error?.message ?? error}`, stage: "watermark" });
			return false;
		}
	}

	// ── 观察水位（P0-8：与总结水位拆分，独立文件）───────────────────────────
	// 记录观察通道推进到的 lastStepSeq / 最近一次 step 墙钟 lastTs，供 wall-clock stall 判定。
	function loadObservationWatermark(sessionId) {
		try {
			const wm = JSON.parse(fs.readFileSync(observationWatermarkPath(sessionId), "utf8"));
			if (wm && typeof wm === "object") {
				const seq = Number.isFinite(wm.lastStepSeq) ? wm.lastStepSeq : null;
				const ts = typeof wm.lastTs === "number" && Number.isFinite(wm.lastTs) ? wm.lastTs : null;
				if (seq === null && ts === null) return null;
				return { sessionId, lastStepSeq: seq, lastTs: ts, ts: wm.ts ?? null };
			}
			return null;
		} catch {
			return null;
		}
	}

	function saveObservationWatermark(sessionId, { lastStepSeq, lastTs }) {
		try {
			ensureDir(watermarkDir());
			fs.writeFileSync(observationWatermarkPath(sessionId), JSON.stringify({
				sessionId, lastStepSeq: lastStepSeq ?? null, lastTs: lastTs ?? null, ts: new Date().toISOString()
			}, null, 2) + "\n", "utf8");
			return true;
		} catch (error) {
			emit("semantic-watcher/store-corruption", { sessionId, reason: `观察水位写入失败: ${error?.message ?? error}`, stage: "watermark" });
			return false;
		}
	}

	return {
		root, escapeTags,
		nextEntryId, appendEntry, appendGap, appendMilestone,
		readEntries, readAllLines, readGaps, readMilestones,
		archiveEntries, retentionClean, retentionCleanLedger,
		loadWatermark, saveWatermark,
		appendObservation, readObservations,
		loadObservationWatermark, saveObservationWatermark,
		paths: { jsonl: jsonlPath, md: mdPath, milestones: milestonesPath, watermark: watermarkPath, observation: observationJsonlPath, observationWatermark: observationWatermarkPath, archiveDir: archiveDir(), journeyDir: journeyDir() }
	};
}

/**
 * 重启补扫（纯函数）：给定按时间序的会话消息事件列表（assistant/message 形态：
 * {type:"assistant/message", data:{message:{content...}, turn, step}}）与已存水位，
 * 返回水位之后待总结的消息事件。无水位时视为从 0 开始全量补扫。
 */
export function backfillFromSessionMessages(messages, watermark) {
	const lastSeq = watermark?.lastStepSeq ?? 0;
	const seen = new Set();
	if (watermark?.lastMessageId) seen.add(watermark.lastMessageId);
	const out = [];
	for (const ev of messages ?? []) {
		if (ev?.type !== "assistant/message") continue;
		const stepSeq = Number.isFinite(ev?.data?.step) ? ev.data.step
			: Number.isFinite(ev?.data?.message?.step) ? ev.data.message.step : null; // 兼容 step 在 message 内的 dump 形态
		const msgId = ev?.data?.message?.id ?? `${ev?.data?.turn ?? "?"}/${stepSeq ?? "?"}`;
		if (seen.has(msgId)) continue;
		if (stepSeq !== null && stepSeq <= lastSeq) continue;
		out.push(ev);
	}
	return out;
}
