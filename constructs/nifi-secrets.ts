import { Construct } from "constructs";
import { SecretsManager } from "../.gen/modules/secrets_manager";
import { slotsOfRole, type NifiSlotName } from "./slots";

export interface NifiSecretsProps {
  readonly clusterName: string;
  readonly tags: Record<string, string>;
}

// All NiFi sensitive values live in Secrets Manager; Terraform only creates the
// secret "shells" with placeholders and the REAL values are set out-of-band via
// `aws secretsmanager put-secret-value` (see README-nifi-cluster.md).
//
// Separate plain-string secrets rather than one JSON secret on purpose:
// put-secret-value replaces a secret's ENTIRE value, so per-value secrets let
// the operator set/rotate each independently with a bare --secret-string (no
// JSON assembly, no forgotten-key data loss), and the taskdef valueFrom stays
// a plain ARN (no :json-key:: selector).
//
// The four tls/keystore-*/truststore secrets hold BASE64 TEXT of PKCS12
// binaries (~7 KiB each vs the 64 KiB Secrets Manager value limit) — ECS can
// inject secrets only as env vars, so the container wrapper decodes them to
// files at start. Their placeholder is deliberately INVALID base64 starting
// with "PLACEHOLDER": the wrapper's guard exits 1 until the operator uploads
// the real material, so a node can never come up with a bogus keystore.
//
// ignore_secret_changes=true: the module swaps in a twin secret-version
// resource whose lifecycle ignores secret_string/version_stages, so a manual
// put-secret-value wins forever — later applies neither revert the value nor
// show drift. NEVER flip this flag after deploy: it changes the Terraform
// resource address, and the replacement version resource would re-publish the
// placeholder as AWSCURRENT (demoting the real value).
//
// A placeholder version is REQUIRED, not cosmetic: a secret with zero versions
// has no AWSCURRENT and GetSecretValue returns ResourceNotFoundException, which
// fails task launch for every container that binds the secret.
//
// recovery_window_in_days=0: demo posture — destroy deletes the secret
// immediately (ForceDeleteWithoutRecovery) so the name is instantly reusable.
// Any window >0 leaves the secret "scheduled for deletion" and a re-deploy
// with the same name fails until the window elapses. Use 7-30 days for real.
export class NifiSecrets extends Construct {
  public readonly sensitivePropsKeyArn: string;
  public readonly sensitivePropsKeyName: string;
  public readonly tlsKeystorePasswordArn: string;
  public readonly tlsKeystorePasswordName: string;
  public readonly tlsTruststorePasswordArn: string;
  public readonly tlsTruststorePasswordName: string;
  // Per-NiFi-node keystore.p12 (base64) + the shared truststore.p12 (base64).
  public readonly tlsKeystoreB64Arns: Record<NifiSlotName, string>;
  public readonly tlsKeystoreB64Names: Record<NifiSlotName, string>;
  public readonly tlsTruststoreB64Arn: string;
  public readonly tlsTruststoreB64Name: string;

  constructor(scope: Construct, id: string, props: NifiSecretsProps) {
    super(scope, id);

    // Defaults deliberately kept: create_policy=false (the ECS service module
    // grants secretsmanager:GetSecretValue on the exact ARN via its execution
    // role — no resource policy needed), kms_key_id unset (default
    // aws/secretsmanager key, so the execution role needs NO kms:Decrypt),
    // no rotation, no random password (values are operator-supplied).
    //
    // The placeholder is >=12 chars so a NiFi node started BEFORE the operator
    // populates the secret still boots (nifi.sensitive.props.key enforces a
    // 12-char minimum) — it just runs with the wrong key until
    // put-secret-value + force-new-deployment.
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

    // Consumed from FIRST BOOT (AUTH=tls in the task definition):
    // KEYSTORE_PASSWORD / TRUSTSTORE_PASSWORD for secure.sh, the *_B64
    // secrets below for the wrapper's file decode.
    // KEY_PASSWORD is deliberately absent (PKCS12 key password == store
    // password; NiFi falls back to the keystore password when unset). The CA
    // and admin-cert passwords intentionally stay OFF AWS — the CA keystore
    // never leaves the build machine (scripts/tls/README.md).
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

    // One keystore secret per NiFi node: the material differs per node (each
    // cert carries its own FQDN), and the taskdef binds only its own slot's
    // ARN. Loop-accumulate then cast — sound because slotsOfRole("nifi")
    // covers every NifiSlotName by construction (same idiom as perSlot).
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
