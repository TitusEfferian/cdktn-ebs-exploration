#!/bin/bash
#
# EC2 user-data bootstrap — installs Node.js, fetches the bundled boot program
# from S3, and runs it. All real logic (IMDS, discover/attach/mount the tagged
# EBS volume, role directories, ECS agent config) lives in
# scripts/ebs-bootstrap/index.ts, bundled to a single CJS file and delivered via
# S3 (too large for the 16 KB user-data limit).
# Target: Amazon Linux 2023, ECS-optimized AMI (AWS CLI v2 preinstalled). Runs as
# root, once per instance (plain user-data; a fresh boot on each ASG replacement).
#
set -euo pipefail

trap 'echo "ERROR: bootstrap failed at line ${LINENO} (exit $?)" >&2' ERR

# Log to file + syslog + console, matching the original user-data logging.
exec > >(tee -a /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

echo "=== bootstrap start: $(date -u +%FT%TZ) ==="

# retry MAX_ATTEMPTS BASE_DELAY CMD [ARGS...] — exponential backoff for the two
# network-dependent steps below (dnf repo + S3 can flake in early boot). A
# failing command inside the `if` test never trips set -e.
retry() {
  local attempts=$1 delay=$2 i
  shift 2
  for ((i = 1; i <= attempts; i++)); do
    if "$@"; then return 0; fi
    if ((i < attempts)); then
      echo "retry: attempt ${i}/${attempts} of '$*' failed; sleeping ${delay}s" >&2
      sleep "${delay}"
      delay=$((delay * 2))
    fi
  done
  echo "retry: all ${attempts} attempts of '$*' failed" >&2
  return 1
}

retry 5 2 dnf install -y nodejs22
# The versioned package's binary name is undocumented; handle both spellings.
NODE_BIN="$(command -v node || command -v node-22)"

retry 5 2 aws s3 cp "s3://<BUNDLE_BUCKET>/<BUNDLE_KEY>" /opt/ebs-bootstrap.cjs --region "<REGION>"

export VOLUME_TAG="<VOLUME_TAG>" CLUSTER_NAME="<CLUSTER_NAME>" SLOT_NAME="<SLOT_NAME>" NODE_ROLE="<NODE_ROLE>"
"${NODE_BIN}" /opt/ebs-bootstrap.cjs

echo "=== bootstrap complete: $(date -u +%FT%TZ) ==="
sync
sleep 1
