#!/bin/bash
# Deploy SeamlessLiquidator to Base Chain (8453)

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🚀 Deploying SeamlessLiquidator to Base...${NC}"
echo ""

# Check required environment variables
if [ -z "$RPC_BASE" ]; then
    echo -e "${RED}❌ Error: RPC_BASE environment variable not set${NC}"
    echo "Example: export RPC_BASE=https://mainnet.base.org"
    exit 1
fi

if [ -z "$WALLET_PK_BASE" ]; then
    echo -e "${RED}❌ Error: WALLET_PK_BASE environment variable not set${NC}"
    echo "Example: export WALLET_PK_BASE=0x..."
    exit 1
fi

# Read beneficiary from config.yaml
BENEFICIARY=$(grep -A 1 "beneficiary:" config.yaml | grep "0x" | sed 's/.*"\(0x[^"]*\)".*/\1/')
if [ -z "$BENEFICIARY" ]; then
    echo -e "${RED}❌ Error: Could not read beneficiary address from config.yaml${NC}"
    exit 1
fi

echo -e "${GREEN}Configuration:${NC}"
echo "  Chain: Base (8453)"
echo "  RPC: $RPC_BASE"
echo "  Beneficiary: $BENEFICIARY"
echo "  Seamless Provider: 0x0E02EB705be325407707662C6f6d3466E939f3a0"
echo ""

# Compile contracts
echo -e "${YELLOW}📦 Compiling contracts...${NC}"
forge build

# Deploy
echo -e "${YELLOW}🔨 Deploying SeamlessLiquidator...${NC}"
DEPLOY_OUTPUT=$(forge create \
  --rpc-url "$RPC_BASE" \
  --private-key "$WALLET_PK_BASE" \
  --constructor-args \
    "0x0E02EB705be325407707662C6f6d3466E939f3a0" \
    "$BENEFICIARY" \
  contracts/SeamlessLiquidator.sol:SeamlessLiquidator 2>&1)

echo "$DEPLOY_OUTPUT"

# Extract deployed address
DEPLOYED_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "Deployed to:" | awk '{print $3}')

if [ -z "$DEPLOYED_ADDRESS" ]; then
    echo -e "${RED}❌ Deployment failed!${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ Deployment successful!${NC}"
echo -e "${GREEN}Contract Address: $DEPLOYED_ADDRESS${NC}"
echo ""

# Update config.yaml
echo -e "${YELLOW}📝 Updating config.yaml...${NC}"

# Check if contracts.liquidator section exists
if grep -q "contracts:" config.yaml; then
    if grep -q "8453:" config.yaml; then
        # Update existing entry
        sed -i "s/8453: .*/8453: \"$DEPLOYED_ADDRESS\"/" config.yaml
        echo -e "${GREEN}✅ Updated existing Base liquidator address in config.yaml${NC}"
    else
        # Add new entry under existing contracts section
        sed -i "/liquidator:/a\\    8453: \"$DEPLOYED_ADDRESS\"" config.yaml
        echo -e "${GREEN}✅ Added Base liquidator address to config.yaml${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Could not auto-update config.yaml${NC}"
    echo -e "${YELLOW}Please manually add:${NC}"
    echo ""
    echo "contracts:"
    echo "  liquidator:"
    echo "    8453: \"$DEPLOYED_ADDRESS\""
fi

echo ""
echo -e "${GREEN}🎉 SeamlessLiquidator deployed successfully!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Verify contract on BaseScan:"
echo "     https://basescan.org/address/$DEPLOYED_ADDRESS"
echo ""
echo "  2. Test in dry-run mode:"
echo "     docker-compose restart"
echo "     docker logs -f | grep seamless"
echo ""
echo "  3. Enable live execution when ready"
echo ""
