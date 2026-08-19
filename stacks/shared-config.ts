// Constants shared by BOTH stacks (ebs_test_secrets + ebs_test). clusterName
// is the coupling point of the stack split: the secrets stack derives the
// deterministic secret names from it, the main stack looks the same names up.
// scripts/verify-cluster.mjs mirrors region/clusterName — keep them in sync.
export const region = "ap-northeast-1";
export const clusterName = "ecs-ebs-demo";
export const commonTags = { Environment: "test", ManagedBy: "cdktn" };
