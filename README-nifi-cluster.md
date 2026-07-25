# NiFi cluster + ZooKeeper ensemble on ECS/EC2 with per-slot EBS persistence

The "real project" evolution of the [EBS persistence demo](README-ebs-demo.md):
a 3-node **Apache NiFi 2.10** cluster coordinated by a 3-node **ZooKeeper
3.9.5** ensemble, on the same ECS cluster, with the same
volume-survives-the-instance guarantee — now six times over.

## Topology

| Slot   | AZ              | Instance   | Volume (gp3)     | Task                          |
|--------|-----------------|------------|------------------|-------------------------------|
| nifi-1 | ap-northeast-1a | t4g.medium | nifi-1-data 30 G | apache/nifi:2.10.0 (HTTP)     |
| nifi-2 | ap-northeast-1c | t4g.medium | nifi-2-data 30 G | apache/nifi:2.10.0 (HTTP)     |
| nifi-3 | ap-northeast-1d | t4g.medium | nifi-3-data 30 G | apache/nifi:2.10.0 (HTTP)     |
| zk-1   | ap-northeast-1a | t4g.small  | zk-1-data 10 G   | zookeeper:3.9.5 (ECR mirror)  |
| zk-2   | ap-northeast-1c | t4g.small  | zk-2-data 10 G   | zookeeper:3.9.5 (ECR mirror)  |
| zk-3   | ap-northeast-1d | t4g.small  | zk-3-data 10 G   | zookeeper:3.9.5 (ECR mirror)  |

Every slot is: one single-instance ASG (AZ-pinned via its one subnet) → one
**capacity provider** → one ECS service (desired=1, min 0%/max 100%). The
capacity provider is the placement fence: a slot's task can only ever run on
that slot's instance; while the instance is being replaced the task waits in
PROVISIONING. Tasks run in **awsvpc** mode and register **A records** in the
Cloud Map private zone `nifi.internal` (`nifi-1.nifi.internal`, ..., TTL 10 s)
— stable peer names that survive task/instance replacement.

At boot, each instance runs the same SDK-v3 boot program as the original demo:
discover volume by `Name=<slot>-data` in its own AZ → wait until `available`
(a replaced instance's volume may still be detaching) → attach → mkfs **only
if empty** → mount `/mnt/ebs` → create/chown the role's directories → install a
systemd guard (the ECS agent refuses to start unless `/mnt/ebs` is mounted) →
write `ECS_CLUSTER` **last**. NiFi's repositories
(`flowfile/content/provenance/database/state/flow`) and ZK's `data/datalog`
are host-bind-mounted from the volume, so a slot's whole identity — ZK `myid`,
NiFi flow + repos — survives instance replacement.

**Unsecured HTTP (deliberate, demo-only):** NiFi 2.x supports HTTP clustering
(all requests anonymous), but its Docker image removed the HTTP mode — the
task definition patches the image's `start.sh` at container start (guarded
`sed`s that FAIL the container loudly if the upstream image changes). TLS is
prepared but not enabled: see [`scripts/tls/`](scripts/tls/README.md).

The busybox demo from README-ebs-demo.md keeps running unchanged alongside.

## Prerequisites

- AWS credentials for the target account in `ap-northeast-1`; AWS CLI v2;
  **Session Manager plugin** (for `ecs execute-command` and the UI tunnel);
  `cdktn` toolchain.
- Rough cost while running 24/7: ~**$200/month** (3×t4g.medium + 4×t4g.small
  incl. busybox, single NAT gateway, ~110 GiB gp3, logs — Tokyo on-demand,
  approximate). Tear down with `cdktn destroy` when idle.

All commands below are PowerShell-first; set once per session:

```powershell
$REGION = "ap-northeast-1"; $CLUSTER = "ecs-ebs-demo"; $env:AWS_PAGER = ""
```

## Pre-deploy checks

```powershell
# this account must expose the three pinned AZs (fails loudly if not):
aws ec2 describe-availability-zones --region $REGION --zone-names ap-northeast-1a ap-northeast-1c ap-northeast-1d --query "AvailabilityZones[].{Name:ZoneName,ID:ZoneId,State:State}" --output table

# t4g ENI capacity (expect MaximumNetworkInterfaces = 3 — one task ENI + primary is plenty):
aws ec2 describe-instance-types --region $REGION --instance-types t4g.small t4g.medium --query "InstanceTypes[].[InstanceType,NetworkInfo.MaximumNetworkInterfaces,MemoryInfo.SizeInMiB]" --output table
```

