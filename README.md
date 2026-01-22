# Ingext: The Self-Hosted Data Fabric & Lakehouse 🚀

<a href="https://ingext.io/streaming">
  <img src="img/basic_fabric.png" alt="Ingext Data Fabric Architecture - Real-time Data Ingestion and Routing for AWS EKS, Azure AKS, and GCP GKE" width="800">
</a>

Ingext is a high-performance, **self-hosted data fabric** and **modern lakehouse** solution designed to solve the hardest part of data systems: **clean collection, real-time transformation, and intelligent routing *before* storage.**

### Build a Scalable Data Lakehouse on Kubernetes
Whether you are running on **AWS (EKS)**, **Azure (AKS)**, or **Google Cloud (GKE)**, Ingext provides the infrastructure-as-code and Helm charts needed to deploy a production-ready data platform in minutes.

## Why Try Ingext?

If you’ve struggled with:
- **Rising Data Storage Costs**: High bills from uncompressed, redundant, or "dark" data.
- **Brittle Ingestion Pipelines**: ETL jobs that break whenever a schema changes.
- **Inconsistent Data**: Discrepancies between your data lake, warehouse, and analytics tools.
- **The "Storage First" Trap**: Realizing you need to re-process terabytes of data because it was stored in a messy, raw format.

Ingext lets you build a **"Schema-on-Write"** fabric that cleans, enriches, and routes data in real-time, ensuring your **S3, Blob Storage, or GCS** lakehouse only stores high-value, curated data.

---

## 🚀 Fastest Way to Try Ingext (Recommended)

If your goal is to see Ingext in action without manually configuring Kubernetes internals, use our **Unified Lakehouse Installers**. These automate your cloud infrastructure, storage, ingress, and TLS.

| Cloud Provider | Installer Path | Key Technologies |
| :--- | :--- | :--- |
| **AWS** | [`lakehouse-aws/`](lakehouse-aws/README.md) | EKS, S3, Karpenter, ALB, IAM Pod Identity |
| **Azure** | [`lakehouse-azure/`](lakehouse-azure/README.md) | AKS, Blob Storage, App Gateway, Workload Identity |
| **GCP** | [`ingext-gke-helper/`](ingext-gke-helper/README.md) | GKE, GCS, Cloud Load Balancer, Managed Certificates |

---

## Key Features & Capabilities

- **Real-time Data Fabric**: Collect from HTTP, Syslog, Kafka, and more.
- **Intelligent Routing**: Send data once, route to multiple destinations simultaneously.
- **Schema-on-Write**: Transform and normalize data *before* it hits the disk.
- **Automated Lakehouse**: Automatically organized storage in S3/Blob/GCS.
- **High Performance**: Process millions of events per second with C-level efficiency.
- **Self-Hosted Control**: Maintain 100% ownership of your data and infrastructure.

## What Success Looks Like

After completing the 30-60 minute deployment, you will have:

1.  **Management Console**: A professional UI to manage your pipes, parsers, and dashboards.
2.  **Live Data Fabric**: A system capable of ingestion from any source with real-time feedback.
3.  **Curated Datalake**: Data automatically organized, partitioned, and stored in your cloud bucket.
4.  **Real-time Observability**: Instant visibility into data flow, throughput, and error rates.

### Data Fabric Configuration

<img src="img/SimpleFabric.png" alt="Ingext Management Console - Designing Real-time Data Pipelines" width="800">

### Data Lake Search

<img src="img/Search.png" alt="Ingext Search Interface - Querying the Self-Hosted Data Lake" width="800">

---

## Documentation & Learning

This repository focuses on **deployment**. For building and using Ingext pipelines, visit our [Official Documentation](https://ingext.readme.io/docs/quick-start-guide):

- [Quick Start Guide](https://ingext.readme.io/docs/quick-start-guide) (Your first pipeline)
- [Fluency Processing Language (FPL)](https://ingext.readme.io/docs/fluency-processing-language) (Powering transformations)
- [Data Sources & Sinks](https://ingext.readme.io/docs/adding-a-data-source) (Where data comes from and goes)
- [Parsers & Transformations](https://ingext.readme.io/docs/creating-a-processor) (Cleaning your data)

---

## First Steps After Login [configuration with ingext cli](configuration.md)

1.  **Access the Console**: Navigate to your configured domain (e.g., `https://lakehouse.yourdomain.com`).
2.  **Login**:
    - **User**: `admin@ingext.io`
    - **Password**: `ingext`
    - > **Important**: These are for initial testing only. Change your password immediately in the settings.
3.  **Create a Pipe**: Follow the [Quick Start](https://ingext.readme.io/docs/quick-start-guide) to create your first streaming pipeline.
4.  **Verify Flow**: Send a test event and watch it appear in the real-time stream and your datalake.

---

## Who Is This For?

-   **Platform & Data Engineers**: Regain control over ingestion and reduce storage overhead.
-   **Security Teams (SIEM/SOAR)**: Real-time log normalization, filtering, and routing.
-   **Cloud Architects**: Deploying self-hosted, scalable alternatives to Snowflake or Databricks.
-   **DevOps Teams**: Managing data infrastructure as code with Helm and Kubernetes.

---

## ⚙️ Advanced: Manual Installation

If you prefer to customize every component or deploy to an existing cluster, please refer to the [Technical_README.md](Technical_README.md).

---

## Time & Cost Expectations

-   **Deployment Time**: 30–60 minutes (cloud resource provisioning).
-   **Cloud Costs**: Minimal during trial (approx. $2-5/day depending on cluster size).
-   **Cleanup**: Use the provided `cleanup-lakehouse.sh` scripts in each cloud directory to delete all resources and stop billing.

---

## Support & Community

If you encounter issues during installation or have questions about Ingext:
- **GitHub Issues**: Open an [Issue](https://github.com/ingext/ingext-community/issues)
- **Website**: [ingext.io](https://ingext.io)
- **Email**: support@ingext.io

---
<!--
Keywords: Data Fabric, Data Lakehouse, Self-Hosted Data Platform, Kubernetes Data Ingestion, AWS EKS S3, Azure AKS Blob, GCP GKE GCS, Real-time ETL, Schema-on-Write, Data Routing, Log Normalization, SIEM Ingestion, Fluency Processing Language, FPL, Helm Charts Data Lake.
-->
