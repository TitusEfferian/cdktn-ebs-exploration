# NiFi cluster + ZooKeeper ensemble on ECS/EC2 with per-slot EBS persistence

The "real project" evolution of the [EBS persistence demo](README-ebs-demo.md):
a 3-node **Apache NiFi 2.10** cluster coordinated by a 3-node **ZooKeeper
3.9.5** ensemble, on the same ECS cluster, with the same
volume-survives-the-instance guarantee — now six times over.

## Topology

| Slot   | AZ              | Instance   | Volume (gp3)     | Task                           |
|--------|-----------------|------------|------------------|--------------------------------|
| nifi-1 | ap-northeast-1a | t4g.medium | nifi-1-data 30 G | apache/nifi:2.10.0 (HTTPS mTLS)|
| nifi-2 | ap-northeast-1c | t4g.medium | nifi-2-data 30 G | apache/nifi:2.10.0 (HTTPS mTLS)|
| nifi-3 | ap-northeast-1d | t4g.medium | nifi-3-data 30 G | apache/nifi:2.10.0 (HTTPS mTLS)|
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

**TLS from first boot:** NiFi runs the image's own `AUTH=tls` path — HTTPS
UI/API on 8443 with client-certificate auth, mutual TLS on the cluster
protocol (11443) and load-balance (6342) channels. You mint the CA, per-node
keystores and shared truststore locally with [`scripts/tls/`](scripts/tls/README.md)
(outputs are gitignored) and upload them into Secrets Manager via CLI; the
container decodes them back to files at start and **crash-loops, on purpose,
until you do** (clear log line, no bogus certs ever). The UI needs
`admin.p12` imported into your browser — there is no username/password.

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
```

## Generate TLS material + populate ALL SEVEN secrets (REQUIRED)

Terraform only creates placeholder-seeded Secrets Manager secrets and ignores
value changes forever — the real values are yours to set. **NiFi tasks
crash-loop with a clear log line (`TLS keystore secret not populated...`)
until the four TLS material secrets hold real base64** — deliberate
fail-closed. The order is always deploy → populate → roll: `put-secret-value`
cannot create a secret, the secrets only exist after `cdktn deploy` (and a
destroy deletes them, recovery window 0), so run the uploads right after
deploy while NiFi crash-loops harmlessly, then force a new deployment on
nifi-1/2/3. Step 1 (minting the TLS material) can happen anytime — before or
after deploy.

Step 1 — mint the CA + node keystores + shared truststore + admin browser cert
(outputs land in gitignored `scripts/tls/out`; the keystore password must be
**colon-free** — `02` enforces it). Needs JDK 21+ (`keytool -version`) and Git
for Windows; from PowerShell, Git Bash runs the scripts (bare `bash` would hit
Windows' WSL stub):

```powershell
cd scripts\tls
$env:TLS_CA_PASS='...'; $env:TLS_NODE_PASS='...'; $env:TLS_TRUST_PASS='...'; $env:TLS_ADMIN_PASS='...'
$gitbash = 'C:\Program Files\Git\bin\bash.exe'
& $gitbash 01-generate-ca.sh; & $gitbash 02-generate-node-certs.sh; & $gitbash 03-generate-truststore.sh; & $gitbash 04-generate-admin-cert.sh; & $gitbash 99-verify.sh
cd ..\..
```

(sh equivalent for WSL/Docker/Linux — see `scripts/tls/README.md`; no JDK
locally? `docker run --rm -it -v "${PWD}\scripts\tls:/tls" -w /tls
eclipse-temurin:21 bash` from the repo root, then run the scripts inside.)

Step 2 — upload (PowerShell, from the repo root):

```powershell
# the NiFi sensitive-props key (>=12 chars, encrypts sensitive values in flow.json):
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/sensitive-props-key --secret-string 'your-random-key-min-12-chars'

# the two TLS passwords (exactly the values you exported in step 1):
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-password   --secret-string 'the-TLS_NODE_PASS-you-used'
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/truststore-password --secret-string 'the-TLS_TRUST_PASS-you-used'

# the TLS material as base64 text (decoded back to .p12 files at container start):
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-nifi-1 --secret-string ([Convert]::ToBase64String([IO.File]::ReadAllBytes("scripts\tls\out\nodes\nifi-1\keystore.p12")))
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-nifi-2 --secret-string ([Convert]::ToBase64String([IO.File]::ReadAllBytes("scripts\tls\out\nodes\nifi-2\keystore.p12")))
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-nifi-3 --secret-string ([Convert]::ToBase64String([IO.File]::ReadAllBytes("scripts\tls\out\nodes\nifi-3\keystore.p12")))
aws secretsmanager put-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/truststore --secret-string ([Convert]::ToBase64String([IO.File]::ReadAllBytes("scripts\tls\out\shared\truststore.p12")))

# verify all SEVEN landed — each line prints "False <length>" when populated, or
# "True <length>" while still the placeholder (the value itself is never printed):
aws secretsmanager get-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/sensitive-props-key --query "[starts_with(SecretString,'PLACEHOLDER'),length(SecretString)]" --output text
aws secretsmanager get-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-password --query "[starts_with(SecretString,'PLACEHOLDER'),length(SecretString)]" --output text
aws secretsmanager get-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/truststore-password --query "[starts_with(SecretString,'PLACEHOLDER'),length(SecretString)]" --output text
aws secretsmanager get-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-nifi-1 --query "[starts_with(SecretString,'PLACEHOLDER'),length(SecretString)]" --output text
aws secretsmanager get-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-nifi-2 --query "[starts_with(SecretString,'PLACEHOLDER'),length(SecretString)]" --output text
aws secretsmanager get-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/keystore-nifi-3 --query "[starts_with(SecretString,'PLACEHOLDER'),length(SecretString)]" --output text
aws secretsmanager get-secret-value --region $REGION --secret-id ecs-ebs-demo/nifi/tls/truststore --query "[starts_with(SecretString,'PLACEHOLDER'),length(SecretString)]" --output text

# secrets are injected at container START only — roll the three NiFi services:
aws ecs update-service --region $REGION --cluster $CLUSTER --service nifi-1 --force-new-deployment | Out-Null
aws ecs update-service --region $REGION --cluster $CLUSTER --service nifi-2 --force-new-deployment | Out-Null
aws ecs update-service --region $REGION --cluster $CLUSTER --service nifi-3 --force-new-deployment | Out-Null
aws ecs wait services-stable --region $REGION --cluster $CLUSTER --services nifi-1 nifi-2 nifi-3
```

**NEVER delete these secrets**: all five per-node bindings (key, two
passwords, keystore, truststore) are launch-time dependencies — a missing one
fails every new NiFi task. Set the sensitive-props key BEFORE building any
flow you care about: it encrypts sensitive component properties inside
`flow.json.gz`, so changing it later invalidates those saved values (a
destroy-first workflow sidesteps this entirely).

```powershell
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

One-time browser prep: import `scripts/tls/out/clients/admin/admin.p12`
(password = your `TLS_ADMIN_PASS`) into the browser/OS certificate store —
the UI authenticates by client certificate; there is no username/password.
Optionally trust `scripts/tls/out/ca/ca.pem` to silence the server-cert
warning (the server cert is signed by your private CA).

The tasks live in private subnets with no load balancer; the tunnel rides SSM
through the slot's own instance (instance SG → task SG :8443 is allowed):

```powershell
$TASK = aws ecs list-tasks --region $REGION --cluster $CLUSTER --service-name nifi-1 --query "taskArns[0]" --output text
$TASK_IP = aws ecs describe-tasks --region $REGION --cluster $CLUSTER --tasks $TASK --query "tasks[0].attachments[?type=='ElasticNetworkInterface'] | [0].details[?name=='privateIPv4Address'] | [0].value" --output text
$CI  = aws ecs describe-tasks --region $REGION --cluster $CLUSTER --tasks $TASK --query "tasks[0].containerInstanceArn" --output text
$IID = aws ecs describe-container-instances --region $REGION --cluster $CLUSTER --container-instances $CI --query "containerInstances[0].ec2InstanceId" --output text

aws ssm start-session --region $REGION --target $IID --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=$TASK_IP,portNumber=8443,localPortNumber=8443"
```

> Windows note: use exactly this **shorthand** `--parameters` form. The JSON
> form breaks silently under Windows PowerShell 5.1 (it strips the inner
> quotes before the CLI sees them).

Browse **https://localhost:8443/nifi** — accept the CA warning (unless you
trusted `ca.pem`) and pick the `admin` certificate when the browser prompts.
`localhost`/`127.0.0.1` are in every node cert's SAN precisely for this tunnel.

Cluster state check — from INSIDE a nifi container (the API requires a client
certificate; the node's own keystore doubles as one, and Windows PowerShell
5.1 can neither skip CA validation nor send P12 client certs cleanly):

```powershell
aws ecs execute-command --region $REGION --cluster $CLUSTER --task $TASK --container nifi --interactive --command "/bin/bash"
#   inside:
#     curl -fsk --cert-type P12 --cert /opt/nifi/nifi-current/conf/keystore.p12:"$KEYSTORE_PASSWORD" https://nifi-1.nifi.internal:8443/nifi-api/controller/cluster | grep -o '"status":"[A-Z_]*"' | sort | uniq -c
#   expect: 3 x "CONNECTED"
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

## How the TLS pieces fit

TLS is ON from first boot — [`scripts/tls/README.md`](scripts/tls/README.md)
documents the whole wiring: the keytool suite (plain JDK 21 `keytool`; NiFi
2.x removed tls-toolkit), the Secrets Manager delivery flow, the RFC1779
identity-string rules, how the container wrapper fixes (and then asserts) the
stock image's `authorizers.xml` Node-Identity gap, why tenant files
(`users.xml`/`authorizations.xml`) stay ephemeral and re-seed every start, and
rotation.

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
data, by design, for this demo. The seven Secrets Manager secrets delete
immediately too (`recovery_window_in_days = 0` — no 30-day "scheduled for
deletion" state), so their names are instantly reusable on the next deploy;
re-populate ALL of them after every fresh deploy (the TLS material in
`scripts/tls/out` can be re-uploaded as-is — no need to re-mint certs).
