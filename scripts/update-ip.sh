#!/bin/bash
# Usage: ./scripts/update-ip.sh <ip-set-id> [region]
#
# Updates the WAF IP allowlist to your current public IP.
# Run this whenever your IP changes (new network, VPN, etc.).
#
# Get the IP set ID from the CDK output (WafIpSetId).

set -e

IP_SET_ID="$1"
REGION="${2:-${AWS_DEFAULT_REGION:-us-east-1}}"
IP_SET_NAME="aga-allowed-ips"

if [ -z "$IP_SET_ID" ]; then
  echo "Usage: ./scripts/update-ip.sh <ip-set-id> [region]"
  echo ""
  echo "Get the IP set ID from the CDK output:"
  echo "  aws cloudformation describe-stacks --stack-name AgaStack \\"
  echo "    --query 'Stacks[0].Outputs[?OutputKey==\`WafIpSetId\`].OutputValue' --output text"
  exit 1
fi

MY_IP=$(curl -sf https://checkip.amazonaws.com)
if [ -z "$MY_IP" ]; then
  echo "Error: could not determine public IP."
  exit 1
fi

LOCK_TOKEN=$(aws wafv2 get-ip-set \
  --scope REGIONAL \
  --region "$REGION" \
  --id "$IP_SET_ID" \
  --name "$IP_SET_NAME" \
  --query LockToken --output text)

aws wafv2 update-ip-set \
  --scope REGIONAL \
  --region "$REGION" \
  --id "$IP_SET_ID" \
  --name "$IP_SET_NAME" \
  --addresses "${MY_IP}/32" \
  --lock-token "$LOCK_TOKEN"

echo "✓ WAF IP set updated: ${MY_IP}/32"
