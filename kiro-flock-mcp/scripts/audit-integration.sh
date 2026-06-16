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
#   - graphify installed:  uv tool install graphifyy        (CLI command: graphify)
#   - RECOMMENDED for a full audit: a semantic backend for docs/markdown contract extraction —
#       set ONE API key (GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY ...)
#       or AUDIT_BACKEND=ollama for a local model. With NO backend/key the audit still runs but
#       falls back to code-only `graphify update` (no LLM); markdown contracts and cross-team
#       seams are then under-reported.
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
#   AUDIT_BACKEND    extraction backend: azure|bedrock|claude|claude-cli|deepseek|gemini|kimi|ollama|openai
#                    (default: unset -> if no API key is set either, the audit falls back to
#                    code-only `graphify update` (no LLM, no crash); markdown contracts and
#                    cross-team seams are then under-reported. Set this or a key for a full audit.
#   AUDIT_PAIRS      optional contract-compliance checks, semicolon-separated
#                    "Type>Consumer" pairs, e.g. "ApiContract>FrontendClient;UserDTO>DataPipeline"

set -euo pipefail

GRAPHIFY_BIN="${GRAPHIFY_BIN:-graphify}"
AUDIT_BACKEND="${AUDIT_BACKEND:-}"   # empty -> graphify auto-detects backend from API key
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
  AUDIT_BACKEND   backend: azure|bedrock|claude|claude-cli|deepseek|gemini|kimi|ollama|openai (default: auto-detect from API key; code-only needs none)
  AUDIT_PAIRS     contract checks, ';'-separated "Type>Consumer", e.g. "ApiContract>FrontendClient;UserDTO>DataPipeline"

Prerequisites: convergence confirmed first; graphify installed (uv tool install graphifyy);
a backend API key for markdown contracts (or local ollama; code-only needs none). See skill section 17.
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
  echo "error: '$GRAPHIFY_BIN' not on PATH. Install with: uv tool install graphifyy" >&2
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

# Not-for-logs boundary (skill section 17): we extract ONLY the per-team folders
# (environment/<team>/). The convergence logs live in store/ — a SIBLING of environment/,
# never inside a team folder — so they are out of scope by construction, no ignore file needed.

echo "== WeltenBuilder integration audit =="
echo "backend : ${AUDIT_BACKEND:-auto-detect (set AUDIT_BACKEND or an API key; code-only needs none)}"
echo "teams   : ${#team_dirs[@]}"
for d in "${team_dirs[@]}"; do echo "          - $d"; done
echo

# Cross-team seams come from SEMANTIC extraction (an LLM backend). The CLI builds ONE path at
# a time, so a cross-folder graph = build each team's graph + merge-graphs.
#
# CRITICAL: `graphify extract` defaults to the bedrock backend when a folder contains docs
# (and every team has README.md / qa-feedback.md). Without a usable backend that call HARD-FAILS
# (e.g. "requires boto3") and `set -e` would abort the whole audit. So we only call `extract`
# when a backend is actually available; otherwise we fall back to `graphify update` (AST/code-only,
# no LLM) which never invokes a model. Code-only still builds and merges each team's code graph,
# but markdown contracts and cross-team symbol resolution are under-reported.
#
# A backend is "available" if AUDIT_BACKEND is set (incl. ollama / bedrock-via-IAM) or any
# provider API key is exported.
_have_key=""
for v in "${OPENAI_API_KEY:-}" "${GEMINI_API_KEY:-}" "${GOOGLE_API_KEY:-}" \
         "${ANTHROPIC_API_KEY:-}" "${DEEPSEEK_API_KEY:-}" "${MOONSHOT_API_KEY:-}"; do
  [[ -n "$v" ]] && _have_key=1
done
SEMANTIC=""
[[ -n "$AUDIT_BACKEND" || -n "$_have_key" ]] && SEMANTIC=1

backend_args=()
[[ -n "$AUDIT_BACKEND" ]] && backend_args=(--backend "$AUDIT_BACKEND")

if [[ -z "$SEMANTIC" ]]; then
  echo "WARNING: no backend or API key detected -> falling back to code-only extraction" >&2
  echo "         (graphify update, no LLM). Cross-team seam / missing-edge detection is" >&2
  echo "         UNRELIABLE without semantic extraction. Set AUDIT_BACKEND" >&2
  echo "         (azure|bedrock|claude|claude-cli|deepseek|gemini|kimi|ollama|openai) or a provider API key for a" >&2
  echo "         full audit. The pipeline still runs (code structure only)." >&2
  echo >&2
fi

# --force: overwrite each team's graph even if a re-audit (post-fix) has fewer nodes, so the
# audit reflects current downloaded state and clears ghost duplicates (skill section 17).
graph_jsons=()
for d in "${team_dirs[@]}"; do
  if [[ -n "$SEMANTIC" ]]; then
    echo "-- extracting (semantic): $d"
    "$GRAPHIFY_BIN" extract "$d" "${backend_args[@]}"
  else
    echo "-- extracting (code-only): $d"
    "$GRAPHIFY_BIN" update "$d" --force
  fi
  gj="$d/graphify-out/graph.json"
  if [[ -f "$gj" ]]; then
    graph_jsons+=("$gj")
  else
    echo "warning: no graph.json produced for $d (empty folder or extraction failed)" >&2
  fi
done

if [[ ${#graph_jsons[@]} -lt 2 ]]; then
  echo "error: fewer than 2 team graphs were produced; cannot build a cross-team graph." >&2
  exit 1
fi

mkdir -p graphify-out
echo "-- merging ${#graph_jsons[@]} team graphs -> graphify-out/graph.json"
"$GRAPHIFY_BIN" merge-graphs "${graph_jsons[@]}" --out graphify-out/graph.json

# Cluster the merged graph + regenerate GRAPH_REPORT.md. Community *naming* needs an LLM
# backend; structural god-nodes/surprising-connections do not. No backend -> keep "Community N".
if [[ -n "$AUDIT_BACKEND" ]]; then
  "$GRAPHIFY_BIN" cluster-only . --graph graphify-out/graph.json --backend "$AUDIT_BACKEND"
else
  "$GRAPHIFY_BIN" cluster-only . --graph graphify-out/graph.json --no-label
fi

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
    path_out="$("$GRAPHIFY_BIN" path "$src" "$dst" 2>&1)"
    echo "$path_out"
    # graphify path exits 0 in all cases; detect the negative outcomes by text.
    # Validated against graphify 0.8.39: "No path found between '..' and '..'."
    # (both nodes exist but are unconnected) and "No node matching '..' found."
    # (the type/client is absent from the graph entirely — an even stronger
    # signal). Treat both as CRITICAL.
    if echo "$path_out" | grep -qiE "no path found|no node matching"; then
      echo "  !! NO LINK — no structural path between '$src' and '$dst' (or one is absent"
      echo "     from the graph). CRITICAL: trigger that team's fix loop (qa-feedback.md"
      echo "     semantics or a mapreduce map directive). See skill section 17."
    fi
  done
fi

echo
echo "Audit complete. Findings → act via direction_set / mapreduce_exec, then re-run this audit."
echo "Reminder: this is detection, not prevention; incubator-side only (writes to graphify-out/)."
