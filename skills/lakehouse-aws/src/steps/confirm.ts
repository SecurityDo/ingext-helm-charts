import { PreflightInput } from "../schema.js";

export type DomainConfirmation = {
  rootDomain: string;
  siteDomain: string;
  siteDomainWasConstructed: boolean;
  message: string;
  warnings: Array<{ code: string; message: string }>;
};

export type DiscoveryContext = {
  route53Found: boolean;
  route53ZoneId?: string;
  route53ZoneName?: string;
  certFound: boolean;
  certArn?: string;
  certDomain?: string;
  certIsWildcard?: boolean;
};

/**
 * Confirms domain configuration with the user.
 * Displays the root domain and site domain, and provides contextual feedback
 * based on what was discovered in Route53 and ACM.
 */
export function confirmDomains(
  input: PreflightInput,
  siteDomain: string,
  discovery?: DiscoveryContext
): DomainConfirmation {
  const siteDomainWasConstructed = !input.siteDomain;
  
  const constructionNote = siteDomainWasConstructed
    ? `                 ↑ Constructed as: ${siteDomain}
                 (k8 is a common subdomain pattern for Kubernetes)`
    : `                 ↑ Explicitly provided by user`;

  // Build DNS status message
  let dnsStatus: string;
  if (discovery?.route53Found) {
    dnsStatus = `
✓ DNS Ready:     Route53 hosted zone found: ${discovery.route53ZoneName}
                 Zone ID: ${discovery.route53ZoneId}
                 DNS records can be automatically created during installation.`;
  } else {
    dnsStatus = `
⚠️  DNS Warning:  No Route53 hosted zone found for: ${input.rootDomain}
                 You must manually configure DNS records.
                 Create an A/CNAME record pointing ${siteDomain} to your load balancer.`;
  }

  // Build certificate status message
  let certStatus: string;
  if (discovery?.certFound) {
    const certType = discovery.certIsWildcard ? "Wildcard" : "Exact match";
    certStatus = `
✓ Certificate:   ${certType} certificate found: ${discovery.certDomain}
                 ARN: ${discovery.certArn}
                 Valid for: ${siteDomain}`;
  } else {
    certStatus = `
⚠️  Certificate:  No ACM certificate found covering: ${siteDomain}
                 You must create an ACM certificate in ${input.awsRegion}.
                 Request at: https://console.aws.amazon.com/acm/`;
  }

  // Build action items
  let actionItems: string;
  if (discovery?.route53Found && discovery?.certFound) {
    actionItems = `
✓ Ready:         All prerequisites met. You can proceed with installation.`;
  } else {
    const items: string[] = [];
    if (!discovery?.route53Found) {
      items.push("   1. Set up Route53 hosted zone OR prepare manual DNS configuration");
    }
    if (!discovery?.certFound) {
      items.push(`   ${items.length + 1}. Create ACM certificate for ${siteDomain} in ${input.awsRegion}`);
    }
    actionItems = `
⚠️  Action Required:
${items.join('\n')}`;
  }

  const message = `
═══════════════════════════════════════════════════════════════
Domain Configuration
═══════════════════════════════════════════════════════════════

Root Domain:     ${input.rootDomain}
                 ↑ This is YOUR domain (e.g., ingext.io, example.com)

Site Domain:     ${siteDomain}
${constructionNote}
                 This is where your Lakehouse will be accessible.
${dnsStatus}
${certStatus}
${actionItems}

═══════════════════════════════════════════════════════════════
`;

  const warnings: Array<{ code: string; message: string }> = [];
  if (discovery && !discovery.route53Found) {
    warnings.push({
      code: "NO_ROUTE53_ZONE",
      message: `No Route53 hosted zone found for ${input.rootDomain}. Manual DNS configuration required.`,
    });
  }
  if (discovery && !discovery.certFound) {
    warnings.push({
      code: "NO_ACM_CERTIFICATE",
      message: `No ACM certificate found covering ${siteDomain}. Certificate creation required.`,
    });
  }

  return {
    rootDomain: input.rootDomain,
    siteDomain,
    siteDomainWasConstructed,
    message,
    warnings,
  };
}
