/**
 * P2 novelty 单测：中文 3-gram MinHash 边界、selfcheck 解析、判定三分支（§5.2/§7.3）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	JACCARD_THRESHOLD, EMBEDDING_COSINE_THRESHOLD, SIGNATURE_PERMS,
	minhashSignature, signatureOf, estimatedJaccard, exactJaccard, lexicalCheck,
	cosine, parseSelfcheckJson, buildSelfcheckPrompt, decideNovelty
} from "../lib/novelty.js";
import { normalizeForNgram } from "../lib/textutil.js";

test("MinHash：相同文本签名一致、Jaccard=1；不同文本显著低于阈值", () => {
	const a = signatureOf("这是一段中文结论文本，用于测试最小哈希签名");
	const b = signatureOf("这是一段中文结论文本，用于测试最小哈希签名");
	assert.equal(a.length, SIGNATURE_PERMS);
	assert.deepEqual(Array.from(a), Array.from(b));
	assert.equal(estimatedJaccard(a, b), 1);
	const c = signatureOf("完全不同的另外一段话，讨论别的主题和方向");
	assert.ok(estimatedJaccard(a, c) < JACCARD_THRESHOLD);
});

test("exactJaccard：归一化后等价文本≈1，无公共 3-gram=0", () => {
	assert.ok(exactJaccard("ＡＢＣ测试文本", "abc测试文本") > 0.99);
	assert.ok(exactJaccard("甲乙丙丁戊", "己庚辛壬癸") === 0);
});

test("minhashSignature 返回固定长度有符号整型签名", () => {
	const sig = minhashSignature(normalizeForNgram("任意中文文本内容若干"));
	assert.equal(sig.length, SIGNATURE_PERMS);
});

test("lexicalCheck：词法命中返回 duplicate 与 duplicateOf", () => {
	const cand = [{ id: "j_0002", summary: "读取配置文件失败因为路径不存在" }];
	const hit = lexicalCheck("读取配置文件失败因为路径不存在", cand);
	assert.equal(hit.lexicalDuplicate, true);
	assert.equal(hit.duplicateOf, "j_0002");
	const miss = lexicalCheck("全新的方向：改用数据库索引优化查询计划", cand);
	assert.equal(miss.lexicalDuplicate, false);
	assert.equal(miss.duplicateOf ?? null, null);
	// 改进②：自定义阈值可改变判定结果（部分重叠文本：默认 0.8 miss、0.2 hit）
	const looser = lexicalCheck("读取配置文件失败因为目录不存在", cand, 0.2);
	assert.equal(looser.lexicalDuplicate, true);
	const stillMiss = lexicalCheck("读取配置文件失败因为目录不存在", cand);
	assert.equal(stillMiss.lexicalDuplicate, false, "默认阈值下部分重叠仍为 miss");
});

test("cosine：同向=1、正交≈0", () => {
	assert.ok(Math.abs(cosine([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
	assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});

test("cosine：零向量安全", () => {
	assert.equal(cosine([0, 0], [1, 1]), 0);
});

test("parseSelfcheckJson：围栏/裸 JSON/前后噪声/畸形", () => {
	assert.deepEqual(
		parseSelfcheckJson('```json\n{"novelty":"duplicate","duplicate_of":"j_0003"}\n```'),
		{ novelty: "duplicate", duplicate_of: "j_0003" }
	);
	assert.deepEqual(parseSelfcheckJson('前缀噪声 {"novelty":"new"} 后缀'), { novelty: "new", duplicate_of: null });
	assert.equal(parseSelfcheckJson("根本不是 JSON"), null);
	assert.equal(parseSelfcheckJson(null), null);
});

test("buildSelfcheckPrompt：含新结论与近期条目摘要", () => {
	const p = buildSelfcheckPrompt("新结论文本", [{ id: "j_0001", summary: "近期结论", step: 3 }]);
	assert.ok(p.includes("新结论文本"));
	assert.ok(p.includes("近期结论"));
});

test("decideNovelty 三分支（§5.2 规则）", () => {
	const lexHit = decideNovelty({ lexicalDuplicate: true, duplicateOf: "j_0001" }, null);
	assert.equal(lexHit.novelty, "duplicate");
	assert.equal(lexHit.semantic_duplicate, false);
	const semHit = decideNovelty({ lexicalDuplicate: false, duplicateOf: null }, { semanticDuplicate: true, duplicateOf: "j_0005" });
	assert.equal(semHit.novelty, "duplicate");
	assert.equal(semHit.semantic_duplicate, true);
	const nw = decideNovelty({ lexicalDuplicate: false, duplicateOf: null }, null);
	assert.equal(nw.novelty, "new");
	// 改进③：纯语义模式下 lexical=null 时仍能正确判定
	const semOnlyHit = decideNovelty(null, { semanticDuplicate: true, duplicateOf: "j_0002" });
	assert.equal(semOnlyHit.novelty, "duplicate");
	assert.equal(semOnlyHit.semantic_duplicate, true);
	const semOnlyMiss = decideNovelty(null, { semanticDuplicate: false, duplicateOf: null });
	assert.equal(semOnlyMiss.novelty, "new");
	assert.equal(semOnlyMiss.similarity, null);
	const noInfo = decideNovelty(null, null);
	assert.equal(noInfo.novelty, "new");
});

test("embedding 阈值常量", () => {
	assert.equal(EMBEDDING_COSINE_THRESHOLD, 0.85);
});
