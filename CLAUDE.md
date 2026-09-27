# free-llm-router

본인 전용 앱에서 무료 LLM 을 폴백하며 쓰기 위한 라우터 (Android · iOS — Kotlin · Swift · KMP · Flutter · React Native) + 데스크톱용 LiteLLM 게이트웨이.

**새 세션은 먼저 `HANDOFF.md` 를 읽는다.** 배경, 확정된 결정, 공통 폴백 명세, 할 일이 거기 있다.

- `.env`, `local.properties` 등 키가 든 파일은 커밋하지 않는다
- 모델 목록의 기준은 `gateway/config.yaml` (추후 `spec/models.json` 으로 이전 예정)
