# ingext-datalake

## Prepare EKS cluster

### Create one EKS cluster with eksctl

### Save the cluster context for kubectl

### Install the Pod Identity Agent Add-on

### Create the Pod Identity Association for the ebs csi controller

### Install the EBS CSI Driver Add-on

### Install gp3 storageclass

### Install the Mountpoint for Amazon S3 CSI driver

### Configure service account for the AWS load balancer controller

### Install the controller into the kube-system namespace

```bash
./eks_setup.sh <profile> <awsRegion> <clusterName>
```

## Create service account for the application (ingext-switch + datalake)

### Create a S3 bucket for the datalake and the shared storage

```bash
./create_s3_bucket.sh <profile> <awsRegion> <bucketName> <expireDays>
```

### Create service account with the access permission to the S3 bucket

```bash
./setup_ingext_serviceaccount.sh <namespace> <profile> <awsRegion>  <clusterName> <bucketName>
```

## Install Karpenter for pod management

```bash
./setup_karpenter.sh <profile> <awsRegion> <clusterName>
```

## Install Ingext datalake

### Setup datalake configurations

```bash
helm install ingext-lake-config oci://public.ecr.aws/ingext/ingext-lake-config -n <namespace> \
  --set storageType=s3 \
  --set s3.bucket=<bucketName> \
  --set s3.region=<awsRegion>
```

### Setup node pools for the datalake

```bash
helm upgrade --install ingext-merge-pool oci://public.ecr.aws/ingext/ingext-eks-pool \
  --set poolName=pool-merge \
  --set clusterName=<clusterName> \
  --set-json 'instanceType=["r5.large"]' \
  --set-json 'capacityType=["spot","on-demand"]'


helm upgrade --install ingext-search-pool oci://public.ecr.aws/ingext/ingext-eks-pool \
  --set poolName=pool-search \
  --set clusterName=<clusterName> \
  --set-json 'instanceType=["m5.large"]' \
  --set-json 'capacityType=["on-demand"]'

helm install ingext-manager-role oci://public.ecr.aws/ingext/ingext-manager-role -n ingext

helm install ingext-s3-lake oci://public.ecr.aws/ingext/ingext-s3-lake -n ingext --set bucket.name=<bucketName> --set bucket.region=<region>

helm install ingext-lake-mgr oci://public.ecr.aws/ingext/ingext-lake-mgr -n ingext

helm install ingext-lake-worker oci://public.ecr.aws/ingext/ingext-lake-worker -n ingext

helm install ingext-search-service oci://public.ecr.aws/ingext/ingext-search-service -n ingext
```
