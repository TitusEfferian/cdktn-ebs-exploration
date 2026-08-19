// Shared constants / tunables (mirror the original user-data.sh).
export const DEVICE_REQUEST = "/dev/sdf"; // requested attach name; Nitro remaps to /dev/nvme?n1
export const MOUNT_POINT = "/mnt/ebs";
export const DEFAULT_FS_TYPE = "ext4";
export const MAX_WAIT_MS = 600_000; // max wait for any single state change
export const INTERVAL_MS = 5_000; // interval between polls
export const IMDS_WAIT_MS = 60_000; // max wait for the first IMDS success
export const ECS_CONFIG = "/etc/ecs/ecs.config";
export const ECS_DROPIN_DIR = "/etc/systemd/system/ecs.service.d";
export const ECS_DROPIN_FILE = `${ECS_DROPIN_DIR}/10-require-ebs.conf`;
export const FSTAB = "/etc/fstab";
export const CONTAINER_UID = 1000;
export const CONTAINER_GID = 1000;
export const LOG_PREFIX = "[ebs-bootstrap]";
