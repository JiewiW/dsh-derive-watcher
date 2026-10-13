/**
 * dsh-derive-watcher — 语义停滞状态机（计划书 §5.5 + L2 契约 §2.2/§5.8）。
 *
 * 计数单位：每条成功总结的 assistant/message（summarizer 产出的 entry）。
 *  - duplicate 且无 new → stall+1；new → 归零（级动作状态不清）；
 *  - gap → 不增不减，另计 consecutiveGap，≥3 发 summarizer-degraded 且停滞响应暂停（保持不升级）；
 *  - 只有 semantic_duplicate=true 计入语义停滞升级；纯词法 duplicate 仅记账 + 发 lexical-repeat；
 *  - 重置边界：new 归零、真人 user 消息归零并清级动作状态、turn 边界不归零；
 *  - 阈值 stall1Steps<stall2Steps<stall3Steps（设置层已做倒挂校验）；
 *  - 每级进入动作一次：stall-1 注入+事件；stall-2 注入+L2 denyToolCategory("read",
 *    {code:"semantic-stall-2", ttlSteps: stall3-stall2})（enableStall2Deny=false 仅注入）；
 *    stall-3 L2 rejectStep({code:"semantic-stall"})+交接账本+种子导出（enableStall3Reject=false 仅告警）；
 *  - L2 不可用 fail-open：降级仅注入/仅告警，并发 semantic-watcher/execution-unavailable。
 *
 * 本模块不做注入与种子构建：返回动作结果，index.js 据此组装 pre-step 消息与写账本。
 */
import { EVT } from "./events.js";

/** intervention 载荷的可选附加字段（ttlSteps/expiresAtStep/pending）：仅当 L2 返回真实数字/布尔才写入。 */
const INTERVENTION_OPTIONAL_FIELDS = ["ttlSteps", "expiresAtStep", "pending"];

