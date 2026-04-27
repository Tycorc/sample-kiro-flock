/**
 * EC2 agent bootstrap — reads config from /etc/aga/agent.json, computes
 * neighbours, and starts the agent loop.
 *
 * Authentication is handled by the KIRO_API_KEY environment variable,
 * set by the systemd unit from SSM Parameter Store at boot.
 */
import fs from "node:fs";
import { runLoop } from "./agentLoop.js";

const CONFIG_PATH = process.env.AGA_CONFIG_PATH ?? "/etc/aga/agent.json";

interface AgentConfig {
  agentIndex: number;
  concurrency: number;
  neighbourRadius: number;
  bucket: string;
  region: string;
  loopIntervalSeconds: number;
  model: string | null;
}

/** Ring-topology neighbour indices (excludes self).
 *  IMPORTANT: a duplicate of this algorithm exists in lambda/handler.ts
 *  (returning string[] like "agent-N"). Changes here must be mirrored there. */
function computeNeighbours(i: number, n: number, r: number): number[] {
  const neighbours: number[] = [];
  for (let d = 1; d <= r; d++) {
    neighbours.push((i - d + n) % n);
    neighbours.push((i + d) % n);
  }
  return Array.from(new Set(neighbours))
    .filter((idx) => idx !== i)
    .sort((a, b) => a - b);
}

export default async function bootstrap(): Promise<void> {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const cfg: AgentConfig = JSON.parse(raw);

  const neighbours = computeNeighbours(
    cfg.agentIndex,
    cfg.concurrency,
    cfg.neighbourRadius,
  );

  if (!process.env.KIRO_API_KEY) {
    console.warn("⚠ KIRO_API_KEY not set — kiro-cli acp will fail to authenticate");
  }

  console.log(`agent-${cfg.agentIndex} started — neighbours: [${neighbours.join(", ")}]`);

  await runLoop({
    agentIndex: cfg.agentIndex,
    concurrency: cfg.concurrency,
    neighbours,
    bucket: cfg.bucket,
    region: cfg.region,
    loopIntervalSeconds: cfg.loopIntervalSeconds,
    model: cfg.model,
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
