import { kubectl, waitForPodsReady } from "../../tools/kubectl.js";
import { helm, upgradeInstall } from "../../tools/helm.js";
import { findHostedZoneForDomain } from "../../tools/route53.js";
import { aws, getVpcIdFromCluster } from "../../tools/aws.js";
import { createPolicy, findPolicyByName } from "../../tools/iam.js";
import { createPodIdentityAssociation } from "../../tools/eksctl.js";
import { getExecMode, run } from "../../tools/shell.js";
import { testALBReadiness } from "../../tools/alb.js";

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
  waitForALB?: boolean; // Wait for ALB to be fully provisioned and test connectivity
  testALBConnectivity?: boolean; // Test HTTP connectivity to ALB
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

  // Gate 1: Check Phase 6 pods are ready (graceful wait)
  if (verbose) console.error(`   Checking Phase 6 (Datalake) pods readiness...`);
  const phase6Wait = await waitForPodsReady(namespace, profile, region, {
    maxWaitMinutes: 5,
    verbose,
    description: "Phase 6 (Datalake) pods"
  });

  evidence.gates.phase6Healthy = phase6Wait.ok;

  // Gate 2: Check certArn is known
  evidence.gates.certArnKnown = !!certArn && certArn.length > 0;

  // Gate 3: Check siteDomain is known
  evidence.gates.siteDomainKnown = !!siteDomain && siteDomain.length > 0;

  // Validate gates
  if (!phase6Wait.ok) {
    blockers.push({
      code: "PHASE6_NOT_READY",
      message: "Phase 6 (Datalake) pods are not all ready after waiting. Ensure Phase 6 completes before Phase 7.",
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
    // ALB Controller not installed - SELF-HEAL: Install it
    if (verbose) {
      console.error("⚠️  AWS Load Balancer Controller not found. Installing now...");
    }

    const clusterName = env.CLUSTER_NAME;
    
    // 1. Create/Find IAM Policy
    const policyName = `AWSLoadBalancerControllerIAMPolicy_${clusterName}`;
    const policyCheck = await findPolicyByName(policyName, profile, region);
    let policyArn = policyCheck.arn;

    if (!policyCheck.found) {
      if (verbose) console.error(`   Creating IAM policy: ${policyName}...`);
      
      // Fetch policy document from official AWS docs using curl
      const policyUrl = "https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json";
      const curlResult = await run("curl", ["-sL", policyUrl]);
      
      if (!curlResult.ok) {
        blockers.push({
          code: "ALB_POLICY_FETCH_FAILED",
          message: `Failed to fetch IAM policy from ${policyUrl}: ${curlResult.stderr}`,
          remediation: "Check internet connection or manually create policy",
        });
        return { ok: false, evidence, blockers };
      }

      let policyDoc;
      try {
        policyDoc = JSON.parse(curlResult.stdout);
      } catch (e) {
        blockers.push({
          code: "ALB_POLICY_PARSE_FAILED",
          message: `Failed to parse IAM policy JSON: ${String(e)}`,
          remediation: "Check policy URL content",
        });
        return { ok: false, evidence, blockers };
      }

      const policyResult = await createPolicy(policyName, policyDoc, profile, region);
      if (policyResult.ok) {
        policyArn = policyResult.arn;
      } else {
        blockers.push({
          code: "ALB_POLICY_CREATE_FAILED",
          message: `Failed to create IAM policy for ALB controller: ${policyResult.error}`,
          remediation: "Check IAM permissions for creating policies",
        });
        return { ok: false, evidence, blockers };
      }
    }

    // 2. Create Pod Identity Association
    if (verbose) console.error("   Creating Pod Identity Association for ALB controller...");
    const roleName = `AWSLoadBalancerControllerRole_${clusterName}`;
    await createPodIdentityAssociation({
      cluster: clusterName,
      namespace: "kube-system",
      serviceAccountName: "aws-load-balancer-controller",
      roleName: roleName,
      permissionPolicyArns: policyArn!,
      region,
      profile,
    });

    // 3. Add EKS Helm Repo
    if (verbose) console.error("   Adding EKS Helm repository...");
    await helm(["repo", "add", "eks", "https://aws.github.io/eks-charts"], { AWS_PROFILE: profile, AWS_REGION: region });
    await helm(["repo", "update"], { AWS_PROFILE: profile, AWS_REGION: region });

    // 4. Get VPC ID
    const vpcId = await getVpcIdFromCluster(clusterName, profile, region);
    if (!vpcId) {
      blockers.push({
        code: "VPC_ID_NOT_FOUND",
        message: `Could not determine VPC ID for cluster ${clusterName}`,
        remediation: "Check EKS cluster status and AWS permissions",
      });
      return { ok: false, evidence, blockers };
    }

    // 5. Install Helm Chart
    if (verbose) console.error("   Installing aws-load-balancer-controller Helm chart...");
    const installResult = await helm(
      [
        "upgrade", "--install", "aws-load-balancer-controller", "eks/aws-load-balancer-controller",
        "-n", "kube-system",
        "--set", `clusterName=${clusterName}`,
        "--set", `region=${region}`,
        "--set", `vpcId=${vpcId}`,
        "--set", "serviceAccount.create=true",
        "--set", "serviceAccount.name=aws-load-balancer-controller",
        "--wait", "--timeout", "5m"
      ],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );

    if (installResult.ok) {
      evidence.albController.installed = true;
      evidence.albController.ready = true;
      if (verbose) console.error("✓ AWS Load Balancer Controller installed successfully");
    } else {
      blockers.push({
        code: "ALB_CONTROLLER_INSTALL_FAILED",
        message: `Failed to install ALB controller: ${installResult.stderr}`,
        remediation: "Check Helm logs and EKS permissions",
      });
      return { ok: false, evidence, blockers };
    }
  }

  // ============================================================
  // Step 2: Install Ingress Helm Chart
  // ============================================================

  if (verbose) {
    console.error("\n⏳ Step 2: Installing Ingress Helm chart...");
  }

  const clusterName = env.CLUSTER_NAME;
  const lbName = `albingext${clusterName}ingress`.toLowerCase().replace(/[^a-z0-9]/g, "");

  const startTime = Date.now();
  const ingressResult = await helm(
    [
      "upgrade", "--install", "ingext-community-ingress-aws",
      "oci://public.ecr.aws/ingext/ingext-community-ingress-aws",
      "--namespace", namespace,
      "--set", `siteDomain=${siteDomain}`,
      "--set", `certArn=${certArn}`,
      "--set", `loadBalancerName=${lbName}`,
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
  // Step 3: Detect ALB Provisioning and Test Readiness
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
  // Step 3.5: Test ALB Readiness (Optional)
  // ============================================================

  if (options.waitForALB || options.testALBConnectivity) {
    if (verbose) {
      console.error("\n⏳ Step 3.5: Testing ALB readiness...");
    }

    const albTestResult = await testALBReadiness(
      namespace,
      profile,
      region,
      {
        waitForProvisioning: options.waitForALB ?? false,
        maxWaitMinutes: 5,
        testHttp: options.testALBConnectivity ?? true,
        testDns: false, // DNS test is separate
        siteDomain: siteDomain,
        verbose: verbose
      }
    );

    if (albTestResult.ready) {
      if (verbose) {
        console.error(`✓ ${albTestResult.message}`);
        if (albTestResult.httpTest?.statusCode) {
          console.error(`   HTTP test: ${albTestResult.httpTest.statusCode}`);
        }
      }
      // Update evidence with confirmed ALB status
      if (albTestResult.hostname) {
        evidence.ingress.albDnsName = albTestResult.hostname;
      }
      evidence.ingress.albStatus = albTestResult.albState === "active" ? "ACTIVE" : "PROVISIONING";
    } else {
      if (verbose) {
        console.error(`⚠️  ${albTestResult.message}`);
      }
      // Don't block installation, but note the status
      if (albTestResult.albState === "provisioning") {
        evidence.ingress.albStatus = "PROVISIONING";
      } else if (albTestResult.albState === "failed") {
        evidence.ingress.albStatus = "NOT_READY";
      }
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
