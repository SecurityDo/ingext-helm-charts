#!/usr/bin/env tsx
/**
 * Test ALB Readiness
 * 
 * Comprehensive test to verify that the AWS Application Load Balancer is:
 * 1. Provisioned and has a hostname assigned
 * 2. In "active" state in AWS
 * 3. Accepting HTTP connections
 * 4. (Optional) DNS is configured and resolving
 */

import { readEnvFile } from "../src/tools/file.js";
import { testALBReadiness } from "../src/tools/alb.js";

async function main() {
  const args = process.argv.slice(2);
  const waitForProvisioning = args.includes("--wait");
  const testDns = args.includes("--test-dns");
  const verbose = !args.includes("--quiet");

  // Read environment configuration
  const envFile = await readEnvFile("./lakehouse_ingext.env");
  if (!envFile.ok || !envFile.env) {
    console.error("❌ Failed to read environment file");
    console.error("   Expected: ./lakehouse_ingext.env");
    process.exit(1);
  }

  const env = envFile.env;
  const namespace = env.NAMESPACE || "ingext";
  const siteDomain = env.SITE_DOMAIN;
  const profile = env.AWS_PROFILE || "default";
  const region = env.AWS_REGION || "us-east-2";

  console.error("=".repeat(60));
  console.error("🧪 Testing ALB Readiness");
  console.error("=".repeat(60));
  console.error("");
  console.error(`Namespace: ${namespace}`);
  if (siteDomain) {
    console.error(`Domain: ${siteDomain}`);
  }
  console.error("");

  const result = await testALBReadiness(
    namespace,
    profile,
    region,
    {
      waitForProvisioning,
      maxWaitMinutes: 5,
      testHttp: true,
      testDns: testDns && !!siteDomain,
      siteDomain: siteDomain,
      verbose: verbose
    }
  );

  console.error("");
  console.error("=".repeat(60));
  console.error("Test Results");
  console.error("=".repeat(60));
  console.error("");

  if (result.ready) {
    console.error("✅ ALB is READY and working");
    console.error("");
    console.error(`   Hostname: ${result.hostname}`);
    if (result.albState) {
      console.error(`   State: ${result.albState.toUpperCase()}`);
    }
    if (result.httpTest?.statusCode) {
      console.error(`   HTTP Test: ${result.httpTest.statusCode} (OK)`);
    }
    if (result.dnsTest?.resolves) {
      console.error(`   DNS Test: Resolves to ${result.dnsTest.resolvedIp || result.hostname}`);
    }
    console.error("");
    console.error(`   ${result.message}`);
    process.exit(0);
  } else {
    console.error("❌ ALB is NOT ready");
    console.error("");
    if (result.hostname) {
      console.error(`   Hostname: ${result.hostname}`);
    }
    if (result.albState) {
      console.error(`   State: ${result.albState.toUpperCase()}`);
    }
    if (result.httpTest) {
      if (result.httpTest.ok) {
        console.error(`   HTTP Test: ${result.httpTest.statusCode} (OK)`);
      } else {
        console.error(`   HTTP Test: FAILED - ${result.httpTest.error || `HTTP ${result.httpTest.statusCode}`}`);
      }
    }
    if (result.dnsTest && !result.dnsTest.resolves) {
      console.error(`   DNS Test: FAILED - ${result.dnsTest.error || "Does not resolve"}`);
    }
    console.error("");
    console.error(`   ${result.message}`);
    console.error("");
    console.error("💡 Tips:");
    if (result.albState === "provisioning") {
      console.error("   - ALB provisioning typically takes 2-5 minutes");
      console.error("   - Run with --wait to wait for provisioning");
      console.error("   - Check status: kubectl get ingress -n " + namespace);
    }
    if (result.httpTest && !result.httpTest.ok) {
      console.error("   - Check if backend pods are running: kubectl get pods -n " + namespace);
      console.error("   - Check ALB target group health in AWS Console");
    }
    if (result.dnsTest && !result.dnsTest.resolves) {
      console.error("   - Configure DNS to point to the ALB hostname");
      console.error("   - Run: npx tsx scripts/configure-dns.ts");
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Unexpected error:");
  console.error(error);
  process.exit(1);
});
