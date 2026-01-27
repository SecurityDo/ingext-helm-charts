import { run } from "./shell.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type Env = Record<string, string>;

export async function createPolicy(
  policyName: string,
  policyDocument: any,
  profile: string,
  region: string
): Promise<{ ok: boolean; arn?: string; existed?: boolean; error?: string }> {
  // Pass policy document as JSON string directly
  const policyJson = JSON.stringify(policyDocument);

  const result = await run(
    "aws",
    [
      "iam",
      "create-policy",
      "--policy-name",
      policyName,
      "--policy-document",
      policyJson,
      "--query",
      "Policy.Arn",
      "--output",
      "text",
    ],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );

  if (result.ok) {
    return { ok: true, arn: result.stdout.trim(), existed: false };
  } else if (result.stderr.includes("EntityAlreadyExists")) {
    // Policy already exists, find it
    const findResult = await findPolicyByName(policyName, profile, region);
    if (findResult.found) {
      return { ok: true, arn: findResult.arn, existed: true };
    }
    return { ok: false, error: "Policy exists but could not retrieve ARN" };
  } else {
    return { ok: false, error: result.stderr };
  }
}

export async function findPolicyByName(
  policyName: string,
  profile: string,
  region: string
): Promise<{ found: boolean; arn?: string }> {
  const result = await run(
    "aws",
    [
      "iam",
      "list-policies",
      "--query",
      `Policies[?PolicyName=='${policyName}'].Arn`,
      "--output",
      "text",
    ],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );

  if (result.ok && result.stdout.trim()) {
    return { found: true, arn: result.stdout.trim() };
  }

  return { found: false };
}

export async function getAccountId(profile: string, region: string): Promise<string | null> {
  const result = await run(
    "aws",
    ["sts", "get-caller-identity", "--query", "Account", "--output", "text"],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );

  if (result.ok) {
    return result.stdout.trim();
  }

  return null;
}

export async function deleteRole(roleName: string, profile: string) {
  // First, detach all attached policies
  const listResult = await run(
    "aws",
    [
      "iam",
      "list-attached-role-policies",
      "--role-name",
      roleName,
      "--query",
      "AttachedPolicies[*].PolicyArn",
      "--output",
      "text",
    ],
    { AWS_PROFILE: profile }
  );

  if (listResult.ok && listResult.stdout.trim()) {
    const policies = listResult.stdout.trim().split(/\s+/).filter(Boolean);
    for (const policyArn of policies) {
      await run(
        "aws",
        ["iam", "detach-role-policy", "--role-name", roleName, "--policy-arn", policyArn],
        { AWS_PROFILE: profile }
      );
    }
  }

  // Delete inline policies
  const inlineResult = await run(
    "aws",
    [
      "iam",
      "list-role-policies",
      "--role-name",
      roleName,
      "--query",
      "PolicyNames[]",
      "--output",
      "text",
    ],
    { AWS_PROFILE: profile }
  );

  if (inlineResult.ok && inlineResult.stdout.trim()) {
    const policies = inlineResult.stdout.trim().split(/\s+/).filter(Boolean);
    for (const policyName of policies) {
      await run(
        "aws",
        ["iam", "delete-role-policy", "--role-name", roleName, "--policy-name", policyName],
        { AWS_PROFILE: profile }
      );
    }
  }

  // Remove role from instance profiles (required before deletion)
  const instanceProfilesResult = await run(
    "aws",
    [
      "iam",
      "list-instance-profiles-for-role",
      "--role-name",
      roleName,
      "--query",
      "InstanceProfiles[*].InstanceProfileName",
      "--output",
      "text",
    ],
    { AWS_PROFILE: profile }
  );

  if (instanceProfilesResult.ok && instanceProfilesResult.stdout.trim()) {
    const instanceProfiles = instanceProfilesResult.stdout.trim().split(/\s+/).filter(Boolean);
    for (const instanceProfileName of instanceProfiles) {
      await run(
        "aws",
        ["iam", "remove-role-from-instance-profile", "--instance-profile-name", instanceProfileName, "--role-name", roleName],
        { AWS_PROFILE: profile }
      );
    }
  }

  // Finally, delete the role
  const deleteResult = await run(
    "aws",
    ["iam", "delete-role", "--role-name", roleName],
    { AWS_PROFILE: profile }
  );

  return deleteResult;
}

export async function deletePolicy(policyName: string, accountId: string, profile: string) {
  const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

  // Delete all non-default policy versions first
  const versionsResult = await run(
    "aws",
    [
      "iam",
      "list-policy-versions",
      "--policy-arn",
      policyArn,
      "--query",
      "Versions[?IsDefaultVersion==`false`].VersionId",
      "--output",
      "text",
    ],
    { AWS_PROFILE: profile }
  );

  if (versionsResult.ok && versionsResult.stdout.trim()) {
    const versions = versionsResult.stdout.trim().split(/\s+/).filter(Boolean);
    for (const versionId of versions) {
      await run(
        "aws",
        ["iam", "delete-policy-version", "--policy-arn", policyArn, "--version-id", versionId],
        { AWS_PROFILE: profile }
      );
    }
  }

  // Delete the policy
  const deleteResult = await run(
    "aws",
    ["iam", "delete-policy", "--policy-arn", policyArn],
    { AWS_PROFILE: profile }
  );

  return deleteResult;
}

export async function getRole(roleName: string, profile: string) {
  const result = await run(
    "aws",
    ["iam", "get-role", "--role-name", roleName],
    { AWS_PROFILE: profile }
  );
  return result;
}

export async function createRole(roleName: string, trustPolicyJson: string, profile: string) {
  const result = await run(
    "aws",
    ["iam", "create-role", "--role-name", roleName, "--assume-role-policy-document", trustPolicyJson],
    { AWS_PROFILE: profile }
  );
  return result;
}

export async function attachPolicy(roleName: string, policyArn: string, profile: string) {
  const result = await run(
    "aws",
    ["iam", "attach-role-policy", "--role-name", roleName, "--policy-arn", policyArn],
    { AWS_PROFILE: profile }
  );
  return result;
}
