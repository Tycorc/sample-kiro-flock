import { runLoop, type AgentLoopConfig } from "./agentLoop";

// --- Mocks ---

jest.mock("node:fs", () => ({
  readFileSync: jest.fn().mockReturnValue("## Agent Loop Prompt\nDo stuff."),
}));

const mockClient = {
  prompt: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock("./acpClient", () => ({
  AcpClient: {
    create: jest.fn().mockImplementation(() => Promise.resolve(mockClient)),
  },
}));

// --- Helpers ---

function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    agentIndex: 2,
    concurrency: 5,
    neighbours: [1, 3],
    bucket: "test-bucket",
    region: "us-east-1",
    loopIntervalSeconds: 0,
    model: null,
    ...overrides,
  };
}

// --- Tests ---

beforeEach(() => {
  jest.clearAllMocks();
});

describe("agentLoop", () => {
  describe("initialPrompt content", () => {
    it("contains correct agent ID and neighbour paths", async () => {
      let capturedPrompt = "";
      mockClient.prompt.mockImplementation(async function* (text: string) {
        capturedPrompt = text;
        process.emit("SIGTERM" as any);
      });

      await runLoop(makeConfig());

      expect(capturedPrompt).toContain("agent-2");
      expect(capturedPrompt).toContain("/store/agent-2.ndjson");
      expect(capturedPrompt).toContain("/store/agent-1.ndjson");
      expect(capturedPrompt).toContain("/store/agent-3.ndjson");
    });
  });

  describe("shutdown", () => {
    it("exits cleanly on SIGTERM", async () => {
      mockClient.prompt.mockImplementation(async function* () {
        process.emit("SIGTERM" as any);
      });

      await expect(runLoop(makeConfig())).resolves.toBeUndefined();
      expect(mockClient.close).toHaveBeenCalled();
    });
  });

  describe("MCP server config", () => {
    it("passes bucket and region to the S3 MCP server entry", async () => {
      mockClient.prompt.mockImplementation(async function* () {
        process.emit("SIGTERM" as any);
      });

      const { AcpClient } = require("./acpClient");
      await runLoop(makeConfig({ bucket: "my-bucket", region: "eu-west-1" }));

      const createOpts = AcpClient.create.mock.calls[0][0];
      const server = createOpts.mcpServers[0];
      expect(server.name).toBe("aga-s3");
      expect(server.env).toContainEqual({ name: "AGA_BUCKET", value: "my-bucket" });
      expect(server.env).toContainEqual({ name: "AGA_REGION", value: "eu-west-1" });
    });
  });
});
