import { Construct } from "constructs";
import { EbsVolume } from "@cdktn/provider-aws/lib/ebs-volume";
import { IamPolicy } from "@cdktn/provider-aws/lib/iam-policy";

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

    // Policy letting the instance self-attach the volume (fed to the ASG role).
    // Describe* cannot be resource-scoped; Attach/Detach on "*" is fine for a demo.
    const ebsPolicy = new IamPolicy(this, "ebs_attach_policy", {
      name: `${props.clusterName}-ebs-self-attach`,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "Describe",
            Effect: "Allow",
            Action: ["ec2:DescribeVolumes", "ec2:DescribeInstances"],
            Resource: "*",
          },
          {
            Sid: "AttachDetach",
            Effect: "Allow",
            Action: ["ec2:AttachVolume", "ec2:DetachVolume"],
            Resource: "*",
          },
        ],
      }),
      tags: props.tags,
    });

    this.volumeId = ebsVolume.id;
    this.ebsPolicyArn = ebsPolicy.arn;
  }
}
