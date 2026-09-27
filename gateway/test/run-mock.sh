#!/bin/bash
# 모의 제공처로 게이트웨이(LiteLLM) 동작 확인. 실제 키·실제 제공처 호출 없음.
# 사용: gateway/test/run-mock.sh [--scenario 이름] [--port 4100] [--out 결과.json]
# 필요: Docker Desktop 실행 중, Node 18+. 이미지는 docker-compose.yml 과 같은 LiteLLM v1.101.0.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

# docker-compose.yml 문법 확인. .env 없이 보려고 env_file 만 비운다(.env 를 만들거나 읽지 않는다).
override="$(mktemp -t flr-compose).yml"
trap 'rm -f "$override"' EXIT
printf 'services:\n  litellm:\n    env_file: !reset []\n' > "$override"
docker compose -f "$here/../docker-compose.yml" -f "$override" config --quiet
echo "docker-compose.yml: OK"

node "$here/mock-scenarios.mjs" "$@"
