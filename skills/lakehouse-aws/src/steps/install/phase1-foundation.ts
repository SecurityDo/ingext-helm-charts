import { getCluster, createCluster, createNodegroup, createAddon, createPodIdentityAssociation } from "../../tools/eksctl.js";
import { upgradeInstall } from "../../tools/helm.js";
import { aws } from "../../tools/aws.js";
import { getNodes } from "../../tools/kubectl.js";

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

export async function runPhase1Foundation(env: Record<string, string>): Promise<{
  ok: boolean;
  evidence: Phase1Evidence;
  blockers: Array<{ code: string; message: string }>;
}> {
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

  // 1. Check if cluster exists
  const clusterCheck = await getCluster(clusterName, region, profile);
  evidence.eks.existed = clusterCheck.exists;

  // 2. Create cluster if missing
  if (!clusterCheck.exists) {
    const createResult = await createCluster({
      name: clusterName,
      region,
      profile,
      version: "1.34",
      nodegroupName: "standardworkers",
      nodeType,
      nodeCount,
    });

    if (!createResult.ok) {
      blockers.push({
        code: "EKS_CLUSTER_CREATE_FAILED",
        message: `Failed to create EKS cluster: ${createResult.stderr}`,
      });
      return { ok: false, evidence, blockers };
    }
    evidence.eks.created = true;

    // Wait for nodes to be ready after cluster creation
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30s wait for node initialization
  }

  // 3. Update kubeconfig
  const kubeconfigResult = await aws(
    ["eks", "update-kubeconfig", "--region", region, "--name", clusterName, "--alias", clusterName],
    profile,
    region
  );
  evidence.eks.kubeconfigUpdated = kubeconfigResult.ok;
  if (!kubeconfigResult.ok) {
    blockers.push({
      code: "KUBECONFIG_UPDATE_FAILED",
      message: `Failed to update kubeconfig: ${kubeconfigResult.stderr}`,
    });
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
              nodegroupName: "standardworkers",
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
  const vpcCniAddon = await createAddon(clusterName, "vpc-cni", region, profile);
  if (vpcCniAddon.ok) {
    evidence.eks.addonsInstalled.push("vpc-cni");
  }

  // 5. Install addon: eks-pod-identity-agent
  const podIdentityAddon = await createAddon(clusterName, "eks-pod-identity-agent", region, profile);
  if (podIdentityAddon.ok) {
    evidence.eks.addonsInstalled.push("eks-pod-identity-agent");
  }

  // 6. Create pod identity association for EBS CSI
  const ebsRoleName = `AmazonEKS_EBS_CSI_DriverRole_${clusterName}`;
  const ebsPodIdentity = await createPodIdentityAssociation({
    cluster: clusterName,
    namespace: "kube-system",
    serviceAccountName: "ebs-csi-controller-sa",
    roleName: ebsRoleName,
    permissionPolicyArns: "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
    region,
    profile,
  });
  // Note: We don't track this in addonsInstalled, but it's required for EBS CSI

  // 7. Install addon: aws-ebs-csi-driver
  const ebsCsiAddon = await createAddon(clusterName, "aws-ebs-csi-driver", region, profile);
  if (ebsCsiAddon.ok) {
    evidence.eks.addonsInstalled.push("aws-ebs-csi-driver");
  }

  // 8. Install StorageClass via Helm
  const storageClassResult = await upgradeInstall(
    "ingext-aws-gp3",
    "oci://public.ecr.aws/ingext/ingext-aws-gp3",
    "kube-system"
  );
  evidence.eks.storageClassInstalled = storageClassResult.ok;
  if (!storageClassResult.ok) {
    blockers.push({
      code: "STORAGECLASS_INSTALL_FAILED",
      message: `Failed to install StorageClass: ${storageClassResult.stderr}`,
    });
  }

  // 9. Install addon: aws-mountpoint-s3-csi-driver (via AWS CLI, not eksctl)
  const s3CsiResult = await aws(
    ["eks", "create-addon", "--cluster-name", clusterName, "--addon-name", "aws-mountpoint-s3-csi-driver", "--region", region],
    profile,
    region
  );
  // Ignore errors if already exists (idempotency)
  if (s3CsiResult.ok || s3CsiResult.stderr.includes("already exists")) {
    evidence.eks.addonsInstalled.push("aws-mountpoint-s3-csi-driver");
  }

  return {
    ok: blockers.length === 0,
    evidence,
    blockers,
  };
}