export function createStallController({
	emit = () => {},
	log = (line) => console.warn(line),
	getSettings = () => ({}),
	getL2 = null,
	writeHandoff = null,
	now = Date.now
} = {}) {
	const states = new Map();

	function stateFor(sessionId) {
		let s = states.get(sessionId);
		if (!s) {
			s = {
				stallCount: 0, consecutiveGap: 0, evidenceSeq: 0, actioned: { 1: false, 2: false, 3: false }, paused: false, lastLevel: 0,
				gapDegradedFired: false,
				// P0-8 观察旁路：连续无 text/产物 step 的 barren 窗口追踪（wall-clock）。
				watchRunCount: 0, watchRunStartTs: null, watchStall1Fired: false
			};
			states.set(sessionId, s);
		}
		return s;
	}

	function watchConfig() {
		const s = getSettings() ?? {};
		const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
		return { k: num(s.stallWatchSteps, 3), tMs: num(s.stallWatchWindowSec, 300) * 1000 };
	}

	function thresholds() {
		const s = getSettings() ?? {};
		const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
		return { t1: num(s.stall1Steps, 3), t2: num(s.stall2Steps, 6), t3: num(s.stall3Steps, 10) };
	}

	function buildWarning(level, evidenceSeq, stallCount, ttlSteps) {
		if (level === 1) {
			return `【语义监视 · stall-1】检测到连续 ${stallCount} 条重复结论（evidenceSeq=${evidenceSeq}）。当前方向可能已停滞：请回顾目标，改变方法或换一条路径，不要重复已尝试的操作。`;
		}
		if (level === 2) {
			return `【语义监视 · stall-2】连续重复已达 ${stallCount} 条（evidenceSeq=${evidenceSeq}）。读取类工具已临时限流（semantic-stall-2，TTL ${ttlSteps} 步）。请停止重试同一思路：改写假设、更换工具类别，或明确记录 dead-end 后切换方向。`;
		}
		return `【语义监视 · stall-3】连续重复已达 ${stallCount} 条（evidenceSeq=${evidenceSeq}）。本回合判定语义死锁：已生成交接班账与续跑种子。请结束本 turn，由下一会话凭种子继续，不要再发起新步骤。`;
	}

	/**
	 * v0.2.0 干预受理持久化：L2 调用成功受理后发 semantic-watcher/intervention。
	 * 复用 createEventSink（session.append ignorable），不开第二条落库通道。
	 * fail-soft：emit 自身异常只输出一行 log（默认 console.warn），绝不影响 stall 主流程与既有失败分支。
	 * 附加字段只取 L2 真实返回值：非数字/非布尔（含 undefined）一律省略，禁止编造字段。
	 */
	function emitIntervention(base, extra) {
		const payload = { ...base, action: extra.action, accepted: Boolean(extra.accepted), code: extra.code };
		for (const key of INTERVENTION_OPTIONAL_FIELDS) {
			const value = extra[key];
			if (typeof value === "number" || typeof value === "boolean") payload[key] = value;
		}
		try {
			emit(EVT.INTERVENTION, payload);
		} catch (error) {
			log(`[dsh-derive-watcher] intervention 事件发射失败（干预结果不受影响）: ${error?.message ?? error}`);
		}
	}

	/**
	 * gap 处理：连续 gap≥3 记 degraded 并提示总结质量降级。
	 * P0-8：不再置常驻 paused 冻结（此前 stalled.paused 阻断 escalate），
	 * gap 期改「降级继续计数」——总结不进账不阻断观察旁路的停滞检测。
	 */
	function onGap(sessionId, meta = {}) {
		const st = stateFor(sessionId);
		st.consecutiveGap += 1;
		if (st.consecutiveGap >= 3 && !st.gapDegradedFired) {
			st.gapDegradedFired = true;
			st.evidenceSeq += 1;
			emit(EVT.SUMMARIZER_DEGRADED, {
				sessionId, turn: meta.turn ?? null, step: meta.step ?? null, evidenceSeq: st.evidenceSeq,
				consecutiveGap: st.consecutiveGap,
				suppressReason: "总结质量降级（连续 gap ≥3）：不进账但停滞观测继续计数"
			});
		}
		return { consecutiveGap: st.consecutiveGap, paused: st.paused };
	}

	/**
	 * P0-8：观察旁路（onSummarized 之外直接喂的轻量 step 事件）。
	 * 连续 K 个「无 text 且无产物」的 step 且墙钟跨度 ≥ T 报一次 stall-1（watch 独立于总结阈值，幂等合一）。
	 * clock：跨调用注入 `now()`（默认 Date.now）供时钟推进单测，禁真实 sleep。
	 */
	function onObservation(sessionId, obs = {}) {
		const st = stateFor(sessionId);
		const ts = Number.isFinite(obs.ts) ? obs.ts : now();
		const { k, tMs } = watchConfig();
		// P0-2/P0-8：barren = 无 text、无产物、且无 reasoning 输出。
		// reasoning 有量（事故会话 186K reasoning）即视为活跃，不得误判为停滞。
		const barren = !obs.hasText && !obs.hasArtifact && !(obs.reasoningLen > 0);
		if (!barren) {
			// 有产出：清空 barren 窗口，视为活动
			st.watchRunCount = 0;
			st.watchRunStartTs = null;
			st.watchStall1Fired = false;
			return { level: 0, fired: false };
		}
		if (st.watchRunCount === 0) st.watchRunStartTs = ts;
		st.watchRunCount += 1;
		if (st.watchStall1Fired) return { level: 0, fired: false }; // 单次 run 已报过，不重复
		const spanMs = st.watchRunStartTs != null ? ts - st.watchRunStartTs : 0;
		if (st.watchRunCount >= k && spanMs >= tMs) {
			st.watchStall1Fired = true;
			st.lastLevel = Math.max(st.lastLevel, 1);
			emit(EVT.STALL, {
				sessionId, turn: obs.turn ?? null, step: obs.step ?? null, evidenceSeq: st.evidenceSeq,
				level: 1, stallCount: st.watchRunCount, spanMs, warning: buildWatchWarning(st.watchRunCount, spanMs / 1000)
			});
			log(`[dsh-derive-watcher] stall-1（wall-clock 观察） session=${sessionId} barrenRun=${st.watchRunCount} spanMs=${spanMs}`);
			return { level: 1, fired: true };
		}
		return { level: 0, fired: false, runCount: st.watchRunCount, spanMs };
	}

	function buildWatchWarning(runCount, spanSec) {
		return `【语义监视 · stall-1】连续 ${runCount} 个 step 未产出可见 text/产物（墙钟约 ${spanSec.toFixed(0)} 秒）。会话可能已空转停滞：请回顾目标，改变方法或换一条路径。`;
	}

	/**
	 * 吸收一批新落账 entry（按账本顺序逐条判定）。
	 * 返回 { level, warningText, evidenceSeq, escalated }（无升级时 level=0）。
	 */
	function onEntries(sessionId, entries) {
		let last = { level: 0, warningText: null, evidenceSeq: stateFor(sessionId).evidenceSeq, escalated: false };
		for (const entry of entries ?? []) {
			if (!entry || typeof entry !== "object") continue;
			const st = stateFor(sessionId);
			if (entry.novelty === "new") {
				st.stallCount = 0;
				st.consecutiveGap = 0;
				st.gapDegradedFired = false;
				st.paused = false; // 总结恢复产出 → 解除 gap 暂停
				st.watchRunCount = 0; st.watchRunStartTs = null; st.watchStall1Fired = false; // P0-8 复位观察窗口
				last = { level: 0, warningText: null, evidenceSeq: st.evidenceSeq, escalated: false };
				continue;
			}
			if (entry.novelty !== "duplicate") continue;
			st.stallCount += 1;
			if (entry.semantic_duplicate !== true) {
				// 纯词法重复：仅记账 + lexical-repeat，不计入停滞升级
				st.evidenceSeq += 1;
				emit(EVT.LEXICAL_REPEAT, {
					sessionId, turn: entry.turn ?? null, step: entry.step ?? null, evidenceSeq: st.evidenceSeq,
					duplicateOf: entry.duplicate_of ?? null, stallCount: st.stallCount
				});
				last = { level: 0, warningText: null, evidenceSeq: st.evidenceSeq, escalated: false };
				continue;
			}
			last = escalate(sessionId, entry);
		}
		return last;
	}

	function escalate(sessionId, entry) {
		const st = stateFor(sessionId);
		if (st.paused) return { level: 0, warningText: null, evidenceSeq: st.evidenceSeq, escalated: false, paused: true };
		const { t1, t2, t3 } = thresholds();
		const level = st.stallCount >= t3 && !st.actioned[3] ? 3
			: st.stallCount >= t2 && !st.actioned[2] ? 2
			: st.stallCount >= t1 && !st.actioned[1] ? 1 : 0;
		if (level === 0) return { level: 0, warningText: null, evidenceSeq: st.evidenceSeq, escalated: false };

		st.evidenceSeq += 1;
		st.actioned[level] = true;
		st.lastLevel = level;
		const evidenceSeq = st.evidenceSeq;
		const ttlSteps = Math.max(1, t3 - t2);
		const warningText = buildWarning(level, evidenceSeq, st.stallCount, ttlSteps);
		const base = { sessionId, turn: entry.turn ?? null, step: entry.step ?? null, evidenceSeq, level, stallCount: st.stallCount };
		emit(EVT.STALL, { ...base, warning: warningText, code: level === 2 ? "semantic-stall-2" : level === 3 ? "semantic-stall" : null });
		log(`[dsh-derive-watcher] stall level=${level} session=${sessionId} count=${st.stallCount} evidenceSeq=${evidenceSeq}`);

		const l2 = typeof getL2 === "function" ? getL2() : getL2;
		const settings = getSettings() ?? {};

		if (level === 2 && settings.enableStall2Deny !== false) {
			// L2 denyToolCategory：幂等键 (sessionId, evidenceSeq, code)；不可用 → fail-open 仅注入
			if (l2 && typeof l2.denyToolCategory === "function") {
				Promise.resolve()
					.then(() => l2.denyToolCategory(sessionId, "read", {
						code: "semantic-stall-2", evidenceSeq, ttlSteps
					}))
					.then((r) => {
						if (!r?.accepted) throw new Error(`deny 未受理: ${r?.reason ?? "unknown"}`);
						log(`[dsh-derive-watcher] L2 deny read session=${sessionId} expiresAtStep=${r.expiresAtStep ?? "?"}`);
						emitIntervention(base, {
							action: "deny-read", accepted: true, code: "semantic-stall-2",
							ttlSteps: ttlSteps, expiresAtStep: r.expiresAtStep
						});
					})
					.catch((error) => {
						emit(EVT.EXECUTION_UNAVAILABLE, {
							...base, suppressReason: `L2 step-governor denyToolCategory 不可用，stall-2 降级为仅注入: ${error?.message ?? error}`
						});
					});
			} else {
				emit(EVT.EXECUTION_UNAVAILABLE, {
					...base, suppressReason: "L2 step-governor 未就绪，stall-2 降级为仅注入"
				});
			}
		}

		if (level === 3) {
			// 交接账本 + 种子导出（index.js 注入 writeHandoff）；L2 rejectStep 幂等键 (sessionId, evidenceSeq)
			const failOpen = (suppressReason) => emit(EVT.EXECUTION_UNAVAILABLE, { ...base, suppressReason });
			if (typeof writeHandoff === "function") {
				Promise.resolve()
					.then(() => writeHandoff(sessionId, { evidenceSeq, stallCount: st.stallCount, turn: base.turn, step: base.step }))
					.then((r) => {
						if (r?.path) emit(EVT.HANDOFF_WRITTEN, { ...base, path: r.path, seedPath: r.seedPath ?? null });
					})
					.catch((error) => failOpen(`交接账本写入失败: ${error?.message ?? error}`));
			} else {
				failOpen("未配置交接账本回调（writeHandoff），stall-3 降级为仅告警");
			}
			if (settings.enableStall3Reject !== false) {
				if (l2 && typeof l2.rejectStep === "function") {
					Promise.resolve()
						.then(() => l2.rejectStep(sessionId, { code: "semantic-stall", evidenceSeq }))
						.then((r) => {
							if (!r?.accepted && !r?.pending) throw new Error(`reject 未受理: ${r?.reason ?? "unknown"}`);
							log(`[dsh-derive-watcher] L2 reject session=${sessionId} pending=${r.pending === true}`);
							emitIntervention(base, {
								action: "reject-step", accepted: r.accepted === true, code: "semantic-stall",
								pending: r.pending
							});
						})
						.catch((error) => failOpen(`L2 rejectStep 不可用，stall-3 降级为仅告警: ${error?.message ?? error}`));
				} else {
					failOpen("L2 step-governor 未就绪，stall-3 降级为仅告警");
				}
			}
		}

		return { level, warningText, evidenceSeq, escalated: true };
	}

	/** 真人 user 消息：计数与级动作状态全部归零（含观察窗口复位）。 */
	function onUserMessage(sessionId) {
		const st = stateFor(sessionId);
		st.stallCount = 0;
		st.consecutiveGap = 0;
		st.gapDegradedFired = false;
		st.paused = false;
		st.actioned = { 1: false, 2: false, 3: false };
		st.lastLevel = 0;
		st.watchRunCount = 0; st.watchRunStartTs = null; st.watchStall1Fired = false;
		return st;
	}

	function getSnapshot(sessionId) {
		const st = states.get(sessionId);
		return st ? { ...st, actioned: { ...st.actioned } } : null;
	}

	function resetState(sessionId) {
		states.delete(sessionId);
	}

	return { onEntries, onGap, onObservation, onUserMessage, escalate, getSnapshot, resetState, thresholds, buildWarning };
}
