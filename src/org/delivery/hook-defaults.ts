// 세션 훅 기본값 — 너지 문구의 서버 '라이브 단일소스'(#270 재정립).
//  세션종료(stop-writeback-gate) 너지 전문. 어드민이 runtime-config.writeback_notice 로 덮어쓰지 않으면 이 값이 effective.
//  라이브 흐름: GET /api/ui/org/runtime-config 가 (override || 이 기본값)을 fold 해 서빙(delivery.ts) →
//    session-preload 가 매 세션 ~/.lively/hooks-config.json 에 기록 → 게이트가 그 값으로 너지. 설치 번들도 동일 fold(publish.ts:writeRuntimeBundle).
//  ⚠ kit/hooks/stop-writeback-gate.mjs 의 REASON 은 게이트웨이 영영 불가 시의 짧은 last-resort '스텁'일 뿐 — 이 전문과 동일할 필요 없다
//    (과거엔 동기화 요구였으나 #270 에서 라이브 단일소스로 이관 — 재설치 없이 이 값 수정만으로 다음 세션 반영).
//  웹 관리 UI(세션 주입 지도 ▸ 세션 종료)는 이 기본값을 노출해 '실제 값 표시 + 기본값으로 되돌리기'를 제공한다.
export const DEFAULT_WRITEBACK_NOTICE =
  "아직 기록하지 않은 작업만 마무리 전에 남기세요(세션당 1회). " +
  "작은 변경은 activity_log 1건으로 성격(type)·결과·project_id를 기록하고, 커밋했다면 commit_sha·repo·touches도 포함합니다. " +
  "도메인 should/is를 점검해 변화 없으면 checked_no_change, 변화 있으면 해당 카테고리·엣지를 갱신합니다. " +
  "새로 생긴 지속적 결정·설계·런북만 knowledge_save 전문+분류로 남겨 작업·프로젝트 산출물에 연결하세요. " +
  "외부 원문은 조직에 남길 가치가 있고 기존 미러에 없을 때만 source_save합니다. 중복 기록을 만들지 마세요. " +
  "진행한 프로젝트/태스크 상태를 갱신하되 기록을 위해 무관한 검색·새 과업을 만들지 않습니다. " +
  "상세 기록 규칙과 승인 경계는 세션 조직 지침을 따르세요. 기록할 것이 없으면 그대로 종료합니다.";
