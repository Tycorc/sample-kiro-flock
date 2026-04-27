// Env vars must be set before handler.ts is imported (it reads them at top level).
// jest.mock() calls are hoisted above imports by babel/ts-jest, but process.env
// assignments are NOT hoisted — so we place them inside a beforeAll won't help either.
// Instead we rely on the fact that jest runs the test file top-to-bottom AFTER hoisting
// jest.mock calls. The trick: set env vars in the jest.mock factory or simply accept
// that the BUCKET etc. will be undefined at import time. We set them here and the
// handler module will capture `undefined`. We'll adjust assertions accordingly OR
// use a different approach: set env BEFORE jest.mock via a global setup.
//
// Cleanest approach: set env vars at the very top. jest.mock is hoisted above imports
// but process.env assignments at file top level also run before imports in ts-jest.

process.env.BUCKET_NAME = "test-bucket";
process.env.AMI_ID = "ami-test";
process.env.SECURITY_GROUP_ID = "sg-test";
process.env.INSTANCE_PROFILE_ARN = "arn:aws:iam::instance-profile/test";
process.env.SUBNET_ID = "subnet-test";

import type { APIGatewayProxyEvent } from "aws-lambda";
import type { ClusterConfig, AgentLogs } from "./s3Store";
import type { AgentInstanceInfo } from "./ec2Manager";

jest.mock("./s3Store");
jest.mock("./ec2Manager");
jest.mock("./cwMetrics");

import { readConfig, writeConfig, readAgentLogs } from "./s3Store";
import { startCluster, stopCluster, describeCluster } from "./ec2Manager";
import { getInstanceMetrics } from "./cwMetrics";
import { handler } from "./handler";

const mockReadConfig = readConfig as jest.MockedFunction<typeof readConfig>;
const mockWriteConfig = writeConfig as jest.MockedFunction<typeof writeConfig>;
const mockReadAgentLogs = readAgentLogs as jest.MockedFunction<typeof readAgentLogs>;
const mockStartCluster = startCluster as jest.MockedFunction<typeof startCluster>;
const mockStopCluster = stopCluster as jest.MockedFunction<typeof stopCluster>;
const mockDescribeCluster = describeCluster as jest.MockedFunction<typeof describeCluster>;
const mockGetInstanceMetrics = getInstanceMetrics as jest.MockedFunction<typeof getInstanceMetrics>;

const DEFAULT_CONFIG: ClusterConfig = {
  concurrency: 2,
  neighbourRadius: 1,
  instanceType: "t3.medium",
  loopIntervalSeconds: 30,
  model: null,
  idleTimeoutSeconds: 120,
};

function makeEvent(method: string, path: string, body?: unknown, base64?: boolean): APIGatewayProxyEvent {
  const raw = body ? JSON.stringify(body) : null;
  return {
    httpMethod: method,
    path,
    body: base64 && raw ? Buffer.from(raw).toString("base64") : raw,
    isBase64Encoded: base64 ?? false,
  } as unknown as APIGatewayProxyEvent;
}

function parse(res: any): { status: number; body: any } {
  return { status: res.statusCode, body: JSON.parse(res.body ?? "{}") };
}

beforeEach(() => jest.clearAllMocks());

// --- Status derivation ---

describe("agent status derivation", () => {
  const instance0: AgentInstanceInfo = { instanceId: "i-0", agentIndex: 0, state: "running" };

  beforeEach(() => {
    mockReadConfig.mockResolvedValue({ ...DEFAULT_CONFIG, concurrency: 1 });
    mockDescribeCluster.mockResolvedValue([instance0]);
    mockGetInstanceMetrics.mockResolvedValue({});
  });

  test("no log entry → starting", async () => {
    mockReadAgentLogs.mockResolvedValue([
      { agentId: "agent-0", lastEntry: null, prevEntry: null, lastUpdatedTs: null },
    ]);
    const { body } = parse(await handler(makeEvent("GET", "/cluster/status")));
    expect(body.agents[0].status).toBe("starting");
  });

  test("stale timestamp → idle", async () => {
    const staleTs = new Date(Date.now() - 200_000).toISOString();
    mockReadAgentLogs.mockResolvedValue([{
      agentId: "agent-0",
      lastEntry: { ts: staleTs, iteration: 1, action: "a", result: "r", next_intent: "n" },
      prevEntry: null,
      lastUpdatedTs: staleTs,
    }]);
    const { body } = parse(await handler(makeEvent("GET", "/cluster/status")));
    expect(body.agents[0].status).toBe("idle");
  });

  test("fresh timestamp → running", async () => {
    const freshTs = new Date(Date.now() - 10_000).toISOString();
    mockReadAgentLogs.mockResolvedValue([{
      agentId: "agent-0",
      lastEntry: { ts: freshTs, iteration: 1, action: "a", result: "r", next_intent: "n" },
      prevEntry: null,
      lastUpdatedTs: freshTs,
    }]);
    const { body } = parse(await handler(makeEvent("GET", "/cluster/status")));
    expect(body.agents[0].status).toBe("running");
  });
});

