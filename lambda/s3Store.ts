// S3 key layout:
// config.json                    — cluster config
// store/agent-N.ndjson           — agent logs (NDJSON, one JSON per line)
// store/instance-ids.json        — persisted instance IDs for stop/status

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export interface ClusterConfig {
  concurrency: number;
  neighbourRadius: number;
  instanceType: string;
  loopIntervalSeconds: number;
  model: string | null;
  idleTimeoutSeconds: number;
}

export interface AgentLogEntry {
  ts: string;
  iteration: number;
  action: string;
  result: string;
  next_intent: string;
}

export interface AgentLogs {
  agentId: string;
  lastEntry: AgentLogEntry | null;
  prevEntry: AgentLogEntry | null;
  lastUpdatedTs: string | null;
}

async function getObject(bucket: string, key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await res.Body?.transformToString()) ?? null;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "NoSuchKey") return null;
    throw e;
  }
}

export async function readConfig(bucket: string): Promise<ClusterConfig> {
  const body = await getObject(bucket, "config.json");
  if (!body) throw new Error("config.json not found in bucket");
  return JSON.parse(body) as ClusterConfig;
}

export async function writeConfig(bucket: string, cfg: ClusterConfig): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: "config.json",
    Body: JSON.stringify(cfg), ContentType: "application/json",
  }));
}

export async function readAgentLogs(bucket: string, concurrency: number): Promise<AgentLogs[]> {
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => {
      const agentId = `agent-${i}`;
      const key = `store/${agentId}.ndjson`;
      return getObject(bucket, key).then((body): AgentLogs => {
        if (!body) return { agentId, lastEntry: null, prevEntry: null, lastUpdatedTs: null };
        const lines = body.split("\n").filter(l => l.trim());
        const entries = lines.map(l => JSON.parse(l) as AgentLogEntry);
        const last = entries.length > 0 ? entries[entries.length - 1] : null;
        const prev = entries.length > 1 ? entries[entries.length - 2] : null;
        return { agentId, lastEntry: last, prevEntry: prev, lastUpdatedTs: last?.ts ?? null };
      });
    })
  );
  return results;
}
