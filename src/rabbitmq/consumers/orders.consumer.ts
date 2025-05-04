import { Injectable, Logger, Inject, forwardRef, OnModuleInit, Controller } from '@nestjs/common';
import { RmqContext, Ctx, Payload, EventPattern } from '@nestjs/microservices';
import { PaymentsService } from '../../payments/payments.service';
import { PaymentStatus, PaymentProvider } from '@prisma/client';

@Controller()
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
    try {
      this.logger.log(`Received order.created event - payload type: ${typeof data}`);
      
      // Log complete received data for debug
      this.logger.debug(`Full data received: ${JSON.stringify(data)}`);
      
      // Extract order data from the message
      let order = data;
            
      // Check message pattern and headers for debugging
      const pattern = context.getPattern();
      const message = context.getMessage();
      const headers = message?.properties?.headers || {};
      
      this.logger.log(`Message pattern: ${pattern}`);
      this.logger.log(`Message headers: ${JSON.stringify(headers)}`);
            
      // Final validation of order data
      if (!order || !order.id) {
        this.logger.error('Invalid order data received');
        this.logger.error(`Data received: ${JSON.stringify(data).substring(0, 200)}...`);
        // Always acknowledge the message to avoid blocking the queue
        const channel = context.getChannelRef();
        const originalMsg = context.getMessage();
        channel.ack(originalMsg);
        return;
      }
      
      this.logger.log(`Processing order ${order.id} with amount ${order.totalAmount}`);
      
      // Create a payment for the order with pending status
      const paymentResult = await this.paymentsService.createPayment({
        orderId: order.id,
        amount: typeof order.totalAmount === 'string' ? parseFloat(order.totalAmount) : order.totalAmount,
        paymentMethod: order.paymentMethod || 'card',
        currency: order.currency || 'USD',
        description: `Payment for order ${order.id}`,
        provider: PaymentProvider.STRIPE,
        metadata: { orderId: order.id }
      }, order.userId);
      
      this.logger.log(`Payment created with ID: ${paymentResult.id}`);
      
      // Acknowledge the message
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
      
      this.logger.log(`Order ${order.id} event acknowledged and payment created successfully`);
    } catch (error) {
      this.logger.error(`Error processing order.created event: ${error.message}`, error.stack);
      if (data) {
        this.logger.error(`Data received type: ${typeof data}, preview: ${JSON.stringify(data).substring(0, 100)}...`);
      }
      
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
    try {
      this.logger.log(`Received order.cancelled event`);
      
      // Extract order data from the message
      let order = data;
            
      // Final validation
      if (!order || !order.id) {
        this.logger.error('Invalid order data received');
        this.logger.error(`Data received: ${JSON.stringify(data).substring(0, 200)}...`);
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
      if (data) {
        this.logger.error(`Data received type: ${typeof data}, preview: ${JSON.stringify(data).substring(0, 100)}...`);
      }
      
      // Acknowledge message even on error
      const channel = context.getChannelRef();
      const originalMsg = context.getMessage();
      channel.ack(originalMsg);
    }
  }
} 