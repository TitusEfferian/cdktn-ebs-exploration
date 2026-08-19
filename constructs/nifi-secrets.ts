import { Construct } from "constructs";
import { DataAwsSecretsmanagerSecret } from "@cdktn/provider-aws/lib/data-aws-secretsmanager-secret";
import { SecretsManager } from "../.gen/modules/secrets_manager";
import { perRoleSlot, type NifiSlotName } from "./slots";

/**
 * The deterministic Secrets Manager secret names, derived from the cluster
 * name. Single source of truth for BOTH sides of the stack split: the
 * producer (NifiSecrets, in the secrets stack) creates secrets under these
 * names and the consumer (NifiSecretsLookup, in the main stack) looks the
 * same names up — no cross-stack references needed.
 */
export interface NifiSecretNames {
  readonly sensitivePropsKey: string;
  readonly tlsKeystorePassword: string;
  readonly tlsTruststorePassword: string;
  readonly tlsKeystoreB64: Readonly<Record<NifiSlotName, string>>;
  readonly tlsTruststoreB64: string;
}

export function nifiSecretNames(clusterName: string): NifiSecretNames {
  return {
    sensitivePropsKey: `${clusterName}/nifi/sensitive-props-key`,
    tlsKeystorePassword: `${clusterName}/nifi/tls/keystore-password`,
    tlsTruststorePassword: `${clusterName}/nifi/tls/truststore-password`,
    tlsKeystoreB64: perRoleSlot("nifi", (s) => `${clusterName}/nifi/tls/keystore-${s.name}`),
    tlsTruststoreB64: `${clusterName}/nifi/tls/truststore`,
  };
}

/** Plain string bundle passed across stacks; deliberately no construct types. */
export interface NifiSecretRefs {
  readonly sensitivePropsKeyArn: string;
  readonly sensitivePropsKeyName: string;
  readonly tlsKeystorePasswordArn: string;
  readonly tlsKeystorePasswordName: string;
  readonly tlsTruststorePasswordArn: string;
  readonly tlsTruststorePasswordName: string;
  readonly tlsKeystoreB64Arns: Readonly<Record<NifiSlotName, string>>;
  readonly tlsKeystoreB64Names: Readonly<Record<NifiSlotName, string>>;
  readonly tlsTruststoreB64Arn: string;
  readonly tlsTruststoreB64Name: string;
}

export interface NifiSecretsProps {
  readonly clusterName: string;
  readonly tags: Record<string, string>;
}

export class NifiSecrets extends Construct implements NifiSecretRefs {
  public readonly sensitivePropsKeyArn: string;
  public readonly sensitivePropsKeyName: string;
  public readonly tlsKeystorePasswordArn: string;
  public readonly tlsKeystorePasswordName: string;
  public readonly tlsTruststorePasswordArn: string;
  public readonly tlsTruststorePasswordName: string;
  public readonly tlsKeystoreB64Arns: Readonly<Record<NifiSlotName, string>>;
  public readonly tlsKeystoreB64Names: Readonly<Record<NifiSlotName, string>>;
  public readonly tlsTruststoreB64Arn: string;
  public readonly tlsTruststoreB64Name: string;

  constructor(scope: Construct, id: string, props: NifiSecretsProps) {
    super(scope, id);

    const placeholder = "PLACEHOLDER-set-via-aws-cli";
    const names = nifiSecretNames(props.clusterName);

    const sensitivePropsKey = new SecretsManager(this, "sensitive_props_key", {
      name: names.sensitivePropsKey,
      description:
        "NiFi nifi.sensitive.props.key (>=12 chars, identical on all nodes). " +
        "Real value set out-of-band via aws secretsmanager put-secret-value; " +
        "Terraform ignores value changes.",
      recoveryWindowInDays: 0,
      ignoreSecretChanges: true,
      secretString: placeholder,
      tags: props.tags,
    });

    const tlsKeystorePassword = new SecretsManager(this, "tls_keystore_password", {
      name: names.tlsKeystorePassword,
      description:
        "NiFi TLS: node keystore password (shared by the 3 node keystores; " +
        "colon-free). Real value set out-of-band via put-secret-value; " +
        "Terraform ignores value changes.",
      recoveryWindowInDays: 0,
      ignoreSecretChanges: true,
      secretString: placeholder,
      tags: props.tags,
    });

    const tlsTruststorePassword = new SecretsManager(this, "tls_truststore_password", {
      name: names.tlsTruststorePassword,
      description:
        "NiFi TLS: shared truststore password. Real value set out-of-band " +
        "via put-secret-value; Terraform ignores value changes.",
      recoveryWindowInDays: 0,
      ignoreSecretChanges: true,
      secretString: placeholder,
      tags: props.tags,
    });

    const keystores = perRoleSlot(
      "nifi",
      (s) =>
        new SecretsManager(this, `tls_keystore_${s.name}`, {
          name: names.tlsKeystoreB64[s.name],
          description:
            `base64 of ${s.name}'s keystore.p12 (scripts/tls output). Real ` +
            "value set out-of-band via put-secret-value; Terraform ignores " +
            "value changes.",
          recoveryWindowInDays: 0,
          ignoreSecretChanges: true,
          secretString: placeholder,
          tags: props.tags,
        }),
    );

    const tlsTruststoreB64 = new SecretsManager(this, "tls_truststore", {
      name: names.tlsTruststoreB64,
      description:
        "base64 of the shared truststore.p12 (CA cert only; scripts/tls " +
        "output). Real value set out-of-band via put-secret-value; Terraform " +
        "ignores value changes.",
      recoveryWindowInDays: 0,
      ignoreSecretChanges: true,
      secretString: placeholder,
      tags: props.tags,
    });

    this.sensitivePropsKeyArn = sensitivePropsKey.secretArnOutput;
    this.sensitivePropsKeyName = sensitivePropsKey.secretNameOutput;
    this.tlsKeystorePasswordArn = tlsKeystorePassword.secretArnOutput;
    this.tlsKeystorePasswordName = tlsKeystorePassword.secretNameOutput;
    this.tlsTruststorePasswordArn = tlsTruststorePassword.secretArnOutput;
    this.tlsTruststorePasswordName = tlsTruststorePassword.secretNameOutput;
    this.tlsKeystoreB64Arns = perRoleSlot("nifi", (s) => keystores[s.name].secretArnOutput);
    this.tlsKeystoreB64Names = perRoleSlot("nifi", (s) => keystores[s.name].secretNameOutput);
    this.tlsTruststoreB64Arn = tlsTruststoreB64.secretArnOutput;
    this.tlsTruststoreB64Name = tlsTruststoreB64.secretNameOutput;
  }
}

export interface NifiSecretsLookupProps {
  readonly clusterName: string;
}

/**
 * Consumer-side counterpart of NifiSecrets: resolves the seven secrets BY
 * NAME via aws_secretsmanager_secret data sources (metadata only — never
 * DataAwsSecretsmanagerSecretVersion, which would pull secret VALUES into
 * state). The lookups fail at plan time until the secrets stack is deployed,
 * which is the intended ordering guard between the otherwise-independent
 * stacks.
 */
export class NifiSecretsLookup extends Construct implements NifiSecretRefs {
  public readonly sensitivePropsKeyArn: string;
  public readonly sensitivePropsKeyName: string;
  public readonly tlsKeystorePasswordArn: string;
  public readonly tlsKeystorePasswordName: string;
  public readonly tlsTruststorePasswordArn: string;
  public readonly tlsTruststorePasswordName: string;
  public readonly tlsKeystoreB64Arns: Readonly<Record<NifiSlotName, string>>;
  public readonly tlsKeystoreB64Names: Readonly<Record<NifiSlotName, string>>;
  public readonly tlsTruststoreB64Arn: string;
  public readonly tlsTruststoreB64Name: string;

  constructor(scope: Construct, id: string, props: NifiSecretsLookupProps) {
    super(scope, id);

    const names = nifiSecretNames(props.clusterName);

    const sensitivePropsKey = new DataAwsSecretsmanagerSecret(this, "sensitive_props_key", {
      name: names.sensitivePropsKey,
    });

    const tlsKeystorePassword = new DataAwsSecretsmanagerSecret(this, "tls_keystore_password", {
      name: names.tlsKeystorePassword,
    });

    const tlsTruststorePassword = new DataAwsSecretsmanagerSecret(this, "tls_truststore_password", {
      name: names.tlsTruststorePassword,
    });

    const keystores = perRoleSlot(
      "nifi",
      (s) =>
        new DataAwsSecretsmanagerSecret(this, `tls_keystore_${s.name}`, {
          name: names.tlsKeystoreB64[s.name],
        }),
    );

    const tlsTruststoreB64 = new DataAwsSecretsmanagerSecret(this, "tls_truststore", {
      name: names.tlsTruststoreB64,
    });

    this.sensitivePropsKeyArn = sensitivePropsKey.arn;
    this.sensitivePropsKeyName = names.sensitivePropsKey;
    this.tlsKeystorePasswordArn = tlsKeystorePassword.arn;
    this.tlsKeystorePasswordName = names.tlsKeystorePassword;
    this.tlsTruststorePasswordArn = tlsTruststorePassword.arn;
    this.tlsTruststorePasswordName = names.tlsTruststorePassword;
    this.tlsKeystoreB64Arns = perRoleSlot("nifi", (s) => keystores[s.name].arn);
    this.tlsKeystoreB64Names = names.tlsKeystoreB64;
    this.tlsTruststoreB64Arn = tlsTruststoreB64.arn;
    this.tlsTruststoreB64Name = names.tlsTruststoreB64;
  }
}
