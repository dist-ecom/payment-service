# Stripe Test Token Integration

## Overview

This document outlines the implementation of direct Stripe test token support in the payment service. This enhancement allows for easier testing of payment flows by using Stripe's test tokens like `tok_visa` directly, without requiring client-side tokenization.

## Implementation Details

The following changes were made to enable direct token support:

1. **Updated DTO Structure**:
   - Modified `ConfirmPaymentDto` to accept either `paymentMethodId` or `token`
   - Both fields are optional, but at least one must be provided

2. **Enhanced Stripe Service**:
   - Updated `confirmPaymentWithCard` method to handle test tokens
   - Added logic to create a payment method from a token when needed
   - Improved error handling for payment intent states

3. **Improved Payment Confirmation Flow**:
   - Modified payment service to support different confirmation methods
   - Added fallback mechanisms for payment intents in difficult states

## Testing

Two test scripts have been created to demonstrate and test the implementation:

1. **direct-token-payment.sh** - A comprehensive test that:
   - Creates a new order
   - Creates a payment for that order
   - Confirms the payment using a Stripe test token
   - Verifies the payment and order statuses

2. **single-token-payment.sh** - An interactive test script that:
   - Takes an existing payment ID as input
   - Allows selection of different test tokens (Visa, Mastercard, Amex, etc.)
   - Attempts to confirm the payment with the selected token
   - Reports the result and final payment status

## Available Test Tokens

| Token | Description |
|-------|-------------|
| tok_visa | Successful Visa card payment |
| tok_visa_debit | Visa debit card |
| tok_mastercard | Mastercard payment |
| tok_amex | American Express |
| tok_discover | Discover card |
| tok_visa_chargeDeclined | Card that will be declined |

## Usage

To test a payment with a Stripe test token:

1. Create a payment for an order using the regular API
2. Use the payment confirmation endpoint with a test token:

```bash
curl -X POST http://localhost:3003/payments/{PAYMENT_ID}/confirm \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "paymentMethod": "card",
    "token": "tok_visa"
  }'
```

## Notes

- This token-based approach is primarily for testing and should not be used in production
- In a production environment, use Stripe Elements or Checkout for PCI-compliant card processing
- The implementation maintains backward compatibility with payment method IDs for regular client-side tokenization 