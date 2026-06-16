# Handover: Graphify-based Integration Audit for WeltenBuilder

**Status:** Ready to implement
**Audience:** A fresh Kiro instance picking up this fork
**Scope:** Add a post-convergence, cross-cluster *integration audit* capability to the WeltenBuilder (multi-cluster) workflow, powered by the `graphify` skill's cross-folder merge graph. Read this whole document before writing any code.

---

## 1. Context you need first

This repo (`sample-kiro-flock`) runs a configurable cluster of Kiro agents on EC2 that coordinate through an append-only shared workspace in S3. **WeltenBuilder** is the multi-cluster layer: several named clusters (feature teams, a `platform-contracts` cluster, a `qa` cluster, a `consolidation` cluster) run simultaneously and coordinate by reading/writing each other's `environment/{cluster_id}/` folders in S3 (stigmergy — no direct messaging).

Two skills govern operation (read both, installed at `~/.kiro/skills/`, mirrored in `kiro-flock-mcp/skills/`):
- **kiro-flock** — single-cluster mechanics (algorithm/radius choice, polling, `store_read_all` post-run analysis).
- **weltenbuilder** — multi-cluster orchestration. The local agent is an **incubator**: it plans topology, writes directions, launches clusters, monitors, and collects results. **It never produces project artifacts.** Productive work happens only inside clusters.

Reference docs also copied into the repo root: `kiro-flock-howto.md`, `weltenbuilder-howto.md`.

Architecture (from `kiro-flock-mcp/README.md`):
```
Local Kiro agent → MCP (kiro-flock-feed, stdio) → API Gateway → Lambda → S3
  S3 layout: environment/{cluster_id}/  knowledge-base/  direction.md  store/agent-*.ndjson
```

`graphify` is a separate, already-installed skill (`~/.kiro/skills/graphify/SKILL.md`). It turns a folder of files into a knowledge graph with community detection, "god nodes", "surprising connections", and `query`/`path`/`explain` tools. Its key feature for us: **merge several folders into one cross-folder graph** (`graphify <folder1> <folder2> ...`).

---

## 2. Why (the validated rationale — do not re-litigate)

WeltenBuilder's data model is one folder per team: `environment/{cluster_id}/`. Graphify's multi-folder merge maps onto that one-to-one:
- Communities in the merged graph ≈ the teams.
- Cross-community edges = the real integration seams between teams.
- A **missing** edge where two teams should connect = a naming/contract mismatch — the #1 WeltenBuilder failure mode (see weltenbuilder skill §13).

So graphify gives the incubator an **independent, structural, post-convergence audit** of integration health. It is **detection, not prevention** — it complements (does not replace) the `platform-contracts` and `qa` clusters. It is incubator-safe: it writes only to `graphify-out/`, never into a team's environment.

**Hard boundaries (respect these):**
- Do NOT run graphify per iteration. It is batch and costs tokens. Run at convergence or a milestone.
- Do NOT use graphify for `store/*.ndjson` log/convergence analysis — that stays with `store_read_all` + kiro-flock skill §8.
- Do NOT make graphify a live-monitoring replacement for `cluster_status`/`stream_logs`.
- Do NOT have the local agent write project files. Graphify output (`graphify-out/`) is analysis, which is allowed.

---

## 3. What to implement

Deliver three things. Keep each small and reviewable.

### 3.1 An "integration audit" operator workflow (documentation-first)
Add a new section to the **weltenbuilder skill** (`kiro-flock-mcp/skills/weltenbuilder/SKILL.md`) titled e.g. "§17 Post-convergence integration audit with graphify". It must specify the exact workflow:
1. Confirm convergence (all feature teams `CONVERGED`, QA signed off) via parallel `cluster_status` sweep.
2. `env_download_all` (omit `cluster_id`) → pulls the whole multi-cluster tree to a local path.
3. Unzip; the tree contains `environment/team-*/`, `environment/platform-contracts/`, etc.
4. Run graphify cross-folder merge over the per-team subfolders.
5. Read `graphify-out/GRAPH_REPORT.md` → god nodes (shared contracts/types), surprising connections (cross-team seams), and run targeted `graphify path "<ContractType>" "<TeamClient>"` checks for contract compliance.
6. Turn findings into action: `direction_set` nudge or `mapreduce_exec` map directive to the specific team(s) with a seam. Re-run audit after the fix loop settles.

