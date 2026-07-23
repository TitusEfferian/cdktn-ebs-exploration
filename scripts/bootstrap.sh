#!/bin/bash
#
# EC2 user-data bootstrap — installs Node.js, fetches the bundled boot program
# from S3, and runs it. All real logic (ECS config, IMDS, discover/attach/mount
# the tagged EBS volume) lives in scripts/ebs-bootstrap/index.ts, bundled to a
# single CJS file and delivered via S3 (too large for the 16 KB user-data limit).
# Target: Amazon Linux 2023, ECS-optimized AMI (AWS CLI v2 preinstalled). Runs as
# root, once per instance (plain user-data; a fresh boot on each ASG replacement).
#
set -euo pipefail

trap 'echo "ERROR: bootstrap failed at line ${LINENO} (exit $?)" >&2' ERR

# Log to file + syslog + console, matching the original user-data logging.
exec > >(tee -a /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

echo "=== bootstrap start: $(date -u +%FT%TZ) ==="

dnf install -y nodejs22
# The versioned package's binary name is undocumented; handle both spellings.
NODE_BIN="$(command -v node || command -v node-22)"

aws s3 cp "s3://<BUNDLE_BUCKET>/<BUNDLE_KEY>" /opt/ebs-bootstrap.cjs --region "<REGION>"

export VOLUME_TAG="<VOLUME_TAG>" CLUSTER_NAME="<CLUSTER_NAME>"
"${NODE_BIN}" /opt/ebs-bootstrap.cjs

echo "=== bootstrap complete: $(date -u +%FT%TZ) ==="
sync
sleep 1
