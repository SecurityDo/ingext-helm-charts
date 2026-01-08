# Requesting an ACM Certificate for AWS Lakehouse

To enable secure HTTPS traffic for your Lakehouse deployment, you must have a valid SSL certificate in **AWS Certificate Manager (ACM)**. This certificate must be in the **same region** as your EKS cluster.

## Step 1: Request the Certificate

1.  Open the [AWS Certificate Manager (ACM) Console](https://console.aws.amazon.com/acm/).
2.  **CRITICAL:** Ensure you are in the correct region (e.g., `us-east-2`) matching your EKS cluster.
3.  Click **Request**.
4.  Select **Request a public certificate** and click **Next**.
5.  **Domain names**:
    - Add `lakehouse.k8.ingext.io`
    - (Optional but recommended) Add `*.k8.ingext.io` to cover future subdomains.
6.  **Validation method**: Select **DNS validation**.
7.  Click **Request**.

## Step 2: Validate the Domain Ownership

The certificate status will be **Pending validation**. You must prove you own the domain.

### If your DNS is in Route 53:
1.  Click on the **Certificate ID** to view details.
2.  In the **Domains** section, click **Create records in Route 53**.
3.  Click **Create records**. AWS will automatically add the required CNAME records to your hosted zone.

### If your DNS is elsewhere:
1.  In the **Domains** section, find the **CNAME name** and **CNAME value**.
2.  Log in to your DNS provider (e.g., GoDaddy, Cloudflare).
3.  Add a new CNAME record using the provided name and value.

## Step 3: Wait for Issuance

Wait for the status to change from **Pending validation** to **Issued**. This typically takes 1–5 minutes for Route 53, but can take longer for external providers.

## Step 4: Get the Certificate ARN

Once the status is **Issued**:
1.  Click on the certificate.
2.  Copy the **Amazon Resource Name (ARN)**. It looks like:
    `arn:aws:acm:us-east-2:123456789012:certificate/abcd-1234-abcd-1234-abcd12345678`

## Step 5: Update your Ingress Configuration

You will need to provide this ARN to your Helm chart or Ingress annotations so the AWS Load Balancer knows which certificate to use.

Example Ingress Annotation:
```yaml
alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-2:123456789012:certificate/abcd...
```

---

## Common Troubleshooting

-   **Wrong Region**: If your ALB cannot "see" your certificate, verify that both the ALB and the ACM Certificate are in the exact same AWS region.
-   **Validation Timeout**: Ensure you haven't deleted the CNAME record in Route 53. ACM needs it to remain there to perform automatic renewals.

