import * as path from "path";
import { buildSync } from "esbuild";
import { App } from "cdktn";
import { MyStack } from "./stacks/my-stack";

// Bundle the on-instance boot program (scripts/ebs-bootstrap) into a single CJS
// file BEFORE synth, so the TerraformAsset in Storage can read it. cdktn re-runs
// this app on every synth/deploy/diff, so the bundle is always regenerated in
// lockstep; it is then delivered to the instance via S3 (too large for the 16 KB
// user-data limit).
const bootstrapBundlePath = path.join(
  __dirname,
  "scripts",
  "ebs-bootstrap",
  "dist",
  "ebs-bootstrap.cjs",
);
buildSync({
  entryPoints: [path.join(__dirname, "scripts", "ebs-bootstrap", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs", // lowest-risk for a boot-critical script (no ESM require shims)
  minify: true,
  outfile: bootstrapBundlePath,
});

const app = new App();
new MyStack(app, "ebs_test", { bootstrapBundlePath });
app.synth();
