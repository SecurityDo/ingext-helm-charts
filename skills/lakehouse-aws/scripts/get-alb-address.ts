#!/usr/bin/env tsx
/**
 * Get ALB Address
 * 
 * Retrieve the AWS Application Load Balancer DNS address from the Kubernetes ingress.
 */

import { readEnvFile } from "../src/tools/file.js";
import { kubectl } from "../src/tools/kubectl.js";

async function main() {
  // Read environment configuration
  const envFile = await readEnvFile("./lakehouse_ingext.env");
  if (!envFile.ok || !envFile.env) {
    console.error("❌ Failed to read environment file");
    process.exit(1);
  }

  const env = envFile.env;
  const namespace = env.NAMESPACE || "ingext";
  const siteDomain = env.SITE_DOMAIN;
  const profile = env.AWS_PROFILE || "default";
  const region = env.AWS_REGION || "us-east-2";

  console.error("=".repeat(60));
  console.error("🔍 Getting ALB Address");
  console.error("=".repeat(60));
  console.error("");
  console.error(`Domain: ${siteDomain}`);
  console.error(`Namespace: ${namespace}`);
  console.error("");

  // Query ingress
  const ingressResult = await kubectl(
    ["get", "ingress", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (!ingressResult.ok) {
    console.error("❌ Failed to query ingress");
    console.error(`   Error: ${ingressResult.stderr}`);
    console.error("");
    console.error("💡 Tip: Run Phase 7 to install ingress:");
    console.error("   npm run dev -- --action install --exec docker");
    process.exit(1);
  }

  try {
    const ingressData = JSON.parse(ingressResult.stdout);
    const ingresses = ingressData.items || [];
    
    if (ingresses.length === 0) {
      console.error("❌ No ingress objects found");
      console.error("");
      console.error("💡 Tip: Run Phase 7 to install ingress:");
      console.error("   npm run dev -- --action install --exec docker");
      process.exit(1);
    }

    const ingress = ingresses[0];
    const ingressName = ingress.metadata?.name;
    const certArn = ingress.metadata?.annotations?.["alb.ingress.kubernetes.io/certificate-arn"];
    const lbIngress = ingress.status?.loadBalancer?.ingress?.[0];
    const albDnsName = lbIngress?.hostname;

    console.error("📋 Ingress Details:");
    console.error(`   Name: ${ingressName}`);
    console.error(`   Namespace: ${namespace}`);
    console.error("");

    if (albDnsName) {
      console.error("✅ ALB Provisioned:");
      console.error("");
      console.log(albDnsName); // Output to stdout for scripting
      console.error("");
      console.error(`   ${albDnsName}`);
      console.error("");
      
      if (certArn) {
        console.error("🔒 TLS Certificate:");
        console.error(`   ${certArn.substring(0, 60)}...`);
        console.error("");
      }

      console.error("📝 Next Steps:");
      console.error("   1. Configure DNS: npx tsx scripts/configure-dns.ts");
      console.error("   2. Or create manual DNS record:");
      console.error(`      Type:   A (Alias) or CNAME`);
      console.error(`      Name:   ${siteDomain}`);
      console.error(`      Target: ${albDnsName}`);
      console.error(`      TTL:    300`);
    } else {
      console.error("⏳ ALB Status: PROVISIONING");
      console.error("");
      console.error("   The ALB is being created by AWS.");
      console.error("   This typically takes 2-5 minutes.");
      console.error("");
      console.error("💡 Tip: Wait a few minutes and try again:");
      console.error("   npx tsx scripts/get-alb-address.ts");
      process.exit(1);
    }
  } catch (e) {
    console.error("❌ Failed to parse ingress data");
    console.error(`   Error: ${e}`);
    process.exit(1);
  }

  console.error("=".repeat(60));
}

main().catch((error) => {
  console.error("❌ Unexpected error:");
  console.error(error);
  process.exit(1);
});
