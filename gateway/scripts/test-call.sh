#!/bin/bash
# 게이트웨이가 응답하는지 한 번 호출해 본다.
# 사용: scripts/test-call.sh [그룹] [호스트]   예: scripts/test-call.sh fast 192.168.0.10
cd "$(dirname "$0")/.." || exit 1
[ -f .env ] && { set -a; . ./.env; set +a; }
curl -sS --max-time 60 "http://${2:-127.0.0.1}:4100/v1/chat/completions" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${1:-chat}\",\"messages\":[{\"role\":\"user\",\"content\":\"한 문장으로 인사해줘\"}]}" |
  jq -r '.choices[0].message.content // .'
