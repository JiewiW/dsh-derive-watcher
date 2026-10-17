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
/** intervention 载荷的可选字符串字段（soft-cut 请求的受理结果）：仅当为真实字符串才写入。 */
const INTERVENTION_STRING_FIELDS = ["reason", "delivery"];

export function createStallController({
	emit = () => {},
	log = (line) => console.warn(line),
	getSettings = () => ({}),
	getL2 = null,
	getCotAnchor = null,
	writeHandoff = null,
	// reasoning-only 停滞命中回调（由 index.js 注入：写 kind="reasoning-stall" 观察账本/走提示通道）。
	// 仅提示用途，禁止在此触发任何 deny/reject 升级。
	onReasoningStall = null,
	now = Date.now
} = {}) {
	const states = new Map();

	function stateFor(sessionId) {
		let s = states.get(sessionId);
		if (!s) {
			s = {
				stallCount: 0, consecutiveGap: 0, evidenceSeq: 0, actioned: { 1: false, 2: false, 3: false }, paused: false, lastLevel: 0,
				lexicalCount: 0, lexicalStallFired: false, // 词法复读独立计数（改进④）
				gapDegradedFired: false,
				// P0-8 观察旁路：连续无 text/产物 step 的 barren 窗口追踪（wall-clock）。
				watchRunCount: 0, watchRunStartTs: null, watchStall1Fired: false,
				// reasoning-only 独立停滞窗口：连续「仅 reasoning、无 text/产物」step 追踪。
				// 与 text barren 窗口完全独立计数；命中后只发 REASONING_STALL 提示信号并清空重计，绝不升级 deny/reject。
				rWatchRunCount: 0, rWatchStartTs: null
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

	/** reasoning-only 停滞窗口配置（独立阈值，不挂 enableInjection 联动；默认 6 步 / 300 秒）。 */
	function reasoningWatchConfig() {
		const s = getSettings() ?? {};
		const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
		return {
			k: num(s.reasoningStallWatchSteps, 6),
			tMs: num(s.reasoningStallWatchWindowSec, 300) * 1000
		};
	}

	function thresholds() {
		const s = getSettings() ?? {};
		const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
		return { t1: num(s.stall1Steps, 3), t2: num(s.stall2Steps, 6), t3: num(s.stall3Steps, 10) };
	}

	/** stall code 按触发来源派生：词法复读升级与语义升级区分 code（改进①）。 */
	function stallCode(level, origin) {
		if (level === 2) return origin === "lexical" ? "lexical-stall-2" : "semantic-stall-2";
		if (level === 3) return origin === "lexical" ? "lexical-stall" : "semantic-stall";
		return null;
	}

	/** 词法复读独立警告文案（改进④；仅提示，不升级/不拦截）。 */
	function buildLexicalWarning(count) {
		return `【语义监视 · 词法复读停滞】连续 ${count} 条回复与最近文本近乎逐字重复，疑似陷入复读。请改变措辞、补充新论点，或明确中止当前输出路径。`;
	}

	function buildWarning(level, evidenceSeq, stallCount, ttlSteps, origin = "semantic") {
		const label = origin === "lexical" ? "词法复读" : "语义";
		const code = stallCode(level, origin);
		if (level === 1) {
			return `【语义监视 · stall-1（${label}）】检测到连续 ${stallCount} 条重复结论（evidenceSeq=${evidenceSeq}）。当前方向可能已停滞：请回顾目标，改变方法或换一条路径，不要重复已尝试的操作。`;
		}
		if (level === 2) {
			return `【语义监视 · stall-2（${label}）】连续重复已达 ${stallCount} 条（evidenceSeq=${evidenceSeq}）。读取类工具已临时限流（${code}，TTL ${ttlSteps} 步）。请停止重试同一思路：改写假设、更换工具类别，或明确记录 dead-end 后切换方向。`;
		}
		return `【语义监视 · stall-3（${label}）】连续重复已达 ${stallCount} 条（evidenceSeq=${evidenceSeq}）。本回合判定语义死锁：已生成交接班账与续跑种子。请结束本 turn，由下一会话凭种子继续，不要再发起新步骤。`;
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
		for (const key of INTERVENTION_STRING_FIELDS) {
			const value = extra[key];
			if (typeof value === "string" && value.length > 0) payload[key] = value;
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
	/** 清空 reasoning-only 独立停滞窗口（步数/起点）。命中后或序列中断时调用。 */
	function resetReasoningWatch(st) {
		st.rWatchRunCount = 0;
		st.rWatchStartTs = null;
	}

	/**
	 * 步骤4：推进 reasoning-only 独立停滞窗口。
	 * 连续 reasoning-only 步数 ≥ reasoningStallWatchSteps 且首末墙钟跨度 ≥ reasoningStallWatchWindowSec
	 * 两个条件同时满足才命中一次；命中即清空窗口重计（同窗口不重复报）。
	 * 仅发 EVT.REASONING_STALL 提示信号 + onReasoningStall 回调（写观察账本），
	 * 绝不触碰 stall-2/3 的 deny/reject 升级（升级仍只由 onEntries 驱动）。
	 * clock：obs.ts 注入，禁真实 sleep。
	 */
	function trackReasoningWatch(st, sessionId, obs, ts) {
		const { k, tMs } = reasoningWatchConfig();
		if (st.rWatchRunCount === 0) st.rWatchStartTs = ts;
		st.rWatchRunCount += 1;
		const spanMs = st.rWatchStartTs != null ? ts - st.rWatchStartTs : 0;
		if (st.rWatchRunCount >= k && spanMs >= tMs) {
			const runCount = st.rWatchRunCount;
			const message = buildReasoningWatchWarning(runCount, spanMs / 1000);
			// 命中即清空窗口重新计数：同一连续序列只报一次，后续再次连续达标可再报。
			resetReasoningWatch(st);
			emit(EVT.REASONING_STALL, {
				sessionId, turn: obs.turn ?? null, step: obs.step ?? null,
				level: 0, reasoningRunCount: runCount, spanMs, warning: message
			});
			if (typeof onReasoningStall === "function") {
				try {
					onReasoningStall(sessionId, {
						turn: obs.turn ?? null, step: obs.step ?? null,
						reasoningRunCount: runCount, spanMs, message
					});
				} catch (err) {
					log(`[dsh-derive-watcher] onReasoningStall 回调失败（不影响停滞判定） session=${sessionId} err=${err?.message || err}`);
				}
			}
			log(`[dsh-derive-watcher] reasoning-stall（仅推理无正式输出） session=${sessionId} reasoningRun=${runCount} spanMs=${spanMs}`);
			return { reasoningFired: true, reasoningRunCount: runCount, reasoningSpanMs: spanMs };
		}
		return { reasoningFired: false, reasoningRunCount: st.rWatchRunCount, reasoningSpanMs: spanMs };
	}

	function onObservation(sessionId, obs = {}) {
		const st = stateFor(sessionId);
		const ts = Number.isFinite(obs.ts) ? obs.ts : now();
		const { k, tMs } = watchConfig();
		// P0-2/P0-8：barren = 无 text、无产物、且无 reasoning 输出。
		// reasoning 有量（事故会话 186K reasoning）即视为活跃，不得误判为停滞。
		const hasProduct = Boolean(obs.hasText) || Boolean(obs.hasArtifact);
		const reasoningOnly = !hasProduct && obs.reasoningLen > 0;
		const barren = !hasProduct && !(obs.reasoningLen > 0);

		// 步骤4：reasoning-only 独立窗口，与下方 text barren 窗口完全独立计数。
		// 连续 reasoning-only 才累计；任一 text/产物或完全空转都中断该连续序列（规格 4.2）。
		const reasoningResult = reasoningOnly
			? trackReasoningWatch(st, sessionId, obs, ts)
			: (resetReasoningWatch(st), { reasoningFired: false, reasoningRunCount: 0, reasoningSpanMs: 0 });

		if (!barren) {
			// 有产出（含 reasoning-only）：清空 text barren 窗口，视为活跃
			st.watchRunCount = 0;
			st.watchRunStartTs = null;
			st.watchStall1Fired = false;
			return { level: 0, fired: false, ...reasoningResult };
		}
		if (st.watchRunCount === 0) st.watchRunStartTs = ts;
		st.watchRunCount += 1;
		if (st.watchStall1Fired) return { level: 0, fired: false, ...reasoningResult }; // 单次 run 已报过，不重复
		const spanMs = st.watchRunStartTs != null ? ts - st.watchRunStartTs : 0;
		if (st.watchRunCount >= k && spanMs >= tMs) {
			st.watchStall1Fired = true;
			st.lastLevel = Math.max(st.lastLevel, 1);
			emit(EVT.STALL, {
				sessionId, turn: obs.turn ?? null, step: obs.step ?? null, evidenceSeq: st.evidenceSeq,
				level: 1, stallCount: st.watchRunCount, spanMs, warning: buildWatchWarning(st.watchRunCount, spanMs / 1000)
			});
			log(`[dsh-derive-watcher] stall-1（wall-clock 观察） session=${sessionId} barrenRun=${st.watchRunCount} spanMs=${spanMs}`);
			return { level: 1, fired: true, ...reasoningResult };
		}
		return { level: 0, fired: false, runCount: st.watchRunCount, spanMs, ...reasoningResult };
	}

	function buildWatchWarning(runCount, spanSec) {
		return `【语义监视 · stall-1】连续 ${runCount} 个 step 未产出可见 text/产物（墙钟约 ${spanSec.toFixed(0)} 秒）。会话可能已空转停滞：请回顾目标，改变方法或换一条路径。`;
	}

	/** reasoning-only 停滞提示文案（区别于普通 stall-1；明确「非正式结论」、只提示不拦截）。 */
	function buildReasoningWatchWarning(runCount, spanSec) {
		return `【语义监视 · 推理停滞】连续 ${runCount} 个 step 仅产出推理过程（reasoning）而无正式 text/产物（墙钟约 ${spanSec.toFixed(0)} 秒）。推理过程提炼仅为非正式结论、不代表已确认事实：请尽快形成可见结论或产物，避免长时间只思考不输出（本提示不拦截任何动作）。`;
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
				st.lexicalCount = 0; st.lexicalStallFired = false; // 改进④：新内容落账复位词法复读连续计数
				resetReasoningWatch(st); // 步骤4：正式结论落账视为活跃，复位 reasoning-only 窗口
				last = { level: 0, warningText: null, evidenceSeq: st.evidenceSeq, escalated: false };
				continue;
			}
			if (entry.novelty !== "duplicate") continue;
			st.stallCount += 1;
			if (entry.semantic_duplicate !== true) {
				// 纯词法重复：默认仅记账 + lexical-repeat，不计入停滞升级
				st.evidenceSeq += 1;
				st.lexicalCount += 1;
				emit(EVT.LEXICAL_REPEAT, {
					sessionId, turn: entry.turn ?? null, step: entry.step ?? null, evidenceSeq: st.evidenceSeq,
					duplicateOf: entry.duplicate_of ?? null, stallCount: st.stallCount, lexicalCount: st.lexicalCount
				});
				const s = getSettings() ?? {};
				// 改进①：词法重复计入升级（enableLexicalStallCount=true 时走 escalate origin="lexical"）
				last = s.enableLexicalStallCount === true
					? escalate(sessionId, entry, "lexical")
					: { level: 0, warningText: null, evidenceSeq: st.evidenceSeq, escalated: false };
				// 改进④：独立词法复读警告通道（lexicalStallSteps>0 且连续达标且未发过）
				const ls = Number(s.lexicalStallSteps);
				const lsSteps = Number.isFinite(ls) && ls > 0 ? Math.round(ls) : 0;
				if (lsSteps > 0 && st.lexicalCount >= lsSteps && !st.lexicalStallFired) {
					st.lexicalStallFired = true;
					emit(EVT.LEXICAL_STALL, {
						sessionId, turn: entry.turn ?? null, step: entry.step ?? null, evidenceSeq: st.evidenceSeq,
						level: 1, lexicalCount: st.lexicalCount, stallCount: st.stallCount,
						warning: buildLexicalWarning(st.lexicalCount)
					});
					log(`[dsh-derive-watcher] lexical-stall（词法复读） session=${sessionId} count=${st.lexicalCount} evidenceSeq=${st.evidenceSeq}`);
				}
				continue;
			}
			st.lexicalCount = 0; // 语义重复打断词法复读连续序列（改进④ 计数口径）
			last = escalate(sessionId, entry);
		}
		return last;
	}

	function escalate(sessionId, entry, origin = "semantic") {
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
		const warningText = buildWarning(level, evidenceSeq, st.stallCount, ttlSteps, origin);
		const base = { sessionId, turn: entry.turn ?? null, step: entry.step ?? null, evidenceSeq, level, stallCount: st.stallCount };
		const code = stallCode(level, origin);
		emit(EVT.STALL, { ...base, warning: warningText, code });
		log(`[dsh-derive-watcher] stall level=${level} origin=${origin} session=${sessionId} count=${st.stallCount} evidenceSeq=${evidenceSeq}`);

		const l2 = typeof getL2 === "function" ? getL2() : getL2;
		const settings = getSettings() ?? {};

		if (level === 2 && settings.enableStall2Deny !== false) {
			// L2 denyToolCategory：幂等键 (sessionId, evidenceSeq, code)；不可用 → fail-open 仅注入
			if (l2 && typeof l2.denyToolCategory === "function") {
				Promise.resolve()
					.then(() => l2.denyToolCategory(sessionId, "read", {
						code: stallCode(2, origin), evidenceSeq, ttlSteps
					}))
					.then((r) => {
						if (!r?.accepted) throw new Error(`deny 未受理: ${r?.reason ?? "unknown"}`);
						log(`[dsh-derive-watcher] L2 deny read session=${sessionId} expiresAtStep=${r.expiresAtStep ?? "?"}`);
						emitIntervention(base, {
							action: "deny-read", accepted: true, code: stallCode(2, origin),
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

		if (level === 2 && settings.enableStall2SoftCut === true) {
			// L2 cot-anchor 软切请求：与上方 denyToolCategory 相互独立、可同时开启。
			// 复用 st.actioned[2] 天然只触发一次；requestSoftCut 为覆盖式挂起，重复调用安全。
			// fail-open：服务缺失/拒绝只发 EXECUTION_UNAVAILABLE，绝不抛断 stall 主流程。
			const anchorService = typeof getCotAnchor === "function" ? getCotAnchor() : getCotAnchor;
			if (anchorService && typeof anchorService.requestSoftCut === "function") {
				// entry 承载最近文本的字段是 summary（journey-store validateEntry 强制非空字符串）；
				// 仅在确为非空字符串时传递，取不到传 null，禁止捏造文本。
				const visibleSummary = typeof entry?.summary === "string" && entry.summary.trim().length > 0
					? entry.summary
					: null;
				Promise.resolve()
					.then(() => anchorService.requestSoftCut({
						sessionId,
						turn: base.turn,
						step: base.step,
						reason: stallCode(2, origin),
						evidenceSeq,
						fullVisibleText: visibleSummary
					}))
					.then((r) => {
						if (r?.accepted !== true) {
							throw new Error(`软切未受理: ${r?.reason ?? "unknown"}`);
						}
						log(`[dsh-derive-watcher] L2 soft-cut requested session=${sessionId} delivery=${r.delivery ?? "?"}`);
						emitIntervention(base, {
							action: "soft-cut-request", accepted: true, code: stallCode(2, origin),
							reason: r.reason ?? null, delivery: r.delivery ?? null
						});
					})
					.catch((error) => {
						emit(EVT.EXECUTION_UNAVAILABLE, {
							...base, suppressReason: `cot-anchor requestSoftCut 不可用，stall-2 软切降级为仅注入: ${error?.message ?? error}`
						});
					});
			} else {
				emit(EVT.EXECUTION_UNAVAILABLE, {
					...base, suppressReason: "cot-anchor 服务未就绪，stall-2 软切降级为仅注入"
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
						.then(() => l2.rejectStep(sessionId, { code: stallCode(3, origin), evidenceSeq }))
						.then((r) => {
							if (!r?.accepted && !r?.pending) throw new Error(`reject 未受理: ${r?.reason ?? "unknown"}`);
							log(`[dsh-derive-watcher] L2 reject session=${sessionId} pending=${r.pending === true}`);
							emitIntervention(base, {
								action: "reject-step", accepted: r.accepted === true, code: stallCode(3, origin),
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
		st.lexicalCount = 0; st.lexicalStallFired = false; // 改进④：真人介入复位词法复读计数
		resetReasoningWatch(st); // 步骤4：真人介入同样复位 reasoning-only 停滞窗口
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
