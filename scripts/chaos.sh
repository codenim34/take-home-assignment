#!/usr/bin/env bash
# Exercises the failure modes from the brief against a running `docker compose up`.
# Usage: scripts/chaos.sh [restart|kill|flush|supersede]   (default: all)
# Tip: run the stack with FAKE_LLM_DELAY_MS=8000 LLM_PROVIDER=fake for a wide window,
# or with a real key (extraction takes a few seconds anyway).
set -euo pipefail
API=${API:-http://localhost:8080/api}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DOCS="$ROOT/fixtures/documents"

status() { curl -s "$API/documents/$1/progress"; echo; }
new_doc() { curl -s -F type=lease -F "title=chaos $1" -F "file=@$DOCS/lease-excerpt-001.pdf" "$API/documents" | sed -E 's/.*"id":"([^"]+)".*/\1/'; }
wait_done() {
  for _ in $(seq 1 60); do
    s=$(curl -s "$API/documents/$1/progress")
    case "$s" in *'"status":"extracted"'*|*'"status":"failed"'*) echo "  -> $s"; return 0;; esac
    sleep 2
  done
  echo "  -> STILL NOT DONE: $s"; return 1
}

restart() {
  echo "== docker compose restart mid-extraction"
  id=$(new_doc restart); sleep 1; status "$id"
  docker compose restart
  wait_done "$id"
}

kill_worker() {
  echo "== SIGKILL the worker mid-extraction, then start it again"
  id=$(new_doc kill); sleep 1; status "$id"
  docker compose kill -s SIGKILL worker; docker compose start worker
  wait_done "$id"
}

flush() {
  echo "== FLUSHALL on Redis mid-extraction, then restart the stack"
  id=$(new_doc flush); sleep 1; status "$id"
  docker compose exec -T redis redis-cli FLUSHALL
  docker compose restart
  wait_done "$id"
}

supersede() {
  echo "== new version while the previous one is still extracting"
  id=$(curl -s -F type=invoice -F "title=chaos supersede" -F "file=@$DOCS/invoice-001.pdf" "$API/documents" | sed -E 's/.*"id":"([^"]+)".*/\1/')
  wait_done "$id"
  curl -s -F "file=@$DOCS/invoice-001.v2.pdf" "$API/documents/$id/versions"; echo
  sleep 1
  curl -s -F "file=@$DOCS/invoice-001.pdf" "$API/documents/$id/versions"; echo
  wait_done "$id"
  curl -s "$API/documents/$id" | grep -o '"versions":\[.*\]' | grep -oE '"version":[0-9]+,"status":"[a-z]+"'
}

case "${1:-all}" in
  restart) restart ;; kill) kill_worker ;; flush) flush ;; supersede) supersede ;;
  all) restart; kill_worker; flush; supersede ;;
esac