// --- Route dispatch ---

describe("route dispatch", () => {
  test("POST /cluster/start calls startCluster", async () => {
    mockReadConfig.mockResolvedValue(DEFAULT_CONFIG);
    mockStartCluster.mockResolvedValue(["i-0", "i-1"]);

    const { status, body } = parse(await handler(makeEvent("POST", "/cluster/start")));
    expect(status).toBe(200);
    expect(body.instanceIds).toEqual(["i-0", "i-1"]);
    expect(mockStartCluster).toHaveBeenCalledWith(
      {
        bucket: "test-bucket",
        amiId: "ami-test",
        securityGroupId: "sg-test",
        instanceProfileArn: "arn:aws:iam::instance-profile/test",
        subnetId: "subnet-test",
      },
      expect.objectContaining({ concurrency: 2 }),
    );
  });

  test("POST /cluster/stop calls stopCluster", async () => {
    mockStopCluster.mockResolvedValue(undefined);

    const { status, body } = parse(await handler(makeEvent("POST", "/cluster/stop")));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockStopCluster).toHaveBeenCalledWith("test-bucket");
  });

  test("GET /cluster/status calls describeCluster, readAgentLogs, getInstanceMetrics", async () => {
    mockReadConfig.mockResolvedValue({ ...DEFAULT_CONFIG, concurrency: 1 });
    mockDescribeCluster.mockResolvedValue([]);
    mockReadAgentLogs.mockResolvedValue([
      { agentId: "agent-0", lastEntry: null, prevEntry: null, lastUpdatedTs: null },
    ]);
    mockGetInstanceMetrics.mockResolvedValue({});

    const { status } = parse(await handler(makeEvent("GET", "/cluster/status")));
    expect(status).toBe(200);
    expect(mockDescribeCluster).toHaveBeenCalled();
    expect(mockReadAgentLogs).toHaveBeenCalled();
    expect(mockGetInstanceMetrics).toHaveBeenCalled();
  });

  test("GET /cluster/config calls readConfig", async () => {
    mockReadConfig.mockResolvedValue(DEFAULT_CONFIG);

    const { status, body } = parse(await handler(makeEvent("GET", "/cluster/config")));
    expect(status).toBe(200);
    expect(body.concurrency).toBe(2);
    expect(mockReadConfig).toHaveBeenCalledWith("test-bucket");
  });

  test("PUT /cluster/config merges partial update with existing config", async () => {
    mockReadConfig.mockResolvedValue(DEFAULT_CONFIG);
    mockWriteConfig.mockResolvedValue(undefined);

    const partial = { concurrency: 8, instanceType: "t3.large" };
    const { status, body } = parse(await handler(makeEvent("PUT", "/cluster/config", partial)));
    expect(status).toBe(200);
    // Returns the merged config
    expect(body.concurrency).toBe(8);
    expect(body.instanceType).toBe("t3.large");
    // Fields not sent by the UI are preserved from existing config
    expect(body.loopIntervalSeconds).toBe(30);
    expect(body.idleTimeoutSeconds).toBe(120);
    expect(mockReadConfig).toHaveBeenCalledWith("test-bucket");
    expect(mockWriteConfig).toHaveBeenCalledWith("test-bucket", expect.objectContaining({
      concurrency: 8,
      instanceType: "t3.large",
      loopIntervalSeconds: 30,
      idleTimeoutSeconds: 120,
    }));
  });

  test("PUT /cluster/config handles base64-encoded body", async () => {
    mockReadConfig.mockResolvedValue(DEFAULT_CONFIG);
    mockWriteConfig.mockResolvedValue(undefined);

    const partial = { concurrency: 4 };
    const { status, body } = parse(await handler(makeEvent("PUT", "/cluster/config", partial, true)));
    expect(status).toBe(200);
    expect(body.concurrency).toBe(4);
    expect(body.loopIntervalSeconds).toBe(30);
  });

  test("unknown route returns 404", async () => {
    const { status, body } = parse(await handler(makeEvent("GET", "/nope")));
    expect(status).toBe(404);
    expect(body.error).toBe("not found");
  });
});
