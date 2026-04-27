/**
 * Agent loop — observe→decide→act→broadcast cycle via ACP + S3 MCP.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KiroRunner, type McpServerEntry } from "./kiroRunner.js";

export interface AgentLoopConfig {
  agentIndex: number;
  concurrency: number;
  neighbours: number[];
  bucket: string;
  region: string;
  loopIntervalSeconds: number;
  model: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runLoop(config: AgentLoopConfig): Promise<void> {
  let shutdown = false;
  process.on("SIGTERM", () => { shutdown = true; });

  const n = config.agentIndex;
  const neighbourPaths = config.neighbours
    .map((i) => `/store/agent-${i}.ndjson`)
    .join(", ");

  const promptHeader = [
    `You are agent-${n}.`,
    `Your log file is: /store/agent-${n}.ndjson.`,
    `Your neighbour log files are: ${neighbourPaths}.`,
    `Your output directory is: /output.`,
    `Your knowledge base is: /knowledge-base.`,
    `Follow your agent loop prompt instructions.`,
  ].join("\n");

  const agentPrompt = readFileSync(
    resolve(__dirname, "..", "agents", "prompts", "agent-loop.md"),
    "utf-8",
  );
  const initialPrompt = promptHeader + "\n\n" + agentPrompt;

  // Standalone S3 MCP server script, bundled alongside this file.
  const s3McpScript = resolve(__dirname, "s3Mcp.js");
  const s3McpServer: McpServerEntry = {
    name: "aga-s3",
    command: "node",
    args: [s3McpScript],
    env: [
      { name: "AGA_BUCKET", value: config.bucket },
      { name: "AGA_REGION", value: config.region },
    ],
  };

  while (!shutdown) {
    const client = await KiroRunner.create({
      cwd: "/",
      model: config.model,
      mcpServers: [s3McpServer],
    });

    try {
      for await (const _chunk of client.prompt(initialPrompt)) {
        // stream — could log chunks here if needed
      }
    } finally {
      await client.close();
    }

    if (!shutdown) {
      await sleep(config.loopIntervalSeconds * 1000);
    }
  }
}
