import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentStatus, PaymentProvider, Payment, WebhookEvent, Prisma } from '@prisma/client';
import { StripeService } from './services/stripe.service';
import { OrderService } from './services/order.service';
import { WebhookEventDto } from './dto/payment-webhook.dto';
import { RabbitmqService } from '../rabbitmq/rabbitmq.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly orderService: OrderService,
    @Inject(forwardRef(() => RabbitmqService))
    private readonly rabbitmqService: RabbitmqService,
  ) {}

  async createPayment(createPaymentDto: CreatePaymentDto, userId: string): Promise<Payment> {
    // Check if order exists and belongs to the user
    const order = await this.orderService.getOrderDetails(createPaymentDto.orderId);
    
    if (order.userId !== userId) {
      throw new BadRequestException('You do not have permission to pay for this order');
    }

    // Check if a payment already exists for this order
    const existingPayment = await this.prisma.payment.findUnique({
      where: { orderId: createPaymentDto.orderId },
    });

    if (existingPayment) {
      // If payment exists but failed or cancelled, we can create a new one
      if (
        existingPayment.status !== PaymentStatus.FAILED &&
        existingPayment.status !== PaymentStatus.CANCELLED
      ) {
        throw new ConflictException('A payment already exists for this order');
      }
      
      // Delete the existing payment record before creating a new one
      await this.prisma.payment.delete({
        where: { id: existingPayment.id },
      });
    }

    // Process based on provider (currently only Stripe is implemented)
    let paymentIntentId: string;
    let clientSecret: string;

    try {
      if (createPaymentDto.provider === PaymentProvider.STRIPE) {
        const result = await this.stripeService.createPaymentIntent(
          createPaymentDto.amount,
          createPaymentDto.currency,
          createPaymentDto.orderId,
          createPaymentDto.metadata,
        );
        
        paymentIntentId = result.paymentIntentId;
        clientSecret = result.clientSecret;
      } else {
        // Mock provider for local development/testing
        paymentIntentId = `mock_${Date.now()}`;
        clientSecret = `mock_secret_${Date.now()}`;
      }

      // Create payment record in database
      const payment = await this.prisma.payment.create({
        data: {
          orderId: createPaymentDto.orderId,
          userId: userId,
          amount: createPaymentDto.amount,
          currency: createPaymentDto.currency,
          status: PaymentStatus.PENDING,
          provider: createPaymentDto.provider,
          paymentMethod: createPaymentDto.paymentMethod,
          paymentIntentId: paymentIntentId,
          clientSecret: clientSecret,
          description: createPaymentDto.description,
          metadata: createPaymentDto.metadata as Prisma.JsonObject,
        },
      });

      return payment;
    } catch (error) {
      this.logger.error(`Error creating payment: ${error.message}`, error.stack);
      throw error;
    }
  }

  async findAll(userId?: string): Promise<Payment[]> {
    const where = userId ? { userId } : {};
    return this.prisma.payment.findMany({ where });
  }

  async findOne(id: string, userId?: string): Promise<Payment> {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id,
        ...(userId && { userId }),
      },
    });

    if (!payment) {
      throw new NotFoundException(`Payment with ID ${id} not found`);
    }

    return payment;
  }

  async findByOrder(orderId: string, userId?: string): Promise<Payment> {
    const payment = await this.prisma.payment.findFirst({
      where: {
        orderId,
        ...(userId && { userId }),
      },
    });

    if (!payment) {
      throw new NotFoundException(`Payment for order ${orderId} not found`);
    }

    return payment;
  }

  async cancelPayment(paymentId: string, userId: string): Promise<Payment> {
    const payment = await this.findOne(paymentId, userId);

    if (
      payment.status !== PaymentStatus.PENDING &&
      payment.status !== PaymentStatus.PROCESSING
    ) {
      throw new BadRequestException('Only pending or processing payments can be cancelled');
    }

    try {
      // Cancel payment with provider
      if (payment.provider === PaymentProvider.STRIPE && payment.paymentIntentId) {
        await this.stripeService.cancelPaymentIntent(payment.paymentIntentId);
      }

      // Update payment status in database
      const updatedPayment = await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.CANCELLED,
        },
      });

      // Update order payment status
      await this.orderService.updatePaymentStatus(
        payment.orderId,
        PaymentStatus.CANCELLED,
        payment.paymentIntentId,
      );

      return updatedPayment;
    } catch (error) {
      this.logger.error(`Error cancelling payment: ${error.message}`, error.stack);
      throw error;
    }
  }

  async refundPayment(paymentId: string, userId: string): Promise<Payment> {
    const payment = await this.findOne(paymentId, userId);

    if (payment.status !== PaymentStatus.SUCCEEDED) {
      throw new BadRequestException('Only successful payments can be refunded');
    }

    try {
      // Process refund with provider
      if (payment.provider === PaymentProvider.STRIPE && payment.paymentIntentId) {
        await this.stripeService.refundPayment(payment.paymentIntentId);
      }

      // Update payment status
      const updatedPayment = await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.REFUNDED,
        },
      });

      // Update order payment status
      await this.orderService.updatePaymentStatus(
        payment.orderId,
        PaymentStatus.REFUNDED,
        payment.paymentIntentId,
      );

      return updatedPayment;
    } catch (error) {
      this.logger.error(`Error refunding payment: ${error.message}`, error.stack);
      throw error;
    }
  }

  async handleWebhook(eventDto: WebhookEventDto): Promise<void> {
    // Log the incoming webhook
    this.logger.log(`Received webhook: ${eventDto.type} - ${eventDto.id}`);

    // Save webhook event to database first
    const webhookEvent = await this.prisma.webhookEvent.create({
      data: {
        provider: 'stripe',
        eventType: eventDto.type,
        eventId: eventDto.id,
        payload: eventDto as unknown as Prisma.JsonObject,
        processed: false,
      },
    });

    try {
      // Process based on event type
      if (eventDto.type === 'payment_intent.succeeded') {
        await this.handlePaymentSucceeded(eventDto.data.object);
      } else if (eventDto.type === 'payment_intent.payment_failed') {
        await this.handlePaymentFailed(eventDto.data.object);
      }

      // Mark webhook as processed
      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          processed: true,
          processedAt: new Date(),
        },
      });
    } catch (error) {
      // Log error and update webhook event with error
      this.logger.error(`Error processing webhook: ${error.message}`, error.stack);
      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          processingErrors: error.message,
        },
      });
      
      // Rethrow error
      throw error;
    }
  }

  private async handlePaymentSucceeded(paymentIntent: any): Promise<void> {
    const paymentIntentId = paymentIntent.id;
    
    // Find payment by paymentIntentId
    const payment = await this.prisma.payment.findFirst({
      where: { paymentIntentId },
    });

    if (!payment) {
      throw new NotFoundException(`Payment with intent ID ${paymentIntentId} not found`);
    }

    // Get receipt URL if available - using 'any' type to allow expanded properties
    let receiptUrl = null;
    if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge !== 'string') {
      receiptUrl = paymentIntent.latest_charge.receipt_url;
    } else if (
      paymentIntent.charges && 
      paymentIntent.charges.data && 
      paymentIntent.charges.data.length > 0
    ) {
      receiptUrl = paymentIntent.charges.data[0].receipt_url;
    }

    // Update payment status
    const updatedPayment = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.SUCCEEDED,
        receiptUrl,
      },
    });

    // Update order payment status
    await this.orderService.updatePaymentStatus(
      payment.orderId,
      PaymentStatus.SUCCEEDED,
      paymentIntentId,
    );

    // Publish payment.processed event
    await this.rabbitmqService.publishPaymentProcessed(updatedPayment);

    this.logger.log(`Payment succeeded and event published for order ${payment.orderId}`);
  }

  private async handlePaymentFailed(paymentIntent: any): Promise<void> {
    const paymentIntentId = paymentIntent.id;
    
    // Find payment by paymentIntentId
    const payment = await this.prisma.payment.findFirst({
      where: { paymentIntentId },
    });

    if (!payment) {
      throw new NotFoundException(`Payment with intent ID ${paymentIntentId} not found`);
    }

    // Update payment status
    const updatedPayment = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.FAILED,
        errorMessage: paymentIntent.last_payment_error?.message || 'Payment failed',
      },
    });

    // Update order payment status
    await this.orderService.updatePaymentStatus(
      payment.orderId,
      PaymentStatus.FAILED,
      paymentIntentId,
    );

    // Publish payment.failed event
    await this.rabbitmqService.publishPaymentFailed(updatedPayment);

    this.logger.log(`Payment failed and event published for order ${payment.orderId}`);
  }

  async checkPaymentStatus(paymentId: string, userId: string): Promise<Payment> {
    const payment = await this.findOne(paymentId, userId);

    // If payment is already in a final state, return it
    if (
      payment.status === PaymentStatus.SUCCEEDED ||
      payment.status === PaymentStatus.FAILED ||
      payment.status === PaymentStatus.REFUNDED ||
      payment.status === PaymentStatus.CANCELLED
    ) {
      return payment;
    }

    // If using Stripe, check the payment status with Stripe
    if (payment.provider === PaymentProvider.STRIPE && payment.paymentIntentId) {
      try {
        // We use 'any' type here because the Stripe types don't include expanded properties
        const paymentIntent = await this.stripeService.retrievePaymentIntent(payment.paymentIntentId) as any;
        
        // Map Stripe status to our status
        const status = this.stripeService.mapStripeStatusToPaymentStatus(paymentIntent.status);
        
        // If status has changed, update it
        if (status !== payment.status) {
          // Get receipt URL if available - using 'any' type to allow expanded properties
          let receiptUrl = null;
          if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge !== 'string') {
            receiptUrl = paymentIntent.latest_charge.receipt_url;
          } else if (
            paymentIntent.charges && 
            paymentIntent.charges.data && 
            paymentIntent.charges.data.length > 0
          ) {
            receiptUrl = paymentIntent.charges.data[0].receipt_url;
          }

          const updatedPayment = await this.prisma.payment.update({
            where: { id: paymentId },
            data: {
              status,
              receiptUrl,
              errorMessage: paymentIntent.last_payment_error?.message,
            },
          });

          // Update order payment status if needed
          if (status === PaymentStatus.SUCCEEDED || status === PaymentStatus.FAILED) {
            await this.orderService.updatePaymentStatus(
              payment.orderId,
              status,
              payment.paymentIntentId,
            );
            
            // Publish appropriate event based on status
            if (status === PaymentStatus.SUCCEEDED) {
              await this.rabbitmqService.publishPaymentProcessed(updatedPayment);
              this.logger.log(`Payment succeeded and event published for order ${payment.orderId}`);
            } else if (status === PaymentStatus.FAILED) {
              await this.rabbitmqService.publishPaymentFailed(updatedPayment);
              this.logger.log(`Payment failed and event published for order ${payment.orderId}`);
            }
          }

          return updatedPayment;
        }
      } catch (error) {
        this.logger.error(`Error checking payment status: ${error.message}`, error.stack);
        // Don't throw error, return current payment status
      }
    }

    return payment;
  }
} 