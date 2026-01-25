import { run } from "./shell";
export async function listCertificates(region) {
    const result = await run("aws", ["acm", "list-certificates", "--region", region, "--output", "json"], { AWS_REGION: region });
    if (!result.ok) {
        return { ok: false, error: result.stderr };
    }
    try {
        return { ok: true, data: JSON.parse(result.stdout) };
    }
    catch {
        return { ok: false, error: "Failed to parse ACM list response" };
    }
}
export async function describeCertificate(arn, region) {
    const result = await run("aws", ["acm", "describe-certificate", "--certificate-arn", arn, "--region", region, "--output", "json"], { AWS_REGION: region });
    if (!result.ok) {
        return { ok: false, error: result.stderr };
    }
    try {
        return { ok: true, data: JSON.parse(result.stdout) };
    }
    catch {
        return { ok: false, error: "Failed to parse ACM describe response" };
    }
}
/**
 * Find certificates that cover a specific domain (exact or wildcard match)
 */
export async function findCertificatesForDomain(domain, region) {
    const listResult = await listCertificates(region);
    if (!listResult.ok) {
        return { ok: false, error: listResult.error };
    }
    const certificates = listResult.data?.CertificateSummaryList || [];
    const matches = [];
    for (const cert of certificates) {
        // Only consider ISSUED certificates
        if (cert.Status !== "ISSUED")
            continue;
        const certDomain = cert.DomainName || "";
        // Exact match
        if (certDomain === domain) {
            matches.push({
                arn: cert.CertificateArn,
                domain: certDomain,
                status: cert.Status,
                wildcard: false,
            });
            continue;
        }
        // Wildcard match (*.example.com covers lakehouse.k8.example.com)
        if (certDomain.startsWith("*.")) {
            const wildcardBase = certDomain.slice(2); // Remove "*."
            if (domain.endsWith(wildcardBase)) {
                matches.push({
                    arn: cert.CertificateArn,
                    domain: certDomain,
                    status: cert.Status,
                    wildcard: true,
                });
            }
        }
    }
    return { ok: true, matches };
}
