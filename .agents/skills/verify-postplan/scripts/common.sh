# Sourced by the other scripts.
REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
PORT="${POSTPLAN_PORT:-3005}"
BASE="http://postplan.localhost:$PORT"
envval() { grep -E "^$1=" "$REPO/.env" 2>/dev/null | head -1 | cut -d= -f2-; }
TOKEN="$(envval BOOTSTRAP_TOKEN)"
TOKEN="${TOKEN:-pp_local_dev_bootstrap}"