Include a worked example and an explicit "when to skip" list (single-cluster runs, research/ideation tasks, non-integrating teams).

### 3.2 A thin convenience wrapper (optional, only if it stays incubator-safe)
If you add code, add ONE optional MCP-adjacent helper or documented CLI snippet that chains: `env_download_all` → unzip → `graphify <subfolders>` → surface the three report sections. Implementation location options (pick the lightest):
- A documented shell snippet in the skill (preferred — zero new surface area), OR
- A small script under `kiro-flock-mcp/scripts/` (e.g. `audit-integration.sh`) that takes a download path and shells out to graphify.
Do **not** add this logic into the EC2 agent loop or the Lambda — it is an operator/incubator-side tool only.

### 3.3 Contract-compliance check recipe
Document the `graphify path` recipe for verifying feature teams actually reference the `platform-contracts` output:
- `graphify path "ApiContract" "FrontendClient"` → no path ⇒ team ignored the contract ⇒ raise as a CRITICAL finding and trigger the team's fix loop via `qa-feedback.md` semantics or a `mapreduce` directive.

---

## 4. How — concrete pointers into the codebase

- MCP tools live in `kiro-flock-mcp/src/tools.ts` and are wired in `kiro-flock-mcp/src/index.ts`. `env_download_all` already exists and, with no `cluster_id`, downloads ALL clusters' `environment/` as a zip — this is your input source. **Reuse it; do not reimplement download.**
- Skills are plain Markdown: `kiro-flock-mcp/skills/{kiro-flock,weltenbuilder}/SKILL.md`. The installed copies are at `~/.kiro/skills/`. The installer (`kiro-flock-mcp/scripts/get-mcp-env.sh`, step 4) copies skills into `~/.kiro/skills/`. If you edit the repo skill, note that re-running the installer re-syncs it.
- Graphify is invoked as a skill/command (`/graphify <path...>`, `/graphify path A B`, `/graphify query "..."`). Code-only corpora use free AST extraction; docs cost tokens. Install if missing: `pip install graphifyy` (or `uv tool install graphifyy`).
- Keep all new behavior **operator-side**. Nothing in `kiro-flock-cluster/agent/*` or `kiro-flock-cluster/lambda/*` should change for this feature.

---

## 5. Acceptance criteria

- [ ] weltenbuilder SKILL.md gains a self-contained "integration audit" section with the 6-step workflow, a worked example, the `graphify path` contract-compliance recipe, and a "when to skip" list.
- [ ] The audit workflow reuses `env_download_all` (no new download code).
- [ ] If a script is added, it lives under `kiro-flock-mcp/scripts/`, is incubator-side only, and does not touch agent/Lambda code.
- [ ] Docs explicitly state: detection-not-prevention, run-at-convergence-only, not-for-logs, not-for-live-monitoring, incubator-only (writes to `graphify-out/` only).
- [ ] No secrets, no `install.config`, no `node_modules` committed. `cdk`/agent/Lambda code unchanged.
- [ ] A demo run is documented against a real multi-cluster output (the operator has `.srf-*` bundles: `srf-contracts`, `srf-backend`, `srf-frontend`, `srf-data`, `srf-qa`, `srf-consolidate` — a textbook WeltenBuilder topology) showing the team-community map and at least one detected/absent cross-team seam.

---

## 6. Suggested validation (demo)

Use the operator's existing multi-cluster output to prove the audit end-to-end before wiring anything:
1. Unzip the `.srf-*` bundles into a single parent folder so each becomes a sibling team folder.
2. `graphify <srf-contracts> <srf-backend> <srf-frontend> <srf-data> <srf-consolidate>` (merge).
3. Confirm: communities map to the teams; god nodes include the contract/shared types; surprising connections expose the frontend↔backend seam; `graphify path` confirms (or refutes) contract usage.
4. Capture the three report sections (God Nodes, Surprising Connections, Suggested Questions) as the demo artifact referenced in acceptance criteria.

---

## 7. Out of scope / do not do

- No changes to the EC2 agent loop, neighbour selection, or Lambda API for this feature.
- No replacement of the QA/contracts/coordinator clusters — graphify augments them.
- No live/continuous graphify runs.
- No graphify on `store/` logs.
- No local creation of project artifacts by the incubator (graphify-out/ analysis is fine).
