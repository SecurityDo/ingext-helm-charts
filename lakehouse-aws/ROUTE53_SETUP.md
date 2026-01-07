# Configuring Route 53 for AWS Lakehouse

This guide explains how to map your public domain (e.g., `lakehouse.k8.ingext.io`) to the AWS Application Load Balancer (ALB) created by the Ingext installer.

## Prerequisites

1.  **ALB DNS Name**: You must have the DNS name of your ALB. You can find it with:
    ```bash
    kubectl get ingress -n ingext-lakehouse
    ```
    Example: `alb-ingext-community-ingress-102364318.us-east-2.elb.amazonaws.com`
2.  **ACM Certificate**: Ensure you have a valid certificate in the same region as your ALB.

---

## Configuration Steps (Route 53 Console)

AWS recommends using an **Alias A Record** instead of a CNAME. Alias records are free, faster, and automatically track IP changes of the load balancer.

1.  Open the [Amazon Route 53 Console](https://console.aws.amazon.com/route53/).
2.  Navigate to **Hosted zones** and select your domain (e.g., `ingext.io`).
3.  Click **Create record**.
4.  Configure the record as follows:
    - **Record name**: Enter the subdomain (e.g., `lakehouse.k8`).
    - **Record type**: Select `A - Routes traffic to an IPv4 address and some AWS resources`.
    - **Alias**: Toggle to **ON**.
    - **Route traffic to**:
        - Select `Alias to Application and Classic Load Balancer`.
        - **Region**: Select the region where your cluster is deployed (e.g., `us-east-2`).
        - **Load balancer**: Choose your ALB from the list (e.g., `alb-ingext-community-ingress`).
    - **Routing policy**: `Simple routing`.
5.  Click **Create records**.

---

## Verification

### 1. DNS Propagation
Wait approximately 60 seconds for DNS to propagate, then run:
```bash
dig lakehouse.k8.ingext.io
```
You should see several IP addresses in the `ANSWER SECTION`. These are the IPs of your ALB.

### 2. HTTPS Connection
Test the full secure connection:
```bash
curl -v https://lakehouse.k8.ingext.io
```
- **Success**: You see `SSL certificate verify ok` and a response from the Ingext service.
- **TLS Error**: Check if your ACM certificate ARN in the Ingress matches the region and domain.
- **404/Timeout**: Verify the security groups allow traffic on port 443 and the Ingress host matches your DNS.

---

## Why use Alias instead of CNAME?

- **Cost**: Alias record queries to AWS resources are free.
- **Performance**: Route 53 responds with the IP address directly, saving a DNS lookup step.
- **Apex Support**: Unlike CNAMEs, Alias records can be used for root domains (e.g., `ingext.io`).

