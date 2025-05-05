#!/bin/bash

# Test script for using the new token-based payment confirmation

# This is a placeholder for your JWT token - replace with a valid token
JWT_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImFkaGFtLmFmaXNAZ21haWwuY29tIiwic3ViIjoiZDBiNTU3OTYtMjkwZi00OGZhLWI3ZTYtMmRmYjUzNTM1NDQ5Iiwicm9sZSI6IkFETUlOIiwiaWF0IjoxNzQ2NDY3Mjk3LCJleHAiOjE3NDY0NzA4OTd9.IE3deuwl-ODYeR1BT_8MycPscS0NA8-4QvGPO30axuQ"

# Step 1: Create a new payment
echo "Creating a new payment..."
PAYMENT_RESPONSE=$(curl -s -X POST http://localhost:3003/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d '{
    "orderId": "test-order-123",
    "amount": 100,
    "currency": "USD",
    "paymentMethod": "card"
  }')

echo "Payment response: $PAYMENT_RESPONSE"

# Extract payment ID from response
PAYMENT_ID=$(echo $PAYMENT_RESPONSE | grep -o '"id":"[^"]*' | cut -d'"' -f4)
echo "Payment ID: $PAYMENT_ID"

if [ -z "$PAYMENT_ID" ]
then
  echo "Error: Could not extract payment ID. Please check if the payment was created successfully."
  exit 1
fi

# Step 2: Confirm the payment using the new token-based method
echo "Confirming payment with token..."
CONFIRM_RESPONSE=$(curl -s -X POST http://localhost:3003/payments/$PAYMENT_ID/confirm \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d '{
    "paymentMethod": "card", 
    "token": "tok_visa"
  }')

echo "Confirmation response: $CONFIRM_RESPONSE"

# Check confirmation status
PAYMENT_STATUS=$(echo $CONFIRM_RESPONSE | grep -o '"status":"[^"]*' | cut -d'"' -f4)
echo "Payment status: $PAYMENT_STATUS"

if [ "$PAYMENT_STATUS" == "SUCCEEDED" ]
then
  echo "✅ Payment successful!"
else
  echo "❌ Payment failed or is still processing."
fi

# Step 3: Check payment status
echo "Checking payment status..."
STATUS_RESPONSE=$(curl -s -X GET http://localhost:3003/payments/$PAYMENT_ID/status \
  -H "Authorization: Bearer $JWT_TOKEN")

echo "Status response: $STATUS_RESPONSE"
echo "Done!" 