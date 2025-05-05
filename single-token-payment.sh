#!/bin/bash

# This script tests only the token-based payment confirmation
# for an existing payment

# Configuration
TOKEN=$(cat auth_token.txt)
PAYMENT_SERVICE="http://localhost:3003"

# Define test tokens
VISA_TOKEN="tok_visa"
MASTERCARD_TOKEN="tok_mastercard"
AMEX_TOKEN="tok_amex"
DECLINED_TOKEN="tok_chargeDeclined"

# Ask for payment ID
read -p "Enter the payment ID to confirm: " PAYMENT_ID

if [ -z "$PAYMENT_ID" ]; then
  echo "Error: Payment ID is required."
  exit 1
fi

# Ask which token to use
echo -e "\nSelect a test token:"
echo "1) Visa (tok_visa) [Default]"
echo "2) Mastercard (tok_mastercard)"
echo "3) American Express (tok_amex)"
echo "4) Declined Card (tok_chargeDeclined)"
read -p "Enter your choice [1-4]: " TOKEN_CHOICE

# Set the token based on user choice
case $TOKEN_CHOICE in
  2) TEST_TOKEN=$MASTERCARD_TOKEN; TOKEN_NAME="Mastercard" ;;
  3) TEST_TOKEN=$AMEX_TOKEN; TOKEN_NAME="American Express" ;;
  4) TEST_TOKEN=$DECLINED_TOKEN; TOKEN_NAME="Declined Card" ;;
  *) TEST_TOKEN=$VISA_TOKEN; TOKEN_NAME="Visa" ;;
esac

echo -e "\n===== Testing Payment Confirmation with $TOKEN_NAME Token ====="

# Confirm the payment with the selected token
echo -e "\nConfirming payment $PAYMENT_ID with $TOKEN_NAME token ($TEST_TOKEN)..."
CONFIRM_RESPONSE=$(curl -s -X POST "$PAYMENT_SERVICE/payments/$PAYMENT_ID/confirm" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"paymentMethod\": \"card\",
    \"token\": \"$TEST_TOKEN\"
  }")

echo "Confirmation response:"
echo "$CONFIRM_RESPONSE" | jq .

# Check if confirmation was successful
PAYMENT_STATUS=$(echo "$CONFIRM_RESPONSE" | jq -r '.status // empty')

if [ "$PAYMENT_STATUS" = "SUCCEEDED" ]; then
  echo -e "\n✅ Payment confirmation SUCCESSFUL!"
elif [ -n "$PAYMENT_STATUS" ]; then
  echo -e "\n⚠️ Payment status: $PAYMENT_STATUS"
else
  echo -e "\n❌ Payment confirmation FAILED!"
fi

# Check payment status
echo -e "\nChecking final payment status..."
STATUS_RESPONSE=$(curl -s -X GET "$PAYMENT_SERVICE/payments/$PAYMENT_ID/status" \
  -H "Authorization: Bearer $TOKEN")

echo "Payment status:"
echo "$STATUS_RESPONSE" | jq .

echo -e "\n===== Payment Test Complete =====" 