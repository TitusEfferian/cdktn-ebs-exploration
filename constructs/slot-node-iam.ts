import { Construct } from "constructs";
import { DataAwsCallerIdentity } from "@cdktn/provider-aws/lib/data-aws-caller-identity";
import { IamRole } from "@cdktn/provider-aws/lib/iam-role";
import { IamRolePolicy } from "@cdktn/provider-aws/lib/iam-role-policy";
import { IamRolePolicyAttachment } from "@cdktn/provider-aws/lib/iam-role-policy-attachment";
import { IamInstanceProfile } from "@cdktn/provider-aws/lib/iam-instance-profile";

export interface SlotNodeIamProps {
  readonly clusterName: string;
  readonly region: string;
  readonly bootstrapBucketArn: string;
  readonly tags: Record<string, string>;
}

export class SlotNodeIam extends Construct {
  public readonly instanceProfileArn: string;
  public readonly roleName: string;

  constructor(scope: Construct, id: string, props: SlotNodeIamProps) {
    super(scope, id);

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
            Sid: "DescribeHasNoResourceLevelSupport",
            Effect: "Allow",
            Action: "ec2:DescribeVolumes",
            Resource: "*",
          },
          {
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
