/**
 * AWS Application Load Balancer (ALB) Testing and Verification Utilities
 */

import { kubectl } from "./kubectl.js";
import { aws } from "./aws.js";
import { run } from "./shell.js";

export type ALBReadinessResult = {
  ready: boolean;
  hostname?: string;
  ip?: string;
  albState?: "active" | "provisioning" | "failed" | "unknown";
  httpTest?: {
    ok: boolean;
    statusCode?: number;
    error?: string;
  };
  dnsTest?: {
    resolves: boolean;
    resolvedIp?: string;
    error?: string;
  };
  message: string;
};

/**
 * Get ALB hostname from Kubernetes ingress
 */
export async function getALBHostname(
  namespace: string,
  awsProfile: string,
  awsRegion: string
): Promise<{ ok: boolean; hostname?: string; error?: string }> {
  const ingressResult = await kubectl(
    ["get", "ingress", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: awsProfile, AWS_REGION: awsRegion }
  );

  if (!ingressResult.ok) {
    return { ok: false, error: ingressResult.stderr };
  }

  try {
    const ingressData = JSON.parse(ingressResult.stdout);
    const ingresses = ingressData.items || [];
    
    if (ingresses.length === 0) {
      return { ok: false, error: "No ingress objects found" };
    }

    const ingress = ingresses[0];
    const lbIngress = ingress.status?.loadBalancer?.ingress?.[0];
    const hostname = lbIngress?.hostname;
    const ip = lbIngress?.ip;

    return { ok: true, hostname: hostname || ip };
  } catch (e) {
    return { ok: false, error: `Failed to parse ingress data: ${String(e)}` };
  }
}

/**
 * Get ALB state from AWS API
 */
export async function getALBState(
  hostname: string,
  awsProfile: string,
  awsRegion: string
): Promise<{ ok: boolean; state?: "active" | "provisioning" | "failed" | "unknown"; error?: string }> {
  // Extract ALB name from hostname (e.g., "alb-xxx-xxx.us-east-2.elb.amazonaws.com" -> "alb-xxx-xxx")
  const albNameMatch = hostname.match(/^([^.]+)/);
  if (!albNameMatch) {
    return { ok: false, error: "Could not extract ALB name from hostname" };
  }

  // Try to find ALB by DNS name
  const result = await aws(
    [
      "elbv2",
      "describe-load-balancers",
      "--query",
      `LoadBalancers[?DNSName=='${hostname}'].{State:State.Code,DNSName:DNSName}`,
      "--output",
      "json"
    ],
    awsProfile,
    awsRegion
  );

  if (!result.ok) {
    // ALB might not be in AWS API yet (still provisioning)
    return { ok: true, state: "provisioning" };
  }

  try {
    const lbs = JSON.parse(result.stdout);
    if (lbs.length === 0) {
      return { ok: true, state: "provisioning" };
    }

    const state = lbs[0].State?.toLowerCase();
    if (state === "active") {
      return { ok: true, state: "active" };
    } else if (state === "provisioning" || state === "creating") {
      return { ok: true, state: "provisioning" };
    } else if (state === "failed" || state === "deleting") {
      return { ok: true, state: "failed" };
    } else {
      return { ok: true, state: "unknown" };
    }
  } catch (e) {
    return { ok: false, error: `Failed to parse ALB state: ${String(e)}` };
  }
}

/**
 * Test HTTP connectivity to ALB
 */
export async function testALBConnectivity(
  hostname: string,
  path: string = "/health-check",
  useHttps: boolean = true
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const protocol = useHttps ? "https" : "http";
  const url = `${protocol}://${hostname}${path}`;

  // Use curl to test connectivity
  const curlResult = await run("curl", [
    "-s",
    "-o", "/dev/null",
    "-w", "%{http_code}",
    "--connect-timeout", "10",
    "--max-time", "30",
    "-k", // Ignore SSL certificate errors (useful for testing)
    url
  ]);

  if (!curlResult.ok) {
    return {
      ok: false,
      error: curlResult.stderr || "Connection failed"
    };
  }

  const statusCode = parseInt(curlResult.stdout.trim(), 10);
  const isSuccess = statusCode >= 200 && statusCode < 500; // Accept 2xx, 3xx, 4xx as "working" (5xx might indicate backend issues)

  return {
    ok: isSuccess,
    statusCode
  };
}

/**
 * Test DNS resolution for a domain
 */
export async function testDNSResolution(
  domain: string
): Promise<{ resolves: boolean; resolvedIp?: string; error?: string }> {
  // Try dig first, fall back to nslookup
  let result = await run("dig", ["+short", domain]);
  
  if (!result.ok || !result.stdout.trim()) {
    // Fallback to nslookup
    result = await run("nslookup", [domain]);
    if (result.ok && result.stdout) {
      // Parse nslookup output
      const ipMatch = result.stdout.match(/Address:\s*(\d+\.\d+\.\d+\.\d+)/);
      if (ipMatch) {
        return { resolves: true, resolvedIp: ipMatch[1] };
      }
    }
    return { resolves: false, error: "DNS resolution failed" };
  }

  const ip = result.stdout.trim().split("\n")[0];
  if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return { resolves: true, resolvedIp: ip };
  }

  // If dig returns a CNAME, try to resolve it
  if (result.stdout.includes("elb.amazonaws.com")) {
    // It's an ALB hostname, which is fine
    return { resolves: true };
  }

  return { resolves: false, error: "Could not parse DNS response" };
}

