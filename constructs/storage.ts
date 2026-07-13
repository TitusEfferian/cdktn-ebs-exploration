import { Construct } from "constructs";
import { EbsVolume } from "@cdktn/provider-aws/lib/ebs-volume";
import { DataAwsCallerIdentity } from "@cdktn/provider-aws/lib/data-aws-caller-identity";
import { DataAwsIamPolicyDocument } from "@cdktn/provider-aws/lib/data-aws-iam-policy-document";
import { IamPolicy as IamPolicyModule } from "../.gen/modules/iam_policy";

export interface StorageProps {
  // Volume AZ — must match the ASG's subnet AZ (typically azs[0]).
  readonly availabilityZone: string;
  readonly clusterName: string;
  readonly volumeName: string;
  readonly tags: Record<string, string>;
}

// Persistent EBS volume plus the IAM policy that lets the instance self-attach it.
export class Storage extends Construct {
  public readonly volumeId: string;
  public readonly ebsPolicyArn: string;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    // Standalone EBS volume — NOT attached via Terraform (no aws_volume_attachment,
    // which would fight the ASG). The instance's user-data finds it by tag+AZ and
    // attaches it. Lives in azs[0] to match the ASG's subnet AZ.
    const ebsVolume = new EbsVolume(this, "ebs_persist", {
      availabilityZone: props.availabilityZone,
      size: 5,
      type: "gp3",
      encrypted: true,
      tags: { Name: props.volumeName, ...props.tags },
    });

    // Account id, purely so Attach/Detach below can be scoped to real ARNs instead
    // of "*" (no permission change from adding this — it's a read-only lookup).
    const current = new DataAwsCallerIdentity(this, "current", {});
    const region = "ap-northeast-1"; // matches the AwsProvider region in main.ts

    const ebsPolicyDocument = new DataAwsIamPolicyDocument(this, "ebs_attach_policy_doc", {
      version: "2012-10-17",
      statement: [
        {
          sid: "Describe",
          effect: "Allow",
          actions: ["ec2:DescribeVolumes", "ec2:DescribeInstances"],
          resources: ["*"],
        },
        {
          sid: "AttachDetachVolume",
          effect: "Allow",
          actions: ["ec2:AttachVolume", "ec2:DetachVolume"],
          resources: [`arn:aws:ec2:${region}:${current.accountId}:volume/*`],
          condition: [
            {
              test: "StringEquals",
              variable: "aws:ResourceTag/Name",
              values: [props.volumeName],
            },
          ],
        },
        {
          sid: "AttachDetachInstance",
          effect: "Allow",
          actions: ["ec2:AttachVolume", "ec2:DetachVolume"],
          resources: [`arn:aws:ec2:${region}:${current.accountId}:instance/*`],
        },
      ],
    });

    const ebsPolicy = new IamPolicyModule(this, "ebs_attach_policy", {
      name: `${props.clusterName}-ebs-self-attach`,
      policy: ebsPolicyDocument.json,
      tags: props.tags,
    });

    this.volumeId = ebsVolume.id;
    this.ebsPolicyArn = ebsPolicy.arnOutput;
  }
}
