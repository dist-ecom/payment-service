# Payment Service

This is a payment processing service for the e-commerce platform. It integrates with Stripe for payment processing, with support for a mock payment gateway for local development.

## Features

- Process payments using Stripe
- Mock payment provider for local development
- Webhook handling for payment events
- Payment status tracking
- Integration with Order Service
- Secure handling of payment information

## Technology Stack

- NestJS framework
- TypeScript
- PostgreSQL with Prisma ORM
- Stripe API for payment processing
- JWT for authentication
- Docker for containerization

## Installation

### Prerequisites

- Node.js (v18+)
- npm or yarn
- PostgreSQL (or Docker)
- Stripe account (for test API keys)

### Setting Up Environment

1. Clone the repository
2. Copy `.env.example` to `.env` and update the configuration
3. Install dependencies:

```bash
npm install
```

4. Generate Prisma client:

```bash
npx prisma generate
```

5. Run migrations:

```bash
npx prisma migrate dev
```

### Running the Service

#### Development Mode

```bash
npm run start:dev
```

#### Production Mode

```bash
npm run build
npm run start:prod
```

### Using Docker

```bash
docker-compose up -d
```

## API Documentation

API documentation is available at `/docs` when the service is running, powered by Swagger.

## Integration with Order Service

The payment service communicates with the order service to:

1. Validate orders before processing payment
2. Update payment status on the order
3. Handle order fulfillment based on payment status

## Stripe Integration

The service uses Stripe in test mode for payment processing. To use your own Stripe account:

1. Create a Stripe account
2. Get your test API keys from the Stripe dashboard
3. Update the `.env` file with your keys
4. Set up a webhook endpoint in Stripe dashboard pointing to `/payments/webhook`

## Mock Payment Gateway

For local development without Stripe, set `ENABLE_MOCK_PAYMENT=true` in `.env`. This will simulate payment flow without making actual API calls to Stripe.

## Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
``` 