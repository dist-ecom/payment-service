import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsObject, IsOptional } from 'class-validator';

export class WebhookEventDto {
  @ApiProperty({
    description: 'The type of event',
    example: 'payment_intent.succeeded',
  })
  @IsNotEmpty()
  @IsString()
  type: string;

  @ApiProperty({
    description: 'The unique identifier for the event',
    example: 'evt_1NjWhHJD4qksNs9kJnwXaZ8P',
  })
  @IsNotEmpty()
  @IsString()
  id: string;

  @ApiProperty({
    description: 'The event payload',
    type: 'object',
  })
  @IsNotEmpty()
  @IsObject()
  data: {
    object: Record<string, any>;
  };
  
  @ApiProperty({
    description: 'The payment provider (e.g., stripe)',
    example: 'stripe',
    required: false,
  })
  @IsOptional()
  @IsString()
  provider?: string;
} 