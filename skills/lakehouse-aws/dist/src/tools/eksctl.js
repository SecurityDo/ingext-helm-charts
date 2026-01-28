import { run } from "./shell.js";
export async function eksctl(args, env) {
    return run("eksctl", args, env);
}
export async function getCluster(name, region, profile) {
    const res = await eksctl(["get", "cluster", "--name", name, "--region", region], { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region });
    return { exists: res.ok, raw: res };
}
export async function createCluster(config) {
    const args = [
        "create",
        "cluster",
        "--name",
        config.name,
        "--region",
        config.region,
        "--version",
        config.version,
        "--nodegroup-name",
        config.nodegroupName,
        "--node-type",
        config.nodeType,
        "--nodes",
        String(config.nodeCount),
        "--managed",
    ];
    // Note: eksctl create cluster outputs progress to stderr, which we capture
    // The command itself takes ~15 minutes, but eksctl shows progress
    return eksctl(args, { AWS_PROFILE: config.profile, AWS_DEFAULT_REGION: config.region });
}
export async function createNodegroup(config) {
    const args = [
        "create",
        "nodegroup",
        "--cluster",
        config.clusterName,
        "--region",
        config.region,
        "--name",
        config.nodegroupName,
        "--node-type",
        config.nodeType,
        "--nodes",
        String(config.nodeCount),
        "--managed",
    ];
    return eksctl(args, { AWS_PROFILE: config.profile, AWS_DEFAULT_REGION: config.region });
}
export async function createAddon(cluster, addon, region, profile) {
    const res = await eksctl(["create", "addon", "--cluster", cluster, "--name", addon, "--region", region], { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region });
    // Ignore errors if addon already exists (idempotency)
    return { ok: res.ok || res.stderr.includes("already exists"), raw: res };
}
export async function createPodIdentityAssociation(config) {
    const args = [
        "create",
        "podidentityassociation",
        "--cluster",
        config.cluster,
        "--namespace",
        config.namespace,
        "--service-account-name",
        config.serviceAccountName,
        "--role-name",
        config.roleName,
        "--permission-policy-arns",
        config.permissionPolicyArns,
        "--region",
        config.region,
    ];
    const res = await eksctl(args, { AWS_PROFILE: config.profile, AWS_DEFAULT_REGION: config.region });
    // If eksctl fails, try AWS CLI as fallback (eksctl can be finicky)
    if (!res.ok && !res.stderr.includes("already exists")) {
        const { aws } = await import("./aws.js");
        // Need role ARN for AWS CLI
        const roleRes = await aws(["iam", "get-role", "--role-name", config.roleName], config.profile, config.region);
        if (roleRes.ok) {
            try {
                const roleData = JSON.parse(roleRes.stdout);
                const roleArn = roleData.Role.Arn;
                const awsRes = await aws([
                    "eks", "create-pod-identity-association",
                    "--cluster-name", config.cluster,
                    "--namespace", config.namespace,
                    "--service-account", config.serviceAccountName,
                    "--role-arn", roleArn,
                    "--region", config.region
                ], config.profile, config.region);
                if (awsRes.ok || awsRes.stderr.includes("ResourceInUseException")) {
                    return { ok: true, raw: awsRes };
                }
            }
            catch (e) {
                // Fallback to original error
            }
        }
    }
    // Ignore errors if already exists (idempotency)
    return { ok: res.ok || res.stderr.includes("already exists"), raw: res };
}
export async function deleteCluster(name, region, profile) {
    return eksctl(["delete", "cluster", "--name", name, "--region", region, "--wait"], { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region });
}
