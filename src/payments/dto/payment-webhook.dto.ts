import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsObject } from 'class-validator';

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
} 