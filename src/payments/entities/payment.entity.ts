import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus, PaymentProvider } from '@prisma/client';

export class Payment {
  @ApiProperty({
    description: 'The unique identifier of the payment',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

  @ApiProperty({
    description: 'The ID of the order this payment is for',
    example: '123e4567-e89b-12d3-a456-426614174001',
  })
  orderId: string;

  @ApiProperty({
    description: 'The ID of the user making the payment',
    example: '123e4567-e89b-12d3-a456-426614174002',
  })
  userId: string;

  @ApiProperty({
    description: 'The payment amount',
    example: 99.99,
  })
  amount: number;

  @ApiProperty({
    description: 'The currency code',
    example: 'USD',
  })
  currency: string;

  @ApiProperty({
    description: 'The current status of the payment',
    enum: PaymentStatus,
    example: PaymentStatus.PENDING,
  })
  status: PaymentStatus;

  @ApiProperty({
    description: 'The payment provider',
    enum: PaymentProvider,
    example: PaymentProvider.STRIPE,
  })
  provider: PaymentProvider;

  @ApiProperty({
    description: 'The payment method used',
    example: 'credit_card',
  })
  paymentMethod: string;

  @ApiProperty({
    description: 'The external payment intent ID',
    example: 'pi_3MHksdJD4qksNs9k31u24nds',
    required: false,
  })
  paymentIntentId?: string;

  @ApiProperty({
    description: 'The client secret for client-side confirmation',
    required: false,
  })
  clientSecret?: string;

  @ApiProperty({
    description: 'URL to the payment receipt',
    required: false,
  })
  receiptUrl?: string;

  @ApiProperty({
    description: 'Description of the payment',
    required: false,
  })
  description?: string;

  @ApiProperty({
    description: 'Additional metadata for the payment',
    type: 'object',
    required: false,
  })
  metadata?: Record<string, any>;

  @ApiProperty({
    description: 'Error message if payment failed',
    required: false,
  })
  errorMessage?: string;

  @ApiProperty({
    description: 'Creation timestamp',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
  })
  updatedAt: Date;
} 