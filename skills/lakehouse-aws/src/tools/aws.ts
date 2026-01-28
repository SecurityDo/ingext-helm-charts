import { run } from "./shell.js";

export async function aws(args: string[], awsProfile: string, awsRegion: string) {
  return run("aws", args, { AWS_PROFILE: awsProfile, AWS_DEFAULT_REGION: awsRegion });
}

export async function getCallerIdentity(awsProfile: string, awsRegion: string) {
  const res = await aws(["sts", "get-caller-identity", "--output", "json"], awsProfile, awsRegion);
  if (!res.ok) return { ok: false as const, error: res.stderr || res.stdout };

  try {
    const j = JSON.parse(res.stdout);
    return { ok: true as const, accountId: j.Account as string, arn: j.Arn as string, userId: j.UserId as string };
  } catch {
    return { ok: false as const, error: "Failed to parse sts get-caller-identity output" };
  }
}

/**
 * List all available AWS profiles
 */
export async function listProfiles(): Promise<string[]> {
  const res = await run("aws", ["configure", "list-profiles"]);
  if (!res.ok) return [];
  return res.stdout.trim().split("\n").filter(Boolean);
}

export async function headBucket(bucket: string, awsProfile: string, awsRegion: string) {
  const res = await aws(["s3api", "head-bucket", "--bucket", bucket], awsProfile, awsRegion);
  return { exists: res.ok, raw: res };
}

export async function describeCluster(clusterName: string, awsProfile: string, awsRegion: string) {
  const res = await aws(
    ["eks", "describe-cluster", "--name", clusterName, "--query", "cluster.status", "--output", "text"],
    awsProfile,
    awsRegion
  );
  
  // Check if the error is actually "cluster not found" vs other errors
  if (!res.ok) {
    const isNotFound = res.stderr.includes("ResourceNotFoundException") || 
                       res.stderr.includes("not found") ||
                       res.stderr.includes("does not exist");
    return { 
      found: false, 
      status: isNotFound ? "NOT_FOUND" : "ERROR", 
      error: res.stderr,
      raw: res 
    };
  }
  
  return { 
    found: true, 
    status: res.stdout.trim(), 
    raw: res 
  };
}

/**
 * List all node groups for a cluster
 */
export async function listNodegroups(clusterName: string, awsProfile: string, awsRegion: string) {
  const res = await aws(
    ["eks", "list-nodegroups", "--cluster-name", clusterName, "--query", "nodegroups", "--output", "json"],
    awsProfile,
    awsRegion
  );
  
  if (!res.ok) {
    // Check if cluster doesn't exist (node groups can't exist without cluster)
    const isClusterNotFound = res.stderr.includes("ResourceNotFoundException") || 
                              res.stderr.includes("not found");
    return { 
      ok: false as const, 
      nodegroups: [] as string[], 
      error: res.stderr,
      clusterNotFound: isClusterNotFound
    };
  }
  
  try {
    const nodegroups = JSON.parse(res.stdout);
    return { ok: true as const, nodegroups: Array.isArray(nodegroups) ? nodegroups : [] };
  } catch {
    return { ok: false as const, nodegroups: [] as string[], error: "Failed to parse nodegroups list" };
  }
}

/**
 * Get node group status
 */
export async function describeNodegroup(
  clusterName: string,
  nodegroupName: string,
  awsProfile: string,
  awsRegion: string
) {
  const res = await aws(
    ["eks", "describe-nodegroup", "--cluster-name", clusterName, "--nodegroup-name", nodegroupName, "--query", "nodegroup.status", "--output", "text"],
    awsProfile,
    awsRegion
  );
  
  if (!res.ok) {
    const isNotFound = res.stderr.includes("ResourceNotFoundException") || 
                       res.stderr.includes("not found");
    return { 
      found: false, 
      status: isNotFound ? "NOT_FOUND" : "ERROR", 
      error: res.stderr 
    };
  }
  
  return { found: true, status: res.stdout.trim() };
}

/**
 * Get VPC ID for an EKS cluster
 */
export async function getVpcIdFromCluster(
  clusterName: string,
  awsProfile: string,
  awsRegion: string
): Promise<string | null> {
  const res = await aws(
    ["eks", "describe-cluster", "--name", clusterName, "--region", awsRegion, "--query", "cluster.resourcesVpcConfig.vpcId", "--output", "text"],
    awsProfile,
    awsRegion
  );
  
  if (res.ok && res.stdout.trim() && !res.stdout.includes("None")) {
    return res.stdout.trim();
  }
  
  return null;
}

/**
 * Delete a node group
 */
export async function deleteNodegroup(clusterName: string, nodegroupName: string, awsProfile: string, awsRegion: string) {
  return aws(
    ["eks", "delete-nodegroup", "--cluster-name", clusterName, "--nodegroup-name", nodegroupName],
    awsProfile,
    awsRegion
  );
}

/**
 * List all Pod Identity Associations for a cluster
 */
export async function listPodIdentityAssociations(clusterName: string, awsProfile: string, awsRegion: string) {
  const res = await aws(
    ["eks", "list-pod-identity-associations", "--cluster-name", clusterName, "--query", "associations", "--output", "json"],
    awsProfile,
    awsRegion
  );
  
  if (!res.ok) return { ok: false as const, associations: [] as any[], error: res.stderr };
  
  try {
    const associations = JSON.parse(res.stdout);
    return { ok: true as const, associations: Array.isArray(associations) ? associations : [] };
  } catch {
    return { ok: false as const, associations: [] as any[], error: "Failed to parse pod identity associations" };
  }
}

/**
 * Delete a Pod Identity Association
 */
export async function deletePodIdentityAssociation(clusterName: string, associationId: string, awsProfile: string, awsRegion: string) {
  return aws(
    ["eks", "delete-pod-identity-association", "--cluster-name", clusterName, "--association-id", associationId],
    awsProfile,
    awsRegion
  );
}

/**
 * Delete EKS cluster using AWS CLI (fallback when eksctl is not available)
 * First deletes all node groups and pod identity associations, then deletes the cluster
 */
export async function deleteClusterWithAwsCli(
  clusterName: string,
  awsProfile: string,
  awsRegion: string
): Promise<{ ok: boolean; stderr: string; stdout: string }> {
  // Step 1: List and delete all node groups
  const nodegroupsResult = await listNodegroups(clusterName, awsProfile, awsRegion);
  
  if (nodegroupsResult.ok && nodegroupsResult.nodegroups.length > 0) {
    console.error(`  Found ${nodegroupsResult.nodegroups.length} node group(s), deleting...`);
    for (const nodegroup of nodegroupsResult.nodegroups) {
      console.error(`  Deleting node group: ${nodegroup}...`);
      const deleteNgResult = await deleteNodegroup(clusterName, nodegroup, awsProfile, awsRegion);
      if (!deleteNgResult.ok) {
        // Check if node group doesn't exist (already deleted)
        if (deleteNgResult.stderr.includes("ResourceNotFoundException") || 
            deleteNgResult.stderr.includes("not found")) {
          console.error(`  ✓ Node group ${nodegroup} already deleted`);
        } else {
          console.error(`  ⚠️  Failed to delete node group ${nodegroup}: ${deleteNgResult.stderr}`);
        }
      } else {
        console.error(`  ✓ Node group ${nodegroup} deletion initiated`);
      }
    }
    
    // Wait for node groups to be deleted (can take a few minutes)
    console.error(`  ⏳ Waiting for node groups to be deleted...`);
    console.error(`     ⚠️  This may take up to 10 minutes. Progress will be shown below (updates every 15 seconds):`);
    let allDeleted = false;
    let attempts = 0;
    const maxAttempts = 40; // 10 minutes max (15 second intervals)
    
      while (attempts < maxAttempts && !allDeleted) {
      await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds
      attempts++;
      
      // First check if cluster still exists (if cluster is DELETING, node groups are being deleted)
      const clusterStatus = await describeCluster(clusterName, awsProfile, awsRegion);
      if (!clusterStatus.found || clusterStatus.status === "DELETING") {
        allDeleted = true;
        // Clear the progress line
        process.stderr.write(`\r${" ".repeat(80)}\r`); // Clear line
        if (clusterStatus.status === "DELETING") {
          console.error(`  ✓ Cluster is DELETING (node groups will be deleted automatically)`);
        } else {
          console.error(`  ✓ Cluster deleted (node groups automatically deleted)`);
        }
        break;
      }
      
      const checkResult = await listNodegroups(clusterName, awsProfile, awsRegion);
      
      // Check if cluster was deleted (node groups can't exist without cluster)
      if (checkResult.ok === false && (checkResult as any).clusterNotFound) {
        allDeleted = true;
        // Clear the progress line
        process.stderr.write(`\r${" ".repeat(80)}\r`); // Clear line
        console.error(`  ✓ Cluster deleted (node groups automatically deleted)`);
        break;
      }
      
      if (checkResult.ok && checkResult.nodegroups.length === 0) {
        allDeleted = true;
        // Clear the progress line
        process.stderr.write(`\r${" ".repeat(80)}\r`); // Clear line
        console.error(`  ✓ All node groups deleted`);
      } else if (checkResult.ok) {
        // Check status of remaining node groups
        const remaining = checkResult.nodegroups;
        const statusChecks = await Promise.all(
          remaining.map(ng => describeNodegroup(clusterName, ng, awsProfile, awsRegion))
        );
        
        const statuses = statusChecks.map((check, i) => 
          check.found ? `${remaining[i]}:${check.status}` : `${remaining[i]}:GONE`
        );
        
        // EKS DeleteCluster REQUIRES node groups to be completely gone (NOT_FOUND)
        // It will fail with ResourceInUseException if they are still DELETING
        const allGone = statusChecks.every(check => 
          !check.found || check.status === "NOT_FOUND"
        );
        
        if (allGone) {
          allDeleted = true;
          // Clear the progress line
          process.stderr.write(`\r${" ".repeat(80)}\r`); // Clear line
          console.error(`  ✓ All node groups have been removed`);
        } else {
          // Show actual status (rewrite same line)
          const activeCount = statusChecks.filter(check => check.found && check.status === "ACTIVE").length;
          const deletingCount = statusChecks.filter(check => check.found && check.status === "DELETING").length;
          const minutes = Math.floor((attempts * 15) / 60);
          const seconds = (attempts * 15) % 60;
          if (activeCount > 0) {
            process.stderr.write(`\r   [${minutes}m ${seconds}s] ${activeCount} node group(s) still ACTIVE: ${statuses.join(", ")}${" ".repeat(20)}`);
          } else if (deletingCount > 0) {
            process.stderr.write(`\r   [${minutes}m ${seconds}s] ${deletingCount} node group(s) DELETING, waiting for removal...${" ".repeat(20)}`);
          } else {
            process.stderr.write(`\r   [${minutes}m ${seconds}s] ${remaining.length} node group(s) remaining: ${statuses.join(", ")}${" ".repeat(20)}`);
          }
        }
      } else {
        // Error checking - might mean cluster/node groups are gone
        const minutes = Math.floor((attempts * 15) / 60);
        const seconds = (attempts * 15) % 60;
        process.stderr.write(`\r   [${minutes}m ${seconds}s] Checking node group status...${" ".repeat(20)}`);
      }
    }
    
    // Clear the progress line at the end if still waiting
    if (!allDeleted) {
      process.stderr.write(`\r${" ".repeat(80)}\r`); // Clear line
    }
    
    if (!allDeleted) {
      console.error(`  ⚠️  Some node groups may still be deleting. Proceeding with cluster deletion...`);
    }
  }

  // Step 1.5: List and delete all Pod Identity Associations
  const podIdentityResult = await listPodIdentityAssociations(clusterName, awsProfile, awsRegion);
  if (podIdentityResult.ok && podIdentityResult.associations.length > 0) {
    console.error(`  Found ${podIdentityResult.associations.length} Pod Identity Association(s), deleting...`);
    for (const assoc of podIdentityResult.associations) {
      console.error(`  Deleting Pod Identity Association: ${assoc.associationId} (${assoc.namespace}/${assoc.serviceAccount})...`);
      const deleteAssocResult = await deletePodIdentityAssociation(clusterName, assoc.associationId, awsProfile, awsRegion);
      if (!deleteAssocResult.ok) {
        if (deleteAssocResult.stderr.includes("ResourceNotFoundException") || 
            deleteAssocResult.stderr.includes("not found")) {
          console.error(`  ✓ Pod Identity Association ${assoc.associationId} already deleted`);
        } else {
          console.error(`  ⚠️  Failed to delete Pod Identity Association ${assoc.associationId}: ${deleteAssocResult.stderr}`);
        }
      } else {
        console.error(`  ✓ Pod Identity Association ${assoc.associationId} deleted`);
      }
    }
  }
  
  // Step 2: Delete the cluster
  console.error(`  Deleting cluster: ${clusterName}...`);
  const deleteResult = await aws(
    ["eks", "delete-cluster", "--name", clusterName],
    awsProfile,
    awsRegion
  );
  
  return {
    ok: deleteResult.ok,
    stderr: deleteResult.stderr,
    stdout: deleteResult.stdout,
  };
}

/**
 * List CloudFormation stacks for an EKS cluster
 * Returns stack names that match the cluster name pattern
 */
export async function listCloudFormationStacks(
  clusterName: string,
  awsProfile: string,
  awsRegion: string
): Promise<{ ok: boolean; stacks: string[]; error?: string }> {
  // eksctl creates stacks with pattern: eksctl-{clusterName}-cluster and eksctl-{clusterName}-nodegroup-*
  const clusterStackPrefix = `eksctl-${clusterName}-`;
  
  const res = await aws(
    [
      "cloudformation",
      "list-stacks",
      "--stack-status-filter",
      "CREATE_IN_PROGRESS",
      "CREATE_FAILED",
      "CREATE_COMPLETE",
      "ROLLBACK_IN_PROGRESS",
      "ROLLBACK_FAILED",
      "ROLLBACK_COMPLETE",
      "DELETE_IN_PROGRESS",
      "DELETE_FAILED",
      "UPDATE_IN_PROGRESS",
      "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
      "UPDATE_COMPLETE",
      "UPDATE_ROLLBACK_IN_PROGRESS",
      "UPDATE_ROLLBACK_FAILED",
      "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
      "UPDATE_ROLLBACK_COMPLETE",
      "REVIEW_IN_PROGRESS",
      "IMPORT_IN_PROGRESS",
      "IMPORT_COMPLETE",
      "IMPORT_ROLLBACK_IN_PROGRESS",
      "IMPORT_ROLLBACK_FAILED",
      "IMPORT_ROLLBACK_COMPLETE",
      "--query",
      `StackSummaries[?starts_with(StackName, '${clusterStackPrefix}')].StackName`,
      "--output",
      "json",
    ],
    awsProfile,
    awsRegion
  );
  
  if (!res.ok) {
    return { ok: false, stacks: [], error: res.stderr };
  }
  
  try {
    const stacks = JSON.parse(res.stdout);
    return { ok: true, stacks: Array.isArray(stacks) ? stacks : [] };
  } catch {
    return { ok: true, stacks: [] };
  }
}

/**
 * Get detailed information about a CloudFormation stack
 */
export async function describeCloudFormationStack(
  stackName: string,
  awsProfile: string,
  awsRegion: string
): Promise<{ ok: boolean; status?: string; resources?: any[]; events?: any[]; terminationProtection?: boolean; error?: string }> {
  const statusRes = await aws(
    ["cloudformation", "describe-stacks", "--stack-name", stackName, "--query", "Stacks[0].{Status:StackStatus,StatusReason:StackStatusReason,TerminationProtection:TerminationProtection}", "--output", "json"],
    awsProfile,
    awsRegion
  );
  
  if (!statusRes.ok) {
    return { ok: false, error: statusRes.stderr };
  }
  
  try {
    const stackInfo = JSON.parse(statusRes.stdout);
    
    // Get stack events (recent failures)
    const eventsRes = await aws(
      ["cloudformation", "describe-stack-events", "--stack-name", stackName, "--max-items", "10", "--query", "StackEvents[?ResourceStatus=='DELETE_FAILED' || ResourceStatus=='CREATE_FAILED' || ResourceStatus=='UPDATE_FAILED'].{Resource:LogicalResourceId,Status:ResourceStatus,Reason:ResourceStatusReason}", "--output", "json"],
      awsProfile,
      awsRegion
    );
    
    const events = eventsRes.ok ? JSON.parse(eventsRes.stdout) : [];
    
    // Get stack resources
    const resourcesRes = await aws(
      ["cloudformation", "describe-stack-resources", "--stack-name", stackName, "--query", "StackResources[?ResourceStatus!='DELETE_COMPLETE'].{Resource:LogicalResourceId,Type:ResourceType,Status:ResourceStatus}", "--output", "json"],
      awsProfile,
      awsRegion
    );
    
    const resources = resourcesRes.ok ? JSON.parse(resourcesRes.stdout) : [];
    
    return {
      ok: true,
      status: stackInfo.Status,
      terminationProtection: stackInfo.TerminationProtection,
      resources: resources,
      events: events,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Get subnet IDs from a CloudFormation stack
 */
async function getSubnetIdsFromStack(
  stackName: string,
  awsProfile: string,
  awsRegion: string
): Promise<string[]> {
  const res = await aws(
    ["cloudformation", "describe-stack-resources", "--stack-name", stackName, "--query", "StackResources[?ResourceType=='AWS::EC2::Subnet'].PhysicalResourceId", "--output", "text"],
    awsProfile,
    awsRegion
  );
  
  if (!res.ok) return [];
  
  const subnetIds = res.stdout.trim().split(/\s+/).filter(Boolean);
  return subnetIds;
}

/**
 * Find network interfaces attached to subnets
 */
async function findNetworkInterfacesInSubnets(
  subnetIds: string[],
  awsProfile: string,
  awsRegion: string
): Promise<string[]> {
  if (subnetIds.length === 0) return [];
  
  const res = await aws(
    ["ec2", "describe-network-interfaces", "--filters", `Name=subnet-id,Values=${subnetIds.join(",")}`, "--query", "NetworkInterfaces[*].NetworkInterfaceId", "--output", "text"],
    awsProfile,
    awsRegion
  );
  
  if (!res.ok) return [];
  
  const eniIds = res.stdout.trim().split(/\s+/).filter(Boolean);
  return eniIds;
}

/**
 * Get detailed network interface information
 */
async function getNetworkInterfaceDetails(
  eniId: string,
  awsProfile: string,
  awsRegion: string
): Promise<{ attachmentId?: string; status?: string; description?: string }> {
  const res = await aws(
    ["ec2", "describe-network-interfaces", "--network-interface-ids", eniId, "--query", "NetworkInterfaces[0].{AttachmentId:Attachment.AttachmentId,Status:Status,Description:Description}", "--output", "json"],
    awsProfile,
    awsRegion
  );
  
  if (res.ok && res.stdout.trim()) {
    try {
      return JSON.parse(res.stdout);
    } catch (e) {
      return {};
    }
  }
  
  return {};
}

/**
 * Detach network interface from instance if attached
 */
async function detachNetworkInterface(
  eniId: string,
  attachmentId: string,
  awsProfile: string,
  awsRegion: string
): Promise<boolean> {
  const res = await aws(
    ["ec2", "detach-network-interface", "--attachment-id", attachmentId, "--force"],
    awsProfile,
    awsRegion
  );
  
  if (res.ok) {
    // Wait for detachment to complete
    await new Promise(resolve => setTimeout(resolve, 5000));
    return true;
  }
  
  return false;
}

/**
 * Delete network interfaces (required before deleting subnets)
 * Now handles attached ENIs by detaching them first
 */
async function deleteNetworkInterfaces(
  eniIds: string[],
  awsProfile: string,
  awsRegion: string
): Promise<{ deleted: string[]; failed: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];
  
  for (const eniId of eniIds) {
    // First, check if ENI is attached and detach it
    const eniDetails = await getNetworkInterfaceDetails(eniId, awsProfile, awsRegion);
    if (eniDetails.attachmentId) {
      // ENI is attached - detach it first
      const detached = await detachNetworkInterface(eniId, eniDetails.attachmentId, awsProfile, awsRegion);
      if (!detached) {
        failed.push(eniId);
        continue;
      }
    }
    
    // Now delete the ENI
    const res = await aws(
      ["ec2", "delete-network-interface", "--network-interface-id", eniId],
      awsProfile,
      awsRegion
    );
    
    if (res.ok) {
      deleted.push(eniId);
    } else {
      // Check if it's already deleted or in use
      if (res.stderr.includes("does not exist") || res.stderr.includes("InvalidNetworkInterfaceID.NotFound")) {
        deleted.push(eniId); // Treat as success
      } else if (res.stderr.includes("is currently in use") || res.stderr.includes("InvalidAttachmentID.NotFound")) {
        // Try waiting and retrying
        await new Promise(resolve => setTimeout(resolve, 10000));
        const retryRes = await aws(
          ["ec2", "delete-network-interface", "--network-interface-id", eniId],
          awsProfile,
          awsRegion
        );
        if (retryRes.ok || retryRes.stderr.includes("does not exist")) {
          deleted.push(eniId);
        } else {
          failed.push(eniId);
        }
      } else {
        failed.push(eniId);
      }
    }
  }
  
  return { deleted, failed };
}

/**
 * Get route table associations for subnets
 */
async function getRouteTableAssociations(
  subnetIds: string[],
  awsProfile: string,
  awsRegion: string
): Promise<Array<{ routeTableId: string; subnetId: string; associationId: string }>> {
  if (subnetIds.length === 0) return [];
  
  const associations: Array<{ routeTableId: string; subnetId: string; associationId: string }> = [];
  
  for (const subnetId of subnetIds) {
    // First, get all route tables that have associations with this subnet
    const res = await aws(
      ["ec2", "describe-route-tables", "--filters", `Name=association.subnet-id,Values=${subnetId}`, "--query", "RouteTables[*].[RouteTableId,Associations[?SubnetId==`'${subnetId}'`].RouteTableAssociationId]", "--output", "json"],
      awsProfile,
      awsRegion
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
                    associations.push({
                      routeTableId: routeTableId,
                      subnetId: subnetId,
                      associationId: assocId
                    });
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        // Fallback to text parsing if JSON fails
        const lines = res.stdout.trim().split("\n");
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            associations.push({
              routeTableId: parts[0],
              subnetId: subnetId,
              associationId: parts[1]
            });
          }
        }
      }
    }
  }
  
  return associations;
}

/**
 * Disassociate route tables from subnets
 */
async function disassociateRouteTables(
  associations: Array<{ routeTableId: string; subnetId: string; associationId: string }>,
  awsProfile: string,
  awsRegion: string
): Promise<{ disassociated: number; failed: number }> {
  let disassociated = 0;
  let failed = 0;
  
  for (const assoc of associations) {
    const res = await aws(
      ["ec2", "disassociate-route-table", "--association-id", assoc.associationId],
      awsProfile,
      awsRegion
    );
    
    if (res.ok) {
      disassociated++;
    } else {
      // Check if already disassociated
      if (!res.stderr.includes("InvalidAssociationID.NotFound") && 
          !res.stderr.includes("does not exist")) {
        failed++;
      } else {
        disassociated++; // Treat as success
      }
    }
  }
  
  return { disassociated, failed };
}

/**
 * Get Internet Gateway ID from VPC
 */
async function getInternetGatewayForVpc(
  vpcId: string,
  awsProfile: string,
  awsRegion: string
): Promise<string | null> {
  const res = await aws(
    ["ec2", "describe-internet-gateways", "--filters", `Name=attachment.vpc-id,Values=${vpcId}`, "--query", "InternetGateways[0].InternetGatewayId", "--output", "text"],
    awsProfile,
    awsRegion
  );
  
  if (res.ok && res.stdout.trim() && !res.stdout.includes("None")) {
    return res.stdout.trim();
  }
  
  return null;
}

/**
 * Detach Internet Gateway from VPC
 */
async function detachInternetGateway(
  igwId: string,
  vpcId: string,
  awsProfile: string,
  awsRegion: string
): Promise<boolean> {
  const res = await aws(
    ["ec2", "detach-internet-gateway", "--internet-gateway-id", igwId, "--vpc-id", vpcId],
    awsProfile,
    awsRegion
  );
  
  return res.ok || res.stderr.includes("InvalidInternetGatewayID.NotFound") || 
         res.stderr.includes("does not exist");
}

/**
 * Get VPC ID from CloudFormation stack
 */
async function getVpcIdFromStack(
  stackName: string,
  awsProfile: string,
  awsRegion: string
): Promise<string | null> {
  const res = await aws(
    ["cloudformation", "describe-stack-resources", "--stack-name", stackName, "--query", "StackResources[?ResourceType=='AWS::EC2::VPC'].PhysicalResourceId", "--output", "text"],
    awsProfile,
    awsRegion
  );
  
  if (res.ok && res.stdout.trim()) {
    return res.stdout.trim();
  }
  
  return null;
}

/**
 * Get VPC ID from a subnet ID
 */
async function getVpcIdFromSubnet(
  subnetId: string,
  awsProfile: string,
  awsRegion: string
): Promise<string | null> {
  const res = await aws(
    ["ec2", "describe-subnets", "--subnet-ids", subnetId, "--query", "Subnets[0].VpcId", "--output", "text"],
    awsProfile,
    awsRegion
  );
  
  if (res.ok && res.stdout.trim() && !res.stdout.includes("None")) {
    return res.stdout.trim();
  }
  
  return null;
}

/**
 * Find and delete Load Balancers associated with a VPC or subnet
 */
async function deleteLoadBalancersInVpc(
  vpcId: string,
  awsProfile: string,
  awsRegion: string,
  subnetId?: string
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  
  // 1. Check Application and Network Load Balancers (v2)
  const lbRes = await aws(
    ["elbv2", "describe-load-balancers", "--query", "LoadBalancers[].{Arn:LoadBalancerArn,VpcId:VpcId,Subnets:AvailabilityZones[].SubnetId}", "--output", "json"],
    awsProfile,
    awsRegion
  );
  
  if (lbRes.ok && lbRes.stdout.trim()) {
    try {
      const lbs = JSON.parse(lbRes.stdout);
      for (const lb of lbs) {
        let match = false;
        if (subnetId) {
          match = lb.Subnets && lb.Subnets.includes(subnetId);
        } else {
          match = lb.VpcId === vpcId;
        }
        
        if (match) {
          // Delete the load balancer
          const delRes = await aws(
            ["elbv2", "delete-load-balancer", "--load-balancer-arn", lb.Arn],
            awsProfile,
            awsRegion
          );
          if (delRes.ok) {
            deleted++;
          } else {
            failed++;
          }
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
  
  // 2. Check Classic Load Balancers
  const classicRes = await aws(
    ["elb", "describe-load-balancers", "--query", "LoadBalancerDescriptions[].{Name:LoadBalancerName,VPC:VPCId,Subnets:Subnets}", "--output", "json"],
    awsProfile,
    awsRegion
  );
  
  if (classicRes.ok && classicRes.stdout.trim()) {
    try {
      const lbs = JSON.parse(classicRes.stdout);
      for (const lb of lbs) {
        let match = false;
        if (subnetId) {
          match = lb.Subnets && lb.Subnets.includes(subnetId);
        } else {
          match = lb.VPC === vpcId;
        }
        
        if (match) {
          const delRes = await aws(
            ["elb", "delete-load-balancer", "--load-balancer-name", lb.Name],
            awsProfile,
            awsRegion
          );
          if (delRes.ok) {
            deleted++;
          } else {
            failed++;
          }
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
  
  return { deleted, failed };
}

/**
 * Forcefully clean up a subnet and ALL its dependencies
 * This is called when a subnet is stuck in DELETE_FAILED
 */
async function forceCleanupSubnet(
  subnetId: string,
  subnetLogicalName: string,
  awsProfile: string,
  awsRegion: string
): Promise<{ cleaned: boolean; dependencies: string[] }> {
  const dependencies: string[] = [];
  let cleaned = true;
  
  // 0. Check for and delete Load Balancers using this subnet
  const vpcId = await getVpcIdFromSubnet(subnetId, awsProfile, awsRegion);
  if (vpcId) {
    const lbResult = await deleteLoadBalancersInVpc(vpcId, awsProfile, awsRegion, subnetId);
    if (lbResult.deleted > 0) {
      dependencies.push(`${lbResult.deleted} Load Balancer(s)`);
      // Wait for LB deletion to propagate
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    if (lbResult.failed > 0) {
      cleaned = false;
    }
  }
  
  // 1. Find and delete ALL network interfaces in this subnet
  const eniIds = await findNetworkInterfacesInSubnets([subnetId], awsProfile, awsRegion);
  if (eniIds.length > 0) {
    dependencies.push(`${eniIds.length} network interface(s)`);
    const eniResult = await deleteNetworkInterfaces(eniIds, awsProfile, awsRegion);
    if (eniResult.failed.length > 0) {
      cleaned = false;
    }
    // Wait for ENI deletion to propagate
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  // 2. Disassociate ALL route tables from this subnet
  const routeAssociations = await getRouteTableAssociations([subnetId], awsProfile, awsRegion);
  if (routeAssociations.length > 0) {
    dependencies.push(`${routeAssociations.length} route table association(s)`);
    const disassocResult = await disassociateRouteTables(routeAssociations, awsProfile, awsRegion);
    if (disassocResult.failed > 0) {
      cleaned = false;
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  // 3. Check for NAT Gateways in this subnet (they block subnet deletion)
  const natGatewayRes = await aws(
    ["ec2", "describe-nat-gateways", "--filter", `Name=subnet-id,Values=${subnetId}`, "--query", "NatGateways[?State!='deleted'].NatGatewayId", "--output", "text"],
    awsProfile,
    awsRegion
  );
  if (natGatewayRes.ok && natGatewayRes.stdout.trim()) {
    const natGatewayIds = natGatewayRes.stdout.trim().split(/\s+/).filter(Boolean);
    if (natGatewayIds.length > 0) {
      dependencies.push(`${natGatewayIds.length} NAT Gateway(s)`);
      for (const natId of natGatewayIds) {
        // Delete NAT Gateway
        await aws(
          ["ec2", "delete-nat-gateway", "--nat-gateway-id", natId],
          awsProfile,
          awsRegion
        );
      }
      // Wait for NAT Gateway deletion
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  
  // 4. Check for VPC Endpoints in this subnet
  const vpcEndpointRes = await aws(
    ["ec2", "describe-vpc-endpoints", "--filters", `Name=subnet-id,Values=${subnetId}`, "--query", "VpcEndpoints[?State!='deleted'].VpcEndpointId", "--output", "text"],
    awsProfile,
    awsRegion
  );
  if (vpcEndpointRes.ok && vpcEndpointRes.stdout.trim()) {
    const vpcEndpointIds = vpcEndpointRes.stdout.trim().split(/\s+/).filter(Boolean);
    if (vpcEndpointIds.length > 0) {
      dependencies.push(`${vpcEndpointIds.length} VPC Endpoint(s)`);
      for (const endpointId of vpcEndpointIds) {
        await aws(
          ["ec2", "delete-vpc-endpoints", "--vpc-endpoint-ids", endpointId],
          awsProfile,
          awsRegion
        );
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  return { cleaned, dependencies };
}

/**
 * Find and delete Security Groups in a VPC (except default)
 */
async function deleteSecurityGroupsInVpc(
  vpcId: string,
  awsProfile: string,
  awsRegion: string
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  
  const res = await aws(
    ["ec2", "describe-security-groups", "--filters", `Name=vpc-id,Values=${vpcId}`, "--query", "SecurityGroups[?GroupName!=`default`].GroupId", "--output", "json"],
    awsProfile,
    awsRegion
  );
  
  if (res.ok && res.stdout.trim()) {
    try {
      const sgIds = JSON.parse(res.stdout);
      
      // First, clear all rules from all SGs to break circular dependencies
      for (const sgId of sgIds) {
        // Revoke ingress
        const ingressRes = await aws(
          ["ec2", "describe-security-groups", "--group-ids", sgId, "--query", "SecurityGroups[0].IpPermissions", "--output", "json"],
          awsProfile,
          awsRegion
        );
        if (ingressRes.ok && ingressRes.stdout.trim() !== "[]") {
          await aws(
            ["ec2", "revoke-security-group-ingress", "--group-id", sgId, "--ip-permissions", ingressRes.stdout.trim()],
            awsProfile,
            awsRegion
          );
        }
        
        // Revoke egress
        const egressRes = await aws(
          ["ec2", "describe-security-groups", "--group-ids", sgId, "--query", "SecurityGroups[0].IpPermissionsEgress", "--output", "json"],
          awsProfile,
          awsRegion
        );
        if (egressRes.ok && egressRes.stdout.trim() !== "[]") {
          await aws(
            ["ec2", "revoke-security-group-egress", "--group-id", sgId, "--ip-permissions", egressRes.stdout.trim()],
            awsProfile,
            awsRegion
          );
        }
      }
      
      // Now delete the SGs
      for (const sgId of sgIds) {
        const delRes = await aws(
          ["ec2", "delete-security-group", "--group-id", sgId],
          awsProfile,
          awsRegion
        );
        if (delRes.ok) {
          deleted++;
        } else {
          failed++;
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
  
  return { deleted, failed };
}

/**
 * Forcefully clean up a VPC and its dependencies
 */
async function forceCleanupVpc(
  vpcId: string,
  awsProfile: string,
  awsRegion: string
): Promise<{ cleaned: boolean; dependencies: string[] }> {
  const dependencies: string[] = [];
  let cleaned = true;
  
  // 1. Delete Load Balancers
  const lbResult = await deleteLoadBalancersInVpc(vpcId, awsProfile, awsRegion);
  if (lbResult.deleted > 0) dependencies.push(`${lbResult.deleted} Load Balancer(s)`);
  if (lbResult.failed > 0) cleaned = false;
  
  // 2. Delete Security Groups (except default)
  const sgResult = await deleteSecurityGroupsInVpc(vpcId, awsProfile, awsRegion);
  if (sgResult.deleted > 0) dependencies.push(`${sgResult.deleted} Security Group(s)`);
  if (sgResult.failed > 0) cleaned = false;
  
  // 3. Detach and delete Internet Gateway
  const igwId = await getInternetGatewayForVpc(vpcId, awsProfile, awsRegion);
  if (igwId) {
    const detached = await detachInternetGateway(igwId, vpcId, awsProfile, awsRegion);
    if (detached) {
      await aws(["ec2", "delete-internet-gateway", "--internet-gateway-id", igwId], awsProfile, awsRegion);
      dependencies.push("Internet Gateway");
    } else {
      cleaned = false;
    }
  }
  
  return { cleaned, dependencies };
}

/**
 * Delete a CloudFormation stack, handling dependencies first if needed
 */
export async function deleteCloudFormationStack(
  stackName: string,
  awsProfile: string,
  awsRegion: string,
  options?: { cleanupDependencies?: boolean }
): Promise<{ ok: boolean; stderr: string; stdout: string; dependenciesCleaned?: boolean }> {
  // If cleanupDependencies is requested, clean up dependencies for stuck/failed resources
  if (options?.cleanupDependencies) {
    const stackDetails = await describeCloudFormationStack(stackName, awsProfile, awsRegion);
    
    if (stackDetails.ok && (stackDetails.status === "DELETE_FAILED" || stackDetails.status === "DELETE_IN_PROGRESS")) {
      const resources = stackDetails.resources || [];
      
      // 1. Handle subnets stuck in DELETE_IN_PROGRESS or DELETE_FAILED
      // Check for both DELETE_IN_PROGRESS (stuck) and DELETE_FAILED
      const stuckOrFailedSubnets = resources.filter((r: any) => 
        r.Type === "AWS::EC2::Subnet" && (r.Status === "DELETE_FAILED" || r.Status === "DELETE_IN_PROGRESS")
      );
      
      if (stuckOrFailedSubnets.length > 0) {
        // Get PhysicalResourceId (actual subnet ID) for each failed subnet
        for (const subnetResource of stuckOrFailedSubnets) {
          const subnetId = subnetResource.PhysicalResourceId || subnetResource.PhysicalId;
          const subnetName = subnetResource.LogicalResourceId || subnetResource.Resource;
          
          if (subnetId) {
            // Forcefully clean up this specific subnet
            const cleanupResult = await forceCleanupSubnet(subnetId, subnetName, awsProfile, awsRegion);
            
            if (!cleanupResult.cleaned) {
              // Log what we found but couldn't clean
              console.error(`   ⚠️  Subnet ${subnetName} (${subnetId}) still has dependencies: ${cleanupResult.dependencies.join(", ")}`);
            } else if (cleanupResult.dependencies.length > 0) {
              console.error(`   ✓ Cleaned up dependencies for ${subnetName}: ${cleanupResult.dependencies.join(", ")}`);
            }
          } else {
            // Fallback: get all subnet IDs from stack and clean them all
            const subnetIds = await getSubnetIdsFromStack(stackName, awsProfile, awsRegion);
            if (subnetIds.length > 0) {
              for (const sid of subnetIds) {
                await forceCleanupSubnet(sid, subnetName, awsProfile, awsRegion);
              }
            }
          }
        }
        
        // Wait for all cleanup to propagate
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      
      // 2. Handle VPC Gateway Attachment stuck in DELETE_IN_PROGRESS or DELETE_FAILED
      const stuckOrFailedGatewayAttachment = resources.find((r: any) => 
        r.Type === "AWS::EC2::VPCGatewayAttachment" && (r.Status === "DELETE_FAILED" || r.Status === "DELETE_IN_PROGRESS")
      );
      
      if (stuckOrFailedGatewayAttachment) {
        const vpcId = await getVpcIdFromStack(stackName, awsProfile, awsRegion);
        if (vpcId) {
          const igwId = await getInternetGatewayForVpc(vpcId, awsProfile, awsRegion);
          if (igwId) {
            await detachInternetGateway(igwId, vpcId, awsProfile, awsRegion);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }
      
      // 3. Handle Internet Gateway that's still in CREATE_COMPLETE - detach it
      const igwResource = resources.find((r: any) => 
        r.Type === "AWS::EC2::InternetGateway" && r.Status === "CREATE_COMPLETE"
      );
      
      if (igwResource) {
        const vpcId = await getVpcIdFromStack(stackName, awsProfile, awsRegion);
        if (vpcId) {
          const igwId = igwResource.PhysicalResourceId || await getInternetGatewayForVpc(vpcId, awsProfile, awsRegion);
          if (igwId) {
            await detachInternetGateway(igwId, vpcId, awsProfile, awsRegion);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }

      // 4. Handle VPC stuck in DELETE_IN_PROGRESS or DELETE_FAILED
      const stuckOrFailedVpc = resources.find((r: any) => 
        r.Type === "AWS::EC2::VPC" && (r.Status === "DELETE_FAILED" || r.Status === "DELETE_IN_PROGRESS")
      );

      if (stuckOrFailedVpc) {
        const vpcId = stuckOrFailedVpc.PhysicalResourceId || stuckOrFailedVpc.PhysicalId;
        if (vpcId) {
          console.error(`   ⏳ Forcefully cleaning up VPC ${vpcId}...`);
          const cleanupResult = await forceCleanupVpc(vpcId, awsProfile, awsRegion);
          if (cleanupResult.dependencies.length > 0) {
            console.error(`   ✓ Cleaned up VPC dependencies: ${cleanupResult.dependencies.join(", ")}`);
          }
        }
      }
    }
  }
  
  const res = await aws(
    ["cloudformation", "delete-stack", "--stack-name", stackName],
    awsProfile,
    awsRegion
  );
  return {
    ok: res.ok,
    stderr: res.stderr,
    stdout: res.stdout,
    dependenciesCleaned: options?.cleanupDependencies || false,
  };
}

/**
 * Check if a CloudFormation stack is deleted and get resource status
 * Also checks for resources stuck in DELETE_IN_PROGRESS and their dependencies
 */
async function checkStackDeleted(
  stackName: string,
  awsProfile: string,
  awsRegion: string,
  stuckThresholdMinutes: number = 5
): Promise<{ deleted: boolean; status?: string; deletingResources?: string[]; stuckResources?: Array<{ name: string; type: string; dependencies?: string[] }> }> {
  const checkRes = await aws(
    ["cloudformation", "describe-stacks", "--stack-name", stackName, "--query", "Stacks[0].StackStatus", "--output", "text"],
    awsProfile,
    awsRegion
  );
  
  if (!checkRes.ok) {
    // Stack not found means it's deleted
    if (checkRes.stderr.includes("does not exist") || 
        checkRes.stderr.includes("Stack with id") && checkRes.stderr.includes("does not exist")) {
      return { deleted: true };
    }
    return { deleted: false, status: "ERROR" };
  }
  
  const status = checkRes.stdout.trim();
  // Stack is deleted if status is DELETE_COMPLETE or empty
  if (status === "DELETE_COMPLETE" || status === "") {
    return { deleted: true };
  }
  
  // If stack is in DELETE_FAILED, get detailed resource information
  if (status === "DELETE_FAILED" || status === "DELETE_IN_PROGRESS") {
    // Get resources with their types, statuses, and physical IDs
    const resourcesRes = await aws(
      ["cloudformation", "describe-stack-resources", "--stack-name", stackName, "--query", "StackResources[?ResourceStatus=='DELETE_IN_PROGRESS' || ResourceStatus=='DELETE_FAILED'].{Resource:LogicalResourceId,Type:ResourceType,Status:ResourceStatus,PhysicalId:PhysicalResourceId}", "--output", "json"],
      awsProfile,
      awsRegion
    );
    
    const deletingResources: string[] = [];
    const stuckResources: Array<{ name: string; type: string; dependencies?: string[] }> = [];
    
    if (resourcesRes.ok && resourcesRes.stdout.trim()) {
      try {
        const resources = JSON.parse(resourcesRes.stdout);
        
        for (const resource of resources) {
          deletingResources.push(resource.Resource);
          
          // Check if this resource type commonly has dependencies that block deletion
          const resourceType = resource.Type || "";
          const resourceName = resource.Resource || "";
          
          // Subnets often get stuck due to network interfaces or route table associations
          if (resourceType === "AWS::EC2::Subnet" && (resource.Status === "DELETE_IN_PROGRESS" || resource.Status === "DELETE_FAILED")) {
            // Use PhysicalResourceId (the actual subnet ID) if available
            const subnetId = resource.PhysicalId || "";
            
            if (subnetId) {
              const dependencies: string[] = [];
              
              // Check for network interfaces
              const eniIds = await findNetworkInterfacesInSubnets([subnetId], awsProfile, awsRegion);
              if (eniIds.length > 0) {
                dependencies.push(`${eniIds.length} network interface(s)`);
              }
              
              // Check for route table associations
              const routeAssociations = await getRouteTableAssociations([subnetId], awsProfile, awsRegion);
              if (routeAssociations.length > 0) {
                dependencies.push(`${routeAssociations.length} route table association(s)`);
              }
              
              if (dependencies.length > 0) {
                stuckResources.push({ name: resourceName, type: resourceType, dependencies });
              } else {
                // Even if no dependencies found, mark as stuck if it's been in progress
                stuckResources.push({ name: resourceName, type: resourceType, dependencies: ["Unknown dependency"] });
              }
            }
          }
          
          // VPC Gateway Attachments get stuck if Internet Gateway is still attached
          if (resourceType === "AWS::EC2::VPCGatewayAttachment" && (resource.Status === "DELETE_IN_PROGRESS" || resource.Status === "DELETE_FAILED")) {
            const vpcId = await getVpcIdFromStack(stackName, awsProfile, awsRegion);
            if (vpcId) {
              const igwId = await getInternetGatewayForVpc(vpcId, awsProfile, awsRegion);
              if (igwId) {
                stuckResources.push({ 
                  name: resourceName, 
                  type: resourceType, 
                  dependencies: ["Internet Gateway still attached"] 
                });
              }
            }
          }
        }
      } catch (e) {
        // Fallback to simple text parsing
        const resourceList = resourcesRes.stdout.trim().split(/\s+/).filter(Boolean);
        deletingResources.push(...resourceList);
      }
    }
    
    return { 
      deleted: false, 
      status, 
      deletingResources,
      stuckResources: stuckResources.length > 0 ? stuckResources : undefined
    };
  }
  
  return { deleted: false, status };
}

/**
 * Wait for multiple CloudFormation stacks to be deleted in parallel.
 * Polls every 15 seconds and returns as soon as all stacks are deleted;
 * maxWaitMinutes is only an upper bound—the call does not block for the full duration if deletion finishes earlier.
 */
export async function waitForStacksDeleted(
  stackNames: string[],
  awsProfile: string,
  awsRegion: string,
  maxWaitMinutes: number = 10
): Promise<{ ok: boolean; deleted: string[]; remaining: string[]; failed?: Array<{ name: string; resources: string[] }> }> {
  if (stackNames.length === 0) {
    return { ok: true, deleted: [], remaining: [] };
  }
  
  const pollIntervalSeconds = 15;
  const maxAttempts = Math.floor((maxWaitMinutes * 60) / pollIntervalSeconds);
  let attempts = 0;
  let remainingStacks = [...stackNames];
  const deletedStacks: string[] = [];
  const stderrIsTTY = typeof process.stderr.isTTY === "boolean" && process.stderr.isTTY;
  
  // Track when resources first appeared as stuck (for proactive cleanup)
  const stuckResourceTimestamps: Map<string, number> = new Map();
  const stuckThresholdMinutes = 5; // Clean up dependencies if stuck > 5 minutes
  
  while (attempts < maxAttempts && remainingStacks.length > 0) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000));
    attempts++;
    const currentTime = Date.now();
    
    // Check all remaining stacks in parallel
    const checkPromises = remainingStacks.map(stackName => 
      checkStackDeleted(stackName, awsProfile, awsRegion, stuckThresholdMinutes).then(result => ({ stackName, ...result }))
    );
    const results = await Promise.all(checkPromises);
    
    // Separate deleted from remaining and collect resource info
    const stillRemaining: string[] = [];
    const resourceStatuses: string[] = [];
    const failedStacks: Array<{ name: string; resources: string[] }> = [];
    const stacksNeedingCleanup: string[] = [];
    
    for (const result of results) {
      if (result.deleted) {
        deletedStacks.push(result.stackName);
        // Clear stuck timestamps for this stack
        for (const key of stuckResourceTimestamps.keys()) {
          if (key.startsWith(result.stackName)) {
            stuckResourceTimestamps.delete(key);
          }
        }
      } else {
        stillRemaining.push(result.stackName);
        
        // Check if stack failed during deletion
        if (result.status === "DELETE_FAILED") {
          if (result.deletingResources && result.deletingResources.length > 0) {
            failedStacks.push({ name: result.stackName, resources: result.deletingResources });
          } else {
            failedStacks.push({ name: result.stackName, resources: [] });
          }
        }
        
        // Track stuck resources and their dependencies
        if (result.stuckResources && result.stuckResources.length > 0) {
          for (const stuck of result.stuckResources) {
            const key = `${result.stackName}:${stuck.name}`;
            if (!stuckResourceTimestamps.has(key)) {
              stuckResourceTimestamps.set(key, currentTime);
            }
            
            const stuckMinutes = (currentTime - stuckResourceTimestamps.get(key)!) / 60000;
            if (stuckMinutes > stuckThresholdMinutes && !stacksNeedingCleanup.includes(result.stackName)) {
              stacksNeedingCleanup.push(result.stackName);
            }
            
            // Show dependencies in status
            const depInfo = stuck.dependencies ? ` [blocked by: ${stuck.dependencies.join(", ")}]` : "";
            resourceStatuses.push(`${result.stackName}: ${stuck.name} (${stuck.type})${depInfo}`);
          }
        }
        
        // Show which resources are still being deleted for this stack
        if (result.deletingResources && result.deletingResources.length > 0) {
          // If we don't have stuck resource info, show simple list
          if (!result.stuckResources || result.stuckResources.length === 0) {
            const maxShow = 4;
            const resourceList = result.deletingResources.length > maxShow 
              ? `${result.deletingResources.slice(0, maxShow).join(", ")} +${result.deletingResources.length - maxShow} more`
              : result.deletingResources.join(", ");
            resourceStatuses.push(`${result.stackName}: ${resourceList}`);
          }
        } else if (result.status) {
          resourceStatuses.push(`${result.stackName}: ${result.status}`);
        }
      }
    }
    
    // Proactively clean up dependencies for stuck resources
    if (stacksNeedingCleanup.length > 0) {
      if (stderrIsTTY) process.stderr.write(`\r${" ".repeat(120)}\r`);
      process.stderr.write(`   ⚠️  Resources stuck in DELETE_IN_PROGRESS for >${stuckThresholdMinutes} minutes. Cleaning up dependencies...\n`);
      
      for (const stackName of stacksNeedingCleanup) {
        await deleteCloudFormationStack(stackName, awsProfile, awsRegion, {
          cleanupDependencies: true
        });
        // Clear timestamps after cleanup attempt
        for (const key of stuckResourceTimestamps.keys()) {
          if (key.startsWith(stackName)) {
            stuckResourceTimestamps.delete(key);
          }
        }
      }
      
      // Wait a moment for cleanup to propagate
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    remainingStacks = stillRemaining;
    
    // Show progress with resource details
    const elapsedSeconds = attempts * pollIntervalSeconds;
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const deletedCount = deletedStacks.length;
    const totalCount = stackNames.length;
    
    // Clear previous line and write new status (use \r in-place only when stderr is a TTY)
    const progressPrefix = `   [${minutes}m ${seconds}s] Deleted ${deletedCount}/${totalCount} stacks. `;
    if (resourceStatuses.length > 0) {
      const statusLine = resourceStatuses[0];
      const maxLineLength = 120;
      const displayLine = statusLine.length > maxLineLength 
        ? statusLine.substring(0, maxLineLength - 3) + "..."
        : statusLine;
      const line = progressPrefix + displayLine;
      if (stderrIsTTY) {
        process.stderr.write(`\r${line}${" ".repeat(50)}\r`);
      } else {
        process.stderr.write(`${line}\n`);
      }
    } else {
      const line = `   [${minutes}m ${seconds}s] Deleted ${deletedCount}/${totalCount} stacks, ${remainingStacks.length} remaining...`;
      if (stderrIsTTY) {
        process.stderr.write(`\r${line}${" ".repeat(30)}\r`);
      } else {
        process.stderr.write(`${line}\n`);
      }
    }
    
    // If any stacks failed, return early with failure info
    if (failedStacks.length > 0) {
      if (stderrIsTTY) process.stderr.write(`\r${" ".repeat(120)}\r`);
      return {
        ok: false,
        deleted: deletedStacks,
        remaining: remainingStacks,
        failed: failedStacks,
      };
    }
  }
  
  if (stderrIsTTY) process.stderr.write(`\r${" ".repeat(120)}\r`);
  
  return {
    ok: remainingStacks.length === 0,
    deleted: deletedStacks,
    remaining: remainingStacks,
  };
}

/**
 * Wait for CloudFormation stack to be deleted (single stack, for backward compatibility)
 */
export async function waitForStackDeleted(
  stackName: string,
  awsProfile: string,
  awsRegion: string,
  maxWaitMinutes: number = 10
): Promise<{ ok: boolean; deleted: boolean }> {
  const result = await waitForStacksDeleted([stackName], awsProfile, awsRegion, maxWaitMinutes);
  return { ok: result.ok, deleted: result.deleted.length > 0 };
}

/**
 * Wait for EKS cluster to reach ACTIVE status
 * Polls every 30 seconds with a maximum timeout
 */
export async function waitForClusterActive(
  clusterName: string,
  awsProfile: string,
  awsRegion: string,
  options?: { maxWaitMinutes?: number; verbose?: boolean }
): Promise<{ ok: boolean; status: string; waitedSeconds: number; error?: string }> {
  const maxWaitMinutes = options?.maxWaitMinutes || 20; // Default 20 minutes
  const maxWaitSeconds = maxWaitMinutes * 60;
  const pollIntervalSeconds = 30;
  const verbose = options?.verbose !== false;
  
  const startTime = Date.now();
  let lastStatus = "";
  let pollCount = 0;
  
  if (verbose) {
    console.error(`⏳ Waiting for cluster '${clusterName}' to become ACTIVE (max ${maxWaitMinutes} minutes)...`);
    console.error(`   Polling every ${pollIntervalSeconds} seconds...`);
  }
  
  while (true) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    pollCount++;
    
    if (elapsed > maxWaitSeconds) {
      if (verbose) {
        console.error(`❌ Timeout after ${maxWaitMinutes} minutes. Final status: ${lastStatus}`);
      }
      return {
        ok: false,
        status: lastStatus,
        waitedSeconds: elapsed,
        error: `Timeout after ${maxWaitMinutes} minutes. Cluster status: ${lastStatus}`,
      };
    }
    
    // Show progress every poll
    if (verbose) {
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      const remaining = Math.max(0, maxWaitSeconds - elapsed);
      const remMinutes = Math.floor(remaining / 60);
      const remSeconds = remaining % 60;
      console.error(`   [Poll #${pollCount}] [${minutes}m ${seconds}s elapsed, ${remMinutes}m ${remSeconds}s remaining] Checking cluster status...`);
    }
    
    const statusCheck = await describeCluster(clusterName, awsProfile, awsRegion);
    
    if (!statusCheck.found) {
      if (verbose) console.error(`❌ Cluster not found`);
      return {
        ok: false,
        status: "NOT_FOUND",
        waitedSeconds: elapsed,
        error: "Cluster not found",
      };
    }
    
    const status = statusCheck.status;
    const statusChanged = status !== lastStatus;
    lastStatus = status;
    
    if (verbose) {
      if (statusChanged || pollCount === 1) {
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        process.stderr.write(`   Status: ${status} [${minutes}m ${seconds}s elapsed]\n`);
      }
    }
    
    if (status === "ACTIVE") {
      const waitedSeconds = Math.floor((Date.now() - startTime) / 1000);
      if (verbose) {
        const minutes = Math.floor(waitedSeconds / 60);
        const seconds = waitedSeconds % 60;
        console.error(`✓ Cluster is ACTIVE! (waited ${minutes}m ${seconds}s, ${pollCount} polls)`);
      }
      return { ok: true, status, waitedSeconds };
    }
    
    if (status === "FAILED" || status === "DELETING") {
      if (verbose) console.error(`❌ Cluster is in ${status} state - cannot proceed`);
      return {
        ok: false,
        status,
        waitedSeconds: elapsed,
        error: `Cluster is in ${status} state`,
      };
    }
    
    // Wait before next poll - show countdown every 5 seconds
    if (verbose && status !== "ACTIVE") {
      for (let remaining = pollIntervalSeconds; remaining > 0; remaining -= 5) {
        process.stderr.write(`   Next check in ${remaining}s...\r`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      process.stderr.write(`   Next check in 0s...\n`);
    } else {
      await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000));
    }
  }
}