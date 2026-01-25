import { headBucket } from "../../tools/aws.js";
import { createBucket } from "../../tools/s3.js";
import { createPolicy } from "../../tools/iam.js";
import { createPodIdentityAssociation } from "../../tools/eksctl.js";
import { kubectl } from "../../tools/kubectl.js";
export async function runPhase2Storage(env, options) {
    const verbose = options?.verbose !== false;
    const blockers = [];
    const clusterName = env.CLUSTER_NAME;
    const region = env.AWS_REGION;
    const profile = env.AWS_PROFILE;
    const bucketName = env.S3_BUCKET;
    const namespace = env.NAMESPACE || "ingext";
    // Deterministic naming
    const serviceAccountName = `${namespace}-sa`;
    const policyName = `ingext_${namespace}_S3_Policy_${clusterName}`;
    const roleName = `ingext_${serviceAccountName}_${clusterName}`;
    const evidence = {
        s3: {
            bucketName,
            existed: false,
            created: false,
            region,
        },
        iam: {
            policyName,
            policyArn: "",
            policyExisted: false,
            policyCreated: false,
            roleName,
        },
        kubernetes: {
            namespaceExisted: false,
            namespaceCreated: false,
            serviceAccountName,
            serviceAccountCreated: false,
            podIdentityAssociated: false,
        },
    };
    // 1. Check if S3 bucket exists
    const bucketCheck = await headBucket(bucketName, profile, region);
    evidence.s3.existed = bucketCheck.exists;
    // 2. Create bucket if missing
    if (!bucketCheck.exists) {
        const createResult = await createBucket(bucketName, region, profile);
        if (!createResult.ok) {
            blockers.push({
                code: "S3_BUCKET_CREATE_FAILED",
                message: `Failed to create S3 bucket: ${createResult.stderr}`,
            });
            return { ok: false, evidence, blockers };
        }
        evidence.s3.created = true;
        // Note: Encryption and public access block are best practices
        // but not blocking - we'll continue even if they fail
    }
    // 3. Generate S3 policy document
    const policyDocument = {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: ["s3:ListBucket"],
                Resource: `arn:aws:s3:::${bucketName}`,
            },
            {
                Effect: "Allow",
                Action: [
                    "s3:PutObject",
                    "s3:GetObject",
                    "s3:DeleteObject",
                    "s3:AbortMultipartUpload",
                ],
                Resource: `arn:aws:s3:::${bucketName}/*`,
            },
        ],
    };
    // 4. Create IAM policy
    const policyResult = await createPolicy(policyName, policyDocument, profile, region);
    if (!policyResult.ok) {
        blockers.push({
            code: "IAM_POLICY_CREATE_FAILED",
            message: `Failed to create IAM policy: ${policyResult.error}`,
        });
        return { ok: false, evidence, blockers };
    }
    evidence.iam.policyArn = policyResult.arn;
    evidence.iam.policyExisted = policyResult.existed || false;
    evidence.iam.policyCreated = !policyResult.existed;
    // 5. Check if namespace exists
    const nsCheckResult = await kubectl(["get", "namespace", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
    evidence.kubernetes.namespaceExisted = nsCheckResult.ok;
    // 6. Create namespace if missing
    if (!nsCheckResult.ok) {
        const nsCreateResult = await kubectl(["create", "namespace", namespace], { AWS_PROFILE: profile, AWS_REGION: region });
        if (!nsCreateResult.ok && !nsCreateResult.stderr.includes("already exists")) {
            blockers.push({
                code: "NAMESPACE_CREATE_FAILED",
                message: `Failed to create namespace: ${nsCreateResult.stderr}`,
            });
            // Not blocking - continue anyway
        }
        else {
            evidence.kubernetes.namespaceCreated = true;
        }
    }
    // 7. Check if service account exists
    const saCheckResult = await kubectl(["get", "serviceaccount", serviceAccountName, "-n", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
    // 8. Create service account if missing
    if (!saCheckResult.ok) {
        const saCreateResult = await kubectl(["create", "serviceaccount", serviceAccountName, "-n", namespace], { AWS_PROFILE: profile, AWS_REGION: region });
        if (!saCreateResult.ok && !saCreateResult.stderr.includes("already exists")) {
            blockers.push({
                code: "SERVICEACCOUNT_CREATE_FAILED",
                message: `Failed to create service account: ${saCreateResult.stderr}`,
            });
            // Not blocking - pod identity will handle it
        }
        else {
            evidence.kubernetes.serviceAccountCreated = true;
        }
    }
    // 9. Create pod identity association
    const podIdentityResult = await createPodIdentityAssociation({
        cluster: clusterName,
        namespace,
        serviceAccountName,
        roleName,
        permissionPolicyArns: evidence.iam.policyArn,
        region,
        profile,
    });
    evidence.kubernetes.podIdentityAssociated = podIdentityResult.ok;
    if (!podIdentityResult.ok && !podIdentityResult.raw.stderr.includes("already exists")) {
        blockers.push({
            code: "POD_IDENTITY_ASSOCIATION_FAILED",
            message: `Failed to create pod identity association: ${podIdentityResult.raw.stderr}`,
        });
    }
    return {
        ok: blockers.length === 0,
        evidence,
        blockers,
    };
}
