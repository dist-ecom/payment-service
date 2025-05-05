import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ConfirmPaymentDto {
  @ApiProperty({ description: 'Payment method', example: 'card', enum: ['card'] })
  @IsEnum(['card'])
  @IsNotEmpty()
  paymentMethod: string;

  @ApiProperty({ 
    description: 'Stripe payment method ID (from client-side tokenization)',
    example: 'pm_1234567890abcdef',
    required: false
  })
  @IsString()
  @IsOptional()
  paymentMethodId?: string;
  
  @ApiProperty({ 
    description: 'Stripe test token (e.g., tok_visa) for test mode only',
    example: 'tok_visa',
    required: false
  })
  @IsString()
  @IsOptional()
  token?: string;
} 