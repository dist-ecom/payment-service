import { Injectable, Logger } from '@nestjs/common';
import { RmqContext, Ctx, Payload, EventPattern } from '@nestjs/microservices';

@Injectable()
export class OrdersConsumer {
  private readonly logger = new Logger(OrdersConsumer.name);

  constructor() {}

  // @ts-ignore
  @EventPattern('order.created')
  // @ts-ignore
  async handleOrderCreated(
    // @ts-ignore
    @Payload() data: any,
    // @ts-ignore
    @Ctx() context: RmqContext
  ) {
    this.logger.log(`Received order.created event: ${JSON.stringify(data)}`);
    try {
      // Here we would process the payment for a new order
      // For now, we'll just log the event
      
      // Acknowledge the message
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error(`Error processing order.created event: ${error.message}`);
    }
  }

  // @ts-ignore
  @EventPattern('order.cancelled')
  // @ts-ignore
  async handleOrderCancelled(
    // @ts-ignore
    @Payload() data: any,
    // @ts-ignore
    @Ctx() context: RmqContext
  ) {
    this.logger.log(`Received order.cancelled event: ${JSON.stringify(data)}`);
    try {
      // Here we would handle cancelling a payment or issuing a refund if needed
      // For now, we'll just log the event
      
      // Acknowledge the message
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error(`Error processing order.cancelled event: ${error.message}`);
    }
  }
} 