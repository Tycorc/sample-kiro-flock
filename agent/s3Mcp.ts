#!/usr/bin/env node
/**
 * Standalone S3 MCP server — speaks MCP JSON-RPC 2.0 over stdio.
 *
 * Launched by kiro-cli as a subprocess via the McpServerStdio entry in
 * ACP newSession(). Bucket and region come from environment variables:
 *   AGA_BUCKET  — S3 bucket name
 *   AGA_REGION  — AWS region
 *
 * Tools: fs_read, fs_write (with append), fs_list
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createInterface } from "node:readline";

const bucket = process.env.AGA_BUCKET ?? "";
const region = process.env.AGA_REGION ?? "us-east-1";

if (!bucket) {
  process.stderr.write("AGA_BUCKET is not set\n");
  process.exit(1);
}

const s3 = new S3Client({ region });

// ---------------------------------------------------------------------------
// Prefix allowlists
// ---------------------------------------------------------------------------

const READ_PREFIXES  = ["store/", "output/", "knowledge-base/", "config.json", "direction.md"];
const WRITE_PREFIXES = ["store/", "output/", "knowledge-base/"];
const LIST_PREFIXES  = ["output/", "knowledge-base/"];

function toKey(path: string): string {
  return path.replace(/^\/+/, "");
}

function isReadAllowed(key: string): boolean {
  return READ_PREFIXES.some(p => key === p || key.startsWith(p));
}

function isWriteAllowed(key: string): boolean {
  return WRITE_PREFIXES.some(p => key.startsWith(p));
}

function isListAllowed(key: string): boolean {
  return LIST_PREFIXES.some(p => key.startsWith(p));
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "fs_read",
    description: "Read a file from the shared store.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Virtual path (e.g. /store/agent-0.ndjson, /output/docs/summary.md)" },
      },
      required: ["path"],
    },
  },
  {
    name: "fs_write",
    description: "Write or append to a file in the shared store. Paths can include directories (e.g. /output/chapters/intro.md).",
    inputSchema: {
      type: "object",
      properties: {
        path:    { type: "string",  description: "Virtual path" },
        content: { type: "string",  description: "Content to write" },
        append:  { type: "boolean", description: "Append to existing content (default: false)" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "fs_list",
    description: "List files under a directory in the shared store. Only works for /output/ and /knowledge-base/.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list (e.g. /output/, /knowledge-base/)" },
      },
      required: ["path"],
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function respond(id: string | number | null, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id: string | number | null, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function toolResult(id: string | number | null, text: string, isError = false): void {
  respond(id, { content: [{ type: "text", text }], isError });
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleFsRead(id: string | number | null, path: string): Promise<void> {
  const key = toKey(path);
  if (!isReadAllowed(key)) { toolResult(id, `Read denied: ${path}`, true); return; }
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = (await resp.Body?.transformToString()) ?? "";
    toolResult(id, body);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") {
      toolResult(id, "", true);
    } else {
      toolResult(id, `S3 read error: ${err}`, true);
    }
  }
}

async function handleFsWrite(id: string | number | null, path: string, content: string, append: boolean): Promise<void> {
  const key = toKey(path);
  if (!isWriteAllowed(key)) { toolResult(id, `Write denied: ${path}`, true); return; }
  try {
    let body = content;
    if (append) {
      try {
        const existing = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const prev = (await existing.Body?.transformToString()) ?? "";
        body = prev + content;
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== "NoSuchKey") throw err;
      }
    }
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    toolResult(id, "OK");
  } catch (err: unknown) {
    toolResult(id, `S3 write error: ${err}`, true);
  }
}

async function handleFsList(id: string | number | null, path: string): Promise<void> {
  const prefix = toKey(path).replace(/\/?$/, "/");
  if (!isListAllowed(prefix)) { toolResult(id, `List denied: ${path}`, true); return; }
  try {
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const keys = (resp.Contents ?? [])
      .map(o => o.Key)
      .filter((k): k is string => !!k && k !== prefix)
      .map(k => "/" + k);
    toolResult(id, keys.length > 0 ? keys.join("\n") : "(empty)");
  } catch (err: unknown) {
    toolResult(id, `S3 list error: ${err}`, true);
  }
}

// ---------------------------------------------------------------------------
// Main stdio loop
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: { jsonrpc: string; id?: string | number | null; method: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    respondError(null, -32700, "Parse error");
    return;
  }

  const { method, id = null } = msg;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "aga-s3-mcp", version: "1.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const params = msg.params ?? {};
    const toolName = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    if (toolName === "fs_read") {
      handleFsRead(id, args.path as string);
    } else if (toolName === "fs_write") {
      handleFsWrite(id, args.path as string, args.content as string, (args.append as boolean) ?? false);
    } else if (toolName === "fs_list") {
      handleFsList(id, args.path as string);
    } else {
      respondError(id, -32601, `Unknown tool: ${toolName}`);
    }
    return;
  }

  if (id != null) respondError(id, -32601, `Method not found: ${method}`);
});

rl.on("close", () => process.exit(0));
