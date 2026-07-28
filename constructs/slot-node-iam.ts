import { Construct } from "constructs";
import { DataAwsCallerIdentity } from "@cdktn/provider-aws/lib/data-aws-caller-identity";
import { IamRole } from "@cdktn/provider-aws/lib/iam-role";
import { IamRolePolicy } from "@cdktn/provider-aws/lib/iam-role-policy";
import { IamRolePolicyAttachment } from "@cdktn/provider-aws/lib/iam-role-policy-attachment";
import { IamInstanceProfile } from "@cdktn/provider-aws/lib/iam-instance-profile";

export interface SlotNodeIamProps {
  readonly clusterName: string;
  // Region for the IAM ARNs below (must match the AwsProvider region).
  readonly region: string;
  // Bundle bucket the boot shim downloads the boot program from.
  readonly bootstrapBucketArn: string;
  readonly tags: Record<string, string>;
}

// ONE shared instance role for all six slot ASGs (demo posture). Attach scope
// is a dedicated authorization tag (EbsSelfAttach=<cluster>) present on both
// the six volumes and the six instances, NOT the display Name tag — so the
// policy stays static as slots are added, and repurposing an org-wide tag can
// never silently widen attach scope.
//
// Deliberately NO ec2:DetachVolume: the failover flow relies on
// termination auto-detach, and under a shared role DetachVolume would let a
// buggy/compromised node detach a HEALTHY sibling's in-use volume (in-AZ
// denial of service). Attach-only keeps the blast radius at "wrong-slot
// attach after a code bug", which single-attach gp3 + the boot program's
// unique-tag guard already make hard to reach. (Hardened variant for later:
// six per-slot roles conditioned on aws:ResourceTag/Slot = aws:PrincipalTag/Slot.)
export class SlotNodeIam extends Construct {
  public readonly instanceProfileArn: string;
  public readonly roleName: string;

  constructor(scope: Construct, id: string, props: SlotNodeIamProps) {
    super(scope, id);

    // Account id, purely so the policy ARNs are real instead of "*".
    const current = new DataAwsCallerIdentity(this, "current", {});

    const role = new IamRole(this, "role", {
      name: `${props.clusterName}-slot-node`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      tags: props.tags,
    });

    // Managed policies: ECS agent registration/pull/logs + SSM Session Manager
    // (port-forward path to the NiFi UI). Still the documented best practice.
    new IamRolePolicyAttachment(this, "ecs_managed", {
      role: role.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
    });
    new IamRolePolicyAttachment(this, "ssm_managed", {
      role: role.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    });

    new IamRolePolicy(this, "ebs_and_bundle", {
      role: role.id,
      name: "ebs-self-attach-and-boot-bundle",
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            // EC2 Describe* actions support no resource-level permissions —
            // Resource "*" with no conditions is the only valid shape.
            Sid: "DescribeHasNoResourceLevelSupport",
            Effect: "Allow",
            Action: "ec2:DescribeVolumes",
            Resource: "*",
          },
          {
            // AttachVolume evaluates BOTH the volume and the instance resource,
            // so the tag condition must be stated on each in its own statement.
            Sid: "AttachClusterVolumes",
            Effect: "Allow",
            Action: "ec2:AttachVolume",
            Resource: `arn:aws:ec2:${props.region}:${current.accountId}:volume/*`,
            Condition: {
              StringEquals: { "aws:ResourceTag/EbsSelfAttach": props.clusterName },
            },
          },
          {
            Sid: "AttachOnlyToClusterInstances",
            Effect: "Allow",
            Action: "ec2:AttachVolume",
            Resource: `arn:aws:ec2:${props.region}:${current.accountId}:instance/*`,
            Condition: {
              StringEquals: { "aws:ResourceTag/EbsSelfAttach": props.clusterName },
            },
          },
          {
            // Boot-bundle download. aws:ResourceAccount pins the bucket to this
            // account so a hijacked/recreated same-name bucket elsewhere can
            // never serve boot code.
            Sid: "ReadBootBundle",
            Effect: "Allow",
            Action: "s3:GetObject",
            Resource: `${props.bootstrapBucketArn}/*`,
            Condition: {
              StringEquals: { "aws:ResourceAccount": current.accountId },
            },
          },
        ],
      }),
    });

    const profile = new IamInstanceProfile(this, "profile", {
      name: `${props.clusterName}-slot-node`,
      role: role.name,
      tags: props.tags,
    });

    this.instanceProfileArn = profile.arn;
    this.roleName = role.name;
  }
}
