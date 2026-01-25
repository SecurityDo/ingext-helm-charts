import { kubectl } from "../../tools/kubectl.js";
import { helm } from "../../tools/helm.js";
import { findHostedZoneForDomain } from "../../tools/route53.js";

export type Phase7Evidence = {
  gates: {
    phase6Healthy: boolean;
    certArnKnown: boolean;
    siteDomainKnown: boolean;
  };
  albController: {
    installed: boolean;
    namespace: string;
    ready: boolean;
    deploymentName?: string;
  };
  ingress: {
    releaseInstalled: boolean;
    ingressName?: string;
    albDnsName?: string;
    albStatus?: string; // "PROVISIONING" | "ACTIVE" | "PENDING" | "NOT_READY"
    certAttached: boolean;
  };
  dns: {
    route53Available: boolean;
    zoneId?: string;
    zoneName?: string;
    instruction: string; // DNS setup guidance
  };
  helm: {
    releases: Array<{
      name: string;
      status: string;
      revision: number;
      chart: string;
      elapsedSeconds?: number;
      error?: string;
    }>;
  };
};

export type Phase7Options = {
  force?: boolean;
  verbose?: boolean;
};

export async function runPhase7Ingress(
  env: Record<string, string>,
  options: Phase7Options = {}
): Promise<{
  ok: boolean;
  evidence: Phase7Evidence;
  blockers: Array<{ code: string; message: string; remediation?: string }>;
}> {
  const verbose = options.verbose ?? true;
  const namespace = env.NAMESPACE || "ingext";
  const siteDomain = env.SITE_DOMAIN;
  const certArn = env.CERT_ARN;
  const profile = env.AWS_PROFILE || "default";
  const region = env.AWS_REGION || "us-east-2";

  const evidence: Phase7Evidence = {
    gates: {
      phase6Healthy: false,
      certArnKnown: false,
      siteDomainKnown: false,
    },
    albController: {
      installed: false,
      namespace: "kube-system",
      ready: false,
    },
    ingress: {
      releaseInstalled: false,
      certAttached: false,
    },
    dns: {
      route53Available: false,
      instruction: "",
    },
    helm: {
      releases: [],
    },
  };

  const blockers: Array<{ code: string; message: string; remediation?: string }> = [];

  // ============================================================
  // Gate Checks (Non-blocking, evidence only)
  // ============================================================

  // Gate 1: Check Phase 6 pods are ready
  const phase6PodsCheck = await kubectl(
    ["get", "pods", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (phase6PodsCheck.ok) {
    try {
      const podsData = JSON.parse(phase6PodsCheck.stdout);
      const pods = podsData.items || [];
      const activePods = pods.filter((p: any) => {
        const phase = p.status?.phase;
        if (phase === "Succeeded" || phase === "Failed") return false;
        const ownerRefs = p.metadata?.ownerReferences || [];
        const isCronJobPod = ownerRefs.some((ref: any) => ref.kind === "Job" && p.metadata.name.includes("cronjob"));
        if (isCronJobPod) return false;
        return true;
      });

      const allReady = activePods.every((p: any) => {
        const readyCondition = p.status?.conditions?.find((c: any) => c.type === "Ready");
        return readyCondition && readyCondition.status === "True";
      });

      evidence.gates.phase6Healthy = allReady && activePods.length > 0;
    } catch (e) {
      evidence.gates.phase6Healthy = false;
    }
  }

  // Gate 2: Check certArn is known
  evidence.gates.certArnKnown = !!certArn && certArn.length > 0;

  // Gate 3: Check siteDomain is known
  evidence.gates.siteDomainKnown = !!siteDomain && siteDomain.length > 0;

  // Validate gates
  if (!evidence.gates.phase6Healthy) {
    blockers.push({
      code: "PHASE6_NOT_READY",
      message: "Phase 6 (Datalake) pods are not all ready. Ensure Phase 6 completes before Phase 7.",
      remediation: "Check pod status: kubectl get pods -n " + namespace,
    });
  }

  if (!evidence.gates.certArnKnown) {
    blockers.push({
      code: "CERT_ARN_MISSING",
      message: "ACM certificate ARN is not configured. Cannot create Ingress without TLS certificate.",
      remediation: "Run preflight to discover certificate or specify --cert-arn",
    });
  }

  if (!evidence.gates.siteDomainKnown) {
    blockers.push({
      code: "SITE_DOMAIN_MISSING",
      message: "Site domain is not configured. Cannot create Ingress without domain.",
      remediation: "Specify --domain or ensure env file contains SITE_DOMAIN",
    });
  }

  // If gates fail, return early (but not with --force)
  if (blockers.length > 0 && !options.force) {
    return { ok: false, evidence, blockers };
  }

  // ============================================================
  // Step 1: Verify/Install AWS Load Balancer Controller
  // ============================================================

  if (verbose) {
    console.error("\n⏳ Step 1: Checking AWS Load Balancer Controller...");
  }

  // Check if ALB controller deployment exists
  const albControllerCheck = await kubectl(
    ["get", "deployment", "aws-load-balancer-controller", "-n", "kube-system", "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (albControllerCheck.ok) {
    evidence.albController.installed = true;
    evidence.albController.deploymentName = "aws-load-balancer-controller";
    
    try {
      const deployment = JSON.parse(albControllerCheck.stdout);
      const ready = deployment.status?.readyReplicas || 0;
      const desired = deployment.spec?.replicas || 0;
      evidence.albController.ready = ready === desired && ready > 0;
      
      if (verbose) {
        console.error(`✓ AWS Load Balancer Controller already installed (${ready}/${desired} replicas)`);
      }
    } catch (e) {
      evidence.albController.ready = false;
      if (verbose) {
        console.error("✓ AWS Load Balancer Controller deployment exists");
      }
    }
  } else {
    // ALB Controller not installed
    if (verbose) {
      console.error("⚠️  AWS Load Balancer Controller not found");
      console.error("   This is typically installed during cluster setup.");
      console.error("   Phase 7 will continue, but ALB provisioning may fail.");
    }
    
    blockers.push({
      code: "ALB_CONTROLLER_MISSING",
      message: "AWS Load Balancer Controller is not installed in kube-system namespace.",
      remediation: "Install ALB Controller: https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html",
    });
    
    // Don't fail hard - operator may have it installed differently
    if (!options.force) {
      return { ok: false, evidence, blockers };
    }
  }

  // ============================================================
  // Step 2: Install Ingress Helm Chart
  // ============================================================

  if (verbose) {
    console.error("\n⏳ Step 2: Installing Ingress Helm chart...");
  }

  const startTime = Date.now();
  const ingressResult = await helm(
    [
      "upgrade", "--install", "ingext-community-ingress-aws",
      "oci://public.ecr.aws/ingext/ingext-community-ingress-aws",
      "--namespace", namespace,
      "--set", `siteDomain=${siteDomain}`,
      "--set", `certArn=${certArn}`,
      // No --wait flag (non-blocking)
    ],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

  if (ingressResult.ok) {
    evidence.ingress.releaseInstalled = true;
    evidence.helm.releases.push({
      name: "ingext-community-ingress-aws",
      status: "deployed",
      revision: 1,
      chart: "oci://public.ecr.aws/ingext/ingext-community-ingress-aws",
      elapsedSeconds,
    });
    
    if (verbose) {
      console.error(`✓ Ingress Helm chart installed (${elapsedSeconds}s)`);
    }
  } else {
    evidence.helm.releases.push({
      name: "ingext-community-ingress-aws",
      status: "failed",
      revision: 0,
      chart: "oci://public.ecr.aws/ingext/ingext-community-ingress-aws",
      elapsedSeconds,
      error: ingressResult.stderr,
    });
    
    blockers.push({
      code: "INGRESS_HELM_INSTALL_FAILED",
      message: `Failed to install ingext-community-ingress-aws Helm chart: ${ingressResult.stderr}`,
      remediation: "Check Helm chart availability and namespace permissions",
    });
    
    return { ok: false, evidence, blockers };
  }

  // ============================================================
  // Step 3: Detect ALB Provisioning (Non-Blocking)
  // ============================================================

  if (verbose) {
    console.error("\n⏳ Step 3: Querying Ingress object...");
  }

  // Wait a moment for ingress to be created
  await new Promise(resolve => setTimeout(resolve, 2000));

  const ingressCheck = await kubectl(
    ["get", "ingress", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (ingressCheck.ok) {
    try {
      const ingressData = JSON.parse(ingressCheck.stdout);
      const ingresses = ingressData.items || [];
      
      if (ingresses.length > 0) {
        const ingress = ingresses[0];
        evidence.ingress.ingressName = ingress.metadata?.name;
        
        // Check cert annotation
        const certArnAnnotation = ingress.metadata?.annotations?.["alb.ingress.kubernetes.io/certificate-arn"];
        evidence.ingress.certAttached = certArnAnnotation === certArn;
        
        // Extract ALB DNS name (may not be ready yet)
        const lbIngress = ingress.status?.loadBalancer?.ingress?.[0];
        if (lbIngress?.hostname) {
          evidence.ingress.albDnsName = lbIngress.hostname;
          evidence.ingress.albStatus = "ACTIVE"; // If hostname is present, assume active or provisioning
          
          if (verbose) {
            console.error(`✓ ALB DNS name: ${lbIngress.hostname}`);
          }
        } else {
          evidence.ingress.albStatus = "PROVISIONING";
          
          if (verbose) {
            console.error("⏳ ALB is being provisioned by AWS (this takes 2-5 minutes)");
          }
        }
        
        if (verbose && evidence.ingress.certAttached) {
          console.error(`✓ TLS certificate attached: ${certArn.substring(0, 50)}...`);
        }
      } else {
        if (verbose) {
          console.error("⚠️  No ingress objects found in namespace");
        }
        evidence.ingress.albStatus = "NOT_READY";
      }
    } catch (e) {
      if (verbose) {
        console.error("⚠️  Failed to parse ingress data");
      }
      evidence.ingress.albStatus = "UNKNOWN";
    }
  } else {
    if (verbose) {
      console.error("⚠️  Could not query ingress objects");
    }
  }

  // ============================================================
  // Step 4: DNS Instruction Output (Do NOT Block)
  // ============================================================

  if (verbose) {
    console.error("\n⏳ Step 4: Generating DNS setup instructions...");
  }

  // Check for Route53 hosted zone
  // Extract root domain from siteDomain (e.g., "lakehouse.k8.ingext.io" -> "ingext.io")
  const domainParts = siteDomain.split(".");
  const rootDomain = domainParts.slice(-2).join("."); // Last two parts

  const route53Check = await findHostedZoneForDomain(rootDomain);
  
  if (route53Check.ok && route53Check.zoneId) {
    evidence.dns.route53Available = true;
    evidence.dns.zoneId = route53Check.zoneId;
    evidence.dns.zoneName = route53Check.zoneName || undefined;
    
    evidence.dns.instruction = `DNS can be auto-created for ${siteDomain}
Run with --approve-dns to apply automatically
(DNS auto-creation not yet implemented)`;
    
    if (verbose) {
      console.error(`✓ Route53 hosted zone found: ${route53Check.zoneName}`);
      console.error(`   Zone ID: ${route53Check.zoneId}`);
      console.error("");
      console.error("💡 DNS can be configured automatically (future feature)");
    }
  } else {
    evidence.dns.route53Available = false;
    
    const albDns = evidence.ingress.albDnsName || "<ALB-DNS-will-appear-here>";
    evidence.dns.instruction = `Create a DNS record manually:

Type: CNAME
Name: ${siteDomain}
Target: ${albDns}
TTL: 300`;
    
    if (verbose) {
      console.error("ℹ️  No Route53 hosted zone found for " + rootDomain);
      console.error("");
      console.error("📝 Manual DNS Setup Required:");
      console.error("   " + evidence.dns.instruction.split("\n").join("\n   "));
    }
  }

  // ============================================================
  // Phase 7 Complete
  // ============================================================

  return {
    ok: true,
    evidence,
    blockers: [], // No blockers if we got here
  };
}
