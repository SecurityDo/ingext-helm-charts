/**
 * Validates that all required variables are set and valid for installation.
 * This ensures the user has provided all necessary configuration before proceeding.
 * Note: certArn is now optional as it can be auto-discovered from ACM.
 */
export function validateRequiredVariables(input) {
    const blockers = [];
    const remediation = [];
    // Validate: Certificate ARN format (if provided)
    // Note: certArn can be auto-discovered from ACM, so it's only validated if explicitly provided
    if (input.certArn && !input.certArn.startsWith("arn:aws:acm:")) {
        blockers.push({
            code: "INVALID_CERT_ARN_FORMAT",
            message: `Certificate ARN must be a valid ACM ARN starting with "arn:aws:acm:". Got: ${input.certArn.substring(0, 50)}...`,
        });
        remediation.push({
            message: "Certificate ARN format: arn:aws:acm:<region>:<account-id>:certificate/<cert-id>",
        });
    }
    // Validate: Cluster name should be reasonable
    if (input.clusterName.length < 3) {
        blockers.push({
            code: "INVALID_CLUSTER_NAME",
            message: `Cluster name "${input.clusterName}" is too short. Must be at least 3 characters.`,
        });
        remediation.push({
            message: "Provide a cluster name with: --cluster <name>",
        });
    }
    // Validate: Root domain should look like a valid domain
    const domainRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
    if (!domainRegex.test(input.rootDomain)) {
        blockers.push({
            code: "INVALID_ROOT_DOMAIN_FORMAT",
            message: `Root domain "${input.rootDomain}" does not appear to be a valid domain name.`,
        });
        remediation.push({
            message: "Provide a valid root domain with: --root-domain <your-domain.com>",
        });
        remediation.push({
            message: "Example: --root-domain ingext.io or --root-domain example.com",
        });
        remediation.push({
            message: `The full site domain will be constructed as: lakehouse.k8.${input.rootDomain}`,
        });
    }
    // Validate: Site domain (if explicitly provided) should be valid
    if (input.siteDomain) {
        if (!domainRegex.test(input.siteDomain)) {
            blockers.push({
                code: "INVALID_SITE_DOMAIN_FORMAT",
                message: `Site domain "${input.siteDomain}" does not appear to be a valid domain name.`,
            });
            remediation.push({
                message: "Provide a valid site domain with: --domain <your-site-domain.com>",
            });
            remediation.push({
                message: "Or omit --domain to use the default pattern: lakehouse.k8.{root-domain}",
            });
        }
    }
    // Validate: Node count should be reasonable
    if (input.nodeCount < 1) {
        blockers.push({
            code: "INVALID_NODE_COUNT",
            message: `Node count must be at least 1. Got: ${input.nodeCount}`,
        });
        remediation.push({
            message: "Provide a valid node count with: --node-count <number>",
        });
    }
    // Validate: Node type should be specified
    if (!input.nodeType || input.nodeType.trim() === "") {
        blockers.push({
            code: "MISSING_NODE_TYPE",
            message: "Node instance type is required.",
        });
        remediation.push({
            message: "Provide a node type with: --node-type <instance-type>",
        });
        remediation.push({
            message: "Example: --node-type t3.large",
        });
    }
    return {
        ok: blockers.length === 0,
        blockers,
        remediation,
    };
}
