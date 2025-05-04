import { Injectable, Logger, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { RmqContext, Ctx, Payload, EventPattern } from '@nestjs/microservices';
import { PaymentsService } from '../../payments/payments.service';
import { PaymentStatus, PaymentProvider } from '@prisma/client';

@Injectable()
export class OrdersConsumer implements OnModuleInit {
  private readonly logger = new Logger(OrdersConsumer.name);

  constructor(
    @Inject(forwardRef(() => PaymentsService))
    private readonly paymentsService: PaymentsService
  ) {}

  onModuleInit() {
    this.logger.log('OrdersConsumer initialized and listening for order events');
  }

  @EventPattern('order.created')
  async handleOrderCreated(
    @Payload() data: any,
    @Ctx() context: RmqContext
  ) {
    this.logger.log(`Received order.created event with data: ${JSON.stringify(data)}`);
    
    try {
      const order = data;
      
      if (!order || !order.id) {
        this.logger.error('Invalid order data received');
        // Always acknowledge the message to avoid blocking the queue
        const channel = context.getChannelRef();
        const originalMsg = context.getMessage();
        channel.ack(originalMsg);
        return;
      }
      
      this.logger.log(`Processing order ${order.id} with amount ${order.totalAmount}`);
      
      // Create a payment for the order with pending status
      await this.paymentsService.createPayment({
        orderId: order.id,
        amount: parseFloat(order.totalAmount) || 0,
        paymentMethod: order.paymentMethod || 'card',
        currency: order.currency || 'USD',
        description: `Payment for order ${order.id}`,
        provider: PaymentProvider.STRIPE,
        metadata: { orderId: order.id }
      }, order.userId);
      
      // Acknowledge the message
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
      
      this.logger.log(`Order ${order.id} event acknowledged and payment created`);
    } catch (error) {
      this.logger.error(`Error processing order.created event: ${error.message}`, error.stack);
      
      // Acknowledge message even on error to prevent queue blocking
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
    }
  }

  @EventPattern('order.cancelled')
  async handleOrderCancelled(
    @Payload() data: any,
    @Ctx() context: RmqContext
  ) {
    this.logger.log(`Received order.cancelled event with data: ${JSON.stringify(data)}`);
    
    try {
      const order = data;
      
      if (!order || !order.id) {
        this.logger.error('Invalid order data received');
        // Always acknowledge the message
        const channel = context.getChannelRef();
        const originalMsg = context.getMessage();
        channel.ack(originalMsg);
        return;
      }
      
      this.logger.log(`Processing cancellation for order ${order.id}`);
      
      // Find the payment for this order
      try {
        const payment = await this.paymentsService.findByOrder(order.id);
        
        // Cancel the payment if it's still pending
        if (payment.status === PaymentStatus.PENDING || payment.status === PaymentStatus.PROCESSING) {
          await this.paymentsService.cancelPayment(payment.id, order.userId);
        }
      } catch (err) {
        // If no payment found, that's fine - nothing to cancel
        this.logger.log(`No payment found for cancelled order ${order.id}`);
      }
      
      // Acknowledge the message
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
      
      this.logger.log(`Order ${order.id} cancellation acknowledged and payment cancelled`);
    } catch (error) {
      this.logger.error(`Error processing order.cancelled event: ${error.message}`, error.stack);
      
      // Acknowledge message even on error
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
    }
  }
} 