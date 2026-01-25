import { getCallerIdentity } from "../tools/aws.js";
/**
 * Validates AWS authentication and returns identity or blockers.
 * This is a critical first step - no AWS operations can proceed without valid credentials.
 */
export async function validateAwsAuth(awsProfile, awsRegion) {
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
                    message: `If using SSO: run 'aws sso login --profile ${awsProfile}'`,
                },
                {
                    message: `If using access keys: run 'aws configure --profile ${awsProfile}'`,
                },
                {
                    message: `Verify your AWS credentials are valid and have not expired`,
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
