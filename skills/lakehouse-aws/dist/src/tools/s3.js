import { run } from "./shell.js";
export async function createBucket(bucket, region, profile) {
    // us-east-1 doesn't use LocationConstraint parameter
    if (region === "us-east-1") {
        return run("aws", ["s3api", "create-bucket", "--bucket", bucket, "--region", region], { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region });
    }
    else {
        return run("aws", [
            "s3api",
            "create-bucket",
            "--bucket",
            bucket,
            "--region",
            region,
            "--create-bucket-configuration",
            `LocationConstraint=${region}`,
        ], { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region });
    }
}
export async function putBucketEncryption(bucket, region, profile) {
    return run("aws", [
        "s3api",
        "put-bucket-encryption",
        "--bucket",
        bucket,
        "--server-side-encryption-configuration",
        JSON.stringify({
            Rules: [
                {
                    ApplyServerSideEncryptionByDefault: {
                        SSEAlgorithm: "AES256",
                    },
                    BucketKeyEnabled: true,
                },
            ],
        }),
    ], { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region });
}
export async function putPublicAccessBlock(bucket, region, profile) {
    return run("aws", [
        "s3api",
        "put-public-access-block",
        "--bucket",
        bucket,
        "--public-access-block-configuration",
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
    ], { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region });
}
export async function deleteBucket(bucket, region, profile) {
    return run("aws", ["s3", "rb", `s3://${bucket}`, "--force", "--region", region], { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region });
}
