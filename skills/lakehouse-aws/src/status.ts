import { describeCluster } from "./tools/aws.js";
import { headBucket } from "./tools/aws.js";
import { getCluster } from "./tools/eksctl.js";
import { kubectl } from "./tools/kubectl.js";
import { helm } from "./tools/helm.js";
import { findCertificatesForDomain } from "./tools/acm.js";
import { findHostedZoneForDomain } from "./tools/route53.js";

export type StatusInput = {
  awsProfile: string;
  awsRegion: string;
  clusterName: string;
  s3Bucket?: string;
  namespace?: string;
  rootDomain?: string;
  siteDomain?: string;
};

export type ComponentStatus = "ready" | "deployed" | "degraded" | "missing" | "unknown";

export type StatusResult = {
  timestamp: string;
  cluster: {
    name: string;
    status: ComponentStatus;
    details?: {
      eksStatus?: string;
      kubernetesVersion?: string;
      nodeCount?: number;
      nodes?: Array<{ name: string; status: string; }>;
    };
  };
  infrastructure: {
    s3: {
      status: ComponentStatus;
      bucketName?: string;
      exists?: boolean;
    };
    route53: {
      status: ComponentStatus;
      zoneId?: string;
      zoneName?: string;
    };
    certificate: {
      status: ComponentStatus;
      arn?: string;
      domain?: string;
      validFor?: string[];
    };
  };
  kubernetes: {
    addons: {
      status: ComponentStatus;
      items: Array<{
        name: string;
        status: ComponentStatus;
        version?: string;
      }>;
    };
    storageClass: {
      status: ComponentStatus;
      name?: string;
    };
    karpenter?: {
      status: ComponentStatus;
      version?: string;
      namespace?: string;
      controllerReady?: boolean;
    };
    namespaces: Array<{
      name: string;
      status: ComponentStatus;
    }>;
    workloads?: {
      deployments: Array<{
        name: string;
        namespace: string;
        ready: number;
        desired: number;
        status: ComponentStatus;
      }>;
      statefulSets: Array<{
        name: string;
        namespace: string;
        ready: number;
        desired: number;
        status: ComponentStatus;
      }>;
      pods: Array<{
        name: string;
        namespace: string;
        status: string;
        ready: boolean;
      }>;
    };
  };
  helm: {
    releases: Array<{
      name: string;
      namespace: string;
      chart: string;
      status: string;
      revision: number;
    }>;
  };
  readiness: {
    phase1Foundation: boolean;
    phase2Storage: boolean;
    phase3Compute: boolean;
    phase4CoreServices: boolean;
    phase5Stream: boolean;
    phase6Datalake: boolean;
    phase7Ingress: boolean;
  };
  nextSteps: string[];
};

export async function runStatus(input: StatusInput): Promise<StatusResult> {
  const timestamp = new Date().toISOString();
  const nextSteps: string[] = [];

  // Initialize result structure
  const result: StatusResult = {
    timestamp,
    cluster: {
      name: input.clusterName,
      status: "unknown",
    },
    infrastructure: {
      s3: { status: "unknown" },
      route53: { status: "unknown" },
      certificate: { status: "unknown" },
    },
    kubernetes: {
      addons: { status: "unknown", items: [] },
      storageClass: { status: "unknown" },
      namespaces: [],
    },
    helm: {
      releases: [],
    },
    readiness: {
      phase1Foundation: false,
      phase2Storage: false,
      phase3Compute: false,
      phase4CoreServices: false,
      phase5Stream: false,
      phase6Datalake: false,
      phase7Ingress: false,
    },
    nextSteps,
  };

  // 1. Check EKS Cluster
  const clusterCheck = await describeCluster(input.clusterName, input.awsProfile, input.awsRegion);
  if (clusterCheck.found && clusterCheck.status === "ACTIVE") {
    result.cluster.status = "deployed";
    result.cluster.details = {
      eksStatus: clusterCheck.status,
    };

    // Try to get node information
    const nodesResult = await kubectl(["get", "nodes", "-o", "json"], {
      AWS_PROFILE: input.awsProfile,
      AWS_REGION: input.awsRegion,
    });
    
    if (nodesResult.ok) {
      try {
        const nodesData = JSON.parse(nodesResult.stdout);
        const nodes = nodesData.items || [];
        result.cluster.details.nodeCount = nodes.length;
        result.cluster.details.nodes = nodes.map((node: any) => ({
          name: node.metadata.name,
          status: node.status.conditions.find((c: any) => c.type === "Ready")?.status || "Unknown",
        }));
        
        if (nodes.length > 0) {
          result.cluster.details.kubernetesVersion = nodes[0].status.nodeInfo.kubeletVersion;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  } else if (clusterCheck.status === "CREATING" || clusterCheck.status === "UPDATING") {
    result.cluster.status = "degraded";
    result.cluster.details = { eksStatus: clusterCheck.status };
  } else {
    result.cluster.status = "missing";
    nextSteps.push("Run Phase 1: Foundation to create EKS cluster");
  }

  // 2. Check S3 Bucket
  if (input.s3Bucket) {
    const s3Check = await headBucket(input.s3Bucket, input.awsProfile, input.awsRegion);
    result.infrastructure.s3.bucketName = input.s3Bucket;
    result.infrastructure.s3.exists = s3Check.exists;
    result.infrastructure.s3.status = s3Check.exists ? "deployed" : "missing";
    
    if (!s3Check.exists) {
      nextSteps.push(`Run Phase 2: Storage to create S3 bucket: ${input.s3Bucket}`);
    }
  }

  // 3. Check Route53
  if (input.rootDomain) {
    const route53Check = await findHostedZoneForDomain(input.rootDomain);
    if (route53Check.ok && route53Check.zoneId) {
      result.infrastructure.route53.status = "deployed";
      result.infrastructure.route53.zoneId = route53Check.zoneId;
      result.infrastructure.route53.zoneName = route53Check.zoneName;
    } else {
      result.infrastructure.route53.status = "missing";
      nextSteps.push(`Create Route53 hosted zone for: ${input.rootDomain}`);
    }
  }

  // 4. Check ACM Certificate
  if (input.siteDomain && input.awsRegion) {
    const certCheck = await findCertificatesForDomain(input.siteDomain, input.awsRegion);
    if (certCheck.ok && certCheck.matches && certCheck.matches.length > 0) {
      const cert = certCheck.matches[0];
      result.infrastructure.certificate.status = "deployed";
      result.infrastructure.certificate.arn = cert.arn;
      result.infrastructure.certificate.domain = cert.domain;
      result.infrastructure.certificate.validFor = certCheck.matches.map(c => c.domain);
    } else {
      result.infrastructure.certificate.status = "missing";
      nextSteps.push(`Request ACM certificate for: ${input.siteDomain}`);
    }
  }

  // Only check Kubernetes resources if cluster is active
  if (result.cluster.status === "deployed") {
    // 5. Check EKS Addons
    const addonsToCheck = [
      "eks-pod-identity-agent",
      "aws-ebs-csi-driver",
      "aws-mountpoint-s3-csi-driver",
    ];

    for (const addonName of addonsToCheck) {
      const addonCheck = await kubectl(
        ["get", "daemonset,deployment", "-n", "kube-system", "-l", `app.kubernetes.io/name=${addonName}`, "-o", "json"],
        { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion }
      );

      let addonStatus: ComponentStatus = "missing";
      if (addonCheck.ok) {
        try {
          const data = JSON.parse(addonCheck.stdout);
          if (data.items && data.items.length > 0) {
            addonStatus = "deployed";
          }
        } catch (e) {
          addonStatus = "unknown";
        }
      }

      result.kubernetes.addons.items.push({
        name: addonName,
        status: addonStatus,
      });
    }

    const allAddonsDeployed = result.kubernetes.addons.items.every(a => a.status === "deployed");
    result.kubernetes.addons.status = allAddonsDeployed ? "deployed" : "degraded";

    // 6. Check StorageClass
    const scCheck = await kubectl(
      ["get", "storageclass", "ingext-aws-gp3", "-o", "json"],
      { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion }
    );
    
    if (scCheck.ok) {
      result.kubernetes.storageClass.status = "deployed";
      result.kubernetes.storageClass.name = "ingext-aws-gp3";
    } else {
      result.kubernetes.storageClass.status = "missing";
    }

    // 7. Check Namespaces
    const namespacesToCheck = [input.namespace || "ingext", "kube-system"];
    for (const ns of namespacesToCheck) {
      const nsCheck = await kubectl(
        ["get", "namespace", ns, "-o", "json"],
        { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion }
      );
      
      result.kubernetes.namespaces.push({
        name: ns,
        status: nsCheck.ok ? "deployed" : "missing",
      });
    }

    // 8. Check Deployments and StatefulSets in target namespace
    const ns = input.namespace || "ingext";
    const deploymentsCheck = await kubectl(
      ["get", "deployments", "-n", ns, "-o", "json"],
      { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion }
    );

    if (deploymentsCheck.ok) {
      try {
        const data = JSON.parse(deploymentsCheck.stdout);
        result.kubernetes.workloads = {
          deployments: [],
          statefulSets: [],
          pods: [],
        };

        if (data.items) {
          result.kubernetes.workloads.deployments = data.items.map((dep: any) => {
            const ready = dep.status.readyReplicas || 0;
            const desired = dep.spec.replicas || 0;
            return {
              name: dep.metadata.name,
              namespace: dep.metadata.namespace,
              ready,
              desired,
              status: (ready === desired && ready > 0) ? "deployed" : "degraded",
            };
          });
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    const statefulSetsCheck = await kubectl(
      ["get", "statefulsets", "-n", ns, "-o", "json"],
      { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion }
    );

    if (statefulSetsCheck.ok && result.kubernetes.workloads) {
      try {
        const data = JSON.parse(statefulSetsCheck.stdout);
        if (data.items) {
          result.kubernetes.workloads.statefulSets = data.items.map((sts: any) => {
            const ready = sts.status.readyReplicas || 0;
            const desired = sts.spec.replicas || 0;
            return {
              name: sts.metadata.name,
              namespace: sts.metadata.namespace,
              ready,
              desired,
              status: (ready === desired && ready > 0) ? "deployed" : "degraded",
            };
          });
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // 9. Check Pods
    const podsCheck = await kubectl(
      ["get", "pods", "-n", ns, "-o", "json"],
      { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion }
    );

    if (podsCheck.ok && result.kubernetes.workloads) {
      try {
        const data = JSON.parse(podsCheck.stdout);
        if (data.items) {
          result.kubernetes.workloads.pods = data.items.map((pod: any) => {
            const containerStatuses = pod.status.containerStatuses || [];
            const ready = containerStatuses.every((c: any) => c.ready);
            return {
              name: pod.metadata.name,
              namespace: pod.metadata.namespace,
              status: pod.status.phase,
              ready,
            };
          });
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // 10. Check Helm Releases
    const helmListCheck = await helm(
      ["list", "-A", "-o", "json"],
      { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion }
    );

    if (helmListCheck.ok) {
      try {
        const releases = JSON.parse(helmListCheck.stdout);
        result.helm.releases = releases.map((rel: any) => ({
          name: rel.name,
          namespace: rel.namespace,
          chart: rel.chart,
          status: rel.status,
          revision: rel.revision,
        }));
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  // Determine phase readiness
  // Phase 1 is complete if cluster is deployed, addons are deployed, and StorageClass is deployed
  // Check both kubectl storageclass and helm release for StorageClass
  const hasStorageClass = 
    result.kubernetes.storageClass.status === "deployed" ||
    result.helm.releases.some(r => r.name === "ingext-aws-gp3" && r.status === "deployed");
  
  result.readiness.phase1Foundation = 
    result.cluster.status === "deployed" &&
    result.kubernetes.addons.status === "deployed" &&
    hasStorageClass;

  result.readiness.phase2Storage = 
    result.readiness.phase1Foundation &&
    result.infrastructure.s3.status === "deployed";

  // Check for Karpenter and capture details
  const karpenterRelease = result.helm.releases.find(r => r.name === "karpenter");
  const hasKarpenter = !!karpenterRelease;

  if (karpenterRelease) {
    // Add Karpenter-specific details to result
    result.kubernetes.karpenter = {
      status: "deployed",
      version: karpenterRelease.chart.split("-").pop() || "unknown",
      namespace: karpenterRelease.namespace,
      controllerReady: false,
    };
    
    // Check controller deployment
    const karpenterDeployCheck = await kubectl(
      ["get", "deployment", "karpenter", "-n", "kube-system", "-o", "json"],
      { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion }
    );
    
    if (karpenterDeployCheck.ok) {
      try {
        const deploy = JSON.parse(karpenterDeployCheck.stdout);
        const ready = deploy.status.readyReplicas || 0;
        const desired = deploy.spec.replicas || 0;
        result.kubernetes.karpenter.controllerReady = (ready === desired && ready > 0);
      } catch (e) {
        result.kubernetes.karpenter.controllerReady = false;
      }
    }
  }

  result.readiness.phase3Compute = result.readiness.phase2Storage && hasKarpenter;

  const hasCoreServices = result.helm.releases.some(r => 
    r.name.includes("etcd") || r.name.includes("ingext-stack")
  );
  result.readiness.phase4CoreServices = result.readiness.phase3Compute && hasCoreServices;

  const hasStream = result.helm.releases.some(r => r.name.includes("ingext-community"));
  result.readiness.phase5Stream = result.readiness.phase4CoreServices && hasStream;

  const hasLake = result.helm.releases.some(r => r.name.includes("ingext-lake"));
  result.readiness.phase6Datalake = result.readiness.phase5Stream && hasLake;

  const hasIngress = result.helm.releases.some(r => 
    r.name.includes("ingress") || r.name.includes("alb")
  );
  result.readiness.phase7Ingress = result.readiness.phase6Datalake && hasIngress;

  // Generate next steps based on readiness
  if (!result.readiness.phase1Foundation) {
    if (result.cluster.status === "missing") {
      nextSteps.unshift("Run: npm run dev -- --approve true (Phase 1: Foundation)");
    }
  } else if (!result.readiness.phase2Storage) {
    nextSteps.push("Ready for Phase 2: Storage (S3 bucket and IAM)");
  } else if (!result.readiness.phase3Compute) {
    nextSteps.push("Ready for Phase 3: Compute (Karpenter)");
  } else if (!result.readiness.phase4CoreServices) {
    nextSteps.push("Ready for Phase 4: Core Services");
  } else if (!result.readiness.phase5Stream) {
    nextSteps.push("Ready for Phase 5: Application Stream");
  } else if (!result.readiness.phase6Datalake) {
    nextSteps.push("Ready for Phase 6: Application Datalake");
  } else if (!result.readiness.phase7Ingress) {
    nextSteps.push("Ready for Phase 7: Ingress");
  } else {
    nextSteps.push("✅ All phases complete! Lakehouse is fully deployed.");
  }

  return result;
}
