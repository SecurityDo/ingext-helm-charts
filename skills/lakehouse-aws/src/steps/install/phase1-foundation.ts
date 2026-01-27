import { getCluster, createCluster, createNodegroup, createAddon, createPodIdentityAssociation, deleteCluster } from "../../tools/eksctl.js";
import { upgradeInstall } from "../../tools/helm.js";
import { aws, waitForClusterActive, describeCluster, listCloudFormationStacks, deleteCloudFormationStack, waitForStacksDeleted, describeCloudFormationStack } from "../../tools/aws.js";
import { getNodes, kubectl } from "../../tools/kubectl.js";
import { getRole, createRole, attachPolicy } from "../../tools/iam.js";

// Import helper functions for subnet dependency checking
const findNetworkInterfacesInSubnets = async (subnetIds: string[], profile: string, region: string) => {
  const res = await aws(
    ["ec2", "describe-network-interfaces", "--filters", `Name=subnet-id,Values=${subnetIds.join(",")}`, "--query", "NetworkInterfaces[*].NetworkInterfaceId", "--output", "text"],
    profile,
    region
  );
  if (!res.ok) return [];
  return res.stdout.trim().split(/\s+/).filter(Boolean);
};

const getRouteTableAssociations = async (subnetIds: string[], profile: string, region: string) => {
  const associations: Array<{ routeTableId: string; subnetId: string; associationId: string }> = [];
  for (const subnetId of subnetIds) {
    const res = await aws(
      ["ec2", "describe-route-tables", "--filters", `Name=association.subnet-id,Values=${subnetId}`, "--query", "RouteTables[*].[RouteTableId,Associations[?SubnetId==`'${subnetId}'`].RouteTableAssociationId]", "--output", "json"],
      profile,
      region
    );
    if (res.ok && res.stdout.trim()) {
      try {
        const data = JSON.parse(res.stdout);
        if (Array.isArray(data)) {
          for (const item of data) {
            if (Array.isArray(item) && item.length >= 2) {
              const routeTableId = item[0];
              const associationIds = item[1];
              if (Array.isArray(associationIds)) {
                for (const assocId of associationIds) {
                  if (assocId) {
                    associations.push({ routeTableId, subnetId, associationId: assocId });
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }
  return associations;
};

export type Phase1Evidence = {
  eks: {
    clusterName: string;
    existed: boolean;
    created: boolean;
    nodegroupCreated: boolean;
    kubeconfigUpdated: boolean;
    nodeCount: number;
    nodesReady: number;
    addonsInstalled: string[];
    storageClassInstalled: boolean;
  };
};

export async function runPhase1Foundation(env: Record<string, string>, options?: { verbose?: boolean }): Promise<{
  ok: boolean;
  evidence: Phase1Evidence;
  blockers: Array<{ code: string; message: string }>;
}> {
  const verbose = options?.verbose !== false;
  const blockers: Array<{ code: string; message: string }> = [];
  const evidence: Phase1Evidence = {
    eks: {
      clusterName: env.CLUSTER_NAME,
      existed: false,
      created: false,
      nodegroupCreated: false,
      kubeconfigUpdated: false,
      nodeCount: 0,
      nodesReady: 0,
      addonsInstalled: [],
      storageClassInstalled: false,
    },
  };

  const clusterName = env.CLUSTER_NAME;
  const region = env.AWS_REGION;
  const profile = env.AWS_PROFILE;
  const nodeType = env.NODE_TYPE;
  const nodeCount = parseInt(env.NODE_COUNT, 10);

  // Use verbose, namespaced nodegroup name to prevent collisions
  const nodegroupName = `ingext-${clusterName}-workers`;

  // 1. Check if cluster exists
  if (verbose) {
    process.stderr.write(`\n⏳ Checking if EKS cluster '${clusterName}' exists...\n`);
  }
  const clusterCheck = await getCluster(clusterName, region, profile);
  evidence.eks.existed = clusterCheck.exists;

  if (clusterCheck.exists) {
    if (verbose) process.stderr.write(`✓ Cluster '${clusterName}' already exists\n`);
    
    // Check if cluster is ACTIVE
    const clusterStatus = await describeCluster(clusterName, profile, region);
    if (clusterStatus.found && clusterStatus.status === "ACTIVE") {
      if (verbose) process.stderr.write(`✓ Cluster status: ACTIVE\n`);
      
      // Update kubeconfig if needed
      await aws(["eks", "update-kubeconfig", "--region", region, "--name", clusterName, "--alias", clusterName], profile, region);
      evidence.eks.kubeconfigUpdated = true;

      // Check if addons are installed and healthy
      const addonsRes = await aws(["eks", "list-addons", "--cluster-name", clusterName, "--region", region], profile, region);
      let addons: string[] = [];
      if (addonsRes.ok) {
        try {
          addons = JSON.parse(addonsRes.stdout).addons || [];
        } catch (e) { /* ignore */ }
      }
      
      const criticalAddons = ["vpc-cni", "kube-proxy", "coredns", "aws-ebs-csi-driver", "eks-pod-identity-agent"];
      const missingAddons = criticalAddons.filter(a => !addons.includes(a));
      
      if (missingAddons.length === 0) {
        if (verbose) process.stderr.write(`✓ All critical EKS addons are installed\n`);
        
        // Check EBS CSI Driver health
        const ebsPods = await kubectl(["get", "pods", "-n", "kube-system", "-l", "app.kubernetes.io/name=aws-ebs-csi-driver", "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        let ebsHealthy = false;
        if (ebsPods.ok) {
          try {
            const pods = JSON.parse(ebsPods.stdout).items || [];
            ebsHealthy = pods.length > 0 && pods.every((p: any) => p.status.phase === "Running" && !p.status.containerStatuses?.some((s: any) => s.state?.waiting?.reason === "CrashLoopBackOff"));
          } catch (e) { /* ignore */ }
        }
        
        if (ebsHealthy) {
          if (verbose) process.stderr.write(`✓ EBS CSI driver is healthy\n`);
          
          // Check for StorageClass
          const scCheck = await kubectl(["get", "sc", "gp3", "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
          if (scCheck.ok) {
            if (verbose) process.stderr.write(`✓ GP3 StorageClass is installed\n`);
            
            // Phase 1 is complete!
            evidence.eks.addonsInstalled = addons;
            evidence.eks.storageClassInstalled = true;
            evidence.eks.created = false;
            
            if (verbose) process.stderr.write(`\n✓ Phase 1 Foundation is already complete. Skipping to next phase...\n`);
            return { ok: true, evidence, blockers };
          }
        }
      }
    }
  }

  if (verbose && !clusterCheck.exists) {
    process.stderr.write(`✓ Cluster '${clusterName}' not found, will create\n`);
  }

  // 2. Create cluster if missing
  if (!clusterCheck.exists) {
    // Check for orphaned CloudFormation stacks from previous failed attempts
    if (verbose) {
      process.stderr.write(`\n⏳ Checking for orphaned CloudFormation stacks...\n`);
    }
    const stacksCheck = await listCloudFormationStacks(clusterName, profile, region);
    
    // Proactively add the cluster stack if it's not in the list but exists in a failed state
    if (stacksCheck.ok) {
      const clusterStackName = `eksctl-${clusterName}-cluster`;
      if (!stacksCheck.stacks.includes(clusterStackName)) {
        const clusterStackStatus = await describeCloudFormationStack(clusterStackName, profile, region);
        if (clusterStackStatus.ok && clusterStackStatus.status !== "DELETE_COMPLETE") {
          stacksCheck.stacks.push(clusterStackName);
        }
      }
    }
    
    if (stacksCheck.ok && stacksCheck.stacks.length > 0) {
      if (verbose) {
        console.error(`⚠️  Found ${stacksCheck.stacks.length} orphaned CloudFormation stack(s) from previous failed creation:`);
        stacksCheck.stacks.forEach(stack => console.error(`   - ${stack}`));
        console.error(`\n⏳ Cleaning up orphaned stacks...`);
      }
      
      // Sort stacks to delete cluster stack last (it may have dependencies)
      const sortedStacks = stacksCheck.stacks.sort((a, b) => {
        if (a.includes("-cluster")) return 1; // Cluster stack last
        if (b.includes("-cluster")) return -1;
        return a.localeCompare(b);
      });
      
      // Check initial status of stacks before deletion
      if (verbose && sortedStacks.length > 0) {
        console.error(`   Checking stack status before deletion...`);
        for (const stackName of sortedStacks) {
          const stackDetails = await describeCloudFormationStack(stackName, profile, region);
          if (stackDetails.ok) {
            const status = stackDetails.status || "UNKNOWN";
            if (status === "DELETE_IN_PROGRESS") {
              console.error(`   ⚠️  ${stackName} is already being deleted (${status})`);
              // Show resources that are still being deleted or failed
              if (stackDetails.resources && stackDetails.resources.length > 0) {
                const deletingResources = stackDetails.resources.filter((r: any) => 
                  r.Status === "DELETE_IN_PROGRESS" || r.Status === "DELETE_FAILED"
                );
                if (deletingResources.length > 0) {
                  console.error(`      Resources being deleted: ${deletingResources.map((r: any) => `${r.Resource} (${r.Status})`).join(", ")}`);
                }
                // Also show any resources that previously failed
                const failedResources = stackDetails.resources.filter((r: any) => r.Status === "DELETE_FAILED");
                if (failedResources.length > 0) {
                  console.error(`      Resources that previously failed: ${failedResources.map((r: any) => r.Resource).join(", ")}`);
                }
              }
            } else if (status === "DELETE_FAILED") {
              console.error(`   ⚠️  ${stackName} previously failed to delete (${status})`);
              if (stackDetails.resources && stackDetails.resources.length > 0) {
                const failedResources = stackDetails.resources.filter((r: any) => r.Status === "DELETE_FAILED");
                if (failedResources.length > 0) {
                  console.error(`      Resources that failed: ${failedResources.map((r: any) => r.Resource).join(", ")}`);
                }
                // Show all non-deleted resources
                const remainingResources = stackDetails.resources.filter((r: any) => 
                  r.Status !== "DELETE_COMPLETE"
                );
                if (remainingResources.length > 0) {
                  console.error(`      Resources still present: ${remainingResources.map((r: any) => `${r.Resource} (${r.Type}, ${r.Status})`).join(", ")}`);
                }
              }
            } else {
              console.error(`   ℹ️  ${stackName} status: ${status}`);
            }
          }
        }
      }
      
      // Check which stacks need deletion vs are already being deleted
      const stacksToDelete: string[] = [];
      const stacksAlreadyDeleting: string[] = [];
      const stacksDeleteFailed: string[] = []; // Stacks in DELETE_FAILED need special handling
      
      for (const stackName of sortedStacks) {
        const stackDetails = await describeCloudFormationStack(stackName, profile, region);
        if (stackDetails.ok) {
          const status = stackDetails.status || "UNKNOWN";
          if (status === "DELETE_IN_PROGRESS") {
            stacksAlreadyDeleting.push(stackName);
            if (verbose) {
              console.error(`   ℹ️  ${stackName} is already being deleted (${status})`);
            }
          } else if (status === "DELETE_FAILED") {
            // Stacks in DELETE_FAILED need immediate dependency cleanup - don't wait!
            stacksDeleteFailed.push(stackName);
            if (verbose) {
              console.error(`   ⚠️  ${stackName} previously failed to delete (${status})`);
              if (stackDetails.resources && stackDetails.resources.length > 0) {
                const failedResources = stackDetails.resources.filter((r: any) => r.Status === "DELETE_FAILED");
                if (failedResources.length > 0) {
                  console.error(`      Resources that failed: ${failedResources.map((r: any) => r.Resource).join(", ")}`);
                }
                const remainingResources = stackDetails.resources.filter((r: any) => 
                  r.Status !== "DELETE_COMPLETE"
                );
                if (remainingResources.length > 0) {
                  console.error(`      Resources still present: ${remainingResources.map((r: any) => `${r.Resource} (${r.Type}, ${r.Status})`).join(", ")}`);
                }
              }
            }
          } else {
            stacksToDelete.push(stackName);
          }
        } else {
          // If we can't check status, try to delete it
          stacksToDelete.push(stackName);
        }
      }
      
      // Handle DELETE_FAILED stacks FIRST - they need immediate dependency cleanup
      if (stacksDeleteFailed.length > 0) {
        if (verbose) {
          console.error(`   ⚠️  Found ${stacksDeleteFailed.length} stack(s) in DELETE_FAILED state - cleaning up dependencies and retrying...`);
        }
        
        for (const stackName of stacksDeleteFailed) {
          if (verbose) {
            console.error(`   ⏳ Cleaning up dependencies for ${stackName}...`);
          }
          
          // Clean up dependencies (detach Internet Gateway, disassociate route tables, delete network interfaces)
          await deleteCloudFormationStack(stackName, profile, region, { 
            cleanupDependencies: true 
          });
          
          // Wait a moment for cleanup to propagate
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Check for termination protection
          const currentDetails = await describeCloudFormationStack(stackName, profile, region);
          if (currentDetails.ok && currentDetails.terminationProtection) {
            if (verbose) {
              console.error(`   ⏳ Disabling termination protection for ${stackName}...`);
            }
            await aws(
              ["cloudformation", "update-termination-protection", "--stack-name", stackName, "--no-enable-termination-protection"],
              profile,
              region
            );
          }
          
          // Retry deletion
          if (verbose) {
            console.error(`   ⏳ Retrying deletion of ${stackName}...`);
          }
          await deleteCloudFormationStack(stackName, profile, region);
          
          // After retry, add to wait list
          stacksToDelete.push(stackName);
        }
      }
      
      // Delete stacks that aren't already being deleted
      if (stacksToDelete.length > 0) {
        if (verbose) {
          console.error(`   Initiating deletion of ${stacksToDelete.length} stack(s) in parallel...`);
        }
        
        const deletePromises = stacksToDelete.map(async (stackName) => {
          // Check if stack is in DELETE_FAILED state - if so, try to clean up dependencies first
          const stackDetails = await describeCloudFormationStack(stackName, profile, region);
          const isDeleteFailed = stackDetails.ok && stackDetails.status === "DELETE_FAILED";
          
          if (isDeleteFailed) {
            if (verbose) {
              console.error(`   ⚠️  Stack ${stackName} is in DELETE_FAILED state.`);
              
              // Show WHY it failed - get detailed resource info
              const failedDetails = await describeCloudFormationStack(stackName, profile, region);
              if (failedDetails.ok && failedDetails.resources) {
                const failedSubnets = failedDetails.resources.filter((r: any) => 
                  r.Type === "AWS::EC2::Subnet" && r.Status === "DELETE_FAILED"
                );
                
                if (failedSubnets.length > 0) {
                  console.error(`   🔍 Found ${failedSubnets.length} subnet(s) in DELETE_FAILED:`);
                  for (const subnet of failedSubnets) {
                    const subnetId = subnet.PhysicalResourceId || subnet.PhysicalId;
                    console.error(`      - ${subnet.LogicalResourceId || subnet.Resource} (${subnetId || "ID unknown"})`);
                    
                    // Check what's blocking it
                    if (subnetId) {
                      const eniIds = await findNetworkInterfacesInSubnets([subnetId], profile, region);
                      const routeAssocs = await getRouteTableAssociations([subnetId], profile, region);
                      const blockers: string[] = [];
                      if (eniIds.length > 0) blockers.push(`${eniIds.length} network interface(s)`);
                      if (routeAssocs.length > 0) blockers.push(`${routeAssocs.length} route table association(s)`);
                      
                      if (blockers.length > 0) {
                        console.error(`        Blocked by: ${blockers.join(", ")}`);
                      } else {
                        console.error(`        Blocked by: Unknown dependency (checking NAT Gateways, VPC Endpoints...)`);
                      }
                    }
                  }
                }
              }
              
              console.error(`   ⏳ Forcefully cleaning up ALL dependencies...`);
            }
            
            // For DELETE_FAILED stacks, we MUST clean up dependencies first
            // This will detach Internet Gateways, disassociate route tables, delete network interfaces, etc.
            const cleanupResult = await deleteCloudFormationStack(stackName, profile, region, { 
              cleanupDependencies: true 
            });
            
            // Wait longer for cleanup to propagate (subnets can take time)
            await new Promise(resolve => setTimeout(resolve, 15000));
            
            // Now retry deletion
            if (verbose) {
              console.error(`   ⏳ Retrying deletion of ${stackName} after dependency cleanup...`);
            }
            
            // Check for termination protection before retrying
            const currentDetails = await describeCloudFormationStack(stackName, profile, region);
            if (currentDetails.ok && currentDetails.terminationProtection) {
              if (verbose) {
                console.error(`   ⚠️  Stack ${stackName} has termination protection enabled`);
                console.error(`   ⏳ Disabling termination protection...`);
              }
              await aws(
                ["cloudformation", "update-termination-protection", "--stack-name", stackName, "--no-enable-termination-protection"],
                profile,
                region
              );
            }
            
            // Retry deletion
            return await deleteCloudFormationStack(stackName, profile, region);
          } else {
            // Normal deletion for stacks not in DELETE_FAILED
            const deleteResult = await deleteCloudFormationStack(stackName, profile, region);
            
            if (!deleteResult.ok) {
              // Check for termination protection - need to disable it first
              if (deleteResult.stderr.includes("TerminationProtection is enabled")) {
                if (verbose) {
                  console.error(`   ⚠️  Stack ${stackName} has termination protection enabled`);
                  console.error(`   ⏳ Disabling termination protection and retrying...`);
                }
                // Disable termination protection
                const disableResult = await aws(
                  ["cloudformation", "update-termination-protection", "--stack-name", stackName, "--no-enable-termination-protection"],
                  profile,
                  region
                );
                if (disableResult.ok) {
                  // Retry deletion
                  return await deleteCloudFormationStack(stackName, profile, region);
                }
              }
              // If stack is already being deleted or doesn't exist, that's okay
              if (deleteResult.stderr.includes("does not exist") || 
                  deleteResult.stderr.includes("is in DELETE_IN_PROGRESS")) {
                return { ok: true, stderr: "", stdout: "" }; // Treat as success
              }
            }
            return deleteResult;
          }
        });
        
        await Promise.all(deletePromises);
      }
      
      // Combine all stacks (those we deleted and those already deleting) for waiting
      // Note: stacks that were in DELETE_FAILED are now retried, so we wait for them too
      const allStacksToWaitFor = [...stacksToDelete, ...stacksAlreadyDeleting];
      
      // Wait for all stacks to be deleted in parallel (polling together)
      if (verbose) {
        if (stacksAlreadyDeleting.length > 0 && stacksToDelete.length > 0) {
          console.error(`   ⏳ Waiting for ${allStacksToWaitFor.length} stack(s) to be deleted (${stacksAlreadyDeleting.length} already in progress, ${stacksToDelete.length} just initiated)...`);
        } else if (stacksAlreadyDeleting.length > 0) {
          console.error(`   ⏳ Waiting for ${stacksAlreadyDeleting.length} stack(s) that are already being deleted (this may take a few minutes)...`);
        } else {
          console.error(`   ⏳ Waiting for stacks to be deleted (this may take a few minutes)...`);
        }
      }
      
      const waitResult = await waitForStacksDeleted(allStacksToWaitFor, profile, region, 20); // 20 minute timeout for cluster stacks
      
      if (waitResult.ok) {
        if (verbose) {
          console.error(`   ✓ All ${waitResult.deleted.length} orphaned stacks cleaned up\n`);
        }
      } else {
        // Check if any stacks failed during deletion
        if (waitResult.failed && waitResult.failed.length > 0) {
          if (verbose) {
            console.error(`\n   ⚠️  Stack(s) failed during deletion:`);
            for (const failed of waitResult.failed) {
              console.error(`      - ${failed.name}`);
              if (failed.resources.length > 0) {
                console.error(`        Resources that failed: ${failed.resources.join(", ")}`);
              }
            }
            console.error(`   ⏳ Attempting to clean up dependencies and retry deletion...`);
          }
          
          // Try dependency cleanup and retry deletion for failed stacks
          for (const failedStack of waitResult.failed) {
            const stackDetails = await describeCloudFormationStack(failedStack.name, profile, region);
            if (stackDetails.ok && stackDetails.status === "DELETE_FAILED") {
              if (verbose) {
                console.error(`   ⏳ Cleaning up dependencies for ${failedStack.name}...`);
              }
              
              // Try dependency cleanup
              const retryResult = await deleteCloudFormationStack(failedStack.name, profile, region, {
                cleanupDependencies: true
              });
              
              if (retryResult.ok) {
                if (verbose) {
                  console.error(`   ✓ Retried deletion for ${failedStack.name} after dependency cleanup`);
                }
              } else {
                if (verbose) {
                  console.error(`   ⚠️  Retry deletion failed: ${retryResult.stderr.substring(0, 200)}`);
                }
              }
            }
          }
          
          // Wait a bit more for retried deletions
          if (verbose) {
            console.error(`   ⏳ Waiting additional 10 minutes for retried deletions...`);
          }
          const retryWaitResult = await waitForStacksDeleted(waitResult.failed.map(f => f.name), profile, region, 10);
          
          if (retryWaitResult.ok) {
            if (verbose) {
              console.error(`   ✓ Failed stacks cleaned up after dependency cleanup\n`);
            }
            // Continue with cluster creation
          } else {
            // Still failed after retry - update remaining list
            waitResult.remaining = retryWaitResult.remaining;
            if (verbose) {
              console.error(`   ⚠️  Stacks still failed after dependency cleanup attempt\n`);
            }
          }
        }
        // Check the status of remaining stacks and get detailed diagnostics
        const remainingStatuses: string[] = [];
        const diagnostics: string[] = [];
        
        for (const stackName of waitResult.remaining) {
          const stackDetails = await describeCloudFormationStack(stackName, profile, region);
          
          if (stackDetails.ok) {
            const status = stackDetails.status || "UNKNOWN";
            remainingStatuses.push(`${stackName} (${status})`);
            
            // Add diagnostics for problematic stacks
            if (status === "DELETE_FAILED") {
              diagnostics.push(`\n   Stack ${stackName} failed to delete:`);
              if (stackDetails.resources && stackDetails.resources.length > 0) {
                diagnostics.push(`   Resources preventing deletion:`);
                stackDetails.resources.forEach((r: any) => {
                  diagnostics.push(`     - ${r.Resource} (${r.Type}): ${r.Status}`);
                });
              }
              if (stackDetails.events && stackDetails.events.length > 0) {
                diagnostics.push(`   Recent errors:`);
                stackDetails.events.forEach((e: any) => {
                  if (e.Reason) {
                    diagnostics.push(`     - ${e.Resource}: ${e.Reason}`);
                  }
                });
              }
            } else if (status === "DELETE_IN_PROGRESS") {
              // Check if it's been stuck in DELETE_IN_PROGRESS for a while
              if (stackDetails.resources && stackDetails.resources.length > 0) {
                const stuckResources = stackDetails.resources.filter((r: any) => 
                  r.Status === "DELETE_FAILED" || r.Status === "DELETE_IN_PROGRESS"
                );
                if (stuckResources.length > 0) {
                  diagnostics.push(`\n   Stack ${stackName} is stuck deleting:`);
                  stuckResources.forEach((r: any) => {
                    diagnostics.push(`     - ${r.Resource} (${r.Type}): ${r.Status}`);
                  });
                }
              }
            }
          } else {
            remainingStatuses.push(`${stackName} (UNKNOWN - ${stackDetails.error})`);
          }
        }
        
        if (verbose) {
          console.error(`   ⚠️  ${waitResult.remaining.length} stack(s) still remain:`);
          remainingStatuses.forEach(s => console.error(`      - ${s}`));
          console.error(`   ⚠️  ${waitResult.deleted.length} stack(s) were successfully deleted`);
          
          if (diagnostics.length > 0) {
            diagnostics.forEach(d => console.error(d));
          }
          
          console.error(`\n   ⚠️  Cannot proceed with cluster creation while stacks still exist.`);
          if (remainingStatuses.some(s => s.includes("DELETE_IN_PROGRESS"))) {
            console.error(`   The remaining stack(s) are being deleted. This can take 10-15 minutes.`);
            console.error(`   If they remain stuck, check AWS Console for resource dependencies.`);
          } else if (remainingStatuses.some(s => s.includes("DELETE_FAILED"))) {
            console.error(`   The remaining stack(s) failed to delete. Check the diagnostics above.`);
            
            // If the cluster stack failed to delete, try using eksctl delete cluster
            // which might handle dependencies better (even if cluster doesn't exist, it can clean up stacks)
            const clusterStack = waitResult.remaining.find(s => s.includes("-cluster"));
            if (clusterStack) {
              console.error(`\n   ⏳ Attempting to use eksctl delete cluster to clean up dependencies...`);
              console.error(`   (This works even if the cluster doesn't exist - it cleans up CloudFormation stacks)`);
              
              const eksctlDeleteResult = await deleteCluster(clusterName, region, profile);
              
              if (eksctlDeleteResult.ok) {
                console.error(`   ✓ eksctl delete cluster completed. Waiting for stacks to be cleaned up...`);
                
                // Wait for stacks to be deleted (eksctl should clean them up)
                const recheckResult = await waitForStacksDeleted(waitResult.remaining, profile, region, 5); // 5 more minutes
                
                if (recheckResult.ok) {
                  console.error(`   ✓ All CloudFormation stacks cleaned up by eksctl\n`);
                  // Continue with cluster creation
                } else {
                  console.error(`   ⚠️  Some stacks still remain after eksctl delete: ${recheckResult.remaining.join(", ")}`);
                  console.error(`   Proceeding with cluster creation - eksctl should handle the conflict.\n`);
                  // Continue anyway - eksctl create might be able to handle existing stacks
                }
              } else {
                // Check if error is because cluster doesn't exist (that's okay, we're trying to clean up stacks)
                const errorText = eksctlDeleteResult.stderr || eksctlDeleteResult.stdout || "";
                if (errorText.includes("not found") || errorText.includes("does not exist")) {
                  console.error(`   ℹ️  Cluster doesn't exist (expected). eksctl may still clean up stacks.`);
                  console.error(`   Proceeding with cluster creation - eksctl should handle the stack conflict.\n`);
                  // Continue - eksctl create cluster might be able to reuse or clean up the failed stack
                } else {
                  console.error(`   ⚠️  eksctl delete cluster failed: ${errorText.substring(0, 200)}`);
                  console.error(`   You may need to manually delete resources in AWS Console.`);
                  console.error(`   Or try: eksctl delete cluster --region ${region} --name ${clusterName} --wait\n`);
                }
              }
            } else {
              console.error(`   You may need to manually delete resources in AWS Console.`);
            }
          } else {
            console.error(`   The remaining stack(s) may be stuck. You may need to manually delete them from AWS Console.`);
          }
          console.error(``);
        }
        
        // Final check - if cluster is gone and we've tried eksctl, proceed with creation
        // eksctl create cluster should be able to handle existing stacks (it will either reuse or fail with a clear error)
        const finalClusterCheck = await describeCluster(clusterName, profile, region);
        if (!finalClusterCheck.found && finalClusterCheck.status === "NOT_FOUND") {
          if (verbose) {
            console.error(`   ℹ️  Cluster doesn't exist. Proceeding with cluster creation.`);
            console.error(`   If stack conflicts occur, eksctl will provide clear error messages.\n`);
          }
          // Continue with cluster creation - eksctl will handle any conflicts
        } else if (waitResult.remaining.length > 0) {
          // Stacks still exist but we've tried cleanup - let eksctl create handle it
          if (verbose) {
            console.error(`   ℹ️  Some stacks still exist, but proceeding with cluster creation.`);
            console.error(`   eksctl create cluster will either reuse them or provide clear error messages.\n`);
          }
          // Continue - eksctl create might be able to handle the existing stack
        } else {
          // This shouldn't happen, but just in case
          blockers.push({
            code: "CLOUDFORMATION_STACKS_REMAINING",
            message: `CloudFormation stacks still exist after cleanup: ${waitResult.remaining.join(", ")}. ` +
                     `Status: ${remainingStatuses.join("; ")}. ` +
                     (diagnostics.length > 0 ? `\n${diagnostics.join("\n")}` : "") +
                     `\nWait a few minutes if stacks are in DELETE_IN_PROGRESS, or manually delete them from AWS Console.`,
          });
          return { ok: false, evidence, blockers };
        }
      }
    } else if (stacksCheck.ok) {
      if (verbose) {
        process.stderr.write(`✓ No orphaned stacks found\n`);
      }
    }
    
    if (verbose) {
      console.error(`\n⏳ Creating EKS cluster '${clusterName}' (this takes ~15 minutes)...`);
      console.error(`   Region: ${region}`);
      console.error(`   Node Type: ${nodeType}`);
      console.error(`   Node Count: ${nodeCount}`);
    }
    const createResult = await createCluster({
      name: clusterName,
      region,
      profile,
      version: "1.34",
      nodegroupName,
      nodeType,
      nodeCount,
    });

    if (!createResult.ok) {
      // Check if eksctl is not found (exit code 127 or "Command not found" message)
      const exitCode = (createResult as any).exitCode ?? (createResult.ok ? 0 : 1);
      const isCommandNotFound = exitCode === 127 || 
                                 createResult.stderr.includes("Command not found") ||
                                 createResult.stderr.includes("eksctl not found") ||
                                 createResult.stderr.includes("command not found: eksctl");
      
      // Check if CloudFormation stack already exists (leftover from failed creation)
      const hasCloudFormationConflict = createResult.stderr.includes("AlreadyExistsException") ||
                                        createResult.stderr.includes("Stack") && createResult.stderr.includes("already exists") ||
                                        createResult.stdout.includes("AlreadyExistsException");
      
      if (isCommandNotFound) {
      const errorMsg = `eksctl is not installed.\n\n` +
                      `To fix this, choose one option:\n` +
                      `  1. Install eksctl: https://eksctl.io/installation/\n` +
                      `  2. Use Docker mode: lakehouse install --approve true --exec docker\n\n` +
                      `Docker mode runs eksctl inside a Docker container, so you don't need to install it locally.`;
      if (verbose) {
        console.error(`\n❌ ${errorMsg}`);
      }
      blockers.push({
        code: "EKSCTL_NOT_FOUND",
        message: errorMsg,
      });
    } else if (hasCloudFormationConflict) {
      if (verbose) {
        console.error(`\n⚠️  CloudFormation conflict detected: Stack 'eksctl-${clusterName}-cluster' already exists.`);
        console.error(`   ⏳ Automatically cleaning up the conflicting stack and retrying...`);
      }
      
      // Attempt to clean up the conflicting stack
      const cleanupResult = await deleteCloudFormationStack(`eksctl-${clusterName}-cluster`, profile, region, { 
        cleanupDependencies: true 
      });
      
      if (cleanupResult.ok) {
        if (verbose) console.error(`   ⏳ Waiting for stack deletion to complete...`);
        const waitResult = await waitForStacksDeleted([`eksctl-${clusterName}-cluster`], profile, region, 15);
        
        if (waitResult.ok) {
          if (verbose) console.error(`   ✓ Conflicting stack cleaned up. Retrying cluster creation...`);
          
          // Retry cluster creation
          const retryResult = await createCluster({
            name: clusterName,
            region,
            profile,
            version: "1.34",
            nodegroupName,
            nodeType,
            nodeCount,
          });
          
          if (retryResult.ok) {
            evidence.eks.created = true;
            if (verbose) {
              console.error(`✓ Cluster creation retry command sent`);
              console.error(`⏳ Cluster creation in progress (this takes ~15 minutes)...`);
            }
            // Continue to wait for ACTIVE
          } else {
            blockers.push({
              code: "EKS_CLUSTER_CREATE_RETRY_FAILED",
              message: `Failed to create EKS cluster after cleanup: ${retryResult.stderr}`,
            });
            return { ok: false, evidence, blockers };
          }
        } else {
          blockers.push({
            code: "CLOUDFORMATION_CLEANUP_FAILED",
            message: `Failed to clean up conflicting CloudFormation stack: ${waitResult.remaining.join(", ")}`,
          });
          return { ok: false, evidence, blockers };
        }
      } else {
        blockers.push({
          code: "CLOUDFORMATION_DELETE_INIT_FAILED",
          message: `Failed to initiate deletion of conflicting CloudFormation stack: ${cleanupResult.stderr}`,
        });
        return { ok: false, evidence, blockers };
      }
    } else {
        const errorPreview = createResult.stderr.length > 300 
          ? createResult.stderr.substring(0, 300) + "..."
          : createResult.stderr;
        if (verbose) console.error(`❌ Failed to create cluster: ${errorPreview}`);
        blockers.push({
          code: "EKS_CLUSTER_CREATE_FAILED",
          message: `Failed to create EKS cluster: ${createResult.stderr}`,
        });
      }
      return { ok: false, evidence, blockers };
    }
    evidence.eks.created = true;
    if (verbose) {
      console.error(`✓ Cluster creation command sent`);
      console.error(`⏳ Cluster creation in progress (this takes ~15 minutes)...`);
      console.error(`   You can monitor progress in AWS Console or wait here.`);
    }
  }
  
  // 2b. Wait for cluster to be ACTIVE (whether we created it or it already existed)
  if (verbose) console.error(`\n⏳ Checking cluster status...`);
  const clusterStatus = await describeCluster(clusterName, profile, region);
  if (!clusterStatus.found) {
    blockers.push({
      code: "CLUSTER_NOT_FOUND",
      message: `Cluster '${clusterName}' not found`,
    });
    return { ok: false, evidence, blockers };
  }
  
  if (clusterStatus.status !== "ACTIVE") {
    // Cluster exists but not ACTIVE yet - wait for it
    if (verbose) {
      console.error(`⏳ Cluster status: ${clusterStatus.status}`);
      console.error(`   Waiting for cluster to become ACTIVE...`);
    }
    const waitResult = await waitForClusterActive(clusterName, profile, region, { 
      maxWaitMinutes: 20,
      verbose 
    });
    
    if (!waitResult.ok) {
      if (verbose) console.error(`❌ Cluster did not become ACTIVE: ${waitResult.error}`);
      blockers.push({
        code: "CLUSTER_NOT_READY",
        message: `Cluster '${clusterName}' is not ACTIVE: ${waitResult.status}. ${waitResult.error}`,
      });
      return { ok: false, evidence, blockers };
    }
  } else if (verbose) {
    console.error(`✓ Cluster is already ACTIVE`);
  }

  // 3. Update kubeconfig (cluster is now ACTIVE)
  if (verbose) console.error(`\n⏳ Updating kubeconfig...`);
  const kubeconfigResult = await aws(
    ["eks", "update-kubeconfig", "--region", region, "--name", clusterName, "--alias", clusterName],
    profile,
    region
  );
  evidence.eks.kubeconfigUpdated = kubeconfigResult.ok;
  if (!kubeconfigResult.ok) {
    if (verbose) console.error(`❌ Failed to update kubeconfig: ${kubeconfigResult.stderr.substring(0, 200)}`);
    blockers.push({
      code: "KUBECONFIG_UPDATE_FAILED",
      message: `Failed to update kubeconfig: ${kubeconfigResult.stderr}`,
    });
    return { ok: false, evidence, blockers };
  } else if (verbose) {
    console.error(`✓ Kubeconfig updated`);
  }

  // Verify nodes exist and are ready
  if (kubeconfigResult.ok) {
    const nodesCheck = await getNodes({
      AWS_PROFILE: profile,
      AWS_REGION: region,
    });

    if (nodesCheck.ok) {
      try {
        const nodesData = JSON.parse(nodesCheck.stdout);
        const nodes = nodesData.items || [];
        evidence.eks.nodeCount = nodes.length;

        // Count ready nodes
        for (const node of nodes) {
          const readyCondition = node.status?.conditions?.find((c: any) => c.type === "Ready");
          if (readyCondition && readyCondition.status === "True") {
            evidence.eks.nodesReady++;
          }
        }

        // Handle zero nodes scenario
        if (nodes.length === 0) {
          if (evidence.eks.created) {
            // Cluster was just created but no nodes - this is an error
            blockers.push({
              code: "NO_NODES_CREATED",
              message: "EKS cluster created but no worker nodes found. Check eksctl logs.",
            });
          } else if (evidence.eks.existed) {
            // Cluster existed with no nodes - self-heal by creating nodegroup
            const nodegroupResult = await createNodegroup({
              clusterName,
              nodegroupName,
              nodeType,
              nodeCount,
              region,
              profile,
            });

            evidence.eks.nodegroupCreated = nodegroupResult.ok;

            if (!nodegroupResult.ok) {
              blockers.push({
                code: "NODEGROUP_CREATE_FAILED",
                message: `Failed to create nodegroup: ${nodegroupResult.stderr}`,
              });
            } else {
              // Wait for nodes to be ready (nodegroup creation is async)
              await new Promise(resolve => setTimeout(resolve, 60000)); // 60s wait

              // Re-check nodes after nodegroup creation
              const nodesRecheck = await getNodes({
                AWS_PROFILE: profile,
                AWS_REGION: region,
              });

              if (nodesRecheck.ok) {
                try {
                  const recheckData = JSON.parse(nodesRecheck.stdout);
                  const recheckNodes = recheckData.items || [];
                  evidence.eks.nodeCount = recheckNodes.length;
                  evidence.eks.nodesReady = 0;

                  // Count ready nodes after nodegroup creation
                  for (const node of recheckNodes) {
                    const readyCondition = node.status?.conditions?.find((c: any) => c.type === "Ready");
                    if (readyCondition && readyCondition.status === "True") {
                      evidence.eks.nodesReady++;
                    }
                  }
                } catch (e) {
                  // Ignore JSON parse errors
                }
              }
            }
          }
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }
  }

  // 4. Install addon: vpc-cni (required for node networking)
  if (verbose) console.error(`\n⏳ Installing EKS addons...`);
  if (verbose) console.error(`   Installing vpc-cni...`);
  const vpcCniAddon = await createAddon(clusterName, "vpc-cni", region, profile);
  if (vpcCniAddon.ok) {
    evidence.eks.addonsInstalled.push("vpc-cni");
    if (verbose) console.error(`   ✓ vpc-cni installed`);
  } else if (verbose) {
    console.error(`   ⚠️  vpc-cni may already exist`);
  }

  // 5. Install addon: kube-proxy (required for service networking and API access)
  if (verbose) console.error(`   Installing kube-proxy...`);
  const kubeProxyAddon = await createAddon(clusterName, "kube-proxy", region, profile);
  if (kubeProxyAddon.ok) {
    evidence.eks.addonsInstalled.push("kube-proxy");
    if (verbose) console.error(`   ✓ kube-proxy installed`);
  } else if (verbose) {
    console.error(`   ⚠️  kube-proxy may already exist`);
  }

  // 6. Install addon: coredns (required for DNS resolution and API access)
  if (verbose) console.error(`   Installing coredns...`);
  const corednsAddon = await createAddon(clusterName, "coredns", region, profile);
  if (corednsAddon.ok) {
    evidence.eks.addonsInstalled.push("coredns");
    if (verbose) console.error(`   ✓ coredns installed`);
  } else if (verbose) {
    console.error(`   ⚠️  coredns may already exist`);
  }

  // 7. Install addon: eks-pod-identity-agent
  const podIdentityAddon = await createAddon(clusterName, "eks-pod-identity-agent", region, profile);
  if (podIdentityAddon.ok) {
    evidence.eks.addonsInstalled.push("eks-pod-identity-agent");
  }

  // 8. Install EBS CSI Driver addon FIRST (this creates the service account)
  if (verbose) console.error(`\n⏳ Installing EBS CSI driver addon...`);
  const ebsCsiAddon = await createAddon(clusterName, "aws-ebs-csi-driver", region, profile);
  if (ebsCsiAddon.ok) {
    evidence.eks.addonsInstalled.push("aws-ebs-csi-driver");
    if (verbose) console.error(`✓ EBS CSI driver addon installed`);
  } else {
    if (verbose) console.error(`⚠️  EBS CSI driver addon may already exist`);
  }

  // 9. Create IAM role for EBS CSI driver
  if (verbose) console.error(`⏳ Creating IAM role for EBS CSI driver...`);
  
  const ebsRoleName = `AmazonEKS_EBS_CSI_DriverRole_${clusterName}`;
  
  // First check if role exists
  const roleCheck = await getRole(ebsRoleName, profile);
  
  if (!roleCheck.ok) {
    // Role doesn't exist, create it
    // Get AWS account ID for the trust policy
    const { getAccountId } = await import("../../tools/iam.js");
    const accountId = await getAccountId(profile, region);
    
    if (!accountId) {
      if (verbose) console.error(`❌ Failed to get AWS account ID`);
      blockers.push({
        code: "AWS_ACCOUNT_ID_FAILED",
        message: "Failed to get AWS account ID for IAM role creation",
      });
      return { ok: false, evidence, blockers };
    }
    
    // Create trust policy for pod identity
    const trustPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: {
            Service: "pods.eks.amazonaws.com"
          },
          Action: [
            "sts:AssumeRole",
            "sts:TagSession"
          ]
        }
      ]
    };
    
    const roleResult = await createRole(
      ebsRoleName,
      JSON.stringify(trustPolicy),
      profile
    );
    
    if (!roleResult.ok && !roleResult.stderr.includes("EntityAlreadyExists")) {
      if (verbose) console.error(`⚠️  Failed to create EBS CSI driver role: ${roleResult.stderr.substring(0, 200)}`);
      // Continue anyway - maybe role exists but getRole failed
    } else {
      if (verbose) console.error(`✓ Created IAM role: ${ebsRoleName}`);
    }
    
    // Attach the EBS CSI Driver policy
    const policyArn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy";
    const attachResult = await attachPolicy(ebsRoleName, policyArn, profile);
    
    if (!attachResult.ok && !attachResult.stderr.includes("already attached")) {
      if (verbose) console.error(`⚠️  Failed to attach policy to role: ${attachResult.stderr.substring(0, 200)}`);
    } else {
      if (verbose) console.error(`✓ Attached policy: AmazonEBSCSIDriverPolicy`);
    }
  } else {
    if (verbose) console.error(`✓ IAM role already exists: ${ebsRoleName}`);
  }

  // 10. NOW create pod identity association (service account exists now)
  if (verbose) console.error(`⏳ Creating pod identity association for EBS CSI driver...`);
  const ebsPodIdentity = await createPodIdentityAssociation({
    cluster: clusterName,
    namespace: "kube-system",
    serviceAccountName: "ebs-csi-controller-sa",
    roleName: ebsRoleName,
    permissionPolicyArns: "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
    region,
    profile,
  });
  
  // Verify association exists
  const associationCheck = await aws(
    ["eks", "list-pod-identity-associations", "--cluster-name", clusterName, "--region", region],
    profile,
    region
  );
  
  let associationFound = false;
  if (associationCheck.ok) {
    try {
      const data = JSON.parse(associationCheck.stdout);
      associationFound = data.associations?.some((a: any) => 
        a.namespace === "kube-system" && a.serviceAccount === "ebs-csi-controller-sa"
      );
    } catch (e) { /* ignore */ }
  }

  if (ebsPodIdentity.ok || associationFound) {
    if (verbose) console.error(`✓ Pod identity association verified`);
    
    // 11. Restart EBS CSI controller pods to pick up the new IAM role
    if (verbose) console.error(`⏳ Restarting EBS CSI controller pods to apply new IAM role...`);
    const restartResult = await kubectl(
      ["delete", "pods", "-n", "kube-system", "-l", "app=ebs-csi-controller"],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );
    
    if (verbose) console.error(`✓ Controller pods restarted`);
    
    // Wait for new pods to start and verify health
    if (verbose) console.error(`⏳ Waiting for EBS CSI controllers to stabilize...`);
    let healthy = false;
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 15000));
      const healthCheck = await kubectl(
        ["get", "pods", "-n", "kube-system", "-l", "app.kubernetes.io/name=aws-ebs-csi-driver,app.kubernetes.io/component=csi-controller", "-o", "json"],
        { AWS_PROFILE: profile, AWS_REGION: region }
      );
      if (healthCheck.ok) {
        try {
          const podsData = JSON.parse(healthCheck.stdout);
          const pods = podsData.items || [];
          if (pods.length > 0 && pods.every((p: any) => p.status.phase === "Running")) {
            healthy = true;
            break;
          }
        } catch (e) { /* ignore */ }
      }
    }
    
    if (healthy) {
      if (verbose) console.error(`✓ EBS CSI driver is healthy`);
    } else {
      if (verbose) console.error(`⚠️  EBS CSI driver still stabilizing...`);
    }
  } else {
    const errorMsg = ebsPodIdentity.raw?.stderr || "Unknown error";
    if (verbose) console.error(`⚠️  Failed to create pod identity association: ${errorMsg.substring(0, 200)}`);
  }

  // 12. Install StorageClass via Helm
  if (verbose) console.error(`\n⏳ Installing GP3 StorageClass...`);
  const storageClassResult = await upgradeInstall(
    "ingext-aws-gp3",
    "oci://public.ecr.aws/ingext/ingext-aws-gp3",
    "kube-system",
    { "storageClass.isDefaultClass": "true" },
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  evidence.eks.storageClassInstalled = storageClassResult.ok;
  if (!storageClassResult.ok) {
    if (verbose) {
      console.error(`⚠️  StorageClass installation failed (non-blocking): ${storageClassResult.stderr.substring(0, 200)}`);
      console.error(`   This may be due to ECR authentication. Continuing with installation...`);
    }
    // Don't block on StorageClass - it's not critical for subsequent phases
    // The default gp2 storage class will work, or user can install manually later
  } else if (verbose) {
    console.error(`✓ StorageClass installed`);
  }

  // 11. Install addon: aws-mountpoint-s3-csi-driver (via AWS CLI, not eksctl)
  if (verbose) console.error(`   Installing aws-mountpoint-s3-csi-driver...`);
  const s3CsiResult = await aws(
    ["eks", "create-addon", "--cluster-name", clusterName, "--addon-name", "aws-mountpoint-s3-csi-driver", "--region", region],
    profile,
    region
  );
  // Ignore errors if already exists (idempotency)
  if (s3CsiResult.ok || s3CsiResult.stderr.includes("already exists")) {
    evidence.eks.addonsInstalled.push("aws-mountpoint-s3-csi-driver");
    if (verbose) console.error(`   ✓ aws-mountpoint-s3-csi-driver installed`);
  } else if (verbose) {
    console.error(`   ⚠️  aws-mountpoint-s3-csi-driver may already exist`);
  }

  // 12. Verify critical addon health (EBS CSI Driver)
  if (verbose) console.error(`\n⏳ Verifying EBS CSI driver health...`);
  const ebsHealthCheck = await kubectl(
    ["get", "pods", "-n", "kube-system", "-l", "app.kubernetes.io/name=aws-ebs-csi-driver", "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (ebsHealthCheck.ok) {
    try {
      const podsData = JSON.parse(ebsHealthCheck.stdout);
      const pods = podsData.items || [];
      const controllerPods = pods.filter((p: any) => p.metadata?.name?.includes("ebs-csi-controller"));
      const crashLoopPods = controllerPods.filter((p: any) => 
        p.status?.containerStatuses?.some((s: any) => s.state?.waiting?.reason === "CrashLoopBackOff" || s.state?.waiting?.reason === "Error")
      );

      if (crashLoopPods.length > 0) {
        const podName = crashLoopPods[0].metadata?.name || "unknown";
        const errorMsg = `EBS CSI driver is in CrashLoopBackOff or Error state. Stateful services will fail to start.\n\n` +
                        `Common causes:\n` +
                        `  1. IAM role permissions are incorrect\n` +
                        `  2. Pod identity association failed\n\n` +
                        `To debug: kubectl describe pod ${podName} -n kube-system`;
        if (verbose) console.error(`\n❌ ${errorMsg}`);
        blockers.push({
          code: "EBS_CSI_DRIVER_UNHEALTHY",
          message: errorMsg,
        });
      } else if (controllerPods.length === 0) {
        if (verbose) console.error(`⚠️  EBS CSI driver controller pods not found.`);
        // Don't block yet, maybe they're just starting
      } else {
        const allReady = controllerPods.every((p: any) => 
          p.status?.phase === "Running" && 
          p.status?.containerStatuses?.every((s: any) => s.ready)
        );
        if (allReady) {
          if (verbose) console.error(`✓ EBS CSI driver is healthy`);
        } else {
          if (verbose) console.error(`⚠️  EBS CSI driver is still starting...`);
        }
      }
    } catch (e) {
      if (verbose) console.error(`⚠️  Error parsing EBS CSI driver health check: ${e}`);
    }
  }

  return {
    ok: blockers.length === 0,
    evidence,
    blockers,
  };
}