/**
 * Comprehensive ALB readiness test
 * 
 * Checks:
 * 1. Ingress has ALB hostname assigned
 * 2. ALB is in "active" state in AWS
 * 3. HTTP connectivity works
 * 4. (Optional) DNS resolution works
 */
export async function testALBReadiness(
  namespace: string,
  awsProfile: string,
  awsRegion: string,
  options: {
    waitForProvisioning?: boolean;
    maxWaitMinutes?: number;
    testHttp?: boolean;
    testDns?: boolean;
    siteDomain?: string;
    verbose?: boolean;
  } = {}
): Promise<ALBReadinessResult> {
  const {
    waitForProvisioning = false,
    maxWaitMinutes = 5,
    testHttp = true,
    testDns = false,
    siteDomain,
    verbose = false
  } = options;

  // Step 1: Get ALB hostname from ingress
  if (verbose) {
    process.stderr.write("   Checking ingress for ALB hostname...\n");
  }

  let hostnameResult = await getALBHostname(namespace, awsProfile, awsRegion);
  let waitStartTime = Date.now();
  const maxWaitMs = maxWaitMinutes * 60 * 1000;

  // Wait for hostname to appear if requested
  if (waitForProvisioning && !hostnameResult.hostname) {
    if (verbose) {
      process.stderr.write("   ⏳ Waiting for ALB hostname to be assigned...\n");
    }

    while (!hostnameResult.hostname && (Date.now() - waitStartTime) < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Check every 5 seconds
      hostnameResult = await getALBHostname(namespace, awsProfile, awsRegion);
      
      if (verbose && !hostnameResult.hostname) {
        process.stderr.write("   ⏳ Still waiting for ALB hostname...\n");
      }
    }
  }

  if (!hostnameResult.hostname) {
    return {
      ready: false,
      albState: "provisioning",
      message: "ALB hostname not yet assigned. ALB is still being provisioned by AWS (typically takes 2-5 minutes)."
    };
  }

  const hostname = hostnameResult.hostname;

  // Step 2: Check ALB state in AWS
  if (verbose) {
    process.stderr.write(`   Checking ALB state in AWS for ${hostname}...\n`);
  }

  const albStateResult = await getALBState(hostname, awsProfile, awsRegion);
  const albState = albStateResult.state || "unknown";

  if (albState === "provisioning") {
    if (waitForProvisioning && (Date.now() - waitStartTime) < maxWaitMs) {
      // Continue waiting
      if (verbose) {
        process.stderr.write("   ⏳ ALB is still provisioning, waiting...\n");
      }
      
      while (albState === "provisioning" && (Date.now() - waitStartTime) < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10 seconds
        const stateCheck = await getALBState(hostname, awsProfile, awsRegion);
        if (stateCheck.state === "active") {
          break;
        }
      }
    } else {
      return {
        ready: false,
        hostname,
        albState: "provisioning",
        message: "ALB hostname assigned but ALB is still provisioning in AWS. This typically takes 2-5 minutes."
      };
    }
  }

  if (albState === "failed") {
    return {
      ready: false,
      hostname,
      albState: "failed",
      message: "ALB is in failed state. Check AWS Console for details."
    };
  }

  // Step 3: Test HTTP connectivity
  let httpTest;
  if (testHttp) {
    if (verbose) {
      process.stderr.write(`   Testing HTTP connectivity to ${hostname}...\n`);
    }

    httpTest = await testALBConnectivity(hostname, "/health-check", true);
    
    if (!httpTest.ok) {
      return {
        ready: false,
        hostname,
        albState: albState as "active" | "provisioning" | "failed" | "unknown",
        httpTest,
        message: `ALB is provisioned but HTTP connectivity test failed: ${httpTest.error || `HTTP ${httpTest.statusCode}`}`
      };
    }
  }

  // Step 4: Test DNS resolution (optional)
  let dnsTest;
  if (testDns && siteDomain) {
    if (verbose) {
      process.stderr.write(`   Testing DNS resolution for ${siteDomain}...\n`);
    }

    dnsTest = await testDNSResolution(siteDomain);
    
    if (!dnsTest.resolves) {
      return {
        ready: false,
        hostname,
        albState: albState as "active" | "provisioning" | "failed" | "unknown",
        httpTest,
        dnsTest,
        message: `ALB is working but DNS for ${siteDomain} does not resolve. Configure DNS to point to ${hostname}.`
      };
    }
  }

  // All tests passed
  return {
    ready: true,
    hostname,
    albState: albState as "active" | "provisioning" | "failed" | "unknown",
    httpTest,
    dnsTest,
    message: `ALB is ready and working. Hostname: ${hostname}`
  };
}
