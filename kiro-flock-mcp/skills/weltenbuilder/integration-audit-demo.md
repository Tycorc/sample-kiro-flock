# Integration Audit — Real Demo (closes handover acceptance criterion 6)

This is an **actual** graphify run against a real WeltenBuilder deployment's output, not a hypothetical example. It validates §17 of the weltenbuilder skill end-to-end and documents two findings that only surfaced by running it.

## Input: a real 5-team deployment

The `srf` deployment (a textbook WeltenBuilder topology) was downloaded and unzipped into `environment/<team>/`:

| Team | Role | Files |
|------|------|-------|
| `srf-contracts` | contracts cluster (shared types, api-routes, db-contract) | 39 |
| `srf-backend` | feature team (API + raster/sortiment services) | 34 |
| `srf-frontend` | feature team (React components) | 15 |
| `srf-data` | feature team (Kafka/Flink schema, migrations) | 6 |
| `srf-consolidate` | consolidation cluster (merged `final/` tree) | 48 |

## Environment at run time

- graphify **0.8.39** (installed CLI).
- **No backend API key set** and no local ollama → AST-only extraction.

## What actually ran

The convenience script (`scripts/audit-integration.sh`) **failed** on this real input (see Finding 2). The working sequence was the code-only path:

```bash
cd <download>/    # contains environment/<team>/
for d in environment/*/; do graphify update "$d"; done          # AST-only, no LLM
graphify merge-graphs environment/*/graphify-out/graph.json --out graphify-out/graph.json
graphify cluster-only . --graph graphify-out/graph.json --no-label --no-viz
```

Result: **631 nodes · 1022 edges · 49 communities** across the five teams.

## Team-community map (the headline)

Community detection separated the teams' modules and — most usefully — **clustered the teams' own QA-feedback files into communities that name the real integration mismatches**:

- **Community 29 — "QA Feedback — srf-backend (iteration 3)":** `routes/products.ts` imports wrong function names from the DB module; `services/layout-builder.ts` uses an invalid import path for shared types; extra `/search` router not in contract.
- **Community 28 — "QA Feedback — srf-frontend":** frontend used `SizeVariant` instead of the contract's `ProductSize`; `RasterVersion` type shape wrong; `RasterLayout` used but never defined; inconsistent import paths.
- **Community 35 — "QA Feedback — srf-contracts":** `Orientation` type missing the DB default `'portrait'`; `Legend.description` nullability mismatch.
- **Community 26 — "QA Feedback — srf-data":** `kafka_rasters` PK must include `version`; missing NOT NULL constraints and indexes; Flink sink omits head columns.

These are exactly the cross-team seams the audit is meant to expose.

## God nodes (most-connected) — and a real cross-team signal

```
1-3. requireRole()          14 / 13 / 10 edges   ← appears 3× across teams
4-5. buildSortimentLayout()  9 /  9 edges        ← appears 2× across teams
7.   buildLayoutByRaster()   7 edges
8.   mapFile()               7 edges
```

`requireRole()` is the top betweenness bridge (it connects Communities 19↔5↔27↔21↔22) — the shared permissions function is the real cross-cutting integration point. The **duplication** of `requireRole()` and `buildSortimentLayout()` across `srf-backend` and `srf-consolidate` is itself a finding: the same symbol implemented in multiple teams is precisely what the consolidation cluster is supposed to dedupe.

## Surprising connections (cross-module seams)

```
buildLayoutByRaster() --calls--> getRasterVersionLayout()           [EXTRACTED]
getRasterVersionLayout() --calls--> buildSortimentLayout()          [INFERRED]
  (srf-consolidate raster-service.ts → sortiment/layout-builder.ts)
```

The raster→sortiment call chain in `srf-consolidate` confirms the two feature domains are wired together in the merged deliverable.

## Contract-compliance checks (`graphify path`)

```
path "ProductSize"           -> "RasterPicker()"        → NO PATH   ✗
path "requireRole()"         -> "searchSortiment()"     → 2 hops    ✓ (via search.ts imports)
path "Raster"                -> "FilterFunnel()"        → NO PATH   ✗
path "buildSortimentLayout()"-> "buildLayoutByRaster()" → 2 hops    ✓ (both call mapProduct())
```

The **`ProductSize → RasterPicker()` no-path independently corroborates the srf-frontend QA finding** (frontend used `SizeVariant`, not the contract's `ProductSize`) — the audit caught a real contract mismatch structurally.

## Honest caveats (AST-only run)

- No semantic backend → markdown contracts contribute few edges; **204 isolated nodes** and low community cohesion are expected artifacts of AST-only extraction. With a backend (`--backend gemini|openai|claude|bedrock|...`) the cross-team seams would be denser and the missing-edge signal sharper.
- `graphify path` warned of ambiguous source/target matches (duplicate symbol names across teams). For precise checks, qualify by file or use a backend.

---

## Findings about the implementation (from running it)

**Finding 1 — correction to the earlier review.** graphify 0.8.39 *does* ship a **Bedrock backend** and a real `graphifyy[bedrock]` extra (the CLI error says `pip install graphifyy[bedrock]`), and `merge-graphs` is a real command. The original implementation's `--backend bedrock` was **not** fabricated — the orchestration `SKILL.md` is simply stale relative to the installed binary. Treat the binary (`graphify --help` / per-command usage) as ground truth, not the skill text.

**Finding 2 — real bug in `audit-integration.sh`.** On this real input the script **aborts on the first team**. Cause: when a team folder contains `.md` files (every team has `README.md` / `qa-feedback.md`), graphify attempts semantic extraction and **defaults to the `bedrock` backend**; with no `boto3` it errors, and `set -euo pipefail` kills the script. The script's "no backend → AST-only, pipeline still runs" warning is therefore inaccurate. Recommended fix (follow-up): when no usable backend/key is detected, build per-team graphs with `graphify update <dir>` (code-only, no LLM) instead of `graphify extract`, or require an explicit backend before proceeding.

**Finding 3 (minor, still open).** §17 / install docs say `graphify kiro install`; the real syntax is `graphify install --platform kiro`.

The script's no-path detection (`grep -iE "no path found|not found in"`) **does** match graphify's real output (`No path found between ...`), so that heuristic is correct.
