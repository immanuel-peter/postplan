# Sourced by the other scripts.
REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
PORT="${POSTPLAN_PORT:-3005}"
BASE="http://postplan.localhost:$PORT"
envval() { grep -E "^$1=" "$REPO/.env" 2>/dev/null | head -1 | cut -d= -f2-; }
TOKEN="$(envval BOOTSTRAP_TOKEN)"
TOKEN="${TOKEN:-pp_local_dev_bootstrap}"

# oneshot <mode> <target>: start scripts/oneshot.mjs in the background and print its port.
oneshot() {
  local portfile; portfile="$(mktemp)"
  nohup node "$REPO/.agents/skills/verify-postplan/scripts/oneshot.mjs" "$1" "$2" "$portfile" >/dev/null 2>&1 &
  for _ in $(seq 1 50); do [ -s "$portfile" ] && break; sleep 0.1; done
  cat "$portfile"; rm -f "$portfile"
}
