#!/usr/bin/env bash
# audit-integration.sh
#
# Post-convergence integration audit for a WeltenBuilder deployment, powered by
# the `graphify` skill. See weltenbuilder skill section 17 for the full rationale.
#
# This is an OPERATOR / INCUBATOR-SIDE tool only. It reads a local copy of the
# downloaded multi-cluster environment and writes a knowledge graph to
# `graphify-out/`. It NEVER uploads, NEVER writes into a team environment, and
# NEVER starts/stops a cluster. Nothing in the EC2 agent loop or the Lambda is
# involved. It is detection, not prevention; run it at convergence, not per
# iteration.
#
# Prerequisites:
#   - Convergence confirmed (all teams CONVERGED, QA signed off) BEFORE running.
#   - A local unzip of `env_download_all()` (omit cluster_id → all clusters),
#     i.e. a folder containing environment/<team>/ subfolders.
#   - graphify installed:  uv tool install "graphifyy[bedrock]"  (IAM, no API key)
#       optional HCL:       uv tool install "graphifyy[terraform]"
#
# Usage:
#   ./scripts/audit-integration.sh <download-dir> [team ...]
#   ./scripts/audit-integration.sh ./audit-download
#   ./scripts/audit-integration.sh ./audit-download team-backend team-frontend platform-contracts
#
# If no team folders are given, every immediate subfolder of <download-dir>/environment
# (falling back to <download-dir> itself) is treated as a team.
#
# Options (env vars):
#   GRAPHIFY_BIN     graphify executable (default: graphify)
#   AUDIT_BACKEND    extraction backend (default: bedrock — IAM, no key)
#   AUDIT_PAIRS      optional contract-compliance checks, semicolon-separated
#                    "Type>Consumer" pairs, e.g. "ApiContract>FrontendClient;UserDTO>DataPipeline"

set -euo pipefail

GRAPHIFY_BIN="${GRAPHIFY_BIN:-graphify}"
AUDIT_BACKEND="${AUDIT_BACKEND:-bedrock}"
AUDIT_PAIRS="${AUDIT_PAIRS:-}"

if [[ $# -lt 1 ]]; then
  cat >&2 <<'USAGE'
audit-integration.sh — post-convergence WeltenBuilder integration audit (incubator-side only)

Usage:
  ./scripts/audit-integration.sh <download-dir> [team ...]

Examples:
  ./scripts/audit-integration.sh ./audit-download
  ./scripts/audit-integration.sh ./audit-download team-backend team-frontend platform-contracts

<download-dir> is a local unzip of env_download_all() (omit cluster_id → all clusters),
containing environment/<team>/ subfolders. If no teams are listed, every immediate
subfolder of <download-dir>/environment is treated as a team.

Env vars:
  GRAPHIFY_BIN    graphify executable (default: graphify)
  AUDIT_BACKEND   extraction backend (default: bedrock — IAM, no API key)
  AUDIT_PAIRS     contract checks, ';'-separated "Type>Consumer", e.g. "ApiContract>FrontendClient;UserDTO>DataPipeline"

Prerequisites: convergence confirmed first; graphify installed
  (uv tool install "graphifyy[bedrock]"). See weltenbuilder skill section 17.
USAGE
  exit 1
fi

DOWNLOAD_DIR="$1"; shift
shift_teams=("$@")

if [[ ! -d "$DOWNLOAD_DIR" ]]; then
  echo "error: download dir not found: $DOWNLOAD_DIR" >&2
  exit 1
fi

if ! command -v "$GRAPHIFY_BIN" >/dev/null 2>&1; then
  echo "error: '$GRAPHIFY_BIN' not on PATH. Install with: uv tool install \"graphifyy[bedrock]\"" >&2
  exit 1
fi

# Locate the environment/ root (env_download_all produces environment/<team>/).
ENV_ROOT="$DOWNLOAD_DIR/environment"
[[ -d "$ENV_ROOT" ]] || ENV_ROOT="$DOWNLOAD_DIR"

# Resolve the team subfolders to merge.
team_dirs=()
if [[ ${#shift_teams[@]} -gt 0 ]]; then
  for t in "${shift_teams[@]}"; do
    if [[ -d "$ENV_ROOT/$t" ]]; then
      team_dirs+=("$ENV_ROOT/$t")
    elif [[ -d "$t" ]]; then
      team_dirs+=("$t")
    else
      echo "warning: team folder not found, skipping: $t" >&2
    fi
  done
else
  while IFS= read -r d; do
    team_dirs+=("$d")
  done < <(find "$ENV_ROOT" -mindepth 1 -maxdepth 1 -type d | sort)
fi

if [[ ${#team_dirs[@]} -lt 2 ]]; then
  echo "error: need at least 2 team folders to audit integration seams (found ${#team_dirs[@]})." >&2
  echo "       A single-cluster run has no cross-team seam to audit — see skill section 17 'When to skip'." >&2
  exit 1
fi

# Scope the graph to team content only — never the convergence logs (store/*.ndjson).
# This mechanically enforces the 'not-for-logs' boundary from skill section 17.
IGNORE_FILE="$DOWNLOAD_DIR/.graphifyignore"
cat > "$IGNORE_FILE" <<'EOF'
store/
**/store/
*.ndjson
node_modules/
EOF

echo "== WeltenBuilder integration audit =="
echo "backend : $AUDIT_BACKEND"
echo "teams   : ${#team_dirs[@]}"
for d in "${team_dirs[@]}"; do echo "          - $d"; done
echo "ignore  : $IGNORE_FILE (store/, *.ndjson)"
echo

# Cross-folder merge: communities ≈ teams, cross-community edges ≈ integration seams.
"$GRAPHIFY_BIN" "${team_dirs[@]}" --backend "$AUDIT_BACKEND"

REPORT="graphify-out/GRAPH_REPORT.md"
if [[ -f "$REPORT" ]]; then
  echo
  echo "== GRAPH_REPORT.md (the three sections that matter) =="
  awk '
    /^#+[[:space:]]*(God Nodes|Surprising Connections|Suggested Questions)/ { p=1 }
    p && /^#+[[:space:]]/ && !/God Nodes|Surprising Connections|Suggested Questions/ && seen { p=0 }
    /^#+[[:space:]]*(God Nodes|Surprising Connections|Suggested Questions)/ { seen=1 }
    p { print }
  ' "$REPORT" || cat "$REPORT"
else
  echo "warning: $REPORT not found — graphify may have produced no graph." >&2
fi

# Contract-compliance checks: a missing path = a team that ignored the contract.
if [[ -n "$AUDIT_PAIRS" ]]; then
  echo
  echo "== Contract-compliance checks (graphify path) =="
  IFS=';' read -ra pairs <<< "$AUDIT_PAIRS"
  for pair in "${pairs[@]}"; do
    [[ -z "$pair" ]] && continue
    src="${pair%%>*}"
    dst="${pair##*>}"
    echo "--- path: \"$src\" -> \"$dst\""
    if "$GRAPHIFY_BIN" path "$src" "$dst"; then
      :
    else
      echo "  !! NO PATH — '$dst' does not reference '$src'. CRITICAL: trigger that team's fix loop"
      echo "     (qa-feedback.md semantics or a mapreduce map directive). See skill section 17."
    fi
  done
fi

echo
echo "Audit complete. Findings → act via direction_set / mapreduce_exec, then re-run this audit."
echo "Reminder: this is detection, not prevention; incubator-side only (writes to graphify-out/)."
