import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import { ClusterConfig } from "./s3Store";
import { renderAgentUserData } from "./userData";

const ec2 = new EC2Client({});

export interface AgentInstanceInfo {
  instanceId: string;
  agentIndex: number;
  state: string;
  launchTime: string | null;
}

export interface StartClusterContext {
  bucket: string;
  amiId: string;
  securityGroupId: string;
  instanceProfileArn: string;
  subnetId: string;
}

export async function startCluster(
  ctx: StartClusterContext,
  config: ClusterConfig,
): Promise<string[]> {
  const region = await ec2.config.region();
  const ids: string[] = [];

  for (let i = 0; i < config.concurrency; i++) {
    const userData = renderAgentUserData({
      agentIndex: i,
      concurrency: config.concurrency,
      neighbourRadius: config.neighbourRadius,
      bucket: ctx.bucket,
      region,
      loopIntervalSeconds: config.loopIntervalSeconds,
      model: config.model,
    });

    const res = await ec2.send(new RunInstancesCommand({
      ImageId: ctx.amiId,
      InstanceType: config.instanceType as any,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: ctx.subnetId,
      SecurityGroupIds: [ctx.securityGroupId],
      IamInstanceProfile: { Arn: ctx.instanceProfileArn },
      UserData: Buffer.from(userData).toString("base64"),
      TagSpecifications: [{
        ResourceType: "instance",
        Tags: [
          // for an expansion to multi cluster clean up via the tag would be better
          { Key: "Project", Value: "kiro-flock" },
          { Key: "AgentIndex", Value: String(i) },
          { Key: "Name", Value: `aga-agent-${i}` },
        ],
      }],
    }));

    const id = res.Instances?.[0]?.InstanceId;
    if (id) ids.push(id);
  }

  return ids;
}

export async function stopCluster(bucket: string): Promise<void> {
  // Find all instances by tag, not just the stored IDs, to catch any that
  // were launched but not recorded (e.g. due to a Lambda timeout).
  const tagRes = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: "tag:Project", Values: ["kiro-flock"] },
      { Name: "instance-state-name", Values: ["pending", "running", "stopping"] },
    ],
  }));
  const ids: string[] = [];
  for (const r of tagRes.Reservations ?? []) {
    for (const inst of r.Instances ?? []) {
      if (inst.InstanceId) ids.push(inst.InstanceId);
    }
  }
  if (ids.length === 0) return;
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
}

export async function describeCluster(bucket: string): Promise<AgentInstanceInfo[]> {
  // Query EC2 by the Project tag as the single source of truth.
  const tagRes = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: "tag:Project", Values: ["kiro-flock"] },
      { Name: "instance-state-name", Values: ["pending", "running", "shutting-down", "stopping"] },
    ],
  }));

  const agents: AgentInstanceInfo[] = [];
  for (const reservation of tagRes.Reservations ?? []) {
    for (const inst of reservation.Instances ?? []) {
      const state = inst.State?.Name ?? "unknown";
      const indexTag = inst.Tags?.find(t => t.Key === "AgentIndex");
      agents.push({
        instanceId: inst.InstanceId ?? "",
        agentIndex: indexTag?.Value != null ? Number(indexTag.Value) : -1,
        state,
        launchTime: inst.LaunchTime?.toISOString() ?? null,
      });
    }
  }

  if (agents.length === 0) return [];

  return agents.sort((a, b) => a.agentIndex - b.agentIndex);
}
