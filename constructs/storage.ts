import { Construct } from "constructs";
import { TerraformAsset, AssetType, ITerraformDependable } from "cdktn";
import { EbsVolume } from "@cdktn/provider-aws/lib/ebs-volume";
import { S3Bucket } from "@cdktn/provider-aws/lib/s3-bucket";
import { S3BucketPublicAccessBlock } from "@cdktn/provider-aws/lib/s3-bucket-public-access-block";
import { S3Object } from "@cdktn/provider-aws/lib/s3-object";
import { DataAwsCallerIdentity } from "@cdktn/provider-aws/lib/data-aws-caller-identity";
import { DataAwsIamPolicyDocument } from "@cdktn/provider-aws/lib/data-aws-iam-policy-document";
import { IamPolicy as IamPolicyModule } from "../.gen/modules/iam_policy";

export interface StorageProps {
  // Volume AZ — must match the ASG's subnet AZ (typically azs[0]).
  readonly availabilityZone: string;
  readonly clusterName: string;
  readonly volumeName: string;
  // Path to the esbuild bundle of the boot program (produced in main.ts).
  readonly bootstrapBundlePath: string;
  readonly tags: Record<string, string>;
}

// Persistent EBS volume, the S3-delivered boot bundle, and the IAM policy that
// lets the instance self-attach the volume and read that bundle.
export class Storage extends Construct {
  public readonly volumeId: string;
  public readonly ebsPolicyArn: string;
  // Boot-bundle delivery, consumed by Compute to build the instance user-data.
  public readonly bootstrapBucketName: string;
  public readonly bootstrapObjectKey: string;
  public readonly bootstrapObject: ITerraformDependable;

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

    // Private bucket that delivers the bundled boot program to the instance. The
    // bundle is far larger than the 16 KB user-data limit, so user-data fetches
    // it from here at boot. SSE-S3 encryption is applied automatically (no extra
    // resource needed).
    const bootstrapBucket = new S3Bucket(this, "bootstrap_bucket", {
      bucketPrefix: `${props.clusterName}-boot-`,
      forceDestroy: true, // demo: let `cdktn destroy` empty and remove the bucket
      tags: props.tags,
    });
    // Terraform leaves all four public-access-block flags off by default; turn
    // them all on so the boot bundle can never become publicly reachable.
    new S3BucketPublicAccessBlock(this, "bootstrap_bucket_pab", {
      bucket: bootstrapBucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    // The esbuild bundle produced at synth (see main.ts). Putting the content hash
    // in the object key means a changed bundle changes the key -> changes the
    // user-data -> new launch-template version, so ASG replacements run new code.
    const bootstrapAsset = new TerraformAsset(this, "bootstrap_bundle", {
      path: props.bootstrapBundlePath,
      type: AssetType.FILE,
    });
    const bootstrapKey = `${bootstrapAsset.assetHash}/${bootstrapAsset.fileName}`;
    const bootstrapObject = new S3Object(this, "bootstrap_object", {
      bucket: bootstrapBucket.id,
      key: bootstrapKey,
      source: bootstrapAsset.path,
      sourceHash: bootstrapAsset.assetHash, // re-upload trigger (KMS-safe, unlike etag)
    });

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
        {
          // Let the instance download the boot bundle. Object-scoped; s3:ListBucket
          // is not required for a GetObject by known key.
          sid: "ReadBootBundle",
          effect: "Allow",
          actions: ["s3:GetObject"],
          resources: [`${bootstrapBucket.arn}/*`],
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
    this.bootstrapBucketName = bootstrapBucket.bucket;
    this.bootstrapObjectKey = bootstrapKey;
    this.bootstrapObject = bootstrapObject;
  }
}
