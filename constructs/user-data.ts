import * as fs from "fs";
import * as path from "path";
import { Fn } from "cdktn";

export interface UserDataProps {
  readonly bootstrapBucketName: string;
  readonly bootstrapObjectKey: string;
  readonly region: string;
  readonly volumeTag: string;
  readonly clusterName: string;
  readonly slotName: string;
  readonly nodeRole: string;
}

export function buildUserDataB64(props: UserDataProps): string {
  const scriptTemplate = fs
    .readFileSync(path.join(__dirname, "..", "scripts", "bootstrap.sh"), "utf8")
    .replace(/<BUNDLE_KEY>/g, props.bootstrapObjectKey)
    .replace(/<REGION>/g, props.region)
    .replace(/<VOLUME_TAG>/g, props.volumeTag)
    .replace(/<CLUSTER_NAME>/g, props.clusterName)
    .replace(/<SLOT_NAME>/g, props.slotName)
    .replace(/<NODE_ROLE>/g, props.nodeRole);
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
