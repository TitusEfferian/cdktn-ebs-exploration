import { Construct } from "constructs";
import { App, TerraformStack, TerraformOutput } from "cdktn";

import { SqsQueue } from "@cdktn/provider-aws/lib/sqs-queue";
import { AwsProvider } from "@cdktn/provider-aws/lib/provider";

class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "aws", {
      region: "ap-northeast-1",
    });

    const queue = new SqsQueue(this, "hello-queue", {
      name: "hello-world-queue",
      delaySeconds: 0,
      messageRetentionSeconds: 345600,
      visibilityTimeoutSeconds: 30,
    });

    new TerraformOutput(this, "queue_url", { value: queue.url });
    new TerraformOutput(this, "queue_arn", { value: queue.arn });
  }
}

const app = new App();
new MyStack(app, "ebs_test");
app.synth();
