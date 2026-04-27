/**
 * Lambda handler for the cluster API. Sits behind API Gateway (REST v1)
 * with Cognito auth on /cluster/* routes. Routes are dispatched via
 * method + path matching, no router library.
 *
 * Routes:
 *   POST /cluster/start          - validate config, archive previous run, launch EC2 agents
 *   POST /cluster/stop           - terminate all agent instances
 *   GET  /cluster/status         - aggregate instance state, agent logs, CloudWatch metrics
 *   GET  /cluster/config         - read cluster config from S3
 *   PUT  /cluster/config         - merge partial update into config
 *   GET  /cluster/habitat        - list files agents wrote to output/
 *   GET  /cluster/habitat/file   - read a single output file by key
 *   GET  /cluster/direction      - read the operator's goal document
 *   PUT  /cluster/direction      - update the goal document
 *   GET  /cluster/instance-types - available Graviton types + vCPU quota
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { readConfig, writeConfig, readAgentLogs, ClusterConfig } from "./s3Store";
import { startCluster, stopCluster, describeCluster } from "./ec2Manager";
import { getInstanceMetrics } from "./cwMetrics";

// Environment variables set by the CDK stack. Captured at module load.
const BUCKET = process.env.BUCKET_NAME!;
const AMI_ID = process.env.AMI_ID!;
const SG_ID = process.env.SECURITY_GROUP_ID!;
const INSTANCE_PROFILE = process.env.INSTANCE_PROFILE_ARN!;
const SUBNET_ID = process.env.SUBNET_ID!;
const CONCURRENCY_CAP = parseInt(process.env.CONCURRENCY_CAP ?? "64", 10);

// Ring topology neighbour calculation (mirrors aga/topology.py).
// IMPORTANT: a duplicate of this algorithm exists in agent/bootstrap.ts
// (returning number[] instead of string[]). Changes here must be mirrored there.
function computeNeighbours(index: number, concurrency: number, radius: number): string[] {
  if (radius === 0) return [];
  const seen = new Set<number>();
  for (let k = -radius; k <= radius; k++) {
    if (k === 0) continue;
    seen.add(((index + k) % concurrency + concurrency) % concurrency);
  }
  seen.delete(index);
  return Array.from(seen).sort((a, b) => a - b).slice(0, concurrency - 1).map(i => `agent-${i}`);
}

/** Wrap a value in an API Gateway JSON response. */
function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** API Gateway base64-encodes the body when binaryMediaTypes includes *\/*. */
function getBody(event: APIGatewayProxyEvent): string | null {
  if (!event.body) return null;
  if (event.isBase64Encoded) return Buffer.from(event.body, "base64").toString("utf-8");
  return event.body;
}

/**
 * Validate cluster config fields. Returns an error string or null if valid.
 * Used by both POST /cluster/start and PUT /cluster/config.
 */
