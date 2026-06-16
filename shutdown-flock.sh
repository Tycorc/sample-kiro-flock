#!/usr/bin/env bash
# shutdown-flock.sh — cleanly terminate kiro-flock agent EC2 instances and
# verify they are gone.
#
# This stops the *flock* (the running agent instances). It does NOT delete the
# CDK stack, the S3 bucket, or any logs/environment/knowledge-base data. To tear
# down the deployed infrastructure, run `cdk destroy` in kiro-flock-cluster.
#
# Flock instances are identified by their EC2 tags:
#   Project   = kiro-flock
#   ClusterId = <cluster id>   (e.g. cluster_0, team-auth)
#
# Usage:
#   ./shutdown-flock.sh                            # reads install.config; all clusters
#   ./shutdown-flock.sh --cluster-id team-auth     # scope to one cluster
#   ./shutdown-flock.sh --region eu-central-1 --profile my-profile
#   ./shutdown-flock.sh --yes                       # skip confirmation prompt
#
# Flags override values from install.config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/install.config"

# ── Parse CLI flags ───────────────────────────────────────────────────────────
CLI_REGION=""
CLI_PROFILE=""
CLUSTER_ID=""
ASSUME_YES="no"
WAIT_TIMEOUT=240   # seconds to wait for instances to reach 'terminated'
POLL_INTERVAL=5    # seconds between verification polls

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)      CLI_REGION="$2";  shift 2 ;;
    --profile)     CLI_PROFILE="$2"; shift 2 ;;
    --cluster-id)  CLUSTER_ID="$2";  shift 2 ;;
    --timeout)     WAIT_TIMEOUT="$2"; shift 2 ;;
    -y|--yes)      ASSUME_YES="yes"; shift ;;
    -h|--help)
      echo "Usage: ./shutdown-flock.sh [--cluster-id ID] [--region REGION] [--profile PROFILE] [--yes] [--timeout SECONDS]"
      echo ""
      echo "Terminates kiro-flock agent EC2 instances and verifies they are gone."
      echo "Without --cluster-id, all clusters (Project=kiro-flock) are terminated."
      echo "Does NOT delete the CDK stack or any S3 data."
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Load config file (if it exists) ──────────────────────────────────────────
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

# ── Apply CLI overrides ──────────────────────────────────────────────────────
[[ -n "$CLI_REGION" ]]  && REGION="$CLI_REGION"
[[ -n "$CLI_PROFILE" ]] && PROFILE="$CLI_PROFILE"

# ── Validate required values ─────────────────────────────────────────────────
if [[ -z "${REGION:-}" ]]; then
  echo "ERROR: REGION must be set (install.config or --region)."
  exit 1
fi

# ── AWS CLI wrapper ──────────────────────────────────────────────────────────
AWS=(aws --region "$REGION")
[[ -n "${PROFILE:-}" ]] && AWS+=(--profile "$PROFILE")

# ── Colours ───────────────────────────────────────────────────────────────────
B=$'\033[1m'; G=$'\033[32m'; C=$'\033[36m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
step() { echo ""; echo "${B}${C}━━━━  $*  ━━━━${N}"; echo ""; }
ok()   { echo "${G}✓${N} $*"; }
warn() { echo "${Y}!${N} $*"; }
err()  { echo "${R}✗${N} $*"; }

# Active (non-terminated) states. Once an instance leaves these, it is gone.
ACTIVE_STATES="pending,running,stopping,shutting-down,stopped,rebooting"

# Build the tag filters. Always scope to Project=kiro-flock; add ClusterId when
# the operator narrows to one cluster.
build_filters() {
  local filters=("Name=tag:Project,Values=kiro-flock")
  filters+=("Name=instance-state-name,Values=$ACTIVE_STATES")
  if [[ -n "$CLUSTER_ID" ]]; then
    filters+=("Name=tag:ClusterId,Values=$CLUSTER_ID")
  fi
  printf '%s\n' "${filters[@]}"
}

