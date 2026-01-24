import { PreflightInput } from "../schema.js";

export type DomainConfirmation = {
  rootDomain: string;
  siteDomain: string;
  siteDomainWasConstructed: boolean;
  message: string;
  warnings: Array<{ code: string; message: string }>;
};

/**
 * Confirms domain configuration with the user.
 * Provides clear information about root domain and site domain usage.
 */
export function confirmDomains(input: PreflightInput, constructedSiteDomain: string): DomainConfirmation {
  const siteDomainWasConstructed = !input.siteDomain;
  const siteDomain = input.siteDomain ?? constructedSiteDomain;
  const warnings: Array<{ code: string; message: string }> = [];

  // Build confirmation message
  let message = `\n`;
  message += `═══════════════════════════════════════════════════════════════\n`;
  message += `Domain Configuration Confirmation\n`;
  message += `═══════════════════════════════════════════════════════════════\n\n`;
  message += `Root Domain:     ${input.rootDomain}\n`;
  message += `                 ↑ This is YOUR domain (e.g., ingext.io, example.com)\n`;
  message += `                 You must control DNS for this domain.\n\n`;
  
  message += `Site Domain:     ${siteDomain}\n`;
  if (siteDomainWasConstructed) {
    message += `                 ↑ Constructed as: lakehouse.k8.${input.rootDomain}\n`;
    message += `                 (k8 is a common subdomain pattern for Kubernetes)\n`;
  } else {
    message += `                 ↑ You provided this custom domain\n`;
  }
  message += `                 This is where your Lakehouse will be accessible.\n\n`;

  message += `Certificate:     Must be valid for: ${siteDomain}\n`;
  message += `                 The ACM certificate ARN you provide must cover this domain.\n\n`;

  // Add warnings if domain doesn't match expected pattern
  if (!siteDomain.includes(input.rootDomain)) {
    warnings.push({
      code: "DOMAIN_MISMATCH",
      message: `Site domain "${siteDomain}" does not contain root domain "${input.rootDomain}". Make sure this is intentional.`,
    });
  }

  if (siteDomainWasConstructed && !siteDomain.startsWith("lakehouse.k8.")) {
    warnings.push({
      code: "UNEXPECTED_PATTERN",
      message: `Site domain pattern is unexpected. Expected: lakehouse.k8.{rootDomain}`,
    });
  }

  message += `⚠️  IMPORTANT: Ensure you:\n`;
  message += `   1. Control DNS for: ${input.rootDomain}\n`;
  message += `   2. Have an ACM certificate for: ${siteDomain}\n`;
  message += `   3. Can create DNS records pointing to your AWS Load Balancer\n\n`;
  message += `═══════════════════════════════════════════════════════════════\n`;

  return {
    rootDomain: input.rootDomain,
    siteDomain,
    siteDomainWasConstructed,
    message,
    warnings,
  };
}
