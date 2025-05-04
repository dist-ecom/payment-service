import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException, Inject, forwardRef, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentStatus, PaymentProvider, Payment, WebhookEvent, Prisma } from '@prisma/client';
import { StripeService } from './services/stripe.service';
import { OrderService } from './services/order.service';
import { WebhookEventDto } from './dto/payment-webhook.dto';
import { RabbitmqService } from '../rabbitmq/rabbitmq.service';
import { ConfigService } from '@nestjs/config';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly orderService: OrderService,
    @Inject(forwardRef(() => RabbitmqService))
    private readonly rabbitmqService: RabbitmqService,
    private readonly configService: ConfigService,
  ) {}

  async createPayment(
    createPaymentDto: CreatePaymentDto,
    userId: string,
  ): Promise<Payment> {
    this.logger.log(`Creating payment for order ${createPaymentDto.orderId} with amount ${createPaymentDto.amount}`);
    
    try {
      // Check if payment already exists for this order
      const existingPayment = await this.prisma.payment.findFirst({
        where: { orderId: createPaymentDto.orderId },
      });

      if (existingPayment) {
        // Handle different payment statuses
        if (existingPayment.status === PaymentStatus.PENDING || 
            existingPayment.status === PaymentStatus.PROCESSING) {
          // For pending or processing payments, return the existing payment
          this.logger.log(`Found ${existingPayment.status} payment for order ${createPaymentDto.orderId}. Returning existing payment.`);
          return existingPayment as unknown as Payment;
        } else if (existingPayment.status === PaymentStatus.FAILED || 
                  existingPayment.status === PaymentStatus.CANCELLED) {
          // For failed or cancelled payments, allow creating a new one
          this.logger.log(`Found ${existingPayment.status} payment for order ${createPaymentDto.orderId}. Allowing retry.`);
          
          // Delete the old payment record
          await this.prisma.payment.delete({
            where: { id: existingPayment.id },
          });
          
          this.logger.log(`Deleted previous payment record ${existingPayment.id}`);
        } else if (existingPayment.status === PaymentStatus.SUCCEEDED) {
          // If payment was already successful, just return it
          this.logger.log(`Payment already succeeded for order ${createPaymentDto.orderId}`);
          return existingPayment as unknown as Payment;
        } else if (existingPayment.status === PaymentStatus.REFUNDED) {
          // If payment was refunded, allow creating a new one
          this.logger.log(`Found REFUNDED payment for order ${createPaymentDto.orderId}. Allowing new payment.`);
          
          // Delete the old payment record
          await this.prisma.payment.delete({
            where: { id: existingPayment.id },
          });
        } else {
          this.logger.warn(`Payment already exists for order ${createPaymentDto.orderId} with status ${existingPayment.status}`);
          throw new ConflictException(`Payment already exists for this order with status: ${existingPayment.status}`);
        }
      }

      // Get order details to verify ownership
      const order = await this.orderService.getOrderDetails(createPaymentDto.orderId);
      
      if (!order) {
        this.logger.error(`Order ${createPaymentDto.orderId} not found`);
        throw new NotFoundException(`Order ${createPaymentDto.orderId} not found`);
      }

      if (order.userId !== userId) {
        this.logger.error(`User ${userId} does not own order ${createPaymentDto.orderId}`);
        throw new ForbiddenException('You do not have permission to pay for this order');
      }

      let clientSecret;
      let paymentIntentId;

      // Check if mock payment is enabled
      const useMockPayment = this.configService.get<string>('ENABLE_MOCK_PAYMENT') === 'true';
      this.logger.debug(`Mock payment enabled: ${useMockPayment}`);

      if (useMockPayment) {
        this.logger.log('Using mock payment processor');
        // Generate random strings for mock data
        const randomString = (length: number) => 
          [...Array(length)].map(() => (~~(Math.random() * 36)).toString(36)).join('');
        
        clientSecret = `mock_pi_${Date.now()}_secret_${randomString(24)}`;
        paymentIntentId = `mock_pi_${Date.now()}_${randomString(16)}`;
      } else {
        // Create a payment intent with Stripe
        this.logger.log('Creating Stripe payment intent');
        try {
          const result = await this.stripeService.createPaymentIntent(
            createPaymentDto.amount,
            createPaymentDto.currency || 'USD',
            createPaymentDto.orderId,
            { userId }
          );
          clientSecret = result.clientSecret;
          paymentIntentId = result.paymentIntentId;
          this.logger.debug(`Stripe payment intent created: ${paymentIntentId}`);
        } catch (stripeError) {
          this.logger.error(`Stripe payment intent creation failed: ${stripeError.message}`, stripeError.stack);
          throw new BadRequestException(`Payment processing error: ${stripeError.message}`);
        }
      }

      // Save the payment record to database
      const payment = await this.prisma.payment.create({
        data: {
          orderId: createPaymentDto.orderId,
          userId,
          amount: createPaymentDto.amount,
          currency: createPaymentDto.currency || 'USD',
          status: PaymentStatus.PENDING,
          provider: createPaymentDto.provider || PaymentProvider.STRIPE,
          paymentMethod: createPaymentDto.paymentMethod,
          description: createPaymentDto.description || `Payment for order ${createPaymentDto.orderId}`,
          clientSecret,
          paymentIntentId, // Use the correct field name from the schema
          metadata: createPaymentDto.metadata || {},
        },
      });

      this.logger.log(`Payment ${payment.id} created successfully for order ${createPaymentDto.orderId}`);
      
      // Update order payment status
      await this.orderService.updatePaymentStatus(
        createPaymentDto.orderId,
        PaymentStatus.PENDING,
        payment.paymentIntentId
      );

      return payment;
    } catch (error) {
      this.logger.error(`Failed to create payment: ${error.message}`, error.stack);
      if (error instanceof ConflictException || 
          error instanceof NotFoundException || 
          error instanceof ForbiddenException ||
          error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException(`Payment processing failed: ${error.message}`);
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

    // Check if this webhook was already processed (idempotency)
    const existingEvent = await this.prisma.webhookEvent.findFirst({
      where: {
        eventId: eventDto.id,
        processed: true,
      },
    });

    if (existingEvent) {
      this.logger.log(`Webhook ${eventDto.id} already processed, skipping`);
      return;
    }

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
      // Process based on event type with exponential backoff retry
      let retries = 0;
      const maxRetries = 3;
      let success = false;

      while (!success && retries < maxRetries) {
        try {
          if (eventDto.type === 'payment_intent.succeeded') {
            await this.handlePaymentSucceeded(eventDto.data.object);
          } else if (eventDto.type === 'payment_intent.payment_failed') {
            await this.handlePaymentFailed(eventDto.data.object);
          } else if (eventDto.type === 'payment_intent.canceled') {
            await this.handlePaymentCancelled(eventDto.data.object);
          } else if (eventDto.type === 'charge.refunded') {
            await this.handlePaymentRefunded(eventDto.data.object);
          }
          success = true;
        } catch (error) {
          retries++;
          if (retries >= maxRetries) {
            throw error; // rethrow if we've exhausted retries
          }
          
          // Exponential backoff
          const delay = 1000 * Math.pow(2, retries);
          this.logger.warn(`Retry ${retries}/${maxRetries} for webhook ${eventDto.id} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
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

    // Verify payment amount matches to prevent tampering
    if (Math.round(Number(payment.amount) * 100) !== paymentIntent.amount) {
      this.logger.error(`Payment amount mismatch for ${paymentIntentId}: ${payment.amount} vs ${paymentIntent.amount/100}`);
      throw new BadRequestException('Payment amount mismatch');
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
        updatedAt: new Date(),
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

    // Extract detailed error information
    const errorMessage = paymentIntent.last_payment_error?.message || 'Payment failed';
    const errorCode = paymentIntent.last_payment_error?.code || '';
    const errorType = paymentIntent.last_payment_error?.type || '';
    
    // Update payment status with detailed error information
    const updatedPayment = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.FAILED,
        errorMessage,
        metadata: {
          ...(payment.metadata as object || {}),
          errorCode,
          errorType,
          lastPaymentError: paymentIntent.last_payment_error || {}
        } as Prisma.JsonObject,
        updatedAt: new Date(),
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
  
  private async handlePaymentCancelled(paymentIntent: any): Promise<void> {
    const paymentIntentId = paymentIntent.id;
    
    // Find payment by paymentIntentId
    const payment = await this.prisma.payment.findFirst({
      where: { paymentIntentId },
    });

    if (!payment) {
      throw new NotFoundException(`Payment with intent ID ${paymentIntentId} not found`);
    }
    
    // Update payment status
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.CANCELLED,
        updatedAt: new Date(),
      },
    });

    // Update order payment status
    await this.orderService.updatePaymentStatus(
      payment.orderId,
      PaymentStatus.CANCELLED,
      paymentIntentId,
    );

    this.logger.log(`Payment cancelled for order ${payment.orderId}`);
  }
  
  private async handlePaymentRefunded(charge: any): Promise<void> {
    // Find the payment by charge ID
    // First need to get the payment intent ID from the charge
    const paymentIntentId = charge.payment_intent;
    
    if (!paymentIntentId) {
      throw new Error('No payment intent ID found in refund charge');
    }
    
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
        status: PaymentStatus.REFUNDED,
        metadata: {
          ...(payment.metadata as object || {}),
          refundId: charge.refunds?.data?.[0]?.id,
          refundReason: charge.refunds?.data?.[0]?.reason,
          refundAmount: charge.refunds?.data?.[0]?.amount,
          refundDate: new Date().toISOString(),
        } as Prisma.JsonObject,
        updatedAt: new Date(),
      },
    });

    // Update order payment status
    await this.orderService.updatePaymentStatus(
      payment.orderId,
      PaymentStatus.REFUNDED,
      paymentIntentId,
    );

    this.logger.log(`Payment refunded for order ${payment.orderId}`);
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

  async findByOrderId(orderId: string, userId: string): Promise<Payment> {
    this.logger.log(`Finding payment for order ${orderId}`);
    
    const payment = await this.prisma.payment.findFirst({
      where: { 
        orderId: orderId 
      },
    });
    
    if (!payment) {
      this.logger.warn(`Payment not found for order ${orderId}`);
      throw new NotFoundException(`Payment not found for order ${orderId}`);
    }
    
    // Get order details to verify ownership
    try {
      const order = await this.orderService.getOrderDetails(orderId);
      
      // Check if user is the owner of the order
      if (order && order.userId !== userId) {
        this.logger.warn(`User ${userId} attempted to access payment for order ${orderId} owned by ${order.userId}`);
        throw new ForbiddenException('You are not authorized to access this payment');
      }
    } catch (error) {
      if (!(error instanceof ForbiddenException)) {
        this.logger.error(`Error verifying order ownership: ${error.message}`);
      }
      throw error;
    }
    
    return payment as unknown as Payment;
  }
  
  async confirmPayment(
    paymentId: string, 
    confirmPaymentDto: ConfirmPaymentDto, 
    userId: string
  ): Promise<Payment> {
    this.logger.log(`Confirming payment ${paymentId}`);
    
    // Find the payment
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    
    if (!payment) {
      this.logger.warn(`Payment ${paymentId} not found`);
      throw new NotFoundException(`Payment ${paymentId} not found`);
    }
    
    // Get order details to verify ownership
    try {
      const order = await this.orderService.getOrderDetails(payment.orderId);
      
      // Check if user is the owner of the order
      if (order && order.userId !== userId) {
        this.logger.warn(`User ${userId} attempted to confirm payment ${paymentId} for order ${payment.orderId} owned by ${order.userId}`);
        throw new ForbiddenException('You are not authorized to confirm this payment');
      }
    } catch (error) {
      if (!(error instanceof ForbiddenException)) {
        this.logger.error(`Error verifying order ownership: ${error.message}`);
      }
      throw error;
    }
    
    // Allow confirming payments in PENDING or FAILED state
    if (payment.status !== PaymentStatus.PENDING && payment.status !== PaymentStatus.FAILED) {
      this.logger.warn(`Cannot confirm payment ${paymentId} with status ${payment.status}`);
      throw new BadRequestException(`Cannot confirm payment with status: ${payment.status}`);
    }
    
    try {
      // Process payment with Stripe
      const stripeResult = await this.stripeService.confirmPayment(
        payment.paymentIntentId,
        confirmPaymentDto.cardDetails
      );
      
      // Update payment status
      const updatedPayment = await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.SUCCEEDED,
          updatedAt: new Date(),
        },
      });
      
      // Update order payment status
      await this.orderService.updatePaymentStatus(
        payment.orderId,
        PaymentStatus.SUCCEEDED,
        payment.paymentIntentId
      );
      
      // Publish payment.processed event
      await this.rabbitmqService.publishPaymentProcessed(updatedPayment as unknown as Payment);
      
      this.logger.log(`Payment ${paymentId} confirmed successfully`);
      return updatedPayment as unknown as Payment;
    } catch (error) {
      this.logger.error(`Error confirming payment ${paymentId}: ${error.message}`);
      
      // Check if this is a card error that requires attention
      const errorMessage = error.message || 'Payment confirmation failed';
      const isCardError = error.type === 'StripeCardError' || 
                         errorMessage.toLowerCase().includes('card') || 
                         errorMessage.toLowerCase().includes('payment method');
      
      // Update payment status to FAILED
      const updatedPayment = await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.FAILED,
          errorMessage: errorMessage,
          metadata: {
            ...(payment.metadata as object || {}),
            lastError: {
              message: errorMessage,
              type: error.type || 'unknown',
              code: error.code || 'unknown',
              time: new Date().toISOString()
            }
          } as Prisma.JsonObject,
          updatedAt: new Date(),
        },
      });
      
      // Update order payment status
      await this.orderService.updatePaymentStatus(
        payment.orderId,
        PaymentStatus.FAILED,
        payment.paymentIntentId
      );
      
      // Publish payment.failed event
      await this.rabbitmqService.publishPaymentFailed(updatedPayment as unknown as Payment);
      
      throw new BadRequestException({
        message: errorMessage,
        code: error.code || 'payment_failed',
        type: error.type || 'card_error',
        isCardError: isCardError,
        paymentId: payment.id
      });
    }
  }
} 