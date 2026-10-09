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

export function createStallController({
	emit = () => {},
	log = (line) => console.warn(line),
	getSettings = () => ({}),
	getL2 = null,
	writeHandoff = null
} = {}) {
	const states = new Map();

	function stateFor(sessionId) {
		let s = states.get(sessionId);
		if (!s) {
			s = { stallCount: 0, consecutiveGap: 0, evidenceSeq: 0, actioned: { 1: false, 2: false, 3: false }, paused: false, lastLevel: 0 };
			states.set(sessionId, s);
		}
		return s;
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

	/** gap 处理：不增不减，≥3 记 degraded 并暂停停滞响应。 */
	function onGap(sessionId, meta = {}) {
		const st = stateFor(sessionId);
		st.consecutiveGap += 1;
		if (st.consecutiveGap === 3) {
			st.paused = true;
			st.evidenceSeq += 1;
			emit(EVT.SUMMARIZER_DEGRADED, {
				sessionId, turn: meta.turn ?? null, step: meta.step ?? null, evidenceSeq: st.evidenceSeq,
				consecutiveGap: st.consecutiveGap,
				suppressReason: "连续 gap ≥3：总结质量降级，停滞响应暂停（保持不升级）"
			});
		}
		return { consecutiveGap: st.consecutiveGap, paused: st.paused };
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
				st.paused = false; // 总结恢复产出 → 解除 gap 暂停
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
						})
						.catch((error) => failOpen(`L2 rejectStep 不可用，stall-3 降级为仅告警: ${error?.message ?? error}`));
				} else {
					failOpen("L2 step-governor 未就绪，stall-3 降级为仅告警");
				}
			}
		}

		return { level, warningText, evidenceSeq, escalated: true };
	}

	/** 真人 user 消息：计数与级动作状态全部归零。 */
	function onUserMessage(sessionId) {
		const st = stateFor(sessionId);
		st.stallCount = 0;
		st.consecutiveGap = 0;
		st.paused = false;
		st.actioned = { 1: false, 2: false, 3: false };
		st.lastLevel = 0;
		return st;
	}

	function getSnapshot(sessionId) {
		const st = states.get(sessionId);
		return st ? { ...st, actioned: { ...st.actioned } } : null;
	}

	function resetState(sessionId) {
		states.delete(sessionId);
	}

	return { onEntries, onGap, onUserMessage, escalate, getSnapshot, resetState, thresholds, buildWarning };
}
