# Payment Service Curl Examples

This document provides examples of using the payment service API with curl commands, demonstrating the new token-based payment confirmation flow.

## Prerequisites

- A running payment service at http://localhost:3003
- A valid JWT token for authentication
- An order ID from the order service

## 1. Create a Payment

```bash
curl -X POST http://localhost:3003/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "orderId": "your-order-id",
    "amount": 100,
    "currency": "USD",
    "paymentMethod": "card"
  }'
```

This will return a payment object with status `PENDING` and a `clientSecret` field that you would typically use with Stripe Elements for client-side payment processing. Note the `id` field for use in the confirmation step.

## 2. Confirm Payment with Token

The new token-based method allows confirming payments directly with a Stripe test token without the need for client-side tokenization:

```bash
curl -X POST http://localhost:3003/payments/PAYMENT_ID/confirm \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "paymentMethod": "card",
    "token": "tok_visa"
  }'
```

Replace `PAYMENT_ID` with the ID from the payment creation response.

### Available Test Tokens

| Token | Description |
|-------|-------------|
| tok_visa | Successful Visa card payment |
| tok_visa_debit | Visa debit card |
| tok_mastercard | Mastercard payment |
| tok_amex | American Express |
| tok_discover | Discover card |
| tok_visa_chargeDeclined | Card that will be declined |

## 3. Check Payment Status

```bash
curl -X GET http://localhost:3003/payments/PAYMENT_ID/status \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

This will return the current status of the payment. After a successful confirmation, the status should be `SUCCEEDED`.

## 4. Get Payment by Order ID

```bash
curl -X GET http://localhost:3003/payments/by-order/ORDER_ID \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## 5. Cancel a Payment

```bash
curl -X DELETE http://localhost:3003/payments/PAYMENT_ID/cancel \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## 6. Refund a Payment

```bash
curl -X POST http://localhost:3003/payments/PAYMENT_ID/refund \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Notes

- For real client-side implementation, you would typically use Stripe Elements or Checkout to securely collect payment information
- The token-based method is primarily for testing and development purposes
- In production, you should never log or display payment tokens or sensitive payment information 