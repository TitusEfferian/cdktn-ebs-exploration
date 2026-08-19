import { Construct } from "constructs";
import { TerraformStack, TerraformOutput } from "cdktn";
import { AwsProvider } from "@cdktn/provider-aws/lib/provider";
import { NifiSecrets } from "../constructs";
import { region, clusterName, commonTags } from "./shared-config";

/**
 * Owns the seven NiFi Secrets Manager secrets, split out of the main stack so
 * the populated values SURVIVE cluster teardown (`cdktn destroy ebs_test`
 * never touches them). Deploy this stack FIRST: the main stack resolves the
 * secrets by name at plan time and fails until they exist — the intended
 * ordering guard; there is deliberately no cross-stack dependency.
 */
export class SecretsStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "aws", {
      region,
    });

    // Placeholder-seeded shells — Terraform never manages the real values:
    // populate via aws secretsmanager put-secret-value (see
    // README-nifi-cluster.md); Terraform ignores value changes forever.
    const nifiSecrets = new NifiSecrets(this, "nifi-secrets", {
      clusterName,
      tags: commonTags,
    });

    // Secret NAMES (put-secret-value --secret-id takes the name; ARNs work too).
    new TerraformOutput(this, "nifi_sensitive_key_secret", {
      value: nifiSecrets.sensitivePropsKeyName,
    });
    new TerraformOutput(this, "nifi_tls_keystore_password_secret", {
      value: nifiSecrets.tlsKeystorePasswordName,
    });
    new TerraformOutput(this, "nifi_tls_truststore_password_secret", {
      value: nifiSecrets.tlsTruststorePasswordName,
    });
    new TerraformOutput(this, "nifi_tls_keystore_secrets", {
      value: nifiSecrets.tlsKeystoreB64Names,
    });
    new TerraformOutput(this, "nifi_tls_truststore_secret", {
      value: nifiSecrets.tlsTruststoreB64Name,
    });
  }
}
