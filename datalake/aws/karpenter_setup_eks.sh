#!/bin/bash
set -e 

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <cluster-name> <profile> <region>"
    exit 1
fi

CLUSTER_NAME=$1
PROFILE=$2
REGION=$3
export AWS_PROFILE=$PROFILE
KARPENTER_VERSION="1.8.3"
QUEUE_NAME="KarpenterInterruptionQueue-${CLUSTER_NAME}"

# 1. Get Account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# ... [Previous Tagging and IAM Role Logic from your script remains the same] ...

# 6. Create SQS Interruption Queue
echo "-> Creating Interruption Queue: $QUEUE_NAME"
QUEUE_URL=$(aws sqs create-queue --queue-name "$QUEUE_NAME" --region "$REGION" --query 'QueueUrl' --output text)
QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn --region "$REGION" --query 'Attributes.QueueArn' --output text)


# Define the policy as a string
POLICY=$(cat <<EOT
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "events.amazonaws.com" },
      "Action": "sqs:SendMessage",
      "Resource": "$QUEUE_ARN"
    }
  ]
}
EOT
)

# Apply the policy using the correct JSON structure for --attributes
aws sqs set-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --region "$REGION" \
  --attributes "{\"Policy\":$(echo $POLICY | jq -Rs .)}"


# 7. Create EventBridge Rules for Spot & Health Events
echo "-> Creating EventBridge Rules..."
RULES=("SpotInterruption" "Rebalance" "InstanceStateChange" "ScheduledChange")
PATTERNS=(
  '{"source":["aws.ec2"],"detail-type":["EC2 Spot Instance Interruption Warning"]}'
  '{"source":["aws.ec2"],"detail-type":["EC2 Instance Rebalance Recommendation"]}'
  '{"source":["aws.ec2"],"detail-type":["EC2 Instance State-change Notification"]}'
  '{"source":["aws.health"],"detail-type":["AWS Health Event"]}'
)

for i in "${!RULES[@]}"; do
  RULE_NAME="Karpenter-${CLUSTER_NAME}-${RULES[$i]}"
  aws events put-rule --name "$RULE_NAME" --event-pattern "${PATTERNS[$i]}" --region "$REGION"
  aws events put-targets --rule "$RULE_NAME" --targets "Id=1,Arn=$QUEUE_ARN" --region "$REGION"
done

# 8. Create Service Linked Role (Spot)
aws iam create-service-linked-role --aws-service-name spot.amazonaws.com 2>/dev/null || true

# 9. Install via Helm (Updated with Interruption Queue)
echo "-> Installing Karpenter v${KARPENTER_VERSION} with Spot Interruption support..."
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "$KARPENTER_VERSION" \
  --namespace kube-system \
  --set settings.clusterName="$CLUSTER_NAME" \
  --set settings.interruptionQueue="$QUEUE_NAME" \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --wait
