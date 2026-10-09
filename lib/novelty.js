/**
 * dsh-derive-watcher — 新颖性判定（计划书 §5.2）。
 *
 * 词法层：中文归一化后字符 3-gram MinHash 估计 Jaccard，阈 0.8。
 * 语义层：总结 prompt 附最近 K=recentN 条 summary，schema 自检 novelty/duplicate_of；
 *         embedding 余弦 ≥ 0.85 可选（noveltyMode=embedding|both），无能力自动回退 selfcheck。
 * 规则：词法命中 → duplicate(semantic_duplicate=false)；
 *       词法未命中、语义命中 → duplicate(semantic_duplicate=true)；
 *       皆否 → new。
 */
import { normalizeForNgram, charTrigrams } from "./textutil.js";

export const JACCARD_THRESHOLD = 0.8;
export const EMBEDDING_COSINE_THRESHOLD = 0.85;
export const SIGNATURE_PERMS = 64;
const MERSENNE = 2147483647; // 2^31 - 1

function fnv1a(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** 固定排列族（同输入恒同签名；无需真随机）。 */
const PERMS = (() => {
	const list = [];
	for (let i = 0; i < SIGNATURE_PERMS; i++) {
		// a 为奇数保证双射；b 取稳定的伪随机
		const a = (2 * i + 1) * 2654435761 % MERSENNE;
		const b = fnv1a(`perm-${i}`) % MERSENNE;
		list.push([a, b]);
	}
	return list;
})();

/**
 * MinHash 签名：h_i(x) = (a_i * x + b_i) mod p，p=2^31-1。
 * @param {Set<string>} grams 3-gram 集合
 * @returns {Int32Array} 长度 SIGNATURE_PERMS
 */
export function minhashSignature(grams) {
	const sig = new Int32Array(SIGNATURE_PERMS).fill(MERSENNE);
	for (const g of grams) {
		const x = fnv1a(g) % MERSENNE;
		for (let i = 0; i < SIGNATURE_PERMS; i++) {
			const [a, b] = PERMS[i];
			// 大数乘法防溢出：拆位
			const hi = Math.floor(a / 46341);
			const lo = a % 46341;
			const v = ((hi * x + ((lo * x) % MERSENNE)) % MERSENNE + b) % MERSENNE;
			if (v < sig[i]) sig[i] = v;
		}
	}
	return sig;
}

/** 由原始文本直接取签名（空文本返回全 MERSENNE——调用方须先过滤空文本）。 */
export function signatureOf(text) {
	return minhashSignature(charTrigrams(normalizeForNgram(text)));
}

/** 估计 Jaccard：签名逐位相等比例。 */
export function estimatedJaccard(sigA, sigB) {
	if (!sigA || !sigB || sigA.length !== sigB.length) return 0;
	let eq = 0;
	for (let i = 0; i < sigA.length; i++) if (sigA[i] === sigB[i]) eq++;
	return eq / sigA.length;
}

/**
 * 纯 3-gram Jaccard（测试与边界校验用）。
 */
export function exactJaccard(textA, textB) {
	const a = charTrigrams(normalizeForNgram(textA));
	const b = charTrigrams(normalizeForNgram(textB));
	if (a.size === 0 && b.size === 0) return 1;
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const g of a) if (b.has(g)) inter++;
	const uni = a.size + b.size - inter;
	return inter / uni;
}

/**
 * 词法新颖性：返回 { lexicalDuplicate, similarity, duplicateOf|null }。
 * 在 candidates（[{id, summary, signature}]）里找第一个相似度 ≥ 阈的条目。
 */
export function lexicalCheck(text, candidates, threshold = JACCARD_THRESHOLD) {
	const sig = signatureOf(text);
	let best = { similarity: 0, duplicateOf: null };
	for (const c of candidates) {
		if (!c) continue;
		// 容错：候选未预计算签名时现算（调用方传 {id, summary} 裸形态仍可用）
		const csig = c.signature ?? (typeof c.summary === "string" && c.summary ? signatureOf(c.summary) : null);
		if (!csig) continue;
		const sim = estimatedJaccard(sig, csig);
		if (sim > best.similarity) best = { similarity: sim, duplicateOf: c.id ?? null };
	}
	return {
		lexicalDuplicate: best.similarity >= threshold,
		similarity: Number(best.similarity.toFixed(4)),
		duplicateOf: best.duplicateOf
	};
}

/** 余弦相似度（数值向量）。 */
export function cosine(vecA, vecB) {
	if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) return 0;
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < vecA.length; i++) {
		dot += vecA[i] * vecB[i];
		na += vecA[i] * vecA[i];
		nb += vecB[i] * vecB[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / Math.sqrt(na * nb);
}

/** 语义自检结果解析：接受 {novelty:"new"|"duplicate", duplicate_of} 或 {"is_duplicate":bool,...}。 */
export function parseSelfcheckJson(text) {
	if (typeof text !== "string") return null;
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const raw = fenced ? fenced[1] : text;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let obj;
	try {
		obj = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (obj === null || typeof obj !== "object") return null;
	let novelty = null;
	if (obj.novelty === "new" || obj.novelty === "duplicate") novelty = obj.novelty;
	else if (typeof obj.is_duplicate === "boolean") novelty = obj.is_duplicate ? "duplicate" : "new";
	if (novelty === null) return null;
	const dupOf = typeof obj.duplicate_of === "string" && obj.duplicate_of ? obj.duplicate_of
		: typeof obj.duplicate_of === "number" ? String(obj.duplicate_of) : null;
	return { novelty, duplicate_of: dupOf };
}

export const SELFCHECK_SYSTEM_PROMPT = [
	"你是语义新颖性判定器。给出【新总结】与【近期总结列表】，判断新总结是否与近期某条表达同一结论/发现（等价复述、仅措辞不同算 duplicate）。",
	"只输出一个 JSON 对象，字段：",
	'{"novelty":"new"|"duplicate","duplicate_of":"<命中的近期条目 id 或 null>"}',
	"禁止输出其它文字。"
].join("\n");

/** 构造 selfcheck 用户消息文本。 */
export function buildSelfcheckPrompt(newSummary, recentEntries) {
	const list = (recentEntries ?? []).map((e) => `- id=${e.id} ${e.summary}`).join("\n") || "（空）";
	return `【近期总结】\n${list}\n\n【新总结】\n${newSummary}\n\n请输出 JSON。`;
}

/**
 * embedding 语义检查：embed(text)->Promise<number[]|null> 由调用方注入（ctx.get("llm") 通路）。
 * 任一嵌入失败返回 { semanticDuplicate:false, fallback:true }（回退 selfcheck）。
 */
export async function embeddingCheck(text, candidates, embed, threshold = EMBEDDING_COSINE_THRESHOLD) {
	if (typeof embed !== "function") return { semanticDuplicate: false, fallback: true, duplicateOf: null };
	try {
		const v = await embed(text);
		if (!Array.isArray(v) || v.length === 0) return { semanticDuplicate: false, fallback: true, duplicateOf: null };
		let best = { sim: 0, duplicateOf: null };
		for (const c of candidates) {
			if (!Array.isArray(c.embedding)) continue;
			const sim = cosine(v, c.embedding);
			if (sim > best.sim) best = { sim, duplicateOf: c.id ?? null };
		}
		return {
			semanticDuplicate: best.sim >= threshold,
			fallback: false,
			duplicateOf: best.duplicateOf,
			similarity: Number(best.sim.toFixed(4))
		};
	} catch {
		return { semanticDuplicate: false, fallback: true, duplicateOf: null };
	}
}

/**
 * 汇总判定（§5.2 规则表）。输入：词法结果、语义结果（可 null=未启用/回退）。
 */
export function decideNovelty(lexical, semantic) {
	if (lexical.lexicalDuplicate) {
		return { novelty: "duplicate", semantic_duplicate: false, duplicate_of: lexical.duplicateOf, similarity: lexical.similarity };
	}
	if (semantic && semantic.semanticDuplicate) {
		return { novelty: "duplicate", semantic_duplicate: true, duplicate_of: semantic.duplicateOf, similarity: semantic.similarity ?? null };
	}
	return { novelty: "new", semantic_duplicate: false, duplicate_of: null, similarity: lexical.similarity };
}
