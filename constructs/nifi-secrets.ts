import { Construct } from "constructs";
import { SecretsManager } from "../.gen/modules/secrets_manager";
import { slotsOfRole, type NifiSlotName } from "./slots";

export interface NifiSecretsProps {
  readonly clusterName: string;
  readonly tags: Record<string, string>;
}

export class NifiSecrets extends Construct {
  public readonly sensitivePropsKeyArn: string;
  public readonly sensitivePropsKeyName: string;
  public readonly tlsKeystorePasswordArn: string;
  public readonly tlsKeystorePasswordName: string;
  public readonly tlsTruststorePasswordArn: string;
  public readonly tlsTruststorePasswordName: string;
  public readonly tlsKeystoreB64Arns: Record<NifiSlotName, string>;
  public readonly tlsKeystoreB64Names: Record<NifiSlotName, string>;
  public readonly tlsTruststoreB64Arn: string;
  public readonly tlsTruststoreB64Name: string;

  constructor(scope: Construct, id: string, props: NifiSecretsProps) {
    super(scope, id);

    const placeholder = "PLACEHOLDER-set-via-aws-cli";

    const sensitivePropsKey = new SecretsManager(this, "sensitive_props_key", {
      name: `${props.clusterName}/nifi/sensitive-props-key`,
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
      name: `${props.clusterName}/nifi/tls/keystore-password`,
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
      name: `${props.clusterName}/nifi/tls/truststore-password`,
      description:
        "NiFi TLS: shared truststore password. Real value set out-of-band " +
        "via put-secret-value; Terraform ignores value changes.",
      recoveryWindowInDays: 0,
      ignoreSecretChanges: true,
      secretString: placeholder,
      tags: props.tags,
    });

    const keystoreArns: Partial<Record<NifiSlotName, string>> = {};
    const keystoreNames: Partial<Record<NifiSlotName, string>> = {};
    for (const s of slotsOfRole("nifi")) {
      const keystore = new SecretsManager(this, `tls_keystore_${s.name}`, {
        name: `${props.clusterName}/nifi/tls/keystore-${s.name}`,
        description:
          `base64 of ${s.name}'s keystore.p12 (scripts/tls output). Real ` +
          "value set out-of-band via put-secret-value; Terraform ignores " +
          "value changes.",
        recoveryWindowInDays: 0,
        ignoreSecretChanges: true,
        secretString: placeholder,
        tags: props.tags,
      });
      keystoreArns[s.name] = keystore.secretArnOutput;
      keystoreNames[s.name] = keystore.secretNameOutput;
    }

    const tlsTruststoreB64 = new SecretsManager(this, "tls_truststore", {
      name: `${props.clusterName}/nifi/tls/truststore`,
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
    this.tlsKeystoreB64Arns = keystoreArns as Record<NifiSlotName, string>;
    this.tlsKeystoreB64Names = keystoreNames as Record<NifiSlotName, string>;
    this.tlsTruststoreB64Arn = tlsTruststoreB64.secretArnOutput;
    this.tlsTruststoreB64Name = tlsTruststoreB64.secretNameOutput;
  }
}