# Return active instance IDs (one per line) for the current scope.
list_active_ids() {
  mapfile -t _filters < <(build_filters)
  "${AWS[@]}" ec2 describe-instances \
    --filters "${_filters[@]}" \
    --query "Reservations[].Instances[].InstanceId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'
}

# Print a readable table of active instances for the current scope.
show_active() {
  mapfile -t _filters < <(build_filters)
  "${AWS[@]}" ec2 describe-instances \
    --filters "${_filters[@]}" \
    --query "Reservations[].Instances[].[InstanceId, State.Name, Tags[?Key=='ClusterId']|[0].Value, Tags[?Key=='AgentIndex']|[0].Value]" \
    --output text 2>/dev/null
}

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo "${B}  kiro-flock shutdown${N}"
echo "  Region : $REGION"
echo "  Profile: ${PROFILE:-default}"
echo "  Scope  : ${CLUSTER_ID:-all clusters (Project=kiro-flock)}"
echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"

# ── Verify AWS identity is reachable ─────────────────────────────────────────
if ! "${AWS[@]}" sts get-caller-identity >/dev/null 2>&1; then
  err "Cannot authenticate to AWS (region=$REGION, profile=${PROFILE:-default})."
  err "Check your credentials / SSO session and try again."
  exit 1
fi

# ── Step 1: Find active instances ────────────────────────────────────────────
step "Step 1: Discover active flock instances"

mapfile -t IDS < <(list_active_ids)

if [[ ${#IDS[@]} -eq 0 ]]; then
  ok "No active flock instances found — the flock is already gone."
  exit 0
fi

echo "Found ${#IDS[@]} active instance(s):"
echo ""
printf "  %-21s %-15s %-14s %s\n" "INSTANCE ID" "STATE" "CLUSTER" "AGENT"
show_active | while read -r id state cluster agent; do
  printf "  %-21s %-15s %-14s %s\n" "$id" "$state" "${cluster:-?}" "${agent:-?}"
done
echo ""

# ── Step 2: Confirm ──────────────────────────────────────────────────────────
if [[ "$ASSUME_YES" != "yes" ]]; then
  warn "This will TERMINATE the instances above. This is irreversible."
  read -rp "Proceed? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    echo "Aborted. No instances were terminated."
    exit 0
  fi
fi

# ── Step 3: Terminate ────────────────────────────────────────────────────────
step "Step 2: Terminate instances"

"${AWS[@]}" ec2 terminate-instances \
  --instance-ids "${IDS[@]}" \
  --query "TerminatingInstances[].[InstanceId, CurrentState.Name]" \
  --output text | while read -r id state; do
  echo "  $id -> $state"
done
ok "Termination requested for ${#IDS[@]} instance(s)."

# ── Step 4: Verify gone ──────────────────────────────────────────────────────
step "Step 3: Verify the flock is gone"

elapsed=0
while true; do
  mapfile -t REMAINING < <(list_active_ids)
  remaining=${#REMAINING[@]}

  if [[ $remaining -eq 0 ]]; then
    ok "Verified: 0 active flock instances remain."
    break
  fi

  if [[ $elapsed -ge $WAIT_TIMEOUT ]]; then
    err "Timed out after ${WAIT_TIMEOUT}s with ${remaining} instance(s) still terminating:"
    show_active | while read -r id state cluster agent; do
      echo "    $id ($state, cluster=${cluster:-?})"
    done
    err "They are shutting down but had not reached 'terminated' yet. Re-run to re-check."
    exit 1
  fi

  echo "  ${remaining} instance(s) still shutting down... (${elapsed}s elapsed)"
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo "${B}${G}  Flock shut down.${N}"
echo "  ${#IDS[@]} instance(s) terminated and verified gone."
echo "  CDK stack and S3 data (logs, environment, knowledge-base) are untouched."
echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo ""
