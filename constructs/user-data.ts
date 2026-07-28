import * as fs from "fs";
import * as path from "path";
import { Fn } from "cdktn";

export interface UserDataProps {
  // S3 location of the esbuild boot bundle. The bucket name is a Terraform
  // token; the key is a synth-time string (content hash + filename).
  readonly bootstrapBucketName: string;
  readonly bootstrapObjectKey: string;
  // Region for the user-data `aws s3 cp`.
  readonly region: string;
  // Per-slot boot-program config (exported as env vars by the shim).
  readonly volumeTag: string;
  readonly clusterName: string;
  readonly slotName: string;
  readonly nodeRole: string;
}

// Build the base64 user-data for one instance from scripts/bootstrap.sh.
//
// The generated bucket name is a Terraform token, so base64 must happen in
// Terraform — a Buffer at synth would encode the unresolved token. But the
// script also contains literal double quotes and bash ${...}, which
// Fn.base64encode rejects on a plain string. Fn.join + Fn.rawString keep the
// literal script exact (quotes and all) while splicing the bucket name in as
// a real reference; rawString escapes bash ${VAR} to $${VAR} so Terraform
// leaves it for the shell.
export function buildUserDataB64(props: UserDataProps): string {
  const scriptTemplate = fs
    .readFileSync(path.join(__dirname, "..", "scripts", "bootstrap.sh"), "utf8")
    .replace(/<BUNDLE_KEY>/g, props.bootstrapObjectKey)
    .replace(/<REGION>/g, props.region)
    .replace(/<VOLUME_TAG>/g, props.volumeTag)
    .replace(/<CLUSTER_NAME>/g, props.clusterName)
    .replace(/<SLOT_NAME>/g, props.slotName)
    .replace(/<NODE_ROLE>/g, props.nodeRole);
  // <BUNDLE_BUCKET> must appear exactly once; splice the bucket-name token
  // between the surrounding literal halves. (If bootstrap.sh ever gains a literal
  // Terraform `%{` directive — e.g. from `printf`/`curl -w` — pre-escape it to
  // `%%{`; cdktn's rawString escapes `${` but not `%{`.)
  const parts = scriptTemplate.split("<BUNDLE_BUCKET>");
  if (parts.length !== 2) {
    throw new Error(
      `expected exactly one <BUNDLE_BUCKET> marker in bootstrap.sh, found ${parts.length - 1}`,
    );
  }
  const [scriptHead, scriptTail] = parts;
  return Fn.base64encode(
    Fn.join("", [Fn.rawString(scriptHead), props.bootstrapBucketName, Fn.rawString(scriptTail)]),
  );
}
