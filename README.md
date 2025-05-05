# Payment Service

A microservice for handling payment processing in the e-commerce platform, with Stripe integration and order service communication.

## Table of Contents

- [Payment Service](#payment-service)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Features](#features)
  - [Architecture](#architecture)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Stripe Setup](#stripe-setup)
    - [1. Create a Stripe Account](#1-create-a-stripe-account)
    - [2. API Keys](#2-api-keys)
    - [3. Test Mode](#3-test-mode)
    - [4. Webhook Configuration](#4-webhook-configuration)
  - [Configuration](#configuration)
  - [API Endpoints](#api-endpoints)
  - [Integration with Order Service](#integration-with-order-service)
    - [Order Service Configuration](#order-service-configuration)
    - [Payment Status Mapping](#payment-status-mapping)
  - [Testing](#testing)
    - [Unit and Integration Tests](#unit-and-integration-tests)
    - [Manual Testing with Stripe Test Cards](#manual-testing-with-stripe-test-cards)
    - [Using Stripe Test Tokens](#using-stripe-test-tokens)
    - [Testing Flow](#testing-flow)
  - [Deployment](#deployment)
    - [Using Docker](#using-docker)
    - [Manual Deployment](#manual-deployment)
  - [Troubleshooting](#troubleshooting)
    - [Common Issues](#common-issues)

## Overview

The Payment Service processes payments for the e-commerce platform using Stripe's payment processing API. It handles payment creation, status tracking, and communication with the Order Service to ensure order statuses are properly updated based on payment results.

## Features

- Process payments using Stripe API
- Mock payment provider for local development
- Webhooks for automated payment status updates
- Payment status tracking and history
- Integration with Order Service
- Secure handling of payment information
- Support for cancellations and refunds

## Architecture

The Payment Service is built with:

- NestJS framework
- TypeScript
- PostgreSQL database with Prisma ORM
- Stripe API for payment processing
- JWT authentication
- Service-to-service communication

## Prerequisites

- Node.js (v18+)
- npm or yarn
- PostgreSQL database
- Stripe account (for API keys)
- Docker and Docker Compose (optional)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/your-org/dist-ecom.git
cd dist-ecom/services/payment-service
```

2. Install dependencies:

```bash
npm install
```

3. Set up environment variables:

```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Generate Prisma client:

```bash
npx prisma generate
```

5. Run database migrations:

```bash
npx prisma migrate dev
```

6. Start the service:

```bash
npm run start:dev
```

## Stripe Setup

### 1. Create a Stripe Account

If you don't have a Stripe account, create one at [stripe.com](https://stripe.com).

### 2. API Keys

After creating your account, get your API keys from the Stripe Dashboard:

1. Go to **Developers > API keys**
2. Use the **Secret key** that starts with `sk_test_` for development
3. Add this key to your `.env` file as `STRIPE_SECRET_KEY`

### 3. Test Mode

During development, use Stripe's test mode. In test mode:

- No real charges are made
- Test cards can be used (see [Testing](#testing) section)
- All functionality can be tested without financial consequences

### 4. Webhook Configuration

For local development with webhooks:

1. Install the [Stripe CLI](https://stripe.com/docs/stripe-cli)
2. Run webhook forwarding:

```bash
stripe listen --forward-to localhost:3003/payments/webhook
```

3. Copy the webhook signing secret and add it to your `.env` file as `STRIPE_WEBHOOK_SECRET`

For production:

1. In the Stripe Dashboard, go to **Developers > Webhooks**
2. Add a new webhook endpoint: `https://your-domain.com/payments/webhook`
3. Select the events `payment_intent.succeeded` and `payment_intent.payment_failed`
4. Copy the signing secret and update your environment variables

## Configuration

Configure the payment service using environment variables in the `.env` file:

```
# Application
PORT=3003
NODE_ENV=development

# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/payment_service?schema=public"

# JWT Authentication
JWT_SECRET=your_jwt_secret_key

# Service communication
ORDER_SERVICE_URL=http://localhost:3002
SERVICE_TOKEN=your_service_token_for_interservice_communication

# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_your_test_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret

# Development options
ENABLE_MOCK_PAYMENT=false
```

Important configuration notes:

- `SERVICE_TOKEN` must match between this service and the Order Service
- `STRIPE_SECRET_KEY` should be kept secure and never committed to version control
- `DATABASE_URL` should point to your PostgreSQL instance
- Set `ENABLE_MOCK_PAYMENT=true` to use mock payments without Stripe API calls

## API Endpoints

The Payment Service exposes the following endpoints:

| Method | Endpoint | Description | Authentication |
|--------|----------|-------------|----------------|
| POST | `/payments` | Create a new payment | JWT |
| GET | `/payments` | Get all payments for the user | JWT |
| GET | `/payments/:id` | Get a payment by ID | JWT |
| GET | `/payments/by-order/:orderId` | Get payment by order ID | JWT |
| DELETE | `/payments/:id/cancel` | Cancel a payment | JWT |
| POST | `/payments/:id/refund` | Refund a payment | JWT |
| POST | `/payments/webhook` | Handle Stripe webhooks | None |
| GET | `/payments/:id/status` | Check payment status | JWT |

For detailed API documentation, run the service and visit `/docs`.

## Integration with Order Service

The Payment Service integrates with the Order Service to:

1. Validate orders before processing payments
2. Update order payment status after payment processing

### Order Service Configuration

Ensure the Order Service has:

1. `SERVICE_TOKEN` environment variable set to the same value as in the Payment Service
2. The `ServiceAuthGuard` properly configured
3. The payment status endpoint `/orders/:id/payment-status` is accessible with the service token

### Payment Status Mapping

Payment statuses are mapped between services:

| Payment Service Status | Order Service Status |
|------------------------|--------------------|
| PENDING | pending |
| PROCESSING | pending |
| SUCCEEDED | completed |
| FAILED | failed |
| REFUNDED | refunded |
| CANCELLED | failed |

## Testing

### Unit and Integration Tests

Run the test suite:

```bash
# Run all tests
npm test

# Run integration tests only
npm run test:e2e
```

### Manual Testing with Stripe Test Cards

Use these test card numbers with any future expiration date, CVC, and postal code:

| Card Number | Scenario |
|-------------|----------|
| 4242 4242 4242 4242 | Successful payment |
| 4000 0025 0000 3155 | Requires authentication (3D Secure) |
| 4000 0000 0000 0002 | Payment declined |

### Using Stripe Test Tokens

For testing in environments where you cannot use the Stripe.js library to create payment method IDs, you can use Stripe's test tokens:

1. First, create a payment:
```bash
curl -X POST http://localhost:3003/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "orderId": "your_order_id",
    "amount": 100,
    "currency": "USD",
    "paymentMethod": "card"
  }'
```

2. Then confirm the payment using a test token:
```bash
curl -X POST http://localhost:3003/payments/PAYMENT_ID/confirm \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "paymentMethod": "card",
    "token": "tok_visa"
  }'
```

Available test tokens:
| Token | Description |
|-------|-------------|
| tok_visa | Successful Visa card payment |
| tok_visa_debit | Visa debit card |
| tok_mastercard | Mastercard payment |
| tok_amex | American Express |
| tok_discover | Discover card |
| tok_visa_chargeDeclined | Card that will be declined |

### Testing Flow

1. Create an order through the Order Service
2. Initiate payment through the Payment Service
3. Use a test card to complete or fail the payment
4. Verify the payment status updates in the Payment Service
5. Verify the order status updates in the Order Service

## Deployment

### Using Docker

```bash
# Build and start containers
docker-compose up -d
```

The docker-compose.yml file sets up:
- The payment service
- PostgreSQL database
- Adminer for database management

### Manual Deployment

1. Build the application:

```bash
npm run build
```

2. Set up environment variables in your deployment environment

3. Run database migrations:

```bash
npx prisma migrate deploy
```

4. Start the application:

```bash
node dist/main
```

## Troubleshooting

### Common Issues

1. **Payment Creation Fails**
   - Check your Stripe API key is valid
   - Verify amount is above minimum (typically $0.50 for USD)
   - Ensure currency is supported by Stripe

2. **Webhook Events Not Received**
   - Verify webhook URL is publicly accessible (or use Stripe CLI for local development)
   - Check webhook signing secret is correct
   - Inspect webhook events in Stripe Dashboard

3. **Order Service Communication Errors**
   - Confirm SERVICE_TOKEN matches between services
   - Verify ORDER_SERVICE_URL is correct and accessible
   - Check that the Order Service accepts payment status updates

4. **Database Connection Issues**
   - Verify DATABASE_URL is correct
   - Ensure PostgreSQL is running
   - Check database user permissions

For additional support, refer to [Stripe's API documentation](https://stripe.com/docs/api) or contact the development team.