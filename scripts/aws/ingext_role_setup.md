# Ingext Application: AWS Role & Permission Setup

This document outlines how to configure AWS IAM permissions for the **Ingext** application running on EKS.

## Architecture Overview

Ingext uses the **"Assume Role"** pattern to access AWS resources (like S3 buckets). This is a security best practice that decouples the application's identity from its permissions.

1. **Source Identity:** The application runs as a specific IAM role (`ingext-sa-role`).
2. **Target Role:** You create a specific role that holds the permissions (e.g., S3 Read/Write).
3. **The Handshake:** You authorize the Source Identity to "assume" (switch to) the Target Role temporarily to perform tasks.

!

This setup works identically whether the resources are in the **same AWS account** or a **different (external) AWS account**.

---

## Prerequisites

1. **AWS CLI** installed (`v2` recommended).
2. **Bash** environment (Linux, Mac, or WSL).
3. **IAM Permissions:** The credentials you use to run these scripts must have administrative privileges (ability to create Roles and attach Policies).
4. **Policy File:** A JSON file defining the specific permissions you want to grant Ingext.

### Example: `s3-policy.json`

Create a file named `s3-policy.json` with the specific access rules:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::your-target-bucket-name",
        "arn:aws:s3:::your-target-bucket-name/*"
      ]
    }
  ]
}

## Scenario A: Same-Account Setup

*Use this when the Ingext application and the S3 bucket are in the **same** AWS Account.*

**Script:** `internal-role_setup.sh`

### Usage

```bash
./internal-role_setup.sh <profile> <ingext-sa-role> <new_role_name> <policy_file>

```

| Argument | Description |
| --- | --- |
| `<profile>` | Your local AWS CLI profile name (e.g., `default`). |
| `<ingext-sa-role>` | The existing role used by the Ingext application (Source). |
| `<new_role_name>` | The name for the new role being created (Target). |
| `<policy_file>` | Path to the JSON policy file created in Prerequisites. Set it to '-' for stdin |

### Example Command

```bash
./internal-role_setup.sh default ingext-sa-role IngextS3AccessRole s3-policy.json

# Generate policy for 'my-internal-logs' bucket and pipe to setup
./s3_policy_gen.sh my-internal-logs | \
./internal-role_setup.sh default ingext-sa-role IngextInternalAccessRole -
```

## Scenario B: Cross-Account Setup

*Use this when the Ingext application is in **Account A** and the S3 bucket is in **Account B** (External Customer).*

**Script:** `external-role_setup.sh`

### Usage

```bash
./external-role_setup.sh <local_profile> <ingext-sa-role> <remote_profile> <remote_role_name> <policy_file>

```

| Argument | Description |
| --- | --- |
| `<local_profile>` | AWS CLI profile for the account running Ingext (Source). |
| `<ingext-sa-role>` | The existing role used by the Ingext application. |
| `<remote_profile>` | AWS CLI profile for the customer/target account. |
| `<remote_role_name>` | The name for the new role to be created in the customer account. |
| `<policy_file>` | Path to the JSON policy file. Set it to '-' for stdin |

### Example Command

```bash
# We use 'ingext-prod' profile for our app and 'customer-dev' profile for the target
./external-role_setup.sh ingext-prod ingext-sa-role customer-dev IngextS3AccessRole s3-policy.json

# OR use the pipe | and pass - as the last argument to the setup script.
./s3_policy_gen.sh my-customer-data-bucket | \
./external-role_setup.sh ingext-prod ingext-sa-role customer-dev IngextS3AccessRole -


# On a remote AWS account, configure S3 bucket with event notification, then setup role to read from ingext 
./s3_policy_gen.sh my-customer-data-bucket | \
./external-role_setup.sh ingext-prod ingext-sa-role customer-dev IngextS3AccessRole -

```

## Validation

After running the appropriate script, verify the setup:

1. **Target Role Check:** Go to the IAM Console (Target Account) -> Roles -> Find the new role.
* **Trust Relationship:** Verify it trusts `arn:aws:iam::[SOURCE-ID]:role/ingext-sa-role`.
* **Permissions:** Verify the `s3-policy.json` contents are attached.

2. **Source Role Check:** Go to IAM Console (Source Account) -> Roles -> `ingext-sa-role`.
* **Permissions:** Verify there is an inline policy allowing `sts:AssumeRole` on the specific Target Role ARN.

## Next Steps for the Application

Once the roles are created, provide the **Target Role ARN** to the Ingext application configuration.

**Target Role ARN Format:**
`arn:aws:iam::[TARGET-ACCOUNT-ID]:role/[NEW-ROLE-NAME]`