function validateConfig(config: ClusterConfig): string | null {
  if (config.concurrency > CONCURRENCY_CAP) {
    return `concurrency ${config.concurrency} exceeds the configured cap of ${CONCURRENCY_CAP}`;
  }
  if (!/^(t|c|m|r)\d+g\.(small|medium|large|xlarge)$/.test(config.instanceType)) {
    return `instanceType "${config.instanceType}" is not in the allowed set (Graviton t/c/m/r families, small through xlarge)`;
  }
  const maxRadius = Math.floor(config.concurrency / 2);
  if (!Number.isInteger(config.neighbourRadius) || config.neighbourRadius < 0 || config.neighbourRadius > maxRadius) {
    return `neighbourRadius must be an integer between 0 and ${maxRadius} (concurrency / 2)`;
  }
  if (!Number.isInteger(config.loopIntervalSeconds) || config.loopIntervalSeconds < 0 || config.loopIntervalSeconds > 3600) {
    return "loopIntervalSeconds must be an integer between 0 and 3600";
  }
  if (config.model !== null) {
    return "model must be null (auto); custom model selection is not yet supported";
  }
  return null;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;
  const body = getBody(event);

  try {

    // ---- Start the cluster --------------------------------------------------
    // The actual launch can take minutes for large clusters (sequential
    // RunInstances calls). To avoid the API Gateway 29s timeout, the handler
    // invokes itself asynchronously and returns immediately.
    if (method === "POST" && path === "/cluster/start") {
      const overrides = body ? JSON.parse(body) : {};
      const config = { ...(await readConfig(BUCKET)), ...overrides } as ClusterConfig;

      const err = validateConfig(config);
      if (err) return json(400, { error: err });

      // If this is the async background invocation, do the actual work.
      if (event.headers?.["x-aga-async"] === "true") {
        // Guard against double-start: reject if agents are already running.
        const { EC2Client: _EC2, DescribeInstancesCommand: _Desc } = await import("@aws-sdk/client-ec2");
        const ec2Check = new _EC2({});
        const existing = await ec2Check.send(new _Desc({
          Filters: [
            { Name: "tag:Project", Values: ["kiro-flock"] },
            { Name: "instance-state-name", Values: ["pending", "running"] },
          ],
        }));
        const existingCount = (existing.Reservations ?? []).flatMap(r => r.Instances ?? []).length;
        if (existingCount > 0) {
          console.log(`start: rejected, ${existingCount} agents already running`);
          return json(409, { error: `${existingCount} agents already running, stop the cluster first` });
        }

        // Archive output/ and store/ to history/<datetime>/ so each run starts clean.
        const { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
        const s3 = new S3Client({});
        const [outputObjs, storeObjs] = await Promise.all([
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "output/" })),
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "store/" })),
        ]);
        const toArchive = [
          ...(outputObjs.Contents ?? []).filter(o => o.Key && o.Key !== "output/"),
          ...(storeObjs.Contents ?? []).filter(o => o.Key && o.Key !== "store/"),
        ];
        if (toArchive.length > 0) {
          const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const archivePrefix = `history/${ts}/`;
          console.log(`start: archiving ${toArchive.length} files to ${archivePrefix}`);
          await Promise.all(toArchive.map(async obj => {
            const destKey = archivePrefix + obj.Key!;
            await s3.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/${obj.Key}`, Key: destKey }));
            await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key! }));
          }));
        }

        console.log("start: launching", config.concurrency, "instances, type:", config.instanceType);
        const ids = await startCluster(
          { bucket: BUCKET, amiId: AMI_ID, securityGroupId: SG_ID, instanceProfileArn: INSTANCE_PROFILE, subnetId: SUBNET_ID },
          config,
        );
        return json(200, { instanceIds: ids });
      }

      // Synchronous path: invoke this Lambda asynchronously and return immediately.
      const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
      const lambda = new LambdaClient({});
      const asyncEvent = {
        ...event,
        headers: { ...event.headers, "x-aga-async": "true" },
      };
      await lambda.send(new InvokeCommand({
        FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME!,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(asyncEvent)),
      }));
      return json(202, { status: "starting" });
    }

    // ---- Stop the cluster ---------------------------------------------------
    if (method === "POST" && path === "/cluster/stop") {
      console.log("stop: terminating cluster");
      await stopCluster(BUCKET);
      return json(200, { ok: true });
    }

    // ---- Cluster status -----------------------------------------------------
    // Aggregates EC2 instance state, agent iteration logs from S3, and
    // CloudWatch metrics into a single response for the dashboard.
    // Describe + logs are fetched in parallel, then metrics uses the
    // instance IDs from describe.
    if (method === "GET" && path === "/cluster/status") {
      const config = await readConfig(BUCKET);

      // Fetch instances and logs concurrently.
      const [instances, logs] = await Promise.all([
        describeCluster(BUCKET),
        readAgentLogs(BUCKET, config.concurrency),
      ]);

      if (instances.length === 0) {
        return json(200, { agents: [], clusterState: "stopped" });
      }

      const instanceIdsForMetrics = instances.map(inst => inst.instanceId).filter(Boolean);
      const metricsMap = instanceIdsForMetrics.length > 0
        ? await getInstanceMetrics(instanceIdsForMetrics)
        : {};
      const now = Date.now();

      // Build per-agent status by joining instance state, log entries, and metrics.
      const agents = logs.map((log, i) => {
        const inst = instances.find(inst => inst.agentIndex === i);
        const elapsed = log.lastUpdatedTs
          ? (now - new Date(log.lastUpdatedTs).getTime()) / 1000
          : null;

        // Derive agent status from instance state and log presence.
        let status: string;
        if (!inst) status = "terminated";
        else if (inst.state === "shutting-down") status = "shutting-down";
        else if (inst.state === "terminated") status = "terminated";
        else if (!log.lastEntry) status = "starting";
        else status = "running";

        return {
          agentId: log.agentId,
          instanceId: inst?.instanceId ?? null,
          instanceState: inst?.state ?? (status === "terminated" ? "terminated" : "unknown"),
          lastEntry: log.lastEntry,
          prevEntry: log.prevEntry,
          lastUpdatedTs: log.lastUpdatedTs,
          elapsedSeconds: elapsed !== null ? Math.round(elapsed) : null,
          status,
          neighbours: computeNeighbours(i, config.concurrency, config.neighbourRadius),
          metrics: inst?.instanceId ? (metricsMap[inst.instanceId] ?? { cpu: null, disk: null, memory: null }) : { cpu: null, disk: null, memory: null },
        };
      });

      // Derive overall cluster state from individual agent statuses.
      const hasRunning = agents.some(a => a.status === "running");
      const hasStarting = agents.some(a => a.status === "starting");
      const hasShuttingDown = agents.some(a => a.status === "shutting-down");
      const hasInstances = instances.length > 0;
      const clusterState = !hasInstances ? "stopped"
        : hasShuttingDown && !hasRunning && !hasStarting ? "stopping"
        : hasRunning ? "running"
        : hasStarting ? "starting"
        : hasShuttingDown ? "stopping"
        : "running";

      const launchTimes = instances.map(i => i.launchTime).filter(Boolean) as string[];
      const clusterStartTime = launchTimes.length > 0 ? launchTimes.sort()[0] : null;

      return json(200, { agents, clusterState, clusterStartTime });
    }

    // ---- Read config --------------------------------------------------------
    if (method === "GET" && path === "/cluster/config") {
      return json(200, await readConfig(BUCKET));
    }

    // ---- Update config (partial merge) --------------------------------------
    if (method === "PUT" && path === "/cluster/config") {
      const existing = await readConfig(BUCKET);
      const partial = JSON.parse(body ?? "{}");
      const merged: ClusterConfig = { ...existing, ...partial };

      const err = validateConfig(merged);
      if (err) return json(400, { error: err });

      console.log("config update:", JSON.stringify(merged));
      await writeConfig(BUCKET, merged);
      return json(200, merged);
    }

    // ---- List output files (habitat) ----------------------------------------
    if (method === "GET" && path === "/cluster/habitat") {
      const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({});
      const resp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "output/" }));
      const files = (resp.Contents ?? [])
        .filter(obj => obj.Key && obj.Key !== "output/")
        .map(obj => ({ key: obj.Key!, size: obj.Size ?? 0, lastModified: obj.LastModified?.toISOString() ?? "" }))
        .sort((a, b) => b.lastModified.localeCompare(a.lastModified));

      // Count archived runs for the UI badge
      const histResp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "history/", Delimiter: "/" }));
      const archivedRuns = (histResp.CommonPrefixes ?? []).length;
      return json(200, { files, archivedRuns });
    }

    // ---- Read a single output file ------------------------------------------
    if (method === "GET" && path === "/cluster/habitat/file") {
      const key = event.queryStringParameters?.key;
      if (!key) return json(400, { error: "key required" });
      // Path traversal guard: key must be under output/ and contain no ".."
      if (!key.startsWith("output/") || key.includes("..")) return json(403, { error: "forbidden" });
      const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({});
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const text = (await resp.Body?.transformToString()) ?? "";
        return json(200, { key, content: text });
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "NoSuchKey") return json(404, { error: "not found" });
        throw err;
      }
    }

    // ---- Read direction (operator goal) -------------------------------------
    if (method === "GET" && path === "/cluster/direction") {
      const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({});
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: "direction.md" }));
        const text = (await resp.Body?.transformToString()) ?? "";
        return json(200, { direction: text });
      } catch (err: unknown) {
        // Missing direction is not an error, just means none has been set yet
        if ((err as { name?: string }).name === "NoSuchKey") return json(200, { direction: "" });
        throw err;
      }
    }

    // ---- Update direction ---------------------------------------------------
    if (method === "PUT" && path === "/cluster/direction") {
      const { direction } = JSON.parse(body ?? "{}");
      if (typeof direction !== "string") return json(400, { error: "direction must be a string" });
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({});
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: "direction.md", Body: direction }));
      console.log("direction updated, length:", direction.length);
      return json(200, { ok: true });
    }

    // ---- Available instance types + vCPU quota ------------------------------
    // Queries EC2 for current-gen Graviton types in the t/c/m/r families,
    // picks the latest generation per family+size slot, and fetches the
    // account's on-demand vCPU quota so the UI can show capacity limits.
    if (method === "GET" && path === "/cluster/instance-types") {
      const { EC2Client, DescribeInstanceTypesCommand } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({});
      const allowed = /^(t|c|m|r)\d+g\.(small|medium|large|xlarge)$/;
      const wantSlots = new Map([
        ["t-small", null as any], ["t-medium", null as any],
        ["m-medium", null as any], ["m-large", null as any],
        ["c-large", null as any], ["r-large", null as any],
        ["m-xlarge", null as any],
      ]);
      let nextToken: string | undefined;
      do {
        const resp = await ec2.send(new DescribeInstanceTypesCommand({
          Filters: [
            { Name: "current-generation", Values: ["true"] },
            { Name: "processor-info.supported-architecture", Values: ["arm64"] },
          ],
          MaxResults: 100,
          NextToken: nextToken,
        }));
        for (const t of resp.InstanceTypes ?? []) {
          if (!t.InstanceType || !allowed.test(t.InstanceType)) continue;
          const family = t.InstanceType.replace(/\d.*/, "");
          const size = t.InstanceType.split(".")[1];
          const slot = `${family}-${size}`;
          if (!wantSlots.has(slot)) continue;
          const existing = wantSlots.get(slot);
          const gen = parseInt(t.InstanceType.replace(/\D+/g, ""));
          if (!existing || gen > existing.gen) {
            wantSlots.set(slot, {
              gen,
              type: t.InstanceType,
              vcpus: t.VCpuInfo?.DefaultVCpus ?? 0,
              memoryMb: t.MemoryInfo?.SizeInMiB ?? 0,
            });
          }
        }
        nextToken = resp.NextToken;
      } while (nextToken);

      // Sort: small to xlarge, then t < c < m < r within each size
      const sizeOrder: Record<string, number> = { small: 0, medium: 1, large: 2, xlarge: 3 };
      const familyOrder: Record<string, number> = { t: 0, c: 1, m: 2, r: 3 };
      const types = Array.from(wantSlots.values())
        .filter(Boolean)
        .map(v => ({ type: v.type, vcpus: v.vcpus, memoryGb: Math.round(v.memoryMb / 1024) }))
        .sort((a, b) => {
          const af = a.type.replace(/\d.*/, ""), bf = b.type.replace(/\d.*/, "");
          const as = a.type.split(".")[1], bs = b.type.split(".")[1];
          const sd = (sizeOrder[as] ?? 9) - (sizeOrder[bs] ?? 9);
          if (sd !== 0) return sd;
          return (familyOrder[af] ?? 9) - (familyOrder[bf] ?? 9);
        });

      // On-demand vCPU quota (L-1216C47A = standard families A,C,D,H,I,M,R,T,Z)
      const { ServiceQuotasClient, GetServiceQuotaCommand } = await import("@aws-sdk/client-service-quotas");
      const sq = new ServiceQuotasClient({});
      let vcpuQuota = 0;
      try {
        const qr = await sq.send(new GetServiceQuotaCommand({ ServiceCode: "ec2", QuotaCode: "L-1216C47A" }));
        vcpuQuota = qr.Quota?.Value ?? 0;
      } catch { vcpuQuota = 0; }

      return json(200, { instanceTypes: types, vcpuQuota, concurrencyCap: CONCURRENCY_CAP });
    }

    return json(404, { error: "not found" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("handler error:", method, path, message, err instanceof Error ? err.stack : "");
    return json(500, { error: message });
  }
}
