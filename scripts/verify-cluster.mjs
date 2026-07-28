// Workstation-side deployment verifier (read-only). Run after `cdktn deploy`:
//
//   node scripts/verify-cluster.mjs        (or: npm run verify:cluster)
//
// Checks, one console.table per section:
//   1. the six slot services are stable (running == desired, single deployment)
//   2. every task is RUNNING and health-checked, with its awsvpc ENI IP
//   3. the six slot volumes are in-use and attached
//   4. Cloud Map resolves every slot name (data-plane DiscoverInstances)
//
// Credentials come from the default provider chain (env, SSO, profile...);
// exits non-zero if any check fails. IAM needed: ecs:DescribeServices,
// ecs:ListTasks, ecs:DescribeTasks, ec2:DescribeVolumes,
// servicediscovery:DiscoverInstances.

import { ECSClient, DescribeServicesCommand, ListTasksCommand, DescribeTasksCommand } from "@aws-sdk/client-ecs";
import { EC2Client, DescribeVolumesCommand } from "@aws-sdk/client-ec2";
import { ServiceDiscoveryClient, DiscoverInstancesCommand } from "@aws-sdk/client-servicediscovery";

// Must match stacks/my-stack.ts.
const REGION = "ap-northeast-1";
const CLUSTER = "ecs-ebs-demo";
const NAMESPACE = "nifi.internal";
const SLOTS = ["nifi-1", "nifi-2", "nifi-3", "zk-1", "zk-2", "zk-3"];
const VOLUME_TAGS = SLOTS.map((s) => `${s}-data`);

const ecs = new ECSClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const sd = new ServiceDiscoveryClient({ region: REGION });

let ok = true;
const fail = (msg) => {
  ok = false;
  console.error(`FAIL: ${msg}`);
};

// --- 1. services -------------------------------------------------------------
// One call covers all six (DescribeServices caps at 10). Missing services land
// in failures[], not as thrown errors — must be checked explicitly.
const svcRes = await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: SLOTS }));
for (const f of svcRes.failures ?? []) fail(`service ${f.arn}: ${f.reason}`);
console.log("\n=== ECS services ===");
console.table(
  (svcRes.services ?? []).map((s) => {
    if (s.runningCount !== s.desiredCount) fail(`${s.serviceName}: running ${s.runningCount}/${s.desiredCount}`);
    if ((s.deployments ?? []).length > 1) fail(`${s.serviceName}: deployment still rolling`);
    return {
      service: s.serviceName,
      status: s.status,
      desired: s.desiredCount,
      running: s.runningCount,
      pending: s.pendingCount,
      deployments: (s.deployments ?? []).length,
    };
  }),
);

// --- 2. tasks ---------------------------------------------------------------
console.log("=== tasks ===");
const taskRows = [];
for (const slot of SLOTS) {
  const { taskArns = [] } = await ecs.send(
    new ListTasksCommand({ cluster: CLUSTER, serviceName: slot }),
  );
  if (taskArns.length === 0) {
    fail(`${slot}: no running task`);
    taskRows.push({ slot, task: "-", lastStatus: "MISSING", health: "-", eniIp: "-" });
    continue;
  }
  const { tasks = [] } = await ecs.send(
    new DescribeTasksCommand({ cluster: CLUSTER, tasks: taskArns }),
  );
  for (const t of tasks) {
    const eniIp =
      t.attachments
        ?.find((a) => a.type === "ElasticNetworkInterface")
        ?.details?.find((d) => d.name === "privateIPv4Address")?.value ?? "-";
    if (t.lastStatus !== "RUNNING") fail(`${slot}: task ${t.lastStatus}`);
    if (t.healthStatus === "UNHEALTHY") fail(`${slot}: task UNHEALTHY`);
    taskRows.push({
      slot,
      task: (t.taskArn ?? "").split("/").pop(),
      lastStatus: t.lastStatus,
      health: t.healthStatus, // UNKNOWN until the first health check passes
      eniIp,
    });
  }
}
console.table(taskRows);

// --- 3. volumes -------------------------------------------------------------
console.log("=== slot volumes ===");
const volRes = await ec2.send(
  new DescribeVolumesCommand({ Filters: [{ Name: "tag:Name", Values: VOLUME_TAGS }] }),
);
const volByTag = new Map(
  (volRes.Volumes ?? []).map((v) => [v.Tags?.find((t) => t.Key === "Name")?.Value, v]),
);
console.table(
  VOLUME_TAGS.map((tag) => {
    const v = volByTag.get(tag);
    if (!v) {
      fail(`volume ${tag}: not found`);
      return { volume: tag, state: "MISSING", attachedTo: "-", az: "-" };
    }
    const att = v.Attachments?.[0];
    if (v.State !== "in-use" || att?.State !== "attached") fail(`volume ${tag}: ${v.State}/${att?.State ?? "detached"}`);
    return {
      volume: tag,
      state: v.State,
      attachedTo: att?.InstanceId ?? "-",
      az: v.AvailabilityZone,
    };
  }),
);

// --- 4. Cloud Map -----------------------------------------------------------
// DiscoverInstances is the DATA plane — the same path clients resolve through.
console.log("=== Cloud Map (nifi.internal) ===");
const sdRows = [];
for (const slot of SLOTS) {
  try {
    const { Instances = [] } = await sd.send(
      new DiscoverInstancesCommand({
        NamespaceName: NAMESPACE,
        ServiceName: slot,
        HealthStatus: "ALL",
      }),
    );
    if (Instances.length === 0) fail(`cloud map ${slot}: no registered instance`);
    for (const i of Instances) {
      sdRows.push({
        name: `${slot}.${NAMESPACE}`,
        ip: i.Attributes?.AWS_INSTANCE_IPV4 ?? "-",
        health: i.HealthStatus,
      });
    }
  } catch (err) {
    fail(`cloud map ${slot}: ${err.name}: ${err.message}`);
  }
}
console.table(sdRows);

if (!ok) {
  console.error("\nverify-cluster: FAILED (see FAIL lines above)");
  process.exitCode = 1;
} else {
  console.log("\nverify-cluster: all checks passed");
}
