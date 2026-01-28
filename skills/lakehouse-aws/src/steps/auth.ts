import { getCallerIdentity } from "../tools/aws.js";

export type AuthResult =
  | { ok: true; accountId: string; arn: string; userId: string }
  | {
      ok: false;
      blockers: Array<{ code: string; message: string }>;
      remediation: Array<{ message: string }>;
    };

/**
 * Validates AWS authentication and returns identity or blockers.
 * This is a critical first step - no AWS operations can proceed without valid credentials.
 */
export async function validateAwsAuth(
  awsProfile: string,
  awsRegion: string
): Promise<AuthResult> {
  const ident = await getCallerIdentity(awsProfile, awsRegion);

  if (!ident.ok) {
    return {
      ok: false,
      blockers: [
        {
          code: "AWS_NOT_AUTHENTICATED",
          message: `AWS CLI is not authenticated for profile "${awsProfile}" in region "${awsRegion}". You must authenticate before running preflight.`,
        },
      ],
      remediation: [
        {
          message: "💡 Preferred Fix: Use the Docker Shell",
        },
        {
          message: "   1. Start the Docker shell:",
        },
        {
          message: "      ./lakehouse-aws/start-docker-shell.sh",
        },
        {
          message: "      (This drops you into a container with all tools pre-installed)",
        },
        {
          message: "   2. Run authentication inside that shell:",
        },
        {
          message: `      aws configure --profile ${awsProfile}`,
        },
        {
          message: "",
        },
        {
          message: "Alternative (if running locally):",
        },
        {
          message: `  - If using SSO: run 'aws sso login --profile ${awsProfile}'`,
        },
        {
          message: `  - If using access keys: run 'aws configure --profile ${awsProfile}'`,
        },
        {
          message: `  - Verify your AWS credentials are valid and have not expired`,
        },
      ],
    };
  }

  return {
    ok: true,
    accountId: ident.accountId,
    arn: ident.arn,
    userId: ident.userId,
  };
}
