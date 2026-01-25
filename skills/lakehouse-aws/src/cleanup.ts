import { readEnvFile } from "./tools/file.js";
import { helm } from "./tools/helm.js";
import { kubectl } from "./tools/kubectl.js";
import { deleteCluster } from "./tools/eksctl.js";
import { deleteBucket } from "./tools/s3.js";
import { deleteRole, deletePolicy } from "./tools/iam.js";
import { aws } from "./tools/aws.js";
import { getExecMode } from "./tools/shell.js";

export type CleanupInput = {
  awsProfile: string;
  awsRegion: string;
  clusterName: string;
  s3Bucket?: string;
  namespace?: string;
  approve: boolean;
  envFile?: string;
};

export type CleanupResult = {
  status: "needs_approval" | "completed" | "partial" | "error";
  evidence: {
    helmReleases?: {
      uninstalled: string[];
      failed: string[];
    };
    cluster?: {
      deleted: boolean;
      error?: string;
    };
    s3Bucket?: {
      deleted: boolean;
      error?: string;
    };
    iamRoles?: {
      deleted: string[];
      failed: string[];
    };
    iamPolicies?: {
      deleted: string[];
      failed: string[];
    };
    ebsVolumes?: {
      deleted: string[];
      failed: string[];
    };
  };
  blockers?: Array<{ code: string; message: string }>;
  plan?: string;
};

const HELM_RELEASES = [
  "ingext-ingress",
  "ingext-lake",
  "ingext-s3-lake",
  "ingext-manager-role",
  "ingext-search-pool",
  "ingext-merge-pool",
  "ingext-lake-config",
  "ingext-community",
  "ingext-community-init",
  "ingext-community-config",
  "etcd-single-cronjob",
  "etcd-single",
  "ingext-stack",
  "aws-load-balancer-controller",
  "karpenter",
  "ingext-aws-gp3",
];

function renderCleanupPlan(env: Record<string, string>): string {
  return `
═══════════════════════════════════════════════════════════════
Cleanup Plan - DESTRUCTIVE OPERATION
═══════════════════════════════════════════════════════════════

⚠️  WARNING: This will DELETE all resources for:
  • Cluster: ${env.CLUSTER_NAME}
  • Namespace: ${env.NAMESPACE || "ingext"}
  • S3 Bucket: ${env.S3_BUCKET || "N/A"}
  • All Helm releases
  • All IAM roles and policies
  • All EBS volumes

Phase 1: Uninstall Helm Releases
  • ${HELM_RELEASES.length} releases will be uninstalled

Phase 2: Delete EKS Cluster
  • Cluster: ${env.CLUSTER_NAME}
  • Region: ${env.AWS_REGION}
  • This takes ~15 minutes

Phase 3: Delete S3 Bucket
  • Bucket: ${env.S3_BUCKET || "N/A"}
  • All data will be permanently lost

Phase 4: Cleanup IAM Resources
  • Service account roles
  • Karpenter roles
  • Load balancer controller roles
  • Associated policies

Phase 5: Cleanup EBS Volumes
  • Orphaned volumes tagged for namespace

═══════════════════════════════════════════════════════════════

To proceed, run with --approve true
`.trim();
}

export async function runCleanup(input: CleanupInput): Promise<CleanupResult> {
  // Load env file if provided
  let env: Record<string, string> = {};
  let namespace = input.namespace || "ingext";
  
  if (input.envFile) {
    const envFileResult = await readEnvFile(input.envFile);
    if (envFileResult.ok && envFileResult.env) {
      env = envFileResult.env;
      namespace = env.NAMESPACE || namespace;
    }
  }
  
  // Merge with input (input takes precedence)
  env = {
    ...env,
    AWS_PROFILE: input.awsProfile,
    AWS_REGION: input.awsRegion,
    CLUSTER_NAME: input.clusterName,
    S3_BUCKET: input.s3Bucket || env.S3_BUCKET || "",
    NAMESPACE: namespace,
  };
  
  // Approval gate
  if (!input.approve) {
    return {
      status: "needs_approval",
      evidence: {},
      plan: renderCleanupPlan(env),
    };
  }
  
  const evidence: CleanupResult["evidence"] = {
    helmReleases: { uninstalled: [], failed: [] },
    iamRoles: { deleted: [], failed: [] },
    iamPolicies: { deleted: [], failed: [] },
    ebsVolumes: { deleted: [], failed: [] },
  };
  
  const blockers: Array<{ code: string; message: string }> = [];
  
  // Phase 1: Uninstall Helm Releases
  console.error("\n⏳ Phase 1: Uninstalling Helm Releases...");
  for (const release of HELM_RELEASES) {
    try {
      // Try namespace first
      const nsResult = await helm(
        ["uninstall", release, "-n", namespace],
        { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
      );
      
      if (nsResult.ok || nsResult.stderr.includes("not found")) {
        evidence.helmReleases!.uninstalled.push(`${release} (${namespace})`);
        console.error(`  ✓ Uninstalled ${release} from ${namespace}`);
      } else {
        // Try kube-system
        const kubeSystemResult = await helm(
          ["uninstall", release, "-n", "kube-system"],
          { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
        );
        
        if (kubeSystemResult.ok || kubeSystemResult.stderr.includes("not found")) {
          evidence.helmReleases!.uninstalled.push(`${release} (kube-system)`);
          console.error(`  ✓ Uninstalled ${release} from kube-system`);
        } else {
          evidence.helmReleases!.failed.push(release);
          console.error(`  ⚠️  Failed to uninstall ${release}`);
        }
      }
    } catch (err) {
      evidence.helmReleases!.failed.push(release);
      console.error(`  ⚠️  Error uninstalling ${release}: ${err}`);
    }
  }
  
  // Phase 2: Delete EKS Cluster
  console.error("\n⏳ Phase 2: Deleting EKS Cluster (this takes ~15 min)...");
  try {
    const clusterResult = await deleteCluster(env.CLUSTER_NAME, env.AWS_REGION, env.AWS_PROFILE);
    if (clusterResult.ok) {
      evidence.cluster = { deleted: true };
      console.error(`  ✓ Cluster ${env.CLUSTER_NAME} deletion initiated`);
    } else {
      evidence.cluster = { deleted: false, error: clusterResult.stderr };
      blockers.push({
        code: "CLUSTER_DELETE_FAILED",
        message: `Failed to delete cluster: ${clusterResult.stderr}`,
      });
    }
  } catch (err) {
    evidence.cluster = { deleted: false, error: String(err) };
    blockers.push({
      code: "CLUSTER_DELETE_ERROR",
      message: `Error deleting cluster: ${err}`,
    });
  }
  
  // Phase 3: Delete S3 Bucket
  if (env.S3_BUCKET) {
    console.error("\n⏳ Phase 3: Deleting S3 Bucket...");
    try {
      const bucketResult = await deleteBucket(env.S3_BUCKET, env.AWS_REGION, env.AWS_PROFILE);
      if (bucketResult.ok) {
        evidence.s3Bucket = { deleted: true };
        console.error(`  ✓ Bucket ${env.S3_BUCKET} deleted`);
      } else {
        evidence.s3Bucket = { deleted: false, error: bucketResult.stderr };
        console.error(`  ⚠️  Failed to delete bucket: ${bucketResult.stderr}`);
      }
    } catch (err) {
      evidence.s3Bucket = { deleted: false, error: String(err) };
      console.error(`  ⚠️  Error deleting bucket: ${err}`);
    }
  }
  
  // Phase 4: Cleanup IAM Roles and Policies
  console.error("\n⏳ Phase 4: Cleaning up IAM Resources...");
  
  // Get account ID
  const accountIdResult = await aws(
    getExecMode(),
    ["sts", "get-caller-identity", "--query", "Account", "--output", "text"],
    { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
  );
  const accountId = accountIdResult.ok ? accountIdResult.stdout.trim() : "";
  
  // Delete roles
  const rolesToDelete = [
    `ingext_${namespace}-sa`,
    `KarpenterControllerRole-${env.CLUSTER_NAME}`,
    `KarpenterNodeRole-${env.CLUSTER_NAME}`,
    `AWSLoadBalancerControllerRole_${env.CLUSTER_NAME}`,
  ];
  
  for (const roleName of rolesToDelete) {
    try {
      const result = await deleteRole(roleName, env.AWS_PROFILE);
      if (result.ok) {
        evidence.iamRoles!.deleted.push(roleName);
        console.error(`  ✓ Deleted IAM role: ${roleName}`);
      } else {
        evidence.iamRoles!.failed.push(roleName);
      }
    } catch (err) {
      evidence.iamRoles!.failed.push(roleName);
    }
  }
  
  // Delete policies
  const policiesToDelete = [
    `ingext_${namespace}-sa_S3_Policy`,
    `KarpenterControllerPolicy-${env.CLUSTER_NAME}`,
    `AWSLoadBalancerControllerIAMPolicy_${env.CLUSTER_NAME}`,
  ];
  
  for (const policyName of policiesToDelete) {
    try {
      const result = await deletePolicy(policyName, accountId, env.AWS_PROFILE);
      if (result.ok) {
        evidence.iamPolicies!.deleted.push(policyName);
        console.error(`  ✓ Deleted IAM policy: ${policyName}`);
      } else {
        evidence.iamPolicies!.failed.push(policyName);
      }
    } catch (err) {
      evidence.iamPolicies!.failed.push(policyName);
    }
  }
  
  // Phase 5: Cleanup EBS Volumes
  console.error("\n⏳ Phase 5: Cleaning up EBS Volumes...");
  try {
    const volumesResult = await aws(
      getExecMode(),
      [
        "ec2",
        "describe-volumes",
        "--region",
        env.AWS_REGION,
        "--filters",
        `Name=tag:kubernetes.io/created-for/pvc/namespace,Values=${namespace}`,
        "Name=status,Values=available",
        "--query",
        "Volumes[*].VolumeId",
        "--output",
        "text",
      ],
      { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
    );
    
    if (volumesResult.ok && volumesResult.stdout.trim()) {
      const volumeIds = volumesResult.stdout.trim().split(/\s+/).filter(Boolean);
      for (const volumeId of volumeIds) {
        try {
          const deleteResult = await aws(
            getExecMode(),
            ["ec2", "delete-volume", "--volume-id", volumeId, "--region", env.AWS_REGION],
            { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
          );
          if (deleteResult.ok) {
            evidence.ebsVolumes!.deleted.push(volumeId);
            console.error(`  ✓ Deleted EBS volume: ${volumeId}`);
          } else {
            evidence.ebsVolumes!.failed.push(volumeId);
          }
        } catch (err) {
          evidence.ebsVolumes!.failed.push(volumeId);
        }
      }
    } else {
      console.error("  No orphaned EBS volumes found");
    }
  } catch (err) {
    console.error(`  ⚠️  Error checking EBS volumes: ${err}`);
  }
  
  // Determine final status
  const hasErrors = blockers.length > 0 || 
    (evidence.cluster && !evidence.cluster.deleted) ||
    (evidence.s3Bucket && !evidence.s3Bucket.deleted);
  
  const status: CleanupResult["status"] = hasErrors
    ? "partial"
    : "completed";
  
  // Print summary
  console.error("\n============================================================");
  console.error("📊 Cleanup Summary");
  console.error("============================================================");
  console.error(`Helm Releases: ${evidence.helmReleases!.uninstalled.length} uninstalled, ${evidence.helmReleases!.failed.length} failed`);
  console.error(`IAM Roles:     ${evidence.iamRoles!.deleted.length} deleted, ${evidence.iamRoles!.failed.length} failed${evidence.iamRoles!.deleted.length === 0 && evidence.iamRoles!.failed.length === 0 ? " (none found)" : ""}`);
  console.error(`IAM Policies:  ${evidence.iamPolicies!.deleted.length} deleted, ${evidence.iamPolicies!.failed.length} failed${evidence.iamPolicies!.deleted.length === 0 && evidence.iamPolicies!.failed.length === 0 ? " (none found)" : ""}`);
  console.error(`EBS Volumes:   ${evidence.ebsVolumes!.deleted.length} deleted, ${evidence.ebsVolumes!.failed.length} failed${evidence.ebsVolumes!.deleted.length === 0 && evidence.ebsVolumes!.failed.length === 0 ? " (none found)" : ""}`);
  console.error(`EKS Cluster:   ${evidence.cluster?.deleted ? "✓ DELETED" : "⚠️  NOT DELETED"}`);
  console.error(`S3 Bucket:     ${evidence.s3Bucket?.deleted ? "✓ DELETED" : evidence.s3Bucket ? "⚠️  NOT DELETED" : "N/A"}`);
  console.error("============================================================");
  console.error("\nNote: Empty 'deleted' arrays (deleted: []) mean no items were found in that category - this is normal and not an error.");
  console.error("      Cleanup is successful if the cluster and bucket (if configured) show as DELETED above.");
  
  if (status === "completed") {
    console.error("\n✓ Cleanup completed successfully");
  } else {
    console.error("\n⚠️  Cleanup completed with errors - check evidence for details");
  }
  
  return {
    status,
    evidence,
    blockers: blockers.length > 0 ? blockers : undefined,
  };
}
