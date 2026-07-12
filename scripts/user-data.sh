#!/bin/bash
#
# EC2 user-data — idempotently attach + mount a tagged EBS volume, then join ECS.
# Target: Amazon Linux 2023, ECS-optimized AMI (AWS CLI v2 preinstalled).
# Runs as root, on EVERY boot. Safe to re-run. It NEVER reformats a device that
# already carries a filesystem — that is what preserves data across instance
# replacement (ASG) in the EBS-persistence demo.
#
set -euo pipefail

# --- Fail-loud tracing -------------------------------------------------------
trap 'echo "ERROR: user-data failed at line ${LINENO} (exit $?)" >&2' ERR

# --- Logging: file + console -------------------------------------------------
exec > >(tee -a /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

echo "=== user-data start: $(date -u +%FT%TZ) ==="

# --- Terraform-substituted placeholders --------------------------------------
VOLUME_TAG="<VOLUME_TAG>"      # value of the Name tag on the target EBS volume
CLUSTER_NAME="<CLUSTER_NAME>"  # ECS cluster this instance should register with

# --- Register with the ECS cluster FIRST -------------------------------------
# Write this BEFORE the (potentially slow) EBS attach/mount below, so the ECS
# agent reads the right cluster at startup and never falls back to "default".
mkdir -p /etc/ecs
if grep -qs '^ECS_CLUSTER=' /etc/ecs/ecs.config; then
  sed -i "s|^ECS_CLUSTER=.*|ECS_CLUSTER=${CLUSTER_NAME}|" /etc/ecs/ecs.config
else
  echo "ECS_CLUSTER=${CLUSTER_NAME}" >> /etc/ecs/ecs.config
fi
echo "ECS_CLUSTER set to ${CLUSTER_NAME}"

# --- Constants / tunables ----------------------------------------------------
DEVICE_REQUEST="/dev/sdf"      # requested attach name; Nitro remaps to /dev/nvme?n1
MOUNT_POINT="/mnt/ebs"
FS_TYPE="ext4"
MAX_WAIT=300                   # max seconds to wait for any single state change
INTERVAL=5                     # seconds between polls

export AWS_RETRY_MODE="standard"
export AWS_MAX_ATTEMPTS="10"

wait_for() {
  local desc="$1" timeout="$2"; shift 2
  local elapsed=0
  until "$@"; do
    if (( elapsed >= timeout )); then
      echo "TIMEOUT after ${timeout}s waiting for: ${desc}" >&2
      return 1
    fi
    echo "  ...waiting for ${desc} (${elapsed}/${timeout}s)"
    sleep "${INTERVAL}"
    elapsed=$(( elapsed + INTERVAL ))
  done
  return 0
}

# --- IMDSv2 helpers ----------------------------------------------------------
TOKEN=""
get_imds_token() {
  TOKEN=$(curl -sfX PUT "http://169.254.169.254/latest/api/token" \
               -H "X-aws-ec2-metadata-token-ttl-seconds: 21600") || return 1
  [[ -n "${TOKEN}" ]]
}
imds() {
  curl -sf -H "X-aws-ec2-metadata-token: ${TOKEN}" \
       "http://169.254.169.254/latest/meta-data/$1"
}

wait_for "IMDSv2 token" 60 get_imds_token \
  || { echo "FATAL: could not obtain IMDSv2 token" >&2; exit 1; }

INSTANCE_ID=$(imds instance-id)
AZ=$(imds placement/availability-zone)
REGION="${AZ%[a-z]}"
export AWS_DEFAULT_REGION="${REGION}"
echo "instance=${INSTANCE_ID} az=${AZ} region=${REGION}"

# --- Predicate helpers used by wait_for --------------------------------------
VOLUME_ID=""
discover_volume() {
  VOLUME_ID=$(aws ec2 describe-volumes \
    --filters "Name=tag:Name,Values=${VOLUME_TAG}" \
              "Name=availability-zone,Values=${AZ}" \
    --query 'Volumes[0].VolumeId' --output text 2>/dev/null || echo "None")
  [[ -n "${VOLUME_ID}" && "${VOLUME_ID}" != "None" ]]
}
volume_attached_here() {
  local inst
  inst=$(aws ec2 describe-volumes --volume-ids "${VOLUME_ID}" \
           --query 'Volumes[0].Attachments[0].InstanceId' \
           --output text 2>/dev/null || echo "None")
  [[ "${inst}" == "${INSTANCE_ID}" ]]
}
volume_state_is() {
  local state
  state=$(aws ec2 describe-volumes --volume-ids "${VOLUME_ID}" \
            --query 'Volumes[0].State' --output text 2>/dev/null || echo "unknown")
  [[ "${state}" == "$1" ]]
}
attachment_attached() {
  local st
  st=$(aws ec2 describe-volumes --volume-ids "${VOLUME_ID}" \
         --query 'Volumes[0].Attachments[0].State' \
         --output text 2>/dev/null || echo "unknown")
  [[ "${st}" == "attached" ]]
}

# --- 1) Find the volume in THIS AZ by its Name tag ---------------------------
wait_for "EBS volume tagged Name=${VOLUME_TAG} in ${AZ}" "${MAX_WAIT}" discover_volume \
  || { echo "FATAL: no volume tagged Name=${VOLUME_TAG} in ${AZ}" >&2; exit 1; }

VOL_SERIAL="${VOLUME_ID//-/}"
echo "target volume=${VOLUME_ID} serial=${VOL_SERIAL}"

# --- 2) Attach to THIS instance if it isn't already --------------------------
if volume_attached_here; then
  echo "volume ${VOLUME_ID} already attached to ${INSTANCE_ID} — skipping attach"
else
  wait_for "volume ${VOLUME_ID} to become available" "${MAX_WAIT}" volume_state_is available \
    || { echo "FATAL: ${VOLUME_ID} never became available" >&2; exit 1; }

  echo "attaching ${VOLUME_ID} as ${DEVICE_REQUEST} to ${INSTANCE_ID}"
  aws ec2 attach-volume \
    --volume-id "${VOLUME_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --device "${DEVICE_REQUEST}" >/dev/null

  wait_for "attachment of ${VOLUME_ID} to reach 'attached'" "${MAX_WAIT}" attachment_attached \
    || { echo "FATAL: attachment did not complete" >&2; exit 1; }
  echo "attached."
fi

# --- 3) Resolve the real Nitro device node -----------------------------------
udevadm settle || true
DEVICE=""
resolve_device() {
  local link="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${VOL_SERIAL}"
  if [[ -e "${link}" ]]; then
    DEVICE=$(readlink -f "${link}")
    return 0
  fi
  local dev
  for dev in /dev/nvme*n1; do
    [[ -e "${dev}" ]] || continue
    if ebsnvme-id "${dev}" 2>/dev/null | grep -qF "${VOLUME_ID}"; then
      DEVICE="${dev}"; return 0
    fi
  done
  local name serial
  while read -r name serial; do
    if [[ "${serial}" == "${VOL_SERIAL}" ]]; then
      DEVICE="/dev/${name}"; return 0
    fi
  done < <(lsblk -dno NAME,SERIAL)
  return 1
}
wait_for "NVMe device for ${VOLUME_ID} to appear" "${MAX_WAIT}" resolve_device \
  || { echo "FATAL: could not resolve device for ${VOLUME_ID}" >&2; lsblk || true; exit 1; }
echo "resolved ${VOLUME_ID} -> ${DEVICE}"

# --- 4) Format ONLY if the device is empty (this is what preserves data) -----
device_has_filesystem() {
  if blkid -p "${DEVICE}" >/dev/null 2>&1; then
    return 0
  fi
  local probe
  if probe=$(file -sL "${DEVICE}" 2>/dev/null); then
    [[ "${probe}" != *": data" ]] && return 0
  fi
  return 1
}
if device_has_filesystem; then
  echo "existing filesystem on ${DEVICE} — preserving data (no mkfs)"
else
  echo "no filesystem on ${DEVICE} — creating ${FS_TYPE}"
  mkfs -t "${FS_TYPE}" "${DEVICE}"
fi

# --- 5) Mount + persist in fstab by UUID (nofail) ----------------------------
UUID=$(blkid -s UUID -o value "${DEVICE}")
[[ -n "${UUID}" ]] || { echo "FATAL: no UUID for ${DEVICE}" >&2; exit 1; }
mkdir -p "${MOUNT_POINT}"

FSTAB_LINE="UUID=${UUID} ${MOUNT_POINT} ${FS_TYPE} defaults,nofail 0 2"
if ! grep -qsF "UUID=${UUID} ${MOUNT_POINT} " /etc/fstab; then
  sed -i "\| ${MOUNT_POINT} |d" /etc/fstab
  echo "${FSTAB_LINE}" >> /etc/fstab
  echo "added fstab: ${FSTAB_LINE}"
fi

if ! mountpoint -q "${MOUNT_POINT}"; then
  mount "${MOUNT_POINT}"
  echo "mounted ${DEVICE} at ${MOUNT_POINT}"
else
  echo "${MOUNT_POINT} already mounted"
fi

# --- 6) Permissions (DEMO) ---------------------------------------------------
chmod 0777 "${MOUNT_POINT}"

echo "=== user-data complete: $(date -u +%FT%TZ) ==="
sync
sleep 1
