#!/usr/bin/env tsx
/**
 * Configure DNS for Lakehouse
 * 
 * Automatically creates or updates Route53 DNS records to point the lakehouse
 * domain to the AWS Application Load Balancer.
 */

import { readEnvFile } from "../src/tools/file.js";
import { kubectl } from "../src/tools/kubectl.js";
import { findHostedZoneForDomain } from "../src/tools/route53.js";
import { run, setExecMode } from "../src/tools/shell.js";

// Region-specific ALB canonical hosted zone IDs
const ALB_HOSTED_ZONES: Record<string, string> = {
  "us-east-1": "Z35SXDOTRQ7X7K",
  "us-east-2": "Z3AADJGX6KTTL2",
  "us-west-1": "Z368ELLRRE2KJ0",
  "us-west-2": "Z1H1FL5HABSF5",
  "eu-west-1": "Z32O12XQLNTSW2",
  "eu-central-1": "Z215JYRZR1TBD5",
  "ap-southeast-1": "Z1LMS91P8CMLE5",
  "ap-northeast-1": "Z14GRHDCWA56QT",
};

async function main() {
  console.error("=".repeat(60));
  console.error("🌐 Configure DNS for Lakehouse");
  console.error("=".repeat(60));
  console.error("");

  // Step 1: Read environment configuration
  console.error("📋 Step 1: Reading environment configuration...");
  const envFile = await readEnvFile("./lakehouse_ingext.env");
  if (!envFile.ok || !envFile.env) {
    console.error("❌ Failed to read environment file");
    console.error("   Expected: lakehouse_ingext.env");
    process.exit(1);
  }

  const env = envFile.env;
  const siteDomain = env.SITE_DOMAIN;
  const namespace = env.NAMESPACE || "ingext";
  const region = env.AWS_REGION || "us-east-2";
  const profile = env.AWS_PROFILE || "default";

  if (!siteDomain) {
    console.error("❌ SITE_DOMAIN not configured in environment file");
    process.exit(1);
  }

  console.error(`   Domain: ${siteDomain}`);
  console.error(`   Namespace: ${namespace}`);
  console.error(`   Region: ${region}`);
  console.error("");

  // Step 2: Get ALB address from ingress
  console.error("🔍 Step 2: Getting ALB address from ingress...");
  const ingressResult = await kubectl(
    ["get", "ingress", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (!ingressResult.ok) {
    console.error("❌ Failed to query ingress");
    console.error(`   Error: ${ingressResult.stderr}`);
    console.error("");
    console.error("💡 Tip: Run Phase 7 to install ingress first:");
    console.error("   npm run dev -- --action install --exec docker");
    process.exit(1);
  }

  let albDnsName: string | undefined;
  try {
    const ingressData = JSON.parse(ingressResult.stdout);
    const ingresses = ingressData.items || [];
    
    if (ingresses.length === 0) {
      console.error("❌ No ingress objects found in namespace");
      console.error("");
      console.error("💡 Tip: Run Phase 7 to install ingress first:");
      console.error("   npm run dev -- --action install --exec docker");
      process.exit(1);
    }

    const ingress = ingresses[0];
    const lbIngress = ingress.status?.loadBalancer?.ingress?.[0];
    albDnsName = lbIngress?.hostname;

    if (!albDnsName) {
      console.error("⚠️  ALB is still provisioning (no hostname yet)");
      console.error("   This typically takes 2-5 minutes.");
      console.error("");
      console.error("💡 Tip: Wait a few minutes and try again:");
      console.error("   npx tsx scripts/configure-dns.ts");
      process.exit(1);
    }

    console.error(`   ALB DNS: ${albDnsName}`);
  } catch (e) {
    console.error("❌ Failed to parse ingress data");
    console.error(`   Error: ${e}`);
    process.exit(1);
  }
  console.error("");

  // Step 3: Find Route53 hosted zone
  console.error("🔍 Step 3: Finding Route53 hosted zone...");
  const domainParts = siteDomain.split(".");
  const rootDomain = domainParts.slice(-2).join("."); // e.g., ingext.io

  const route53Result = await findHostedZoneForDomain(rootDomain);
  
  if (!route53Result.ok || !route53Result.zoneId) {
    console.error("❌ No Route53 hosted zone found for " + rootDomain);
    console.error("");
    console.error("💡 Manual DNS Configuration Required:");
    console.error("");
    console.error("   Create a DNS record in your DNS provider:");
    console.error(`   Type:   A (Alias) or CNAME`);
    console.error(`   Name:   ${siteDomain}`);
    console.error(`   Target: ${albDnsName}`);
    console.error(`   TTL:    300`);
    console.error("");
    process.exit(1);
  }

  const zoneId = route53Result.zoneId;
  const zoneName = route53Result.zoneName || rootDomain;
  console.error(`   Hosted Zone: ${zoneName}`);
  console.error(`   Zone ID: ${zoneId}`);
  console.error("");

  // Step 4: Get ALB canonical hosted zone ID for the region
  console.error("📍 Step 4: Determining ALB hosted zone ID...");
  const albZoneId = ALB_HOSTED_ZONES[region];
  if (!albZoneId) {
    console.error(`⚠️  Unknown ALB hosted zone ID for region ${region}`);
    console.error("   Using default for us-east-2: Z3AADJGX6KTTL2");
    console.error("");
    console.error("💡 For other regions, see:");
    console.error("   https://docs.aws.amazon.com/general/latest/gr/elb.html");
  }

  const albCanonicalZoneId = albZoneId || "Z3AADJGX6KTTL2";
  console.error(`   ALB Zone ID: ${albCanonicalZoneId}`);
  console.error("");

  // Step 5: Create or update DNS record
  console.error("📝 Step 5: Creating DNS record...");
  
  const changeBatch = JSON.stringify({
    Changes: [
      {
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: siteDomain,
          Type: "A",
          AliasTarget: {
            HostedZoneId: albCanonicalZoneId,
            DNSName: albDnsName,
            EvaluateTargetHealth: true,
          },
        },
      },
    ],
  });

  const dnsResult = await run(
    "aws",
    [
      "route53",
      "change-resource-record-sets",
      "--hosted-zone-id",
      zoneId,
      "--change-batch",
      changeBatch,
    ]
  );

  if (!dnsResult.ok) {
    console.error("❌ Failed to create DNS record");
    console.error(`   Error: ${dnsResult.stderr}`);
    console.error("");
    console.error("💡 Manual command:");
    console.error(`   aws route53 change-resource-record-sets \\`);
    console.error(`     --hosted-zone-id ${zoneId} \\`);
    console.error(`     --change-batch '${changeBatch}'`);
    process.exit(1);
  }

  console.error("✓ DNS record created successfully!");
  console.error("");

  // Step 6: Verification
  console.error("🔍 Step 6: Verifying DNS configuration...");
  console.error("   Waiting 10 seconds for DNS propagation...");
  await new Promise((resolve) => setTimeout(resolve, 10000));

  const digResult = await run("dig", ["+short", siteDomain, "@8.8.8.8"]);
  if (digResult.ok && digResult.stdout.trim()) {
    console.error(`✓ DNS resolves to: ${digResult.stdout.trim().split("\n")[0]}`);
  } else {
    console.error("⚠️  DNS not yet propagated (this can take 1-5 minutes)");
  }
  console.error("");

  // Summary
  console.error("=".repeat(60));
  console.error("✅ DNS Configuration Complete");
  console.error("=".repeat(60));
  console.error("");
  console.error(`🌐 Your lakehouse is accessible at:`);
  console.error(`   https://${siteDomain}`);
  console.error("");
  console.error("📝 Next Steps:");
  console.error("   1. Wait 1-2 minutes for full DNS propagation");
  console.error("   2. Test access: curl -I https://" + siteDomain);
  console.error("   3. Open in browser: https://" + siteDomain);
  console.error("");
}

main().catch((error) => {
  console.error("❌ Unexpected error:");
  console.error(error);
  process.exit(1);
});
