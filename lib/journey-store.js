import {
	mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync, openSync, writeSync, closeSync
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const KINDS = ["finding", "decision", "dead-end", "hypothesis", "plan", "fact"];
/**
 * reasoning 通道 entry kind（推理过程提炼，非正式结论；r- 前缀与正式 KINDS 物理区分）。
 * 字面量映射：
 *   r-decision        = 推理中的决策
 *   r-hypothesis      = 假设/猜测
 *   r-self-correction = 自我修正
 *   r-dead-end        = 放弃的方案（死胡同）
 *   r-plan            = 下一步计划
 * 禁止收录"正式结论 / final answer / 事实"类内容（那些只能进 text 通道 KINDS）。
 */
export const REASONING_KINDS = ["r-decision", "r-hypothesis", "r-self-correction", "r-dead-end", "r-plan"];
/** 账本通道枚举：text=正式结论通道；reasoning=推理过程提炼通道。通道只能显式传入，禁止由 kind 字符串猜测。 */
export const CHANNELS = ["text", "reasoning"];
/** 观察类 entry 的 kind（P0-2：reasoning 观察走独立通道，不混入正式结论 KINDS；reasoning-stall 为推理停滞信号）。 */
export const OBSERVATION_KINDS = ["reasoning-observation", "reasoning-stall"];
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

/** 按通道取合法 kind 集合（通道显式传入，禁止由 kind 反推）。 */
function kindsForChannel(channel) {
	return channel === "reasoning" ? REASONING_KINDS : KINDS;
}

/**
 * entry 结构校验（§4.1 schema 必填域）。
 * @param {object} entry 待校验 entry
 * @param {"text"|"reasoning"} [channel="text"] 通道：决定 kind 合法集合（text=正式结论，reasoning=推理提炼）
 */
export function validateEntry(entry, channel = "text") {
	const errs = [];
	if (!entry || typeof entry !== "object") return ["entry 非对象"];
	if (!CHANNELS.includes(channel)) errs.push(`channel 非法: ${JSON.stringify(channel)}`);
	if (!/^j_\d{4,}$/.test(entry.id ?? "")) errs.push(`id 非法: ${JSON.stringify(entry.id)}`);
	if (!kindsForChannel(channel).includes(entry.kind)) {
		errs.push(`kind 非法(${channel} 通道): ${JSON.stringify(entry.kind)}`);
	}
	if (typeof entry.summary !== "string" || entry.summary.trim() === "") errs.push("summary 缺失");
	if (entry.novelty !== undefined && !["new", "duplicate"].includes(entry.novelty)) {
		errs.push(`novelty 非法: ${JSON.stringify(entry.novelty)}`);
	}
	return errs;
}

/**
 * 创建账本。emit(name,payload) 由调用方注入（发 store-corruption 等事件用）；
 * fsImpl 可注入假 fs 供单测。root 为账本根目录。
 *
 * 双通道物理隔离：
 *   text      → journey/<sid>.jsonl (+<sid>.md)，watermark/<sid>.json
 *   reasoning → journey/<sid>.reasoning.jsonl (+<sid>.reasoning.md)，watermark/<sid>.reasoning.json
 * 两通道 entry/水位/计数互不影响；readEntries/watermark/retention 均按通道独立。
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
	// text 正式结论通道账本
	const jsonlPath = (sid) => join(journeyDir(), `${sid}.jsonl`);
	const mdPath = (sid) => join(journeyDir(), `${sid}.md`);
	// reasoning 推理提炼通道账本（独立文件，物理隔离）
	const reasoningJsonlPath = (sid) => join(journeyDir(), `${sid}.reasoning.jsonl`);
	const reasoningMdPath = (sid) => join(journeyDir(), `${sid}.reasoning.md`);
	const milestonesPath = (sid) => join(journeyDir(), `${sid}.milestones.jsonl`);
	// 通道独立水位文件
	const watermarkPath = (sid) => join(watermarkDir(), `${sid}.json`);
	const reasoningWatermarkPath = (sid) => join(watermarkDir(), `${sid}.reasoning.json`);
	const observationJsonlPath = (sid) => join(observationDir(), `${sid}.jsonl`);
	const observationWatermarkPath = (sid) => join(watermarkDir(), `${sid}.observation.json`);

	const idCounters = new Map(); // counterKey(sessionId 或 sessionId+"reasoning") -> next number
	const dirEnsured = new Set();

	function ensureDir(dir) {
		if (dirEnsured.has(dir)) return;
		fs.mkdirSync(dir, { recursive: true });
		dirEnsured.add(dir);
	}

	/** 通道→counter key（reasoning 独立计数器，不与 text 抢号）。 */
	function counterKeyFor(sessionId, channel) {
		return channel === "reasoning" ? `${sessionId}reasoning` : sessionId;
	}

	/**
	 * 分配 entry id。通道独立计数：
	 * text 通道重启时从主账本+里程碑+归档恢复最大号；
	 * reasoning 通道只扫 <sid>.reasoning.jsonl（推理通道无里程碑/归档）。
	 */
	function nextEntryId(sessionId, channel = "text") {
		const key = counterKeyFor(sessionId, channel);
		if (!idCounters.has(key)) {
			let max = 0;
			if (channel === "reasoning") {
				try {
					for (const line of fs.readFileSync(reasoningJsonlPath(sessionId), "utf8").split("\n")) {
						const m = /"id":"(j_\d+)"/.exec(line);
						if (m) max = Math.max(max, Number(m[1].slice(2)));
					}
				} catch { /* 账本不存在 */ }
			} else {
				// 从现有账本恢复计数（重启不重号：主账本 + 里程碑 + 归档）
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
			}
			idCounters.set(key, max + 1);
		}
		const n = idCounters.get(key);
		idCounters.set(key, n + 1);
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
	 * @param {string} sessionId 会话 id
	 * @param {object} partial entry 字段
	 * @param {"text"|"reasoning"} [channel="text"] 通道：必须显式区分；text=正式结论账本，reasoning=推理提炼账本
	 * 返回 { ok:true, entry } | { ok:false, reason }。
	 */
	function appendEntry(sessionId, partial, channel = "text") {
		if (!CHANNELS.includes(channel)) {
			const reason = `appendEntry channel 非法: ${JSON.stringify(channel)}`;
			log(`[dsh-derive-watcher] corruption session=${sessionId} ${reason}`);
			emit("semantic-watcher/store-corruption", { sessionId, reason, stage: "validate" });
			return { ok: false, reason };
		}
		const ledgerPath = channel === "reasoning" ? reasoningJsonlPath(sessionId) : jsonlPath(sessionId);
		const mirrorPath = channel === "reasoning" ? reasoningMdPath(sessionId) : mdPath(sessionId);
		const entry = {
			id: partial.id ?? nextEntryId(sessionId, channel),
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
			channel,
			type: "entry"
		};
		if (entry.content_hash === null) entry.content_hash = contentHashOf(entry);
		const errs = validateEntry(entry, channel);
		if (errs.length > 0) {
			const reason = `entry 结构校验失败: ${errs.join("; ")}`;
			log(`[dsh-derive-watcher] corruption session=${sessionId} ${reason}`);
			emit("semantic-watcher/store-corruption", { sessionId, reason, stage: "validate" });
			return { ok: false, reason };
		}
		const line = JSON.stringify(entry);
		const r = appendJsonlLine(ledgerPath, line);
		if (!r.ok) {
			log(`[dsh-derive-watcher] corruption session=${sessionId} ${r.error}`);
			emit("semantic-watcher/store-corruption", { sessionId, reason: r.error, stage: "append", entryId: entry.id, channel });
			return { ok: false, reason: r.error };
		}
		const mdOk = mdAppend(mirrorPath,
			`- ${entry.id} [${entry.kind}] (turn=${entry.turn ?? "-"} step=${entry.step ?? "-"} novelty=${entry.novelty}) ${entry.summary}\n` +
			(entry.detail ? `  ${entry.detail.replace(/\n/g, "\n  ")}\n` : ""));
		if (!mdOk) {
			emit("semantic-watcher/store-corruption", { sessionId, reason: "md 镜像写入失败", stage: "md", entryId: entry.id, channel });
		}
		return { ok: true, entry };
	}

	/** gap 元行（不产出 entry、不参与停滞判定）。固定写 text 主账本。 */
	/**
	 * 记一条降级/跳过 gap。channel 决定写入的物理账本：
	 * reasoning 通道的 LLM 降级/溢出 gap 只能进 reasoning 账本，禁止污染 text 正式结论集合。
	 * @param {"text"|"reasoning"} [channel="text"]
	 */
	function appendGap(sessionId, gapInfo, channel = "text") {
		const safeChannel = CHANNELS.includes(channel) ? channel : "text";
		const gap = {
			type: "gap",
			ts: new Date().toISOString(),
			sessionId,
			channel: safeChannel,
			...gapInfo
		};
		const target = safeChannel === "reasoning" ? reasoningJsonlPath(sessionId) : jsonlPath(sessionId);
		const r = appendJsonlLine(target, JSON.stringify(gap));
		if (!r.ok) emit("semantic-watcher/store-corruption", { sessionId, reason: r.error, stage: "gap", channel: safeChannel });
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

	/** 读取时还原闭标签转写。 */
	function restoreEntryTags(e) {
		return { ...e, summary: restoreClosingTags(e.summary), detail: restoreClosingTags(e.detail) };
	}

	/** text 主账本 entry（读取时还原闭标签转写）。 */
	function readEntries(sessionId) {
		return readLines(jsonlPath(sessionId), "entry").map(restoreEntryTags);
	}

	/** reasoning 账本 entry（独立文件，绝不与 text 主账本互混）。 */
	function readReasoningEntries(sessionId) {
		return readLines(reasoningJsonlPath(sessionId), "entry").map(restoreEntryTags);
	}

	/** 主账本全部行（entry + gap），诊断用。 */
	function readAllLines(sessionId) {
		return readLines(jsonlPath(sessionId));
	}

	/**
	 * 全部 gap 行（总结跳过记录），timeline 呈现失败原因用。
	 * text 通道写主账本、reasoning 通道写独立账本，两本都必须读——否则 reasoning 降级在 timeline 里
	 * 只剩一条「总结质量降级」事件卡，既看不到跳过次数，也无法按 grade 合并降噪。
	 */
	function readGaps(sessionId) {
		return [
			...readLines(jsonlPath(sessionId), "gap"),
			...readLines(reasoningJsonlPath(sessionId), "gap")
		];
	}

	function readMilestones(sessionId) {
		return readLines(milestonesPath(sessionId), "entry").map(restoreEntryTags);
	}

	/**
	 * 追加一条观察事件（P0-2，独立通道，不写主结论账本）。观察为轻量快照，无 summary/detail，
	 * 只记录 {sid,turn,step,ts,hasText,textLen,reasoningLen,hasArtifact}。kind∈OBSERVATION_KINDS：
	 *   reasoning-observation（常规每步观察，默认）/ reasoning-stall（推理停滞信号，可带 message 文案）。
	 */
	function appendObservation(sessionId, obs) {
		const kind = OBSERVATION_KINDS.includes(obs?.kind) ? obs.kind : "reasoning-observation";
		const line = JSON.stringify({
			type: "observation",
			kind,
			ts: new Date().toISOString(),
			sessionId,
			turn: obs.turn ?? null,
			step: obs.step ?? null,
			hasText: obs.hasText === true,
			textLen: Number.isFinite(obs.textLen) ? obs.textLen : 0,
			reasoningLen: Number.isFinite(obs.reasoningLen) ? obs.reasoningLen : 0,
			hasArtifact: obs.hasArtifact === true,
			message: typeof obs.message === "string" && obs.message !== "" ? obs.message : null
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
	 * 且不动主账本。supersedes 链信息随行保留。仅 text 通道（reasoning 不做里程碑折叠）。
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

	/**
	 * P2-21③：主账本/gap 保留期清理——删除 mtime 早于 cutoff 的整个会话账本文件。返回被删文件列表。
	 * 后缀 .jsonl/.md/.milestones.jsonl 自动同时覆盖 text(<sid>.jsonl/<sid>.md) 与
	 * reasoning(<sid>.reasoning.jsonl/<sid>.reasoning.md) 两通道账本；watermark/ 下水位文件不在 journey/ 不受影响。
	 */
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
	// 双通道：text→<sid>.json，reasoning→<sid>.reasoning.json，互不影响。
	function channelWatermarkPath(sessionId, channel) {
		return channel === "reasoning" ? reasoningWatermarkPath(sessionId) : watermarkPath(sessionId);
	}

	function loadWatermark(sessionId, channel = "text") {
		try {
			const wm = JSON.parse(fs.readFileSync(channelWatermarkPath(sessionId, channel), "utf8"));
			if (wm && typeof wm === "object") {
				const seq = wm.lastStepSeq;
				const lastSeq = Number.isFinite(seq) ? seq : null;
				const lastMsg = typeof wm.lastMessageId === "string" ? wm.lastMessageId : null;
				if (lastSeq === null && lastMsg === null) return null;
				return { sessionId, channel, lastMessageId: lastMsg, lastStepSeq: lastSeq, ts: wm.ts ?? null };
			}
			return null;
		} catch {
			return null;
		}
	}

	function saveWatermark(sessionId, { lastMessageId, lastStepSeq }, channel = "text") {
		try {
			ensureDir(watermarkDir());
			fs.writeFileSync(channelWatermarkPath(sessionId, channel), JSON.stringify({
				sessionId, channel, lastMessageId: lastMessageId ?? null, lastStepSeq: lastStepSeq ?? 0, ts: new Date().toISOString()
			}, null, 2) + "\n", "utf8");
			return true;
		} catch (error) {
			emit("semantic-watcher/store-corruption", { sessionId, reason: `水位写入失败: ${error?.message ?? error}`, stage: "watermark", channel });
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
		readEntries, readReasoningEntries, readAllLines, readGaps, readMilestones,
		archiveEntries, retentionClean, retentionCleanLedger,
		loadWatermark, saveWatermark,
		appendObservation, readObservations,
		loadObservationWatermark, saveObservationWatermark,
		paths: {
			jsonl: jsonlPath,
			md: mdPath,
			reasoningJsonl: reasoningJsonlPath,
			reasoningMd: reasoningMdPath,
			milestones: milestonesPath,
			watermark: watermarkPath,
			reasoningWatermark: reasoningWatermarkPath,
			observation: observationJsonlPath,
			observationWatermark: observationWatermarkPath,
			archiveDir: archiveDir(),
			journeyDir: journeyDir()
		}
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