## Deploy and watch the cluster form

```powershell
cdktn deploy        # review the plan, then approve
cdktn output        # slot_asg_names, slot_volume_ids, ui_port_forward_hint, ...

# optionally override the NiFi sensitive-props key (>=12 chars; else a demo default is used):
#   cdktn deploy --var nifi_sensitive_props_key=<random-string>

# watch all six services come up (Ctrl+C to stop):
while ($true) { aws ecs describe-services --region $REGION --cluster $CLUSTER --services nifi-1 nifi-2 nifi-3 zk-1 zk-2 zk-3 --query "services[].{name:serviceName,desired:desiredCount,running:runningCount,status:status}" --output table; Start-Sleep 10 }
```

First boot takes a few minutes per slot: image pull through the NAT, then NiFi
NAR unpack + JVM start (~2–4 min) + flow election (≤1 min once all three vote).
ZooKeeper needs 2 of 3 members up to form quorum; everything retries until then.

One-shot verification from the workstation (services, tasks + ENI IPs,
volumes, Cloud Map):

```powershell
npm run verify:cluster
```

## Verify ZooKeeper

```powershell
$ZK_TASK = aws ecs list-tasks --region $REGION --cluster $CLUSTER --service-name zk-1 --query "taskArns[0]" --output text
aws ecs execute-command --region $REGION --cluster $CLUSTER --task $ZK_TASK --container zookeeper --interactive --command "/bin/bash"
#   inside:  zkServer.sh status            -> Mode: leader | follower
#            echo srvr | nc localhost 2181 -> version/mode/connection stats
#            echo mntr | nc localhost 2181 -> full metrics
```

(If exec says the agent isn't ready yet, wait for `managedAgents` →
`"lastStatus": "RUNNING"` in `aws ecs describe-tasks`.)

## Open the NiFi UI (SSM port-forward)

The tasks live in private subnets with no load balancer; the tunnel rides SSM
through the slot's own instance (instance SG → task SG :8080 is allowed):

```powershell
$TASK = aws ecs list-tasks --region $REGION --cluster $CLUSTER --service-name nifi-1 --query "taskArns[0]" --output text
$TASK_IP = aws ecs describe-tasks --region $REGION --cluster $CLUSTER --tasks $TASK --query "tasks[0].attachments[?type=='ElasticNetworkInterface'] | [0].details[?name=='privateIPv4Address'] | [0].value" --output text
$CI  = aws ecs describe-tasks --region $REGION --cluster $CLUSTER --tasks $TASK --query "tasks[0].containerInstanceArn" --output text
$IID = aws ecs describe-container-instances --region $REGION --cluster $CLUSTER --container-instances $CI --query "containerInstances[0].ec2InstanceId" --output text

aws ssm start-session --region $REGION --target $IID --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=$TASK_IP,portNumber=8080,localPortNumber=8080"
```

> Windows note: use exactly this **shorthand** `--parameters` form. The JSON
> form breaks silently under Windows PowerShell 5.1 (it strips the inner
> quotes before the CLI sees them).

Browse **http://localhost:8080/nifi** (no login — anonymous HTTP demo mode).
Cluster state from the same tunnel:

```powershell
(Invoke-RestMethod "http://localhost:8080/nifi-api/controller/cluster").cluster.nodes | Select-Object address,status   # expect 3 x CONNECTED
```

`Ctrl+C` ends the tunnel.

## The demo: kill a slot, keep the data

Build something visible first (e.g. a GenerateFlowFile → funnel flow on the
canvas), then kill the slot that hosts it:

