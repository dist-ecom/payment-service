#!/bin/bash

# This script demonstrates the complete flow of:
# 1. Creating an order
# 2. Creating a payment for that order
# 3. Confirming the payment using the Stripe test token (tok_mastercard)

# Configuration
TOKEN=$(cat auth_token.txt)
ORDER_SERVICE="http://localhost:3002"
PAYMENT_SERVICE="http://localhost:3003"
PRODUCT_ID="6816a33a6f67758b0c48bab1"
PRODUCT_PRICE="99.99"
SHIPPING_ADDRESS="123 Main St, Anytown, CA 12345"

echo "===== Starting Payment Flow with Stripe Token ====="

# Step 1: Create a new order
echo -e "\n1. Creating a new order..."
ORDER_RESPONSE=$(curl -s -X POST "$ORDER_SERVICE/orders" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"items\": [{\"productId\": \"$PRODUCT_ID\", \"quantity\": 1, \"price\": $PRODUCT_PRICE}], 
    \"shippingAddress\": \"$SHIPPING_ADDRESS\", 
    \"paymentMethod\": \"credit_card\"
  }")

echo "Order created:"
echo "$ORDER_RESPONSE" | jq .

# Extract order ID
ORDER_ID=$(echo "$ORDER_RESPONSE" | jq -r '.id')
if [ "$ORDER_ID" == "null" ] || [ -z "$ORDER_ID" ]; then
  echo "Error: Could not extract order ID. Aborting."
  exit 1
fi

echo "Order ID: $ORDER_ID"

# Step 2: Create a payment for the order
echo -e "\n2. Creating payment for order $ORDER_ID..."
PAYMENT_RESPONSE=$(curl -s -X POST "$PAYMENT_SERVICE/payments" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"orderId\": \"$ORDER_ID\",
    \"amount\": $PRODUCT_PRICE,
    \"currency\": \"USD\",
    \"paymentMethod\": \"card\"
  }")

echo "Payment created:"
echo "$PAYMENT_RESPONSE" | jq .

# Extract payment ID
PAYMENT_ID=$(echo "$PAYMENT_RESPONSE" | jq -r '.id')
if [ "$PAYMENT_ID" == "null" ] || [ -z "$PAYMENT_ID" ]; then
  echo "Error: Could not extract payment ID. Aborting."
  exit 1
fi

echo "Payment ID: $PAYMENT_ID"

# Step 3: Confirm the payment with a Stripe test token
echo -e "\n3. Confirming payment with Stripe test token (tok_mastercard)..."
CONFIRM_RESPONSE=$(curl -s -X POST "$PAYMENT_SERVICE/payments/$PAYMENT_ID/confirm" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "paymentMethod": "card",
    "token": "tok_mastercard"
  }')

echo "Confirmation response:"
echo "$CONFIRM_RESPONSE" | jq .

# Check payment status
echo -e "\n4. Checking final payment status..."
STATUS_RESPONSE=$(curl -s -X GET "$PAYMENT_SERVICE/payments/$PAYMENT_ID/status" \
  -H "Authorization: Bearer $TOKEN")

echo "Payment status:"
echo "$STATUS_RESPONSE" | jq .

# Verify order status updated
echo -e "\n5. Verifying order status..."
ORDER_STATUS_RESPONSE=$(curl -s -X GET "$ORDER_SERVICE/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN")

echo "Order status:"
echo "$ORDER_STATUS_RESPONSE" | jq '{ id: .id, status: .status, paymentStatus: .paymentStatus }'

echo -e "\n===== Payment Flow Complete =====" 