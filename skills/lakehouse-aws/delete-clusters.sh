#!/usr/bin/env bash
# Quick script to delete EKS clusters using Docker execution mode

set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_REGION="${AWS_REGION:-us-east-2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

echo "Deleting EKS clusters..."
echo ""

for cluster in testskillcluster ingextlakehouse; do
  echo "Deleting cluster: $cluster"
  ./skills/lakehouse-aws/bin/run-in-docker.sh eksctl delete cluster \
    --name "$cluster" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" \
    --wait || echo "  Cluster $cluster may already be deleted or deletion failed"
  echo ""
done

echo "✅ Cluster deletion complete!"
echo ""
echo "Verify with:"
echo "  aws eks list-clusters --region $AWS_REGION --profile $AWS_PROFILE"
