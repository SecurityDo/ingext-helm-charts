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
