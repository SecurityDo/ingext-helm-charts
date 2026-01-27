#!/usr/bin/env tsx
/**
 * Check DNS Configuration
 * 
 * Comprehensive DNS diagnostic tool to troubleshoot "site cannot be reached" issues.
 */

import { readEnvFile } from "../src/tools/file.js";
import { kubectl } from "../src/tools/kubectl.js";
import { findHostedZoneForDomain, listHostedZones } from "../src/tools/route53.js";
import { getALBHostname, testALBReadiness } from "../src/tools/alb.js";
import { run, setExecMode } from "../src/tools/shell.js";

async function main() {
  setExecMode("docker");

  console.error("=".repeat(60));
  console.error("🔍 DNS Configuration Diagnostic");
  console.error("=".repeat(60));
  console.error("");

  // Step 1: Read environment
  const envFile = await readEnvFile("./lakehouse_ingext.env");
  if (!envFile.ok || !envFile.env) {
    console.error("❌ Failed to read environment file");
    console.error("   Expected: ./lakehouse_ingext.env");
    process.exit(1);
  }

  const env = envFile.env;
  const siteDomain = env.SITE_DOMAIN;
  const namespace = env.NAMESPACE || "ingext";
  const region = env.AWS_REGION || "us-east-2";
  const profile = env.AWS_PROFILE || "default";

  if (!siteDomain) {
    console.error("❌ SITE_DOMAIN not configured");
    process.exit(1);
  }

  console.error(`Domain: ${siteDomain}`);
  console.error(`Namespace: ${namespace}`);
  console.error(`Region: ${region}`);
  console.error("");

  // Step 2: Get ALB hostname
  console.error("📍 Step 1: Checking ALB hostname...");
  const hostnameResult = await getALBHostname(namespace, profile, region);
  
  if (!hostnameResult.hostname) {
    console.error("❌ ALB hostname not assigned");
    console.error("   The ALB is still provisioning (takes 2-5 minutes)");
    console.error("");
    console.error("💡 Wait and check again:");
    console.error("   lakehouse url");
    process.exit(1);
  }

  const albHostname = hostnameResult.hostname;
  console.error(`✓ ALB Hostname: ${albHostname}`);
  console.error("");

  // Step 3: Check Route53 hosted zone
  console.error("📍 Step 2: Checking Route53 hosted zone...");
  const domainParts = siteDomain.split(".");
  const rootDomain = domainParts.slice(-2).join(".");
  
  const zoneResult = await findHostedZoneForDomain(rootDomain);
  
  if (!zoneResult.ok || !zoneResult.zoneId) {
    console.error("❌ No Route53 hosted zone found for " + rootDomain);
    console.error("");
    console.error("💡 Solutions:");
    console.error("   1. Create Route53 hosted zone for " + rootDomain);
    console.error("   2. Or configure DNS manually in your DNS provider:");
    console.error(`      Type: CNAME`);
    console.error(`      Name: ${siteDomain}`);
    console.error(`      Target: ${albHostname}`);
    process.exit(1);
  }

  console.error(`✓ Hosted Zone: ${zoneResult.zoneName}`);
  console.error(`  Zone ID: ${zoneResult.zoneId}`);
  console.error("");

  // Step 4: Check existing DNS records
  console.error("📍 Step 3: Checking DNS records...");
  const listRecordsResult = await run("aws", [
    "route53",
    "list-resource-record-sets",
    "--hosted-zone-id",
    zoneResult.zoneId!,
    "--query",
    `ResourceRecordSets[?Name=='${siteDomain}.'] || ResourceRecordSets[?Name=='${siteDomain}']`,
    "--output",
    "json"
  ]);

  if (listRecordsResult.ok) {
    try {
      const records = JSON.parse(listRecordsResult.stdout);
      if (records && records.length > 0) {
        const record = records[0];
        console.error(`✓ DNS Record Found:`);
        console.error(`   Name: ${record.Name}`);
        console.error(`   Type: ${record.Type}`);
        
        if (record.AliasTarget) {
          console.error(`   Alias Target: ${record.AliasTarget.DNSName}`);
          if (record.AliasTarget.DNSName === albHostname) {
            console.error(`   ✓ Points to correct ALB`);
          } else {
            console.error(`   ❌ Points to wrong ALB: ${record.AliasTarget.DNSName}`);
            console.error(`      Expected: ${albHostname}`);
          }
        } else if (record.ResourceRecords) {
          console.error(`   Resource Records: ${record.ResourceRecords.map((r: any) => r.Value).join(", ")}`);
        }
      } else {
        console.error("❌ No DNS record found for " + siteDomain);
        console.error("");
        console.error("💡 Create DNS record:");
        console.error("   npx tsx scripts/configure-dns.ts");
      }
    } catch (e) {
      console.error("⚠️  Could not parse DNS records");
    }
  } else {
    console.error("⚠️  Could not list DNS records");
  }
  console.error("");

  // Step 5: Test DNS resolution
  console.error("📍 Step 4: Testing DNS resolution...");
  
  // Test with dig
  const digResult = await run("dig", ["+short", siteDomain, "@8.8.8.8"]);
  if (digResult.ok && digResult.stdout.trim()) {
    const resolved = digResult.stdout.trim().split("\n")[0];
    console.error(`✓ DNS resolves to: ${resolved}`);
    
    // Check if it resolves to ALB IPs (ALB has multiple IPs)
    if (resolved.includes(".") && /^\d+\.\d+\.\d+\.\d+$/.test(resolved)) {
      console.error(`   (IP address - this is correct for ALB)`);
    } else if (resolved.includes("elb.amazonaws.com")) {
      console.error(`   (ALB hostname - DNS is working)`);
    }
  } else {
    console.error("❌ DNS does not resolve");
    console.error("");
    console.error("💡 Possible causes:");
    console.error("   1. DNS record not created yet");
    console.error("   2. DNS propagation delay (can take 1-5 minutes)");
    console.error("   3. DNS cache (try: dig +short " + siteDomain + " @8.8.8.8)");
    console.error("");
    console.error("💡 Solutions:");
    console.error("   1. Create/update DNS record: npx tsx scripts/configure-dns.ts");
    console.error("   2. Wait 1-5 minutes for propagation");
    console.error("   3. Clear DNS cache: sudo dscacheutil -flushcache (macOS)");
  }
  console.error("");

  // Step 6: Test ALB connectivity
  console.error("📍 Step 5: Testing ALB connectivity...");
  const albTest = await testALBReadiness(
    namespace,
    profile,
    region,
    {
      waitForProvisioning: false,
      testHttp: true,
      testDns: false,
      siteDomain: siteDomain,
      verbose: false
    }
  );

  if (albTest.ready) {
    console.error("✓ ALB is ready and accepting connections");
    if (albTest.httpTest?.statusCode) {
      console.error(`   HTTP Status: ${albTest.httpTest.statusCode}`);
    }
  } else {
    console.error(`⚠️  ALB connectivity issue: ${albTest.message}`);
  }
  console.error("");

  // Step 7: Test HTTPS connection to domain
  console.error("📍 Step 6: Testing HTTPS connection to domain...");
  const curlResult = await run("curl", [
    "-s",
    "-o", "/dev/null",
    "-w", "HTTP %{http_code} | Time: %{time_total}s",
    "--connect-timeout", "10",
    "--max-time", "30",
    "-k",
    `https://${siteDomain}`
  ]);

  if (curlResult.ok) {
    const output = curlResult.stdout.trim();
    if (output.includes("HTTP 2") || output.includes("HTTP 3") || output.includes("HTTP 4")) {
      console.error(`✓ HTTPS connection works: ${output}`);
      console.error("   (HTTP 2xx/3xx/4xx means server is responding)");
    } else if (output.includes("HTTP 5")) {
      console.error(`⚠️  Server error: ${output}`);
      console.error("   (Backend may have issues, but DNS/ALB is working)");
    } else {
      console.error(`⚠️  Unexpected response: ${output}`);
    }
  } else {
    console.error("❌ HTTPS connection failed");
    console.error(`   Error: ${curlResult.stderr || curlResult.stdout}`);
    console.error("");
    console.error("💡 Possible causes:");
    console.error("   1. DNS not resolving (see Step 4)");
    console.error("   2. ALB not ready (see Step 5)");
    console.error("   3. Certificate issues");
    console.error("   4. Security group blocking traffic");
  }
  console.error("");

  // Summary
  console.error("=".repeat(60));
  console.error("📋 Summary");
  console.error("=".repeat(60));
  console.error("");
  console.error(`ALB Hostname: ${albHostname}`);
  console.error(`Site Domain: ${siteDomain}`);
  console.error("");
  console.error("💡 Next Steps:");
  
  if (!digResult.ok || !digResult.stdout.trim()) {
    console.error("   1. Create/update DNS record:");
    console.error("      npx tsx scripts/configure-dns.ts");
    console.error("   2. Wait 1-5 minutes for DNS propagation");
  } else if (!curlResult.ok) {
    console.error("   1. DNS is resolving, but HTTPS connection fails");
    console.error("   2. Check ALB target group health in AWS Console");
    console.error("   3. Check security groups allow traffic");
  } else {
    console.error("   ✓ DNS and HTTPS are working!");
    console.error(`   Open in browser: https://${siteDomain}`);
  }
  console.error("");
}

main().catch((error) => {
  console.error("❌ Unexpected error:");
  console.error(error);
  process.exit(1);
});
