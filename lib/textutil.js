/**
 * dsh-derive-watcher — 文本工具：token 估算、中文归一化（novelty 共用）、句界裁剪。
 */

/** 粗估 token：CJK 记 1 token/字，拉丁按 4 字符 1 token（预算门用途，不需要精确）。 */
export function estimateTokens(text) {
	if (typeof text !== "string" || text.length === 0) return 0;
	let cjk = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0);
		if (c >= 0x2e80) cjk++;
	}
	const latin = text.length - cjk;
	return cjk + Math.ceil(latin / 4);
}

/**
 * 中文归一化（novelty 3-gram 前置）：NFKC、全角→半角、去空白与标点、英文小写。
 * 只保留字母数字与 CJK。
 */
export function normalizeForNgram(text) {
	if (typeof text !== "string") return "";
	let s = text.normalize("NFKC").toLowerCase();
	let out = "";
	for (const ch of s) {
		const c = ch.codePointAt(0);
		const isAsciiAlnum = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
		const isCjk = c >= 0x2e80;
		if (isAsciiAlnum || isCjk) out += ch;
	}
	return out;
}

/** 字符 3-gram 集合（长度不足 3 时退化为整串单元素）。 */
export function charTrigrams(normalized) {
	const set = new Set();
	if (normalized.length < 3) {
		if (normalized) set.add(normalized);
		return set;
	}
	for (let i = 0; i + 3 <= normalized.length; i++) set.add(normalized.slice(i, i + 3));
	return set;
}

const SENTENCE_END_RE = /[。！？!?；;\n.]/u;

/**
 * 句界裁剪：把 text 缩到 ≤maxChars（按字符近似 token 预算用），在句界截断；
 * 无法在预算内放下任何整句时返回 null（调用方走整条剔除）。
 * 禁止截断单条中间——返回值必为完整句子序列。
 */
export function trimToSentence(text, maxChars) {
	if (typeof text !== "string") return null;
	if (text.length <= maxChars) return text;
	let out = "";
	let i = 0;
	while (i < text.length) {
		const nextEnd = text.slice(i).search(SENTENCE_END_RE);
		if (nextEnd < 0) {
			// 无句界剩余：如果已有内容则停（不截中间），否则整条放弃
			return out.length > 0 ? out : null;
		}
		const end = i + nextEnd + 1;
		const sentence = text.slice(i, end);
		if (out.length + sentence.length >= maxChars) break; // 恰等于预算视为放不下（保留余量口径）
		out += sentence;
		i = end;
		if (out.length >= maxChars) break;
	}
	return out.length > 0 ? out : null;
}
