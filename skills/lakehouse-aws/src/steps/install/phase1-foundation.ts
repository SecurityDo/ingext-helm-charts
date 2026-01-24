import { getCluster, createCluster, createAddon, createPodIdentityAssociation } from "../../tools/eksctl.js";
import { upgradeInstall } from "../../tools/helm.js";
import { aws } from "../../tools/aws.js";

export type Phase1Evidence = {
  eks: {
    clusterName: string;
    existed: boolean;
    created: boolean;
    kubeconfigUpdated: boolean;
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
      kubeconfigUpdated: false,
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

  // 4. Install addon: eks-pod-identity-agent
  const podIdentityAddon = await createAddon(clusterName, "eks-pod-identity-agent", region, profile);
  if (podIdentityAddon.ok) {
    evidence.eks.addonsInstalled.push("eks-pod-identity-agent");
  }

  // 5. Create pod identity association for EBS CSI
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

  // 6. Install addon: aws-ebs-csi-driver
  const ebsCsiAddon = await createAddon(clusterName, "aws-ebs-csi-driver", region, profile);
  if (ebsCsiAddon.ok) {
    evidence.eks.addonsInstalled.push("aws-ebs-csi-driver");
  }

  // 7. Install StorageClass via Helm
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

  // 8. Install addon: aws-mountpoint-s3-csi-driver (via AWS CLI, not eksctl)
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
