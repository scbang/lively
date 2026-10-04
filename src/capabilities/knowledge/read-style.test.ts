// 지식 상세(knowledge_get)의 서술 형식 신호 테스트.
//
//  조직 지시는 «읽은 지식이 형식에 어긋나면 그 자리에서 고쳐라» 인데, 읽기 응답이 문서별 신호를 주지 않으면 에이전트는
//  어긋났는지 알 수 없다. 저장 응답과 같은 판정(면제·fail-open)을 읽기에도 건다.
//  회귀 대상 ①: 고칠 수 없는 글(외부 미러·폴더)이나 형식이 꺼진 조직에 신호가 실리는 것.
//  회귀 대상 ②: 형식 조회·검사 장애로 읽기가 실패하는 것.
//  회귀 대상 ③: 부분읽기가 잘라낸 줄만 판정해 뒤쪽 위반을 놓치는 것.
import assert from "node:assert/strict";
import { readStyleHint } from "../writing-style.js";
import { knowledgeGetResult } from "./read.js";
import { resolveWritingFormat } from "../../org/policies/writing-format.js";
import type { KnowledgeRow } from "../../v6/knowledge-store.js";

const on = async () => resolveWritingFormat({ enabled: true });
const off = async () => resolveWritingFormat({});
const row = (over: Partial<KnowledgeRow>): KnowledgeRow => ({
  name: "deploy-note", title: "배포 노트 범위", body_md: "노트는 직전 배포 이후 커밋을 싣는다.",
  injection: "recalled", provenance: "authored", lifecycle: "active", confidence: "high", source: "manual",
  summary: null, sort: 0, is_wiki: false, searchable: true, is_folder: false, version: 1, updated_at: "2026-10-01T00:00:00Z", ...over,
});
const BAD = row({ title: "🔴 배포 규칙 (2026-09-23)", body_md: "## 배경\n\n오늘 배포했다." });
type Style = { style?: { count: number; findings: Array<Record<string, unknown>>; note: string; guide_md?: unknown } };
let pass = 0;
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

await ta("위반이 있으면 count·findings·note 를 싣고 가이드 전문은 싣지 않는다", async () => {
  const st = ((await readStyleHint(BAD, on)) as Style).style!;
  assert.ok(st.count >= 4, String(st.count));
  assert.equal(st.findings.length, st.count);
  for (const want of ["title_leading_emoji", "title_date", "lead_missing", "relative_time"]) assert.ok(st.findings.some((f) => f.rule === want), want);
  for (const f of st.findings) assert.ok(typeof f.rule === "string" && typeof f.level === "string" && typeof f.message === "string");
  assert.match(st.note, /서술 형식/);
  assert.match(st.note, /mode='edit'/);
  assert.match(st.note, /knowledge_set_title/);
  assert.match(st.note, /style 이 더는 실리지 않을 때까지/);
  assert.equal(st.guide_md, undefined);
});
await ta("findings 는 앞 10건까지만 싣고 count 는 전체 건수다", async () => {
  // 위반 14건 표본(규칙마다 1건) — 잘림이 실제로 일어나는지 본다.
  const many = row({
    title: "🔴 " + "가".repeat(70) + " (2026-09-23) !1234 — 정정 — 부제",
    body_md: [
      "## ⚠ 정정", "", "> 폐기: 아래는 옛 내용이다.", "오늘 배포했다 → 확인 → 재배포 → 완료 → 끝.",
      "**a** **b** **c** **d** **e** **f** 🔴 ⚠ ✅ 🔴 ⚠ ✅ 이다.", "/Users/someone/a.md 에 있다.", "괄호(안에 (또 괄호) 있다)다.", "아직 대기 중이다.",
    ].join("\n"),
  });
  const st = ((await readStyleHint(many, on)) as Style).style!;
  assert.ok(st.count > 10, String(st.count));
  assert.equal(st.findings.length, 10);
});
await ta("위반이 없거나 형식이 꺼져 있으면 아무것도 싣지 않는다(빈 객체도 아니다)", async () => {
  assert.deepEqual(await readStyleHint(row({}), on), {});
  assert.deepEqual(await readStyleHint(BAD, off), {});
});
await ta("외부 미러와 폴더는 판정하지 않는다", async () => {
  let loaded = 0;
  const counted = async () => { loaded++; return on(); };
  assert.deepEqual(await readStyleHint({ ...BAD, provenance: "observed" }, counted), {});
  assert.deepEqual(await readStyleHint({ ...BAD, is_folder: true }, counted), {});
  assert.equal(loaded, 0, "면제면 형식도 읽지 않는다");
});
await ta("형식 조회가 실패하면 신호 없이 끝난다(throw 하지 않는다)", async () => {
  const boom = async (): Promise<never> => { throw new Error("db down"); };
  assert.deepEqual(await readStyleHint(BAD, boom), {});
});
await ta("판정이 터져도 신호 없이 끝난다", async () => {
  const broken = async () => ({ ...(await on()), apply_to: null as unknown as [] });
  assert.deepEqual(await readStyleHint(BAD, broken), {});
});

// 상세 응답 조립 — 핸들러가 DB 에서 읽은 뒤의 모양.
await ta("상세 응답에 style 이 실리고, 위반이 없으면 키 자체가 없다", async () => {
  const r = await knowledgeGetResult(BAD, {}, {}, on) as Style & { knowledge: KnowledgeRow };
  assert.equal(r.knowledge.name, "deploy-note");
  assert.ok(r.style && r.style.count > 0);
  const clean = await knowledgeGetResult(row({}), {}, {}, on);
  assert.ok(!("style" in clean), JSON.stringify(Object.keys(clean)));
});
await ta("형식 조회가 실패해도 상세 응답은 그대로 나간다", async () => {
  const boom = async (): Promise<never> => { throw new Error("db down"); };
  const r = await knowledgeGetResult(BAD, {}, { pending_revision: { id: 1 } }, boom) as Record<string, unknown>;
  assert.ok(r.knowledge && r.pending_revision);
  assert.ok(!("style" in r));
});
await ta("검토 대기 중인 수정 제안(staged)이 있으면 싣지 않는다(edit 가 막혀 안내를 따를 수 없다)", async () => {
  const staged = await knowledgeGetResult(BAD, {}, { pending_revision: { id: 1, mode: "staged" } }, on);
  assert.ok(!("style" in staged));
  const review = await knowledgeGetResult(BAD, {}, { pending_revision: { id: 1, mode: "applied" } }, on) as Style;
  assert.ok(review.style && review.style.count > 0, "staged 가 아닌 대기는 edit 가 막히지 않는다");
});
await ta("부분읽기도 잘라낸 줄이 아니라 본문 전체를 판정한다", async () => {
  // 위반(상대시간)은 맨 끝 줄에만 있다. 앞 2줄만 읽어도 신호가 실려야 한다.
  const body = ["노트는 직전 배포 이후 커밋을 싣는다.", ...Array.from({ length: 30 }, (_, i) => `항목 ${i + 1} 을 싣는다.`), "오늘 고쳤다."].join("\n");
  const r = await knowledgeGetResult(row({ body_md: body }), { offset: 1, limit: 2 }, {}, on) as Style & { knowledge: KnowledgeRow; body_range: { returned: number } };
  assert.equal(r.body_range.returned, 2);
  assert.doesNotMatch(r.knowledge.body_md, /오늘/);
  assert.ok(r.style?.findings.some((f) => f.rule === "relative_time"), JSON.stringify(r.style));
});
console.log(`read-style: ${pass} passed`);
