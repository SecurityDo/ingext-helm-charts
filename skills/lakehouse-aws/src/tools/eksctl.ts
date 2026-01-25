import { run } from "./shell.js";

export type Env = Record<string, string>;

export async function eksctl(args: string[], env?: Env) {
  return run("eksctl", args, env);
}

export async function getCluster(name: string, region: string, profile: string) {
  const res = await eksctl(
    ["get", "cluster", "--name", name, "--region", region],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );
  return { exists: res.ok, raw: res };
}

export type CreateClusterConfig = {
  name: string;
  region: string;
  profile: string;
  version: string;
  nodegroupName: string;
  nodeType: string;
  nodeCount: number;
};

export async function createCluster(config: CreateClusterConfig) {
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

export type CreateNodegroupConfig = {
  clusterName: string;
  nodegroupName: string;
  nodeType: string;
  nodeCount: number;
  region: string;
  profile: string;
};

export async function createNodegroup(config: CreateNodegroupConfig) {
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

export async function createAddon(cluster: string, addon: string, region: string, profile: string) {
  const res = await eksctl(
    ["create", "addon", "--cluster", cluster, "--name", addon, "--region", region],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );
  // Ignore errors if addon already exists (idempotency)
  return { ok: res.ok || res.stderr.includes("already exists"), raw: res };
}

export type PodIdentityConfig = {
  cluster: string;
  namespace: string;
  serviceAccountName: string;
  roleName: string;
  permissionPolicyArns: string;
  region: string;
  profile: string;
};

export async function createPodIdentityAssociation(config: PodIdentityConfig) {
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
  // Ignore errors if already exists (idempotency)
  return { ok: res.ok || res.stderr.includes("already exists"), raw: res };
}

export async function deleteCluster(name: string, region: string, profile: string) {
  return eksctl(
    ["delete", "cluster", "--name", name, "--region", region, "--wait"],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );
}
