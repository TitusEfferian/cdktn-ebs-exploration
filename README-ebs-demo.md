# ECS-on-EC2 + EBS persistence demo

This stack stands up a minimal ECS-on-EC2 setup whose task data lives on a **standalone
EBS volume**. The point of the demo is to prove that data written into the container's
`/data` survives the EC2 instance being terminated and replaced by the Auto Scaling Group.

## What gets deployed

- 1 ECS cluster with a single **EC2 capacity provider** wired to an Auto Scaling Group.
- 1 EC2 instance (`t4g.small`, arm64, ECS-optimized AL2023) launched by the ASG
  (`min = max = desired = 1`) into **one public subnet** (`ap-northeast-1a`).
- 1 standalone **EBS volume** (`gp3`, 5 GiB, encrypted) tagged `Name=ecs-ebs-persist`,
  created in the **same AZ** as the subnet. It is **not** attached via Terraform — the
  instance's user-data finds it by tag and attaches/mounts it at `/mnt/ebs`.
- 1 ECS service running a **busybox** task (bridge networking) with a host bind-mount
  from `/mnt/ebs` (host) into `/data` (container). Exec is enabled.

The linchpin is `scripts/user-data.sh`: it discovers the volume by tag **in the current
AZ**, attaches it, resolves the real Nitro device by volume-id, and formats it **only if
empty** (`blkid` guard). On a replacement instance the filesystem already exists, so it is
mounted without reformatting and the data is preserved.

## Prerequisites

- AWS credentials for the target account in **`ap-northeast-1`**.
- **AWS CLI v2** locally.
- **Session Manager plugin** installed locally (required for `aws ecs execute-command`).
- `cdktn` toolchain (already used by this project).

## Stack outputs

After deploy, `cdktn output` prints these keys (used throughout the runbook below):

| Output key      | What it is                                              |
|-----------------|---------------------------------------------------------|
| `cluster_name`  | ECS cluster name                                        |
| `service_name`  | ECS service name                                        |
| `ebs_volume_id` | The persistent EBS volume id                            |
| `asg_name`      | Auto Scaling Group name (resolved, includes suffix)     |
| `exec_hint`     | A ready-to-edit `aws ecs execute-command` template      |

## Runbook

```sh
# ---- deploy -------------------------------------------------------------
cd ebs_test
cdktn deploy                      # review the plan, then approve
cdktn output                      # note cluster_name, service_name, asg_name, ebs_volume_id

# ---- find the task, wait until the ExecuteCommandAgent is RUNNING --------
# (substitute the <...> placeholders with the values printed by `cdktn output`)
aws ecs list-tasks --cluster <cluster_name> --region ap-northeast-1
aws ecs describe-tasks --cluster <cluster_name> --tasks <taskId> --region ap-northeast-1 \
  --query 'tasks[0].containers[0].managedAgents'      # wait for RUNNING

# ---- exec in and WRITE THE FILE YOURSELF (this is the demo) --------------
aws ecs execute-command --cluster <cluster_name> --task <taskId> \
  --container app --interactive --command "/bin/sh" --region ap-northeast-1
#   inside the container:
#     vi /data/hello_world.txt      -> type "hello world", then :wq
#     cat /data/hello_world.txt
#     df -h /data                   # shows the mounted EBS device

# ---- find the instance and KILL it --------------------------------------
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names <asg_name> \
  --query 'AutoScalingGroups[0].Instances[].InstanceId' --region ap-northeast-1
aws ec2 terminate-instances --instance-ids <instanceId> --region ap-northeast-1

# ---- watch the ASG replace it (same AZ); user-data reattaches the volume -
aws autoscaling describe-scaling-activities --auto-scaling-group-name <asg_name> \
  --region ap-northeast-1
# (optional) tail the replacement's user-data log via SSM Session Manager:
#   cat /var/log/user-data.log   -> "filesystem exists ... NOT formatting (data preserved)"

# ---- exec into the NEW task and prove persistence -----------------------
aws ecs list-tasks --cluster <cluster_name> --region ap-northeast-1   # new taskId
aws ecs execute-command --cluster <cluster_name> --task <newTaskId> \
  --container app --interactive --command "/bin/sh" --region ap-northeast-1
#   inside: cat /data/hello_world.txt      -> still "hello world"  ✅

# ---- teardown -----------------------------------------------------------
cdktn destroy
```

## Notes

- The `hello_world.txt` file is **not** created by this stack. Writing it by hand during
  the exec session is the whole point of the demo.
- `managed_termination_protection` on the capacity provider is **DISABLED** so you can
  terminate the instance directly with `aws ec2 terminate-instances`.
- The volume has no `prevent_destroy`, so `cdktn destroy` cleans everything up.
