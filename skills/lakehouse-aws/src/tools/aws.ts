import { run } from "./shell.js";

export async function aws(args: string[], awsProfile: string, awsRegion: string) {
  return run("aws", args, { AWS_PROFILE: awsProfile, AWS_DEFAULT_REGION: awsRegion });
}

export async function getCallerIdentity(awsProfile: string, awsRegion: string) {
  const res = await aws(["sts", "get-caller-identity", "--output", "json"], awsProfile, awsRegion);
  if (!res.ok) return { ok: false as const, error: res.stderr || res.stdout };

  try {
    const j = JSON.parse(res.stdout);
    return { ok: true as const, accountId: j.Account as string, arn: j.Arn as string, userId: j.UserId as string };
  } catch {
    return { ok: false as const, error: "Failed to parse sts get-caller-identity output" };
  }
}

export async function headBucket(bucket: string, awsProfile: string, awsRegion: string) {
  const res = await aws(["s3api", "head-bucket", "--bucket", bucket], awsProfile, awsRegion);
  return { exists: res.ok, raw: res };
}

export async function describeCluster(clusterName: string, awsProfile: string, awsRegion: string) {
  const res = await aws(
    ["eks", "describe-cluster", "--name", clusterName, "--query", "cluster.status", "--output", "text"],
    awsProfile,
    awsRegion
  );
  return { found: res.ok, status: res.ok ? res.stdout : "NOT_FOUND", raw: res };
}