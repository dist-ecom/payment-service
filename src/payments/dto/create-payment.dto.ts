import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID, IsNumber, IsString, IsOptional, Min, IsEnum } from 'class-validator';
import { PaymentProvider } from '@prisma/client';

export class CreatePaymentDto {
  @ApiProperty({
    description: 'The ID of the order to pay for',
    example: '123e4567-e89b-12d3-a456-426614174001',
  })
  @IsNotEmpty()
  @IsUUID()
  orderId: string;

  @ApiProperty({
    description: 'The payment amount',
    example: 99.99,
  })
  @IsNotEmpty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @ApiProperty({
    description: 'The currency code',
    example: 'USD',
    default: 'USD',
  })
  @IsString()
  @IsOptional()
  currency?: string = 'USD';

  @ApiProperty({
    description: 'The payment method type',
    example: 'card',
  })
  @IsNotEmpty()
  @IsString()
  paymentMethod: string;

  @ApiProperty({
    description: 'Payment provider',
    enum: PaymentProvider,
    default: PaymentProvider.STRIPE,
  })
  @IsEnum(PaymentProvider)
  @IsOptional()
  provider?: PaymentProvider = PaymentProvider.STRIPE;

  @ApiProperty({
    description: 'Description of what the payment is for',
    example: 'Payment for order #12345',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Additional metadata for the payment',
    type: 'object',
    required: false,
    example: { customerNote: 'Priority shipping' },
  })
  @IsOptional()
  metadata?: Record<string, any>;
} 