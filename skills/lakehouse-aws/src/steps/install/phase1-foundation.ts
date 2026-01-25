import { getCluster, createCluster, createNodegroup, createAddon, createPodIdentityAssociation } from "../../tools/eksctl.js";
import { upgradeInstall } from "../../tools/helm.js";
import { aws, waitForClusterActive, describeCluster } from "../../tools/aws.js";
import { getNodes, kubectl } from "../../tools/kubectl.js";
import { getRole, createRole, attachPolicy } from "../../tools/iam.js";

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
    process.stderr.flush?.();
  }
  const clusterCheck = await getCluster(clusterName, region, profile);
  evidence.eks.existed = clusterCheck.exists;

  if (verbose) {
    process.stderr.write(clusterCheck.exists ? `✓ Cluster '${clusterName}' already exists\n` : `✓ Cluster '${clusterName}' not found, will create\n`);
    process.stderr.flush?.();
  }

  // 2. Create cluster if missing
  if (!clusterCheck.exists) {
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
      if (verbose) console.error(`❌ Failed to create cluster: ${createResult.stderr.substring(0, 200)}`);
      blockers.push({
        code: "EKS_CLUSTER_CREATE_FAILED",
        message: `Failed to create EKS cluster: ${createResult.stderr}`,
      });
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
  
  if (ebsPodIdentity.ok || ebsPodIdentity.stderr.includes("already exists")) {
    if (verbose) console.error(`✓ Pod identity association created`);
    
    // 11. Restart EBS CSI controller pods to pick up the new IAM role
    if (verbose) console.error(`⏳ Restarting EBS CSI controller pods to apply new IAM role...`);
    const restartResult = await kubectl(
      ["delete", "pods", "-n", "kube-system", "-l", "app.kubernetes.io/name=aws-ebs-csi-driver,app.kubernetes.io/component=csi-controller"],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );
    
    if (verbose) console.error(`✓ Controller pods restarted`);
    
    // Wait a bit for new pods to start
    if (verbose) console.error(`⏳ Waiting 30s for EBS CSI controllers to stabilize...`);
    await new Promise(resolve => setTimeout(resolve, 30000));
  } else {
    if (verbose) console.error(`⚠️  Failed to create pod identity association: ${ebsPodIdentity.stderr.substring(0, 200)}`);
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

  return {
    ok: blockers.length === 0,
    evidence,
    blockers,
  };
}
