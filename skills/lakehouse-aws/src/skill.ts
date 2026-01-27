import { PreflightInput } from "./schema.js";
import { headBucket, describeCluster } from "./tools/aws.js";
import { digA } from "./tools/dns.js";
import { writeEnvFile } from "./tools/file.js";
import { validateAwsAuth } from "./steps/auth.js";
import { validateRequiredVariables } from "./steps/collect.js";
import { confirmDomains } from "./steps/confirm.js";
import { checkDockerAvailable } from "./steps/checks.js";
import { findCertificatesForDomain } from "./tools/acm.js";
import { findHostedZoneForDomain } from "./tools/route53.js";

export type PreflightResult = {
  okToInstall: boolean;
  blockers: { code: string; message: string }[];
  remediation: { message: string }[];
  env: Record<string, string>;
  envFile?: string; // Namespace-scoped env file path (e.g., lakehouse_ingext.env)
  evidence: {
    awsAccountId?: string;
    awsArn?: string;
    s3BucketExists?: boolean;
    eksClusterStatus?: string;
    dnsARecord?: string | null;
    dockerVersion?: string;
    domainConfirmation?: {
      rootDomain: string;
      siteDomain: string;
      siteDomainWasConstructed: boolean;
    };
    route53ZoneId?: string;
    route53ZoneName?: string;
    certArn?: string;
    certDomain?: string;
    certIsWildcard?: boolean;
    certAutoDiscovered?: boolean;
  };
  next: { action: "install" | "stop"; reason: string };
};

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  const blockers: PreflightResult["blockers"] = [];
  const remediation: PreflightResult["remediation"] = [];
  const evidence: PreflightResult["evidence"] = {};

  // If Docker mode, check Docker availability first
  if (input.execMode === "docker") {
    const dockerCheck = await checkDockerAvailable();
    if (!dockerCheck.ok) {
      blockers.push({
        code: "DOCKER_NOT_READY",
        message: "Docker is required in docker execution mode but is not available.",
      });
      remediation.push({
        message: "⚠️  ACTION REQUIRED: Start Docker Desktop",
      });
      remediation.push({
        message: "   1. Open Docker Desktop application",
      });
      remediation.push({
        message: "   2. Wait for Docker to fully start (whale icon in menu bar should be steady)",
      });
      remediation.push({
        message: "   3. Verify with: docker version",
      });
      remediation.push({
        message: "   4. Then re-run this command",
      });
      remediation.push({
        message: "",
      });
      remediation.push({
        message: "   Alternative: Use --exec local (requires eksctl, kubectl, helm installed locally)",
      });

      return {
        okToInstall: false,
        blockers,
        remediation,
        env: {},
        evidence,
        next: { action: "stop", reason: "Docker is not available. Start Docker Desktop or use --exec local." },
      };
    }
    evidence.dockerVersion = dockerCheck.version;
  }

  // CRITICAL: Validate AWS authentication FIRST before any other checks
  // We cannot proceed with any AWS operations without valid credentials
  const authResult = await validateAwsAuth(input.awsProfile, input.awsRegion);
  if (!authResult.ok) {
    blockers.push(...authResult.blockers);
    remediation.push(...authResult.remediation);

    return {
      okToInstall: false,
      blockers,
      remediation,
      env: {},
      evidence,
      next: { action: "stop", reason: "AWS authentication required. Run 'aws sso login' or configure credentials first." },
    };
  }

  // Store AWS identity evidence
  evidence.awsAccountId = authResult.accountId;
  evidence.awsArn = authResult.arn;

  // Construct siteDomain from rootDomain if not provided
  // Pattern: lakehouse.k8.{rootDomain}
  const siteDomain = input.siteDomain ?? `lakehouse.k8.${input.rootDomain}`;
  const inputWithDomain = { ...input, siteDomain };

  // Check Route53 for domain ownership FIRST (before showing confirmation)
  const route53Check = await findHostedZoneForDomain(input.rootDomain);
  if (route53Check.ok && route53Check.zoneId) {
    evidence.route53ZoneId = route53Check.zoneId;
    evidence.route53ZoneName = route53Check.zoneName;
  }

  // Discover or validate ACM certificate BEFORE confirmation
  let certArn = input.certArn;
  if (!certArn) {
    const certSearch = await findCertificatesForDomain(siteDomain, input.awsRegion);
    
    if (certSearch.ok && certSearch.matches && certSearch.matches.length > 0) {
      // Prefer exact matches over wildcard
      const exactMatch = certSearch.matches.find(m => !m.wildcard);
      const selectedCert = exactMatch || certSearch.matches[0];
      
      certArn = selectedCert.arn;
      evidence.certArn = certArn;
      evidence.certDomain = selectedCert.domain;
      evidence.certIsWildcard = selectedCert.wildcard;
      evidence.certAutoDiscovered = true;
    } else if (certSearch.ok) {
      blockers.push({
        code: "NO_CERTIFICATE",
        message: `No ACM certificate found covering ${siteDomain} in ${input.awsRegion}`,
      });
      remediation.push({
        message: `Create an ACM certificate for ${siteDomain} or use --cert-arn to specify one`,
      });
      remediation.push({
        message: `Certificates must be in ${input.awsRegion} and in ISSUED status`,
      });
    } else {
      blockers.push({
        code: "ACM_CHECK_FAILED",
        message: `Failed to query ACM: ${certSearch.error}`,
      });
    }
  } else {
    // User provided cert ARN explicitly - validate it
    console.error(`⏳ Validating provided certificate: ${certArn}...`);
    const { describeCertificate } = await import("./tools/acm.js");
    const certDescribe = await describeCertificate(certArn, input.awsRegion);
    
    if (!certDescribe.ok) {
      blockers.push({
        code: "INVALID_CERT_ARN",
        message: `Failed to describe certificate ${certArn}: ${certDescribe.error}`,
      });
      remediation.push({
        message: `Verify the certificate ARN is correct and in ${input.awsRegion}`,
      });
      remediation.push({
        message: `List certificates: aws acm list-certificates --region ${input.awsRegion}`,
      });
    } else {
      const cert = certDescribe.data?.Certificate;
      const certStatus = cert?.Status;
      const certDomain = cert?.DomainName;
      const certSubjectAltNames = cert?.SubjectAlternativeNames || [];
      
      // Check certificate status
      if (certStatus !== "ISSUED") {
        blockers.push({
          code: "CERT_NOT_ISSUED",
          message: `Certificate ${certArn} status is ${certStatus}, must be ISSUED`,
        });
        remediation.push({
          message: `Wait for certificate validation to complete or use a different certificate`,
        });
      }
      
      // Check if certificate covers the domain
      const domainCovered = certSubjectAltNames.some((san: string) => {
        // Exact match
        if (san === siteDomain) return true;
        // Wildcard match
        if (san.startsWith("*.")) {
          const wildcardBase = san.slice(2);
          return siteDomain.endsWith(wildcardBase);
        }
        return false;
      });
      
      if (!domainCovered) {
        blockers.push({
          code: "CERT_DOMAIN_MISMATCH",
          message: `Certificate does not cover ${siteDomain}. Covers: ${certSubjectAltNames.join(", ")}`,
        });
        remediation.push({
          message: `Use a certificate that covers ${siteDomain} or update --domain to match the certificate`,
        });
      }
      
      // If validation passed, store evidence
      if (certStatus === "ISSUED" && domainCovered) {
        evidence.certArn = certArn;
        evidence.certDomain = certDomain;
        evidence.certIsWildcard = certDomain?.startsWith("*.");
        evidence.certAutoDiscovered = false;
        console.error(`✓ Certificate validated: ${certDomain} (status: ${certStatus})`);
      }
    }
  }

  // NOW show domain confirmation with discovery results
  const domainConfirmation = confirmDomains(input, siteDomain, {
    route53Found: !!evidence.route53ZoneId,
    route53ZoneId: evidence.route53ZoneId,
    route53ZoneName: evidence.route53ZoneName,
    certFound: !!certArn,
    certArn: certArn,
    certDomain: evidence.certDomain,
    certIsWildcard: evidence.certIsWildcard,
  });
  
  // Add domain confirmation to evidence
  evidence.domainConfirmation = {
    rootDomain: domainConfirmation.rootDomain,
    siteDomain: domainConfirmation.siteDomain,
    siteDomainWasConstructed: domainConfirmation.siteDomainWasConstructed,
  };

  // Print domain confirmation message to console
  console.error(domainConfirmation.message);

  // Add warnings as blockers if domain issues detected
  if (domainConfirmation.warnings.length > 0) {
    blockers.push(...domainConfirmation.warnings);
  }

  // Validate all required variables are set and valid
  // This ensures the user has provided all necessary configuration before proceeding
  const validationResult = validateRequiredVariables({ ...inputWithDomain, certArn });
  if (!validationResult.ok) {
    blockers.push(...validationResult.blockers);
    remediation.push(...validationResult.remediation);

    return {
      okToInstall: false,
      blockers,
      remediation,
      env: {},
      evidence,
      next: { action: "stop", reason: "Required variables missing or invalid. Please provide all required configuration." },
    };
  }

  // Now that we have AWS access and valid inputs, proceed with readiness gates
  if (!input.readiness.hasBilling) blockers.push({ code: "NO_BILLING", message: "Billing must be enabled to create EKS/S3 resources." });
  if (!input.readiness.hasAdmin) blockers.push({ code: "NO_ADMIN", message: "Admin permissions are required (IAM/VPC/EKS)." });
  if (!input.readiness.hasDns) blockers.push({ code: "NO_DNS", message: `You must control DNS for ${siteDomain}.` });

  // Template bucket default once we know accountId
  const s3Bucket = (input.s3Bucket ?? `ingext-lakehouse-${authResult.accountId}`).toLowerCase().replace(/[^a-z0-9]/g, "");

  // Checks
  console.error(`\n⏳ Checking S3 bucket: ${s3Bucket}...`);
  const b = await headBucket(s3Bucket, input.awsProfile, input.awsRegion);
  evidence.s3BucketExists = b.exists;
  console.error(`✓ S3 bucket ${b.exists ? "exists" : "not found"}`);

  console.error(`⏳ Checking EKS cluster: ${input.clusterName}...`);
  const c = await describeCluster(input.clusterName, input.awsProfile, input.awsRegion);
  evidence.eksClusterStatus = c.status;
  console.error(`✓ EKS cluster status: ${c.status}`);

  if (input.dnsCheck) {
    const d = await digA(siteDomain);
    if (d.ok) evidence.dnsARecord = (d as any).ip;
  }

  console.error(`⏳ Building environment configuration...`);
  const env: Record<string, string> = {
    AWS_PROFILE: input.awsProfile,
    AWS_REGION: input.awsRegion,
    CLUSTER_NAME: input.clusterName,
    S3_BUCKET: s3Bucket,
    ROOT_DOMAIN: input.rootDomain,
    SITE_DOMAIN: siteDomain,
    CERT_ARN: certArn ?? "",
    NAMESPACE: input.namespace,
    NODE_TYPE: input.nodeType,
    NODE_COUNT: String(input.nodeCount),
    PREFLIGHT_HAS_BILLING: String(input.readiness.hasBilling),
    PREFLIGHT_HAS_ADMIN: String(input.readiness.hasAdmin),
    PREFLIGHT_HAS_DNS: String(input.readiness.hasDns),
  };

  // Optional env file artifact
  // Compute namespace-scoped env file path
  // Default: lakehouse_{namespace}.env (e.g., lakehouse_ingext.env)
  const envFilePath = input.outputEnvPath || `./lakehouse_${input.namespace}.env`;
  
  // Check if we can proceed (no blockers so far)
  let okToInstall = blockers.length === 0;
  
  if (input.writeEnvFile && okToInstall) {
    const lines = [
      "# Generated by Lakehouse.AWS preflight skill",
      `# Namespace: ${env.NAMESPACE}`,
      `export AWS_PROFILE="${env.AWS_PROFILE}"`,
      `export AWS_REGION="${env.AWS_REGION}"`,
      `export CLUSTER_NAME="${env.CLUSTER_NAME}"`,
      `export S3_BUCKET="${env.S3_BUCKET}"`,
      `export ROOT_DOMAIN="${env.ROOT_DOMAIN}"`,
      `export SITE_DOMAIN="${env.SITE_DOMAIN}"`,
      ...(certArn ? [`export CERT_ARN="${env.CERT_ARN}"`] : [`# CERT_ARN not discovered or provided`]),
      `export NAMESPACE="${env.NAMESPACE}"`,
      `export NODE_TYPE="${env.NODE_TYPE}"`,
      `export NODE_COUNT="${env.NODE_COUNT}"`,
      `export PREFLIGHT_HAS_BILLING="${env.PREFLIGHT_HAS_BILLING}"`,
      `export PREFLIGHT_HAS_ADMIN="${env.PREFLIGHT_HAS_ADMIN}"`,
      `export PREFLIGHT_HAS_DNS="${env.PREFLIGHT_HAS_DNS}"`,
    ];
    const w = await writeEnvFile(envFilePath, lines, input.overwriteEnv);
    if (!w.ok) {
      blockers.push({ code: "ENV_WRITE_BLOCKED", message: w.error });
    } else {
      console.error(`✓ Environment file written to: ${envFilePath}`);
    }
  }

  // Recompute okToInstall after potential blocker from env file write
  okToInstall = blockers.length === 0;

  console.error(`\n⏳ Preflight complete. okToInstall=${okToInstall}`);

  return {
    okToInstall,
    blockers,
    remediation,
    env,
    envFile: envFilePath,
    evidence,
    next: okToInstall ? { action: "install", reason: "Preflight passed." } : { action: "stop", reason: "Resolve blockers." },
  };
}