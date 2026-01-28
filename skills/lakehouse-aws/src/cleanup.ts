import { readEnvFile } from "./tools/file.js";
import { helm } from "./tools/helm.js";
import { kubectl } from "./tools/kubectl.js";
import { deleteCluster } from "./tools/eksctl.js";
import { deleteBucket } from "./tools/s3.js";
import { deleteRole, deletePolicy } from "./tools/iam.js";
import { aws, describeCluster, deleteClusterWithAwsCli, listCloudFormationStacks, deleteCloudFormationStack, waitForStacksDeleted, listPodIdentityAssociations, deletePodIdentityAssociation } from "./tools/aws.js";

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

// Helm releases in REVERSE installation order (uninstall dependencies first)
// Installation order: Phase 3 (karpenter) -> Phase 4 (core) -> Phase 5 (stream) -> Phase 6 (datalake) -> Phase 7 (ingress)
// Uninstall order: Phase 7 -> Phase 6 -> Phase 5 -> Phase 4 -> Phase 3 -> supporting
const HELM_RELEASES = [
  // Phase 7: Ingress (depends on everything, uninstall first)
  "ingext-ingress",
  // Phase 6: Datalake services (depends on stream/core)
  "ingext-lake",
  "ingext-s3-lake",
  "ingext-merge-pool",
  "ingext-search-pool",
  "ingext-lake-config",
  // Phase 5: Stream services (depends on core)
  "ingext-community",
  "ingext-community-init",
  "ingext-community-config",
  // Phase 4: Core services (foundation)
  "ingext-stack",
  "etcd-single",
  "etcd-single-cronjob",
  // Supporting/Infrastructure (can be uninstalled after workloads)
  "ingext-manager-role",
  "aws-load-balancer-controller",
  "karpenter",
  "ingext-aws-gp3",
];

function renderCleanupPlan(env: Record<string, string>): string {
  return `
${"═".repeat(80)}
${"⚠️  DESTRUCTIVE OPERATION - PERMANENT DELETION ⚠️".padStart(60)}
${"═".repeat(80)}

WARNING: This will DELETE and UNALLOCATE all resources for:
  • Cluster: ${env.CLUSTER_NAME || "N/A"}
  • Namespace: ${env.NAMESPACE || "ingext"}
  • S3 Bucket: ${env.S3_BUCKET || "N/A"}
  • Region: ${env.AWS_REGION || "N/A"}

RESOURCES THAT WILL BE DELETED:
  • All Helm releases (${HELM_RELEASES.length} releases)
  • EKS Cluster and all node groups
  • S3 Bucket and ALL DATA (permanently lost)
  • IAM Roles (service accounts, Karpenter, Load Balancer Controller)
  • IAM Policies (associated with above roles)
  • EBS Volumes (orphaned volumes for this namespace)

ESTIMATED TIME: ~15-20 minutes (cluster deletion is the longest step)

CLEANUP PHASES:
  1. Uninstall Helm Releases (~2-5 minutes)
     - Removes all workloads and services
     - Waits for uninstall completion
  
  2. Delete EKS Cluster (~15 minutes)
     - Deletes cluster and all node groups
     - Waits for complete deletion
  
  3. Delete S3 Bucket (~1 minute)
     - Permanently deletes bucket and all data
     - ⚠️  DATA LOSS: All data in bucket will be lost
  
  4. Cleanup IAM Resources (~1 minute)
     - Deletes IAM roles and policies
     - Removes service account associations
  
  5. Cleanup EBS Volumes (~1 minute)
     - Deletes orphaned EBS volumes
     - Only volumes tagged for this namespace

${"═".repeat(80)}
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
  const helmEnv = { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION };
  
  for (const release of HELM_RELEASES) {
    try {
      // Determine which namespace this release is in
      // Most releases are in the main namespace, but some are in kube-system
      const isKubeSystemRelease = release === "karpenter" || release === "aws-load-balancer-controller";
      const releaseNamespace = isKubeSystemRelease ? "kube-system" : namespace;
      
      // Uninstall with --wait to ensure resources are actually deleted
      const uninstallResult = await helm(
        ["uninstall", release, "-n", releaseNamespace, "--wait", "--timeout", "5m"],
        helmEnv
      );
      
      if (uninstallResult.ok || uninstallResult.stderr.includes("not found")) {
        evidence.helmReleases!.uninstalled.push(`${release} (${releaseNamespace})`);
        console.error(`  ✓ Uninstalled ${release} from ${releaseNamespace}`);
      } else {
        // If uninstall failed, try without --wait as fallback
        const fallbackResult = await helm(
          ["uninstall", release, "-n", releaseNamespace],
          helmEnv
        );
        
        if (fallbackResult.ok || fallbackResult.stderr.includes("not found")) {
          evidence.helmReleases!.uninstalled.push(`${release} (${releaseNamespace})`);
          console.error(`  ✓ Uninstalled ${release} from ${releaseNamespace} (without wait)`);
        } else {
          // Try the other namespace as last resort
          const otherNamespace = isKubeSystemRelease ? namespace : "kube-system";
          const otherNsResult = await helm(
            ["uninstall", release, "-n", otherNamespace],
            helmEnv
          );
          
          if (otherNsResult.ok || otherNsResult.stderr.includes("not found")) {
            evidence.helmReleases!.uninstalled.push(`${release} (${otherNamespace})`);
            console.error(`  ✓ Uninstalled ${release} from ${otherNamespace}`);
          } else {
            evidence.helmReleases!.failed.push(release);
            console.error(`  ⚠️  Failed to uninstall ${release}: ${uninstallResult.stderr || fallbackResult.stderr || otherNsResult.stderr}`);
          }
        }
      }
      
      // Small delay between uninstalls to allow resources to clean up
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      evidence.helmReleases!.failed.push(release);
      console.error(`  ⚠️  Error uninstalling ${release}: ${err}`);
    }
  }
  
  // Wait for Helm uninstalls to complete - actually verify they're gone
  if (evidence.helmReleases!.uninstalled.length > 0) {
    console.error("\n⏳ Waiting for Helm uninstalls to complete...");
    
    // Poll to verify releases are actually deleted
    let allGone = false;
    let attempts = 0;
    const maxAttempts = 20; // 5 minutes max (15 second intervals)
    const releasesToCheck = evidence.helmReleases!.uninstalled.map(r => {
      // Extract release name from "release (namespace)" format
      const match = r.match(/^([^(]+)\s*\(/);
      return match ? match[1] : r.split(' ')[0];
    });
    
    while (attempts < maxAttempts && !allGone) {
      await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds
      attempts++;
      
      // Check if any releases still exist
      const helmListResult = await helm(
        ["list", "-a", "-n", namespace, "-o", "json"],
        helmEnv
      );
      
      if (helmListResult.ok) {
        try {
          const releases = JSON.parse(helmListResult.stdout);
          const existingReleases = releases.map((r: any) => r.name);
          const stillExists = releasesToCheck.filter(name => existingReleases.includes(name));
          
          if (stillExists.length === 0) {
            allGone = true;
            console.error(`  ✓ All Helm releases uninstalled (verified after ${attempts * 15}s)`);
          } else {
            process.stderr.write(`   [${attempts * 15}s] ${stillExists.length} release(s) still uninstalling: ${stillExists.join(", ")}\n`);
          }
        } catch (e) {
          // If we can't parse, assume they're gone (helm list failed might mean no releases)
          allGone = true;
          console.error(`  ✓ Helm cleanup complete (could not verify, assuming complete)`);
        }
      } else {
        // If helm list fails, releases might be gone (or helm not available)
        // Check if it's a "not found" error vs other error
        if (helmListResult.stderr.includes("not found") || helmListResult.stderr.includes("Command not found")) {
          // Helm not available or no releases - assume done
          allGone = true;
          console.error(`  ✓ Helm cleanup complete`);
        } else {
          // Other error - continue waiting
          process.stderr.write(`   [${attempts * 15}s] Checking Helm status...\n`);
        }
      }
    }
    
    if (!allGone) {
      console.error(`  ⚠️  Some Helm releases may still be uninstalling (timeout after ${attempts * 15}s)`);
      console.error(`  Proceeding with cleanup...`);
    }
  }
  
  // Verify and clean up any orphaned resources
  console.error("\n⏳ Verifying resources are deleted and cleaning up orphans...");
  try {
    // Delete all deployments in namespace
    const deploymentsCheck = await kubectl(
      ["get", "deployments", "-n", namespace, "-o", "json"],
      { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
    );
    if (deploymentsCheck.ok) {
      try {
        const data = JSON.parse(deploymentsCheck.stdout);
        const deployments = data.items || [];
        if (deployments.length > 0) {
          console.error(`  Found ${deployments.length} orphaned deployment(s), deleting...`);
          for (const deployment of deployments) {
            await kubectl(
              ["delete", "deployment", deployment.metadata.name, "-n", namespace, "--ignore-not-found=true"],
              { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
            );
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    // Delete all statefulsets in namespace
    const statefulsetsCheck = await kubectl(
      ["get", "statefulsets", "-n", namespace, "-o", "json"],
      { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
    );
    if (statefulsetsCheck.ok) {
      try {
        const data = JSON.parse(statefulsetsCheck.stdout);
        const statefulsets = data.items || [];
        if (statefulsets.length > 0) {
          console.error(`  Found ${statefulsets.length} orphaned statefulset(s), deleting...`);
          for (const sts of statefulsets) {
            await kubectl(
              ["delete", "statefulset", sts.metadata.name, "-n", namespace, "--ignore-not-found=true"],
              { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
            );
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    // Delete all pods in namespace (in case some are orphaned)
    const podsCheck = await kubectl(
      ["get", "pods", "-n", namespace, "-o", "json"],
      { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
    );
    if (podsCheck.ok) {
      try {
        const data = JSON.parse(podsCheck.stdout);
        const pods = data.items || [];
        // Filter out completed/failed pods from cronjobs (they're expected)
        const activePods = pods.filter((p: any) => {
          const phase = p.status?.phase;
          // Keep only Running/Pending pods (exclude Succeeded/Failed from jobs)
          return phase === "Running" || phase === "Pending";
        });
        if (activePods.length > 0) {
          console.error(`  Found ${activePods.length} orphaned pod(s), deleting...`);
          for (const pod of activePods) {
            await kubectl(
              ["delete", "pod", pod.metadata.name, "-n", namespace, "--ignore-not-found=true"],
              { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
            );
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    // Wait a bit for deletions to propagate
    await new Promise(resolve => setTimeout(resolve, 10000));
    console.error("  ✓ Orphaned resource cleanup complete");
  } catch (err) {
    console.error(`  ⚠️  Error cleaning up orphaned resources: ${err}`);
  }
  
  // Phase 2: Delete EKS Cluster
  console.error("\n⏳ Phase 2: Deleting EKS Cluster (this takes ~15 minutes)...");
  console.error("   This is the longest step. Please wait...");
  
  // First, check if cluster actually exists
  const clusterCheck = await describeCluster(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
  if (!clusterCheck.found && clusterCheck.status === "NOT_FOUND") {
    // Double-check with a second call to be sure
    const doubleCheck = await describeCluster(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
    if (!doubleCheck.found && doubleCheck.status === "NOT_FOUND") {
      evidence.cluster = { deleted: true };
      console.error(`  ✓ Cluster ${env.CLUSTER_NAME} not found (already deleted)`);
    } else {
      // Cluster actually exists - the initial check was wrong, proceed with deletion
      console.error(`  ⚠️  Initial check reported cluster not found, but verification shows it exists.`);
      console.error(`  Cluster status: ${doubleCheck.found ? doubleCheck.status : "UNKNOWN"}`);
      console.error(`  Proceeding with deletion...`);
      // Update clusterCheck to reflect actual state so deletion logic below runs
      clusterCheck.found = true;
      clusterCheck.status = doubleCheck.status || "ACTIVE";
    }
  } else if (!clusterCheck.found && clusterCheck.status === "ERROR") {
    // Error checking cluster - proceed with deletion attempt anyway
    console.error(`  ⚠️  Could not verify cluster status: ${clusterCheck.error || "unknown error"}`);
    console.error(`  Proceeding with deletion attempt...`);
  } else if (clusterCheck.found) {
    // Cluster exists, proceed with deletion
    console.error(`  Cluster status: ${clusterCheck.status}`);
    let deleted = false;
    try {
      const clusterResult = await deleteCluster(env.CLUSTER_NAME, env.AWS_REGION, env.AWS_PROFILE);
      if (clusterResult.ok) {
        // eksctl delete with --wait should wait, but let's verify the cluster is actually gone
        // Wait a moment for the status to update
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        
        // Check initial status after deletion command
        const initialCheck = await describeCluster(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
        
        if (!initialCheck.found && initialCheck.status === "NOT_FOUND") {
          // Cluster already deleted
          deleted = true;
          evidence.cluster = { deleted: true };
          console.error(`  ✓ Cluster ${env.CLUSTER_NAME} deleted successfully`);
        } else if (initialCheck.found && initialCheck.status === "ACTIVE") {
          // Cluster is still ACTIVE - eksctl --wait may have failed or timed out
          console.error(`  ⚠️  Cluster is still ACTIVE. eksctl --wait may have failed.`);
          console.error(`  ⚠️  Attempting to verify deletion status...`);
          
          // Continue checking for a bit to see if deletion starts
          console.error(`  ⚠️  This may take up to 15 minutes. Progress will be shown below (updates every 15 seconds):`);
          let attempts = 0;
          const maxAttempts = 60; // 15 minutes max (15 second intervals)
          
          while (attempts < maxAttempts && !deleted) {
            await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds
            attempts++;
            const verifyCheck = await describeCluster(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
            
            if (!verifyCheck.found && verifyCheck.status === "NOT_FOUND") {
              deleted = true;
              evidence.cluster = { deleted: true };
              const minutes = Math.floor((attempts * 15 + 5) / 60);
              const seconds = (attempts * 15 + 5) % 60;
              // Clear the progress line and show success
              process.stderr.write(`\r${" ".repeat(80)}\r`); // Clear line
              console.error(`  ✓ Cluster ${env.CLUSTER_NAME} deleted successfully (verified after ${minutes}m ${seconds}s)`);
            } else if (verifyCheck.found && verifyCheck.status === "DELETING") {
              const minutes = Math.floor((attempts * 15 + 5) / 60);
              const seconds = (attempts * 15 + 5) % 60;
              process.stderr.write(`\r   [${minutes}m ${seconds}s] Cluster deletion in progress (DELETING state)...${" ".repeat(20)}`);
              // Continue waiting
            } else if (verifyCheck.found && verifyCheck.status === "ACTIVE") {
              const minutes = Math.floor((attempts * 15 + 5) / 60);
              const seconds = (attempts * 15 + 5) % 60;
              process.stderr.write(`\r   [${minutes}m ${seconds}s] Cluster still ACTIVE, waiting for deletion to start...${" ".repeat(20)}`);
              // Continue waiting - deletion might start soon
            } else if (verifyCheck.found) {
              const minutes = Math.floor((attempts * 15 + 5) / 60);
              const seconds = (attempts * 15 + 5) % 60;
              process.stderr.write(`\r   [${minutes}m ${seconds}s] Cluster status: ${verifyCheck.status}, waiting...${" ".repeat(20)}`);
            }
          }
          
          // Clear the progress line at the end
          if (!deleted) {
            process.stderr.write(`\r${" ".repeat(80)}\r`); // Clear line
          }
          
          if (!deleted) {
            // Final check
            const finalCheck = await describeCluster(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
            if (!finalCheck.found && finalCheck.status === "NOT_FOUND") {
              deleted = true;
              evidence.cluster = { deleted: true };
              console.error(`  ✓ Cluster ${env.CLUSTER_NAME} deleted (verified)`);
            } else if (finalCheck.found) {
              evidence.cluster = { deleted: false, error: `Cluster still exists with status: ${finalCheck.status}` };
              blockers.push({
                code: "CLUSTER_DELETE_VERIFICATION_FAILED",
                message: `eksctl delete reported success but cluster still exists with status: ${finalCheck.status}. You may need to manually delete it.`,
              });
              console.error(`  ⚠️  Cluster deletion verification failed. Status: ${finalCheck.status}`);
            }
          }
        } else if (initialCheck.found && initialCheck.status === "DELETING") {
          // Deletion in progress, wait for it
          console.error("  ✓ Cluster deletion already in progress");
          console.error("  ⏳ Waiting for cluster deletion to complete...");
          console.error("     ⚠️  This may take up to 15 minutes. Cluster is being deleted asynchronously by AWS.");
          console.error("     Progress will be shown below (updates every 15 seconds):");
          let attempts = 0;
          const maxAttempts = 60; // 15 minutes max
          
          while (attempts < maxAttempts && !deleted) {
            await new Promise(resolve => setTimeout(resolve, 15000));
            attempts++;
            const verifyCheck = await describeCluster(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
            
            if (!verifyCheck.found && verifyCheck.status === "NOT_FOUND") {
              deleted = true;
              evidence.cluster = { deleted: true };
              const minutes = Math.floor((attempts * 15 + 5) / 60);
              const seconds = (attempts * 15 + 5) % 60;
              // Clear the progress line and show success
              process.stderr.write(`\r${" ".repeat(80)}\r`); // Clear line
              console.error(`  ✓ Cluster ${env.CLUSTER_NAME} deleted successfully (verified after ${minutes}m ${seconds}s)`);
            } else if (verifyCheck.found && verifyCheck.status === "DELETING") {
              const minutes = Math.floor((attempts * 15 + 5) / 60);
              const seconds = (attempts * 15 + 5) % 60;
              process.stderr.write(`\r   [${minutes}m ${seconds}s] Cluster deletion in progress (DELETING state)...${" ".repeat(20)}`);
            } else if (verifyCheck.found) {
              const minutes = Math.floor((attempts * 15 + 5) / 60);
              const seconds = (attempts * 15 + 5) % 60;
              process.stderr.write(`\r   [${minutes}m ${seconds}s] Status: ${verifyCheck.status}, waiting...${" ".repeat(20)}`);
            }
          }
          
          // Clear the progress line at the end
          if (!deleted) {
            process.stderr.write(`\r${" ".repeat(80)}\r`); // Clear line
          }
          
          if (!deleted) {
            const finalCheck = await describeCluster(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
            if (!finalCheck.found && finalCheck.status === "NOT_FOUND") {
              deleted = true;
              evidence.cluster = { deleted: true };
              console.error(`  ✓ Cluster ${env.CLUSTER_NAME} deleted (verified)`);
            } else if (finalCheck.found) {
              evidence.cluster = { deleted: false, error: `Cluster still exists. Status: ${finalCheck.status}` };
              blockers.push({
                code: "CLUSTER_DELETE_TIMEOUT",
                message: `Cluster deletion timed out. Status: ${finalCheck.status}`,
              });
            }
          }
        } else {
          // Other status or error
          evidence.cluster = { deleted: false, error: `Unexpected cluster status after deletion: ${initialCheck.status}` };
          blockers.push({
            code: "CLUSTER_DELETE_UNEXPECTED_STATUS",
            message: `Cluster has unexpected status: ${initialCheck.status}`,
          });
        }
        
        if (!deleted) {
          // Final check
          const finalCheck = await describeCluster(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
          if (!finalCheck.found && finalCheck.status === "NOT_FOUND") {
            evidence.cluster = { deleted: true };
            console.error(`  ✓ Cluster ${env.CLUSTER_NAME} deleted (verified)`);
          } else if (finalCheck.found) {
            evidence.cluster = { deleted: false, error: `Cluster still exists after deletion attempt. Status: ${finalCheck.status}` };
            blockers.push({
              code: "CLUSTER_DELETE_VERIFICATION_FAILED",
              message: `Cluster deletion may have failed. Cluster still exists with status: ${finalCheck.status}. Run 'eksctl delete cluster --name ${env.CLUSTER_NAME} --region ${env.AWS_REGION} --wait' manually.`,
            });
            console.error(`  ⚠️  Cluster deletion verification failed. Status: ${finalCheck.status}`);
            console.error(`  ⚠️  You may need to manually delete the cluster.`);
          } else {
            // Error checking - don't assume success, mark as partial
            evidence.cluster = { deleted: false, error: "Could not verify cluster deletion status" };
            blockers.push({
              code: "CLUSTER_DELETE_VERIFICATION_ERROR",
              message: "Could not verify if cluster was deleted. Check manually with: aws eks describe-cluster --name <cluster-name>",
            });
            console.error(`  ⚠️  Could not verify cluster deletion status`);
          }
        }
      } else {
        // eksctl delete failed - check what the error is
        const errorText = (clusterResult.stderr || clusterResult.stdout || "").toLowerCase();
        
        // 1. If error indicates cluster already doesn't exist, verify and mark as deleted
        if (errorText.includes("not found") || errorText.includes("does not exist") || 
            errorText.includes("resourcenotfoundexception")) {
          const verifyCheck = await describeCluster(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
          if (!verifyCheck.found && verifyCheck.status === "NOT_FOUND") {
            evidence.cluster = { deleted: true };
            console.error(`  ✓ Cluster ${env.CLUSTER_NAME} not found (already deleted)`);
          } else {
            // Cluster still exists despite error message, fall through to AWS CLI fallback
            console.error(`  ⚠️  eksctl reported not found, but cluster still exists. Trying AWS CLI fallback...`);
          }
        }

        // 2. If not already deleted, try AWS CLI fallback (more systematic deletion)
        if (!evidence.cluster?.deleted) {
          console.error(`  ⚠️  eksctl deletion failed or not available. Using AWS CLI fallback...`);
          console.error(`  This will systematically delete node groups, pod identities, then the cluster.`);
          
          try {
            const awsCliResult = await deleteClusterWithAwsCli(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
            
            if (awsCliResult.ok) {
              // ... verification loop ...
              let attempts = 0;
              const maxAttempts = 60; // 15 minutes
              let deleted = false;
              
              while (attempts < maxAttempts && !deleted) {
                await new Promise(resolve => setTimeout(resolve, 15000));
                attempts++;
                const verifyCheck = await describeCluster(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
                if (!verifyCheck.found && verifyCheck.status === "NOT_FOUND") {
                  deleted = true;
                  evidence.cluster = { deleted: true };
                  console.error(`  ✓ Cluster ${env.CLUSTER_NAME} deleted successfully`);
                }
              }
            } else {
              evidence.cluster = { deleted: false, error: awsCliResult.stderr };
              blockers.push({
                code: "CLUSTER_DELETE_AWSCLI_FAILED",
                message: `Failed to delete cluster using AWS CLI: ${awsCliResult.stderr}`,
              });
            }
          } catch (err) {
            evidence.cluster = { deleted: false, error: String(err) };
            blockers.push({
              code: "CLUSTER_DELETE_AWSCLI_ERROR",
              message: `Error deleting cluster with AWS CLI: ${err}`,
            });
          }
        }
      }
    } catch (err) {
      evidence.cluster = { deleted: false, error: String(err) };
      blockers.push({
        code: "CLUSTER_DELETE_ERROR",
        message: `Error deleting cluster: ${err}`,
      });
      console.error(`  ⚠️  Error deleting cluster: ${err}`);
    }
    
    // After cluster deletion attempt, check for orphaned CloudFormation stacks
    // eksctl delete should clean them up, but if it failed or timed out, they might remain
    console.error("\n⏳ Checking for orphaned CloudFormation stacks...");
    try {
      const stacksCheck = await listCloudFormationStacks(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
      
      if (stacksCheck.ok && stacksCheck.stacks.length > 0) {
        console.error(`  ⚠️  Found ${stacksCheck.stacks.length} orphaned CloudFormation stack(s):`);
        stacksCheck.stacks.forEach(stack => console.error(`     - ${stack}`));
        console.error(`  ⏳ Cleaning up orphaned stacks...`);
        
        // Sort stacks to delete cluster stack last (it may have dependencies)
        const sortedStacks = stacksCheck.stacks.sort((a, b) => {
          if (a.includes("-cluster")) return 1; // Cluster stack last
          if (b.includes("-cluster")) return -1;
          return a.localeCompare(b);
        });
        
        // Delete all stacks in parallel (they're independent operations)
        console.error(`     Initiating deletion of ${sortedStacks.length} stack(s) in parallel...`);
        
        const deletePromises = sortedStacks.map(async (stackName) => {
          const deleteResult = await deleteCloudFormationStack(stackName, env.AWS_PROFILE, env.AWS_REGION, {
            cleanupDependencies: true
          });
          if (!deleteResult.ok) {
            // Check for termination protection - need to disable it first
            if (deleteResult.stderr.includes("TerminationProtection is enabled")) {
              console.error(`     ⚠️  Stack ${stackName} has termination protection enabled`);
              console.error(`     ⏳ Disabling termination protection and retrying...`);
              // Disable termination protection
              const disableResult = await aws(
                ["cloudformation", "update-termination-protection", "--stack-name", stackName, "--no-enable-termination-protection"],
                env.AWS_PROFILE,
                env.AWS_REGION
              );
              if (disableResult.ok) {
                // Retry deletion
                return await deleteCloudFormationStack(stackName, env.AWS_PROFILE, env.AWS_REGION);
              }
            }
            // If stack is already being deleted or doesn't exist, that's okay
            if (deleteResult.stderr.includes("does not exist") || 
                deleteResult.stderr.includes("is in DELETE_IN_PROGRESS")) {
              return { ok: true, stderr: "", stdout: "" }; // Treat as success
            }
          }
          return deleteResult;
        });
        
        await Promise.all(deletePromises);
        
        // Wait for all stacks to be deleted in parallel (polling together)
        console.error(`  ⏳ Waiting for stacks to be deleted (this may take a few minutes)...`);
        const waitResult = await waitForStacksDeleted(sortedStacks, env.AWS_PROFILE, env.AWS_REGION, 10); // 10 minute timeout
        
        if (waitResult.ok) {
          console.error(`  ✓ All ${waitResult.deleted.length} CloudFormation stacks cleaned up`);
        } else {
          console.error(`  ⚠️  ${waitResult.remaining.length} stack(s) still remain: ${waitResult.remaining.join(", ")}`);
          console.error(`  ⚠️  ${waitResult.deleted.length} stack(s) were successfully deleted`);
        }
      } else {
        console.error(`  ✓ No orphaned CloudFormation stacks found`);
      }
    } catch (err) {
      console.error(`  ⚠️  Error checking for CloudFormation stacks: ${err}`);
      // Don't fail cleanup if stack check fails
    }
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
        // Check if bucket doesn't exist (already deleted) - this is success
        const errorText = bucketResult.stderr || bucketResult.stdout || "";
        if (errorText.includes("NoSuchBucket") || 
            errorText.includes("does not exist") ||
            errorText.includes("not found")) {
          evidence.s3Bucket = { deleted: true };
          console.error(`  ✓ Bucket ${env.S3_BUCKET} not found (already deleted)`);
        } else {
          evidence.s3Bucket = { deleted: false, error: bucketResult.stderr };
          console.error(`  ⚠️  Failed to delete bucket: ${bucketResult.stderr}`);
        }
      }
    } catch (err) {
      const errorMsg = String(err);
      // Check if error indicates bucket doesn't exist
      if (errorMsg.includes("NoSuchBucket") || 
          errorMsg.includes("does not exist") ||
          errorMsg.includes("not found")) {
        evidence.s3Bucket = { deleted: true };
        console.error(`  ✓ Bucket ${env.S3_BUCKET} not found (already deleted)`);
      } else {
        evidence.s3Bucket = { deleted: false, error: errorMsg };
        console.error(`  ⚠️  Error deleting bucket: ${err}`);
      }
    }
  }
  
  // Phase 4: Cleanup IAM Roles and Policies
  console.error("\n⏳ Phase 4: Cleaning up IAM Resources...");
  
  // Proactively delete Pod Identity Associations - these block cluster deletion
  console.error("  Checking for Pod Identity Associations...");
  try {
    const podIdentityResult = await listPodIdentityAssociations(env.CLUSTER_NAME, env.AWS_PROFILE, env.AWS_REGION);
    if (podIdentityResult.ok && podIdentityResult.associations.length > 0) {
      console.error(`  Found ${podIdentityResult.associations.length} Pod Identity Association(s), deleting...`);
      for (const assoc of podIdentityResult.associations) {
        console.error(`  Deleting Pod Identity Association: ${assoc.associationId} (${assoc.namespace}/${assoc.serviceAccount})...`);
        const deleteAssocResult = await deletePodIdentityAssociation(env.CLUSTER_NAME, assoc.associationId, env.AWS_PROFILE, env.AWS_REGION);
        if (deleteAssocResult.ok) {
          console.error(`  ✓ Deleted Pod Identity Association: ${assoc.associationId}`);
        } else {
          console.error(`  ⚠️  Failed to delete Pod Identity Association ${assoc.associationId}: ${deleteAssocResult.stderr}`);
        }
      }
      // Small delay for associations to clear
      await new Promise(resolve => setTimeout(resolve, 5000));
    } else {
      console.error("  ✓ No Pod Identity Associations found");
    }
  } catch (err) {
    console.error(`  ⚠️  Error checking Pod Identity Associations: ${err}`);
  }

  // Get account ID
  const accountIdResult = await aws(
    ["sts", "get-caller-identity", "--query", "Account", "--output", "text"],
    env.AWS_PROFILE,
    env.AWS_REGION
  );
  const accountId = accountIdResult.ok ? accountIdResult.stdout.trim() : "";
  
  // Delete roles - try both naming formats
  const serviceAccountName = `${namespace}-sa`;
  const rolesToDelete = [
    // Service account role (format: ingext_<namespace>-sa_<cluster>)
    `ingext_${serviceAccountName}_${env.CLUSTER_NAME}`,
    // Also try without cluster suffix (legacy format)
    `ingext_${serviceAccountName}`,
    // Karpenter roles
    `KarpenterControllerRole-${env.CLUSTER_NAME}`,
    `KarpenterNodeRole-${env.CLUSTER_NAME}`,
    // Load balancer controller role
    `AWSLoadBalancerControllerRole_${env.CLUSTER_NAME}`,
  ];
  
  console.error("  Checking and deleting IAM roles...");
  for (const roleName of rolesToDelete) {
    try {
      const result = await deleteRole(roleName, env.AWS_PROFILE);
      if (result.ok) {
        evidence.iamRoles!.deleted.push(roleName);
        console.error(`  ✓ Deleted IAM role: ${roleName}`);
      } else if (result.stderr.includes("NoSuchEntity") || result.stderr.includes("not found")) {
        // Role doesn't exist - this is fine, skip it
        console.error(`  - IAM role not found (skipping): ${roleName}`);
      } else {
        evidence.iamRoles!.failed.push(roleName);
        console.error(`  ⚠️  Failed to delete IAM role: ${roleName} - ${result.stderr}`);
      }
    } catch (err) {
      evidence.iamRoles!.failed.push(roleName);
      console.error(`  ⚠️  Error deleting IAM role ${roleName}: ${err}`);
    }
  }
  
  // Delete policies
  const policiesToDelete = [
    // Service account S3 policy (format: ingext_<namespace>-sa_S3_Policy_<cluster>)
    `ingext_${namespace}_S3_Policy_${env.CLUSTER_NAME}`,
    // Also try without cluster suffix
    `ingext_${serviceAccountName}_S3_Policy`,
    // Karpenter policy
    `KarpenterControllerPolicy-${env.CLUSTER_NAME}`,
    // Load balancer controller policy
    `AWSLoadBalancerControllerIAMPolicy_${env.CLUSTER_NAME}`,
  ];
  
  console.error("  Checking and deleting IAM policies...");
  for (const policyName of policiesToDelete) {
    try {
      const result = await deletePolicy(policyName, accountId, env.AWS_PROFILE);
      if (result.ok) {
        evidence.iamPolicies!.deleted.push(policyName);
        console.error(`  ✓ Deleted IAM policy: ${policyName}`);
      } else if (result.stderr.includes("NoSuchEntity") || result.stderr.includes("not found")) {
        // Policy doesn't exist - this is fine, skip it
        console.error(`  - IAM policy not found (skipping): ${policyName}`);
      } else {
        evidence.iamPolicies!.failed.push(policyName);
        console.error(`  ⚠️  Failed to delete IAM policy: ${policyName} - ${result.stderr}`);
      }
    } catch (err) {
      evidence.iamPolicies!.failed.push(policyName);
      console.error(`  ⚠️  Error deleting IAM policy ${policyName}: ${err}`);
    }
  }
  
  // Phase 5: Cleanup EBS Volumes
  console.error("\n⏳ Phase 5: Cleaning up EBS Volumes...");
  try {
    const volumesResult = await aws(
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
      env.AWS_PROFILE,
      env.AWS_REGION
    );
    
    if (volumesResult.ok && volumesResult.stdout.trim()) {
      const volumeIds = volumesResult.stdout.trim().split(/\s+/).filter(Boolean);
      console.error(`  Found ${volumeIds.length} orphaned EBS volume(s)`);
      for (const volumeId of volumeIds) {
        try {
          const deleteResult = await aws(
            ["ec2", "delete-volume", "--volume-id", volumeId, "--region", env.AWS_REGION],
            env.AWS_PROFILE,
            env.AWS_REGION
          );
          if (deleteResult.ok) {
            evidence.ebsVolumes!.deleted.push(volumeId);
            console.error(`  ✓ Deleted EBS volume: ${volumeId}`);
          } else {
            evidence.ebsVolumes!.failed.push(volumeId);
            console.error(`  ⚠️  Failed to delete EBS volume: ${volumeId} - ${deleteResult.stderr}`);
          }
        } catch (err) {
          evidence.ebsVolumes!.failed.push(volumeId);
          console.error(`  ⚠️  Error deleting EBS volume ${volumeId}: ${err}`);
        }
      }
    } else {
      console.error("  ✓ No orphaned EBS volumes found");
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
  console.error("\n" + "=".repeat(80));
  console.error("📊 Cleanup Summary");
  console.error("=".repeat(80));
  console.error(`Helm Releases: ${evidence.helmReleases!.uninstalled.length} uninstalled, ${evidence.helmReleases!.failed.length} failed`);
  console.error(`IAM Roles:     ${evidence.iamRoles!.deleted.length} deleted, ${evidence.iamRoles!.failed.length} failed${evidence.iamRoles!.deleted.length === 0 && evidence.iamRoles!.failed.length === 0 ? " (none found)" : ""}`);
  console.error(`IAM Policies:  ${evidence.iamPolicies!.deleted.length} deleted, ${evidence.iamPolicies!.failed.length} failed${evidence.iamPolicies!.deleted.length === 0 && evidence.iamPolicies!.failed.length === 0 ? " (none found)" : ""}`);
  console.error(`EBS Volumes:   ${evidence.ebsVolumes!.deleted.length} deleted, ${evidence.ebsVolumes!.failed.length} failed${evidence.ebsVolumes!.deleted.length === 0 && evidence.ebsVolumes!.failed.length === 0 ? " (none found)" : ""}`);
  console.error(`EKS Cluster:   ${evidence.cluster?.deleted ? "✓ DELETED" : "⚠️  NOT DELETED"}`);
  if (evidence.cluster && !evidence.cluster.deleted && evidence.cluster.error) {
    console.error(`               Error: ${evidence.cluster.error}`);
  }
  console.error(`S3 Bucket:     ${evidence.s3Bucket?.deleted ? "✓ DELETED" : evidence.s3Bucket ? "⚠️  NOT DELETED" : "N/A"}`);
  if (evidence.s3Bucket && !evidence.s3Bucket.deleted && evidence.s3Bucket.error) {
    console.error(`               Error: ${evidence.s3Bucket.error}`);
  }
  console.error("=".repeat(80));
  console.error("\nNote: Empty 'deleted' arrays mean no items were found in that category - this is normal.");
  console.error("      Cleanup is successful if the cluster and bucket (if configured) show as DELETED above.");
  
  if (status === "completed") {
    console.error("\n✓ Cleanup completed successfully");
  } else {
    console.error("\n⚠️  Cleanup completed with errors - check evidence for details");
    if (blockers.length > 0) {
      console.error("\nBlockers:");
      blockers.forEach(b => console.error(`  - ${b.message}`));
    }
  }
  
  return {
    status,
    evidence,
    blockers: blockers.length > 0 ? blockers : undefined,
  };
}