```powershell
$ASG = "ecs-ebs-demo-nifi-2"   # stable per-slot names; also in `cdktn output slot_asg_names`
$VICTIM = aws autoscaling describe-auto-scaling-groups --region $REGION --auto-scaling-group-names $ASG --query "AutoScalingGroups[0].Instances[0].InstanceId" --output text
$VOL = aws ec2 describe-volumes --region $REGION --filters "Name=tag:Name,Values=nifi-2-data" --query "Volumes[0].VolumeId" --output text

# kill: ASG replaces the instance immediately (returns the scaling activity)
aws autoscaling terminate-instance-in-auto-scaling-group --region $REGION --instance-id $VICTIM --no-should-decrement-desired-capacity

# watch the replacement...
aws autoscaling describe-scaling-activities --region $REGION --auto-scaling-group-name $ASG --max-items 5 --query "Activities[].{start:StartTime,status:StatusCode,progress:Progress,desc:Description}" --output table

# ...and the volume letting go of the old instance, then re-attaching to the new one:
aws ec2 wait instance-terminated --region $REGION --instance-ids $VICTIM
aws ec2 wait volume-available    --region $REGION --volume-ids $VOL      # detached from the old instance
aws ec2 wait volume-in-use       --region $REGION --volume-ids $VOL      # re-attached to the replacement
aws ec2 describe-volumes --region $REGION --volume-ids $VOL --query "Volumes[0].{state:State,attach:Attachments[0].State,instance:Attachments[0].InstanceId}" --output table
```

Meanwhile the other two NiFi nodes keep serving (the UI through nifi-1/nifi-3
stays up; ZK quorum 2/3 likewise survives a zk-slot kill). When the new task is
RUNNING: **the task ENI IP changed** — re-derive `$TASK_IP`/`$IID` and restart
the port-forward, then confirm 3× CONNECTED again and that your flow is still
on the canvas. That flow lived in `flow_storage/flow.json.gz` — plus all
repositories — on `nifi-2-data`, which followed the slot to its new instance.

## Optional: faster DNS healing for the kill demo

While a slot's task is being replaced, its Cloud Map A record is briefly
absent; the VPC resolver may cache that NXDOMAIN for up to ~15 min (the zone's
SOA default), which can make peers slow to re-find the returning node. One-time
tweak per deployment (re-apply after a destroy/recreate):

```powershell
$VPC_ID = (cdktn output | Select-String "vpc_id").ToString().Split("=")[-1].Trim()
$ZONE = aws route53 list-hosted-zones-by-vpc --vpc-id $VPC_ID --vpc-region $REGION --query "HostedZoneSummaries[?starts_with(Name, 'nifi.internal')].HostedZoneId | [0]" --output text
$soa   = aws route53 list-resource-record-sets --hosted-zone-id $ZONE --query "ResourceRecordSets[?Type=='SOA'] | [0]" --output json | ConvertFrom-Json
$parts = $soa.ResourceRecords[0].Value -split ' '
$parts[6] = "60"    # SOA "minimum" = negative-caching TTL
$batch = @{ Comment = "Demo: lower negative-caching TTL to 60s"; Changes = @(@{ Action = "UPSERT"; ResourceRecordSet = @{ Name = $soa.Name; Type = "SOA"; TTL = 60; ResourceRecords = @(@{ Value = ($parts -join ' ') }) } }) }
$batch | ConvertTo-Json -Depth 6 | Out-File change-soa.json -Encoding ascii   # ascii is load-bearing: PS5.1's default UTF-16 breaks the CLI
$CHANGE_ID = aws route53 change-resource-record-sets --hosted-zone-id $ZONE --change-batch file://change-soa.json --query "ChangeInfo.Id" --output text
aws route53 wait resource-record-sets-changed --id $CHANGE_ID
```

(Change only the SOA — never the NS record. Effective negative TTL =
min(SOA record TTL, SOA minimum field), hence 60/60.)

## Enabling TLS later

Everything needed to mint a CA + per-node keystores + shared truststore with
plain JDK 21 `keytool` (NiFi 2.x removed tls-toolkit) is in
[`scripts/tls/`](scripts/tls/README.md), including the artifact layout for
S3 delivery, the identity-string (RFC1779) rules, the `authorizers.xml`
Node-Identity gap in the stock image, and the exact env-var flip from the
HTTP entrypoint patch to the image's own `AUTH=tls` path.

## Teardown

```powershell
# 1. stop the tasks so every volume detaches (instances release them on scale-in):
foreach ($s in "nifi-1","nifi-2","nifi-3","zk-1","zk-2","zk-3") { aws ecs update-service --region $REGION --cluster $CLUSTER --service $s --desired-count 0 | Out-Null }
# 2. destroy
cdktn destroy
```

Skipping step 1 usually still works — destroying the ASGs terminates the
instances, which auto-detaches the volumes — but Terraform will sit retrying
`DeleteVolume` (VolumeInUse) for up to ~10 minutes per volume if a detach is
slow. There is **no prevent_destroy** on the slot volumes: destroy deletes the
data, by design, for this demo.
