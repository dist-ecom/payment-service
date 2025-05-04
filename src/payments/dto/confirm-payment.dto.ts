import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CardDetailsDto {
  @ApiProperty({ description: 'Card number', example: '4242424242424242' })
  @IsString()
  @IsNotEmpty()
  number: string;

  @ApiProperty({ description: 'Expiration month', example: '12' })
  @IsString()
  @IsNotEmpty()
  expMonth: string;

  @ApiProperty({ description: 'Expiration year', example: '2025' })
  @IsString()
  @IsNotEmpty()
  expYear: string;

  @ApiProperty({ description: 'CVC/CVV code', example: '123' })
  @IsString()
  @IsNotEmpty()
  cvc: string;

  @ApiProperty({ description: 'Name on card', example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  name: string;
}

export class ConfirmPaymentDto {
  @ApiProperty({ description: 'Payment method', example: 'card', enum: ['card'] })
  @IsEnum(['card'])
  @IsNotEmpty()
  paymentMethod: string;

  @ApiProperty({ 
    description: 'Card details for the payment',
    type: CardDetailsDto
  })
  @IsObject()
  @ValidateNested()
  @Type(() => CardDetailsDto)
  cardDetails: CardDetailsDto;
} 