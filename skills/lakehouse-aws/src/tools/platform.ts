import { kubectl } from "./kubectl.js";

export type PlatformHealthResult = {
  healthy: boolean;
  nodes: {
    total: number;
    ready: number;
    notReady: number;
  };
  coredns: {
    ready: boolean;
    replicas: { ready: number; desired: number };
  };
  blockers: Array<{ code: string; message: string }>;
};

export async function checkPlatformHealth(
  profile: string,
  region: string
): Promise<PlatformHealthResult> {
  const blockers: Array<{ code: string; message: string }> = [];
  
  const result: PlatformHealthResult = {
    healthy: true,
    nodes: { total: 0, ready: 0, notReady: 0 },
    coredns: { ready: false, replicas: { ready: 0, desired: 0 } },
    blockers,
  };

  // 1. Check nodes exist and are Ready
  const nodesCheck = await kubectl(["get", "nodes", "-o", "json"], {
    AWS_PROFILE: profile,
    AWS_REGION: region,
  });

  if (nodesCheck.ok) {
    try {
      const nodesData = JSON.parse(nodesCheck.stdout);
      const nodes = nodesData.items || [];
      result.nodes.total = nodes.length;
      
      if (nodes.length === 0) {
        result.healthy = false;
        blockers.push({
          code: "NO_NODES_AVAILABLE",
          message: "Cluster has no worker nodes. Phase 1 may have failed to create node group.",
        });
      } else {
        for (const node of nodes) {
          const readyCondition = node.status.conditions.find((c: any) => c.type === "Ready");
          if (readyCondition && readyCondition.status === "True") {
            result.nodes.ready++;
          } else {
            result.nodes.notReady++;
          }
        }
        
        if (result.nodes.ready === 0) {
          result.healthy = false;
          blockers.push({
            code: "NO_READY_NODES",
            message: `Cluster has ${result.nodes.total} node(s) but none are Ready`,
          });
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  // 2. Check CoreDNS is Ready (critical for cluster scheduling)
  const corednsCheck = await kubectl(
    ["get", "deployment", "coredns", "-n", "kube-system", "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (corednsCheck.ok) {
    try {
      const deployment = JSON.parse(corednsCheck.stdout);
      const ready = deployment.status.readyReplicas || 0;
      const desired = deployment.spec.replicas || 0;
      result.coredns.replicas = { ready, desired };
      result.coredns.ready = ready === desired && ready > 0;
      
      if (!result.coredns.ready) {
        result.healthy = false;
        blockers.push({
          code: "COREDNS_NOT_READY",
          message: `CoreDNS is not ready (${ready}/${desired} replicas). Cluster DNS may not function.`,
        });
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  return result;
}
