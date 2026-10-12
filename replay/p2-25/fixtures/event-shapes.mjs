/**
 * 统一事件夹具 —— P2-25 事务四线失效端到端红绿回归测试。
 *
 * 只构造夹具，不改任何产品代码。所有形状依据 DSH 真实运行事件核实：
 *   - agent-loop 安装副本 appendToolResult（定义 @deepseek-ai/dsh-agent-loop/lib/index.js:798；
 *     主路径调用 :678、tool-call 恢复路径 :772）：
 *       session.append("tool/result", {turn, step, message, ...(error?.info ? {error} : {}), ...(meta!==undefined ? {meta} : {})}, ...)
 *     message = createToolResultMessage({callId, content, isError})（dsh-llm lib/types/message.js:92-100）
 *   - tool/call（appendToolCall 定义 agent-loop lib/index.js:788；调用 :687/:771）：
 *       session.append("tool/call", {turn, step, callId, name, arguments})
 *   - assistant/message（agent-loop lib/index.js:1522/:1599/:1636）：
 *       {turn, step, message: {content, source:{provider,model,...}}, interrupted?, usage?, stream}
 *     source.kind = "model"（:64-72）；content 为 text/reasoning blocks 数组。
 *   - user/message（agent-loop lib/index.js:1351）：session.append("user/message", message) ——
 *     事件 data 即 message 本体（real user 的 source.kind="user"；source.plugin 注入的消息
 *     data.source = {kind:"plugin:<id>", plugin:<id>}）。
 */

// 与三大插件一致的插件标识（watcher events.js PLUGIN_ID / governor PLUGIN_ID）。
export const WATCHER_PLUGIN_ID = "dsh-derive-watcher";
export const GOVERNOR_PLUGIN_ID = "dsh-step-governor";
export const COTANCHOR_PLUGIN_ID = "dsh-cot-anchor";

/** 造一个稳定 message id（品牌串，来自 createMessage randomUUID 语义）。 */
function newMessageId(callId) {
	// 真实 initUuid 为 randomUUID；此处用确定性值即可，id 仅用于去重键。
	return `msg_${callId ?? Math.random().toString(36).slice(2, 10)}`;
}

/**
 * tool/result 事件（agent-loop appendToolResult 真实形状）。
 * @param {{turn:number, step:number, callId:string, name?:string, content?:unknown,
 *          isError?:boolean, error?:object}} opts
 *   - error：成功结果为 undefined；失败时传 {message, info:{plugin?, rule?, ...}}，
 *     buildToolResult 会把 error.info 提升到事件 data 顶层 error（与 appendToolResult 一致）。
 *     顶层 error 缺失即代表"该结果非 deny"——这正是断言④的负对照前提。
 * @returns {{type:"tool/result", data:object}}
 */
export function buildToolResult({ turn, step, callId, name = "read", arguments: args = {}, content = "ok", isError = false, error = undefined } = {}) {
	const message = {
		role: "tool",
		source: { kind: "tool", callId },
		toolCallId: callId,
		content,
		isError,
		id: newMessageId(callId)
	};
	const data = { turn, step, message };
	if (error && typeof error === "object" && error.info && typeof error.info === "object") {
		// allowToolResult 把 result.error.info 提升为事件 data 顶层 error。
		data.error = error.info;
	} else if (error && typeof error === "object") {
		data.error = error;
	}
	return { type: "tool/result", data };
}

/** tool/call 事件（agent-loop lib/index.js:788 appendToolCall 真实形状）。 */
export function buildToolCall({ turn, step, callId, name, arguments: args = {} } = {}) {
	return { type: "tool/call", data: { turn, step, callId, name, arguments: args } };
}

/**
 * assistant/message 事件真实形状。
 * @param {{turn:number, step:number, content:Array<{type:string,text:string}>,
 *          reasoning?:string, text?:string, source?:object, id?:string}} opts
 *   reasoning/text 二选一辅助生成 content；纯 reasoning（reasoning 有值、text 空）
 *   即"reasoning-only step"夹具（断言②）。
 */
export function buildAssistantMessage({ turn, step, reasoning = "", text = "", source = { kind: "model", provider: "deepseek", model: "deepseek-chat" }, id } = {}) {
	const content = [];
	if (reasoning) content.push({ type: "reasoning", text: reasoning });
	if (text) content.push({ type: "text", text });
	return {
		type: "assistant/message",
		data: { turn, step, message: { content, source, id: id ?? newMessageId() } }
	};
}

/**
 * user/message 事件（agent-loop lib/index.js:1351 真实形状：data 即 message 本体）。
 * @param {{source?:object, content?:Array, text?:string, id?:string}} opts
 *   source.kind="user" 表示真人（governor noteEvent :497 判定依据）；
 *   source.plugin=<id> 表示插件系统注入（watcher 理想应据此不算真人，见断言⑥）。
 */
export function buildUserMessage({ source = { kind: "user" }, text = "继续", id } = {}) {
	return {
		type: "user/message",
		data: { role: "user", content: [{ type: "text", text }], source, id: id ?? newMessageId() }
	};
}