import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException, Inject, forwardRef, ForbiddenException, InternalServerErrorException, UnprocessableEntityException } from '@nestjs/common';
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
      // Validate currency
      const supportedCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'];
      const currency = createPaymentDto.currency || 'USD';
      
      if (!supportedCurrencies.includes(currency)) {
        throw new BadRequestException(`Unsupported currency: ${currency}. Supported currencies: ${supportedCurrencies.join(', ')}`);
      }
      
      // Validate payment amount
      if (createPaymentDto.amount <= 0) {
        throw new BadRequestException('Payment amount must be greater than zero');
      }
      
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

      // Get order details to verify ownership and amount
      const order = await this.orderService.getOrderDetails(createPaymentDto.orderId);
      
      if (!order) {
        this.logger.error(`Order ${createPaymentDto.orderId} not found`);
        throw new NotFoundException(`Order ${createPaymentDto.orderId} not found`);
      }

      if (order.userId !== userId) {
        this.logger.error(`User ${userId} does not own order ${createPaymentDto.orderId}`);
        throw new ForbiddenException('You do not have permission to pay for this order');
      }
      
      // Verify order is in a state that can be paid
      if (order.status !== 'pending') {
        throw new BadRequestException(`Cannot process payment for order with status: ${order.status}`);
      }
      
      // Verify payment amount matches order total
      if (Math.abs(order.totalAmount - createPaymentDto.amount) > 0.01) {
        this.logger.error(`Payment amount mismatch: ${createPaymentDto.amount} vs order total ${order.totalAmount}`);
        throw new BadRequestException(`Payment amount (${createPaymentDto.amount}) does not match order total (${order.totalAmount})`);
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
          // Prepare metadata for Stripe
          const metadata = {
            orderId: createPaymentDto.orderId,
            userId,
            ...createPaymentDto.metadata || {}
          };
          
          // Create the payment intent
          const result = await this.stripeService.createPaymentIntent(
            createPaymentDto.amount,
            currency,
            createPaymentDto.orderId,
            metadata
          );
          
          clientSecret = result.clientSecret;
          paymentIntentId = result.paymentIntentId;
          this.logger.debug(`Stripe payment intent created: ${paymentIntentId}`);
        } catch (stripeError) {
          this.logger.error(`Stripe payment intent creation failed: ${stripeError.message}`, stripeError.stack);
          throw new UnprocessableEntityException(`Payment processing error: ${stripeError.message}`);
        }
      }

      // Save the payment record to database
      const payment = await this.prisma.payment.create({
        data: {
          orderId: createPaymentDto.orderId,
          userId,
          amount: createPaymentDto.amount,
          currency,
          status: PaymentStatus.PENDING,
          provider: createPaymentDto.provider || PaymentProvider.STRIPE,
          paymentMethod: createPaymentDto.paymentMethod,
          description: createPaymentDto.description || `Payment for order ${createPaymentDto.orderId}`,
          clientSecret,
          paymentIntentId,
          metadata: {
            orderDetails: {
              totalAmount: order.totalAmount,
              paymentMethod: order.paymentMethod,
              status: order.status
            },
            ...createPaymentDto.metadata || {}
          } as Prisma.JsonObject,
        },
      });

      this.logger.log(`Payment ${payment.id} created successfully for order ${createPaymentDto.orderId}`);
      
      // Update order payment status
      await this.orderService.updatePaymentStatus(
        createPaymentDto.orderId,
        PaymentStatus.PENDING,
        payment.paymentIntentId
      );
      
      // Publish payment created event
      await this.rabbitmqService.publishPaymentProcessed(payment);

      return payment;
    } catch (error) {
      this.logger.error(`Failed to create payment: ${error.message}`, error.stack);
      if (error instanceof ConflictException || 
          error instanceof NotFoundException || 
          error instanceof ForbiddenException ||
          error instanceof BadRequestException ||
          error instanceof UnprocessableEntityException) {
        throw error;
      }
      throw new InternalServerErrorException(`Payment processing failed: ${error.message}`);
    }
  }

  async findAll(userId?: string): Promise<Payment[]> {
    const where = userId ? { userId } : {};
    return this.prisma.payment.findMany({ 
      where,
      orderBy: { createdAt: 'desc' }
    });
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
    this.logger.log(`Cancelling payment ${paymentId} for user ${userId}`);
    
    try {
      const payment = await this.findOne(paymentId, userId);
  
      if (payment.status !== PaymentStatus.PENDING &&
          payment.status !== PaymentStatus.PROCESSING) {
        throw new BadRequestException('Only pending or processing payments can be cancelled');
      }
  
      // Cancel payment with provider
      if (payment.provider === PaymentProvider.STRIPE && payment.paymentIntentId) {
        await this.stripeService.cancelPaymentIntent(payment.paymentIntentId);
      }
  
      // Update payment status in database
      const updatedPayment = await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.CANCELLED,
          updatedAt: new Date(),
        },
      });
  
      // Update order payment status
      await this.orderService.updatePaymentStatus(
        payment.orderId,
        PaymentStatus.CANCELLED,
        payment.paymentIntentId,
      );
      
      // Publish payment cancelled event
      await this.rabbitmqService.publishPaymentFailed(updatedPayment);
      
      this.logger.log(`Payment ${paymentId} cancelled successfully`);
  
      return updatedPayment;
    } catch (error) {
      this.logger.error(`Error cancelling payment: ${error.message}`, error.stack);
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException(`Failed to cancel payment: ${error.message}`);
    }
  }

  async refundPayment(paymentId: string, userId: string): Promise<Payment> {
    this.logger.log(`Refunding payment ${paymentId} for user ${userId}`);
    
    try {
      const payment = await this.findOne(paymentId, userId);
  
      if (payment.status !== PaymentStatus.SUCCEEDED) {
        throw new BadRequestException('Only successful payments can be refunded');
      }
  
      // Process refund with provider
      if (payment.provider === PaymentProvider.STRIPE && payment.paymentIntentId) {
        await this.stripeService.refundPayment(payment.paymentIntentId);
      }
  
      // Update payment status
      const updatedPayment = await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.REFUNDED,
          updatedAt: new Date(),
        },
      });
  
      // Update order payment status
      await this.orderService.updatePaymentStatus(
        payment.orderId,
        PaymentStatus.REFUNDED,
        payment.paymentIntentId,
      );
      
      // Publish payment refunded event
      await this.rabbitmqService.publishPaymentFailed(updatedPayment);
      
      this.logger.log(`Payment ${paymentId} refunded successfully`);
  
      return updatedPayment;
    } catch (error) {
      this.logger.error(`Error refunding payment: ${error.message}`, error.stack);
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException(`Failed to refund payment: ${error.message}`);
    }
  }

  /**
   * Handle webhook events from payment providers
   */
  async handleWebhook(event: WebhookEventDto): Promise<void> {
    this.logger.log(`Processing webhook event: ${event.type}`);
    
    try {
      // Handle different event types
      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.handlePaymentIntentSucceeded(event.data.object);
          break;
        
        case 'payment_intent.payment_failed':
          await this.handlePaymentIntentFailed(event.data.object);
          break;
        
        case 'charge.refunded':
          await this.handleChargeRefunded(event.data.object);
          break;
        
        default:
          this.logger.log(`Unhandled webhook event type: ${event.type}`);
      }
    } catch (error) {
      this.logger.error(`Error processing webhook event: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Handle payment_intent.succeeded event
   */
  private async handlePaymentIntentSucceeded(paymentIntent: any): Promise<void> {
    this.logger.log(`Processing payment_intent.succeeded for ${paymentIntent.id}`);
    
    try {
      // Extract metadata
      const { orderId } = paymentIntent.metadata || {};
      
      if (!orderId) {
        this.logger.error(`Payment intent ${paymentIntent.id} does not have an orderId in metadata`);
        return;
      }
      
      // Check if we already have a payment record for this intent
      const existingPayment = await this.prisma.payment.findFirst({
        where: { paymentIntentId: paymentIntent.id }
      });
      
      if (existingPayment) {
        // Update existing payment record if status not already succeeded
        if (existingPayment.status !== PaymentStatus.SUCCEEDED) {
          await this.prisma.payment.update({
            where: { id: existingPayment.id },
            data: {
              status: PaymentStatus.SUCCEEDED,
              updatedAt: new Date(),
              receiptUrl: paymentIntent.charges?.data[0]?.receipt_url,
            }
          });
          
          this.logger.log(`Updated payment ${existingPayment.id} to SUCCEEDED status`);
        }
      } else {
        // Create new payment record
        // Get the amount from the payment intent (in cents)
        const amount = paymentIntent.amount / 100;
        const currency = paymentIntent.currency;
        
        // We need to find the user ID associated with this order
        // This would typically be done by querying the order service
        let userId = paymentIntent.metadata.userId;
        
        if (!userId) {
          try {
            // Try to get order details from order service
            const orderDetails = await this.orderService.getOrderDetails(orderId);
            userId = orderDetails.userId;
          } catch (error) {
            this.logger.error(`Could not get user ID for order ${orderId}: ${error.message}`);
            // Fallback to a default system user ID or null 
            userId = null;
          }
        }
        
        // Create payment record
        const payment = await this.prisma.payment.create({
          data: {
            orderId,
            userId,
            amount,
            currency,
            paymentIntentId: paymentIntent.id,
            paymentMethod: paymentIntent.payment_method,
            status: PaymentStatus.SUCCEEDED,
            provider: PaymentProvider.STRIPE,
            receiptUrl: paymentIntent.charges?.data[0]?.receipt_url,
            description: `Payment for order ${orderId}`,
            metadata: paymentIntent.metadata,
          }
        });
        
        this.logger.log(`Created new payment record: ${payment.id}`);
      }
      
      // Notify order service about successful payment
      try {
        await this.orderService.updatePaymentStatus(
          orderId,
          PaymentStatus.SUCCEEDED,
          paymentIntent.id
        );
        this.logger.log(`Updated order ${orderId} payment status to PAID`);
      } catch (error) {
        this.logger.error(`Failed to update order payment status: ${error.message}`, error.stack);
        // We don't want to fail the webhook processing if this call fails
        // Consider implementing a retry mechanism or queue
      }
      
    } catch (error) {
      this.logger.error(`Error processing payment intent succeeded: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Handle payment_intent.payment_failed event
   */
  private async handlePaymentIntentFailed(paymentIntent: any): Promise<void> {
    this.logger.log(`Processing payment_intent.payment_failed for ${paymentIntent.id}`);
    
    try {
      // Extract metadata
      const { orderId } = paymentIntent.metadata || {};
      
      if (!orderId) {
        this.logger.error(`Payment intent ${paymentIntent.id} does not have an orderId in metadata`);
        return;
      }
      
      // Check if we have a payment record for this intent
      const existingPayment = await this.prisma.payment.findFirst({
        where: { paymentIntentId: paymentIntent.id }
      });
      
      if (existingPayment) {
        // Update existing payment record
        await this.prisma.payment.update({
          where: { id: existingPayment.id },
          data: {
            status: PaymentStatus.FAILED,
            updatedAt: new Date(),
            errorMessage: paymentIntent.last_payment_error?.message,
          }
        });
        
        this.logger.log(`Updated payment ${existingPayment.id} to FAILED status`);
      }
      
      // Notify order service about failed payment
      try {
        await this.orderService.updatePaymentStatus(
          orderId,
          PaymentStatus.FAILED,
          paymentIntent.id
        );
        this.logger.log(`Updated order ${orderId} payment status to FAILED`);
      } catch (error) {
        this.logger.error(`Failed to update order payment status: ${error.message}`, error.stack);
      }
      
    } catch (error) {
      this.logger.error(`Error processing payment intent failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Handle charge.refunded event
   */
  private async handleChargeRefunded(charge: any): Promise<void> {
    this.logger.log(`Processing charge.refunded for ${charge.id}`);
    
    try {
      // Get the payment intent ID from the charge
      const paymentIntentId = charge.payment_intent;
      
      if (!paymentIntentId) {
        this.logger.error(`Charge ${charge.id} does not have a payment_intent`);
        return;
      }
      
      // Find the payment record by payment intent ID
      const payment = await this.prisma.payment.findFirst({
        where: { paymentIntentId }
      });
      
      if (!payment) {
        this.logger.error(`No payment record found for payment intent ${paymentIntentId}`);
        return;
      }
      
      // Update payment status to refunded
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.REFUNDED,
          updatedAt: new Date(),
          metadata: {
            refundId: charge.id,
            refundAmount: charge.amount_refunded / 100,
            refundDate: new Date().toISOString()
          } as any,
        }
      });
      
      this.logger.log(`Updated payment ${payment.id} to REFUNDED status`);
      
      // Notify order service about refund
      try {
        await this.orderService.updatePaymentStatus(
          payment.orderId,
          PaymentStatus.REFUNDED,
          paymentIntentId
        );
        this.logger.log(`Updated order ${payment.orderId} payment status to REFUNDED`);
      } catch (error) {
        this.logger.error(`Failed to update order payment status: ${error.message}`, error.stack);
      }
      
    } catch (error) {
      this.logger.error(`Error processing charge refunded: ${error.message}`, error.stack);
      throw error;
    }
  }

  async checkPaymentStatus(paymentId: string, userId: string): Promise<Payment> {
    try {
      const payment = await this.findOne(paymentId, userId);
      
      // If payment is already in a final state, just return it
      const finalStates = [
        PaymentStatus.SUCCEEDED,
        PaymentStatus.FAILED,
        PaymentStatus.CANCELLED,
        PaymentStatus.REFUNDED
      ];
      
      if (finalStates.includes(payment.status as any)) {
        return payment;
      }
      
      // Only check with provider if we're using a real payment provider
      if (payment.provider === PaymentProvider.STRIPE && 
          payment.paymentIntentId && 
          !payment.paymentIntentId.startsWith('mock_')) {
          
        // Get latest status from Stripe
        const paymentIntent = await this.stripeService.retrievePaymentIntent(payment.paymentIntentId);
        
        // Map Stripe status to our internal status
        let updatedStatus = payment.status;
        
        switch(paymentIntent.status) {
          case 'succeeded':
            updatedStatus = PaymentStatus.SUCCEEDED;
            break;
          case 'canceled':
            updatedStatus = PaymentStatus.CANCELLED;
            break;
          case 'requires_payment_method':
          case 'requires_confirmation':
          case 'requires_action':
          case 'processing':
            // These are all variations of "in progress" - keep as PENDING
            updatedStatus = PaymentStatus.PENDING;
            break;
          default:
            // If we don't recognize the status, leave it unchanged
            this.logger.warn(`Unrecognized Stripe payment status: ${paymentIntent.status}`);
        }
        
        // If status has changed, update our record
        if (updatedStatus !== payment.status) {
          const updatedPayment = await this.prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: updatedStatus,
              updatedAt: new Date(),
            },
          });
          
          // Update order payment status if needed
          if (updatedStatus === PaymentStatus.SUCCEEDED) {
            await this.orderService.updatePaymentStatus(
              payment.orderId,
              PaymentStatus.SUCCEEDED,
              payment.paymentIntentId,
            );
            
            // Publish payment.processed event
            await this.rabbitmqService.publishPaymentProcessed(updatedPayment);
          } else if (updatedStatus === PaymentStatus.CANCELLED) {
            await this.orderService.updatePaymentStatus(
              payment.orderId,
              PaymentStatus.CANCELLED,
              payment.paymentIntentId,
            );
          }
          
          return updatedPayment;
        }
      }
      
      // If no changes or not using a real provider, return the original payment
      return payment;
    } catch (error) {
      this.logger.error(`Error checking payment status: ${error.message}`, error.stack);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(`Failed to check payment status: ${error.message}`);
    }
  }

  async findByOrderId(orderId: string, userId: string): Promise<Payment> {
    try {
      const payment = await this.prisma.payment.findFirst({
        where: {
          orderId,
          userId,
        },
      });
  
      if (!payment) {
        throw new NotFoundException(`Payment for order ${orderId} not found`);
      }
  
      // Check if payment needs status updating (for pending payments)
      if (payment.status === PaymentStatus.PENDING || payment.status === PaymentStatus.PROCESSING) {
        return this.checkPaymentStatus(payment.id, userId);
      }
  
      return payment;
    } catch (error) {
      this.logger.error(`Error finding payment by order ID: ${error.message}`, error.stack);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(`Failed to retrieve payment information: ${error.message}`);
    }
  }

  async confirmPayment(
    paymentId: string, 
    confirmPaymentDto: ConfirmPaymentDto, 
    userId: string
  ): Promise<Payment> {
    this.logger.log(`Confirming payment ${paymentId} for user ${userId}`);
    
    try {
      const payment = await this.findOne(paymentId, userId);
      
      if (payment.status !== PaymentStatus.PENDING) {
        throw new BadRequestException(`Cannot confirm payment with status: ${payment.status}`);
      }
      
      // Only confirm real payments, not mock ones
      if (payment.provider === PaymentProvider.STRIPE && 
          payment.paymentIntentId && 
          !payment.paymentIntentId.startsWith('mock_')) {
          
        // The DTO now includes either payment_method_id or token
        const { paymentMethodId, token } = confirmPaymentDto;
        
        // Basic validation
        if (!paymentMethodId && !token) {
          throw new BadRequestException('Either a payment method ID or a token is required');
        }
        
        try {
          // Confirm payment with Stripe using payment method ID or token
          const result = await this.stripeService.confirmPaymentWithCard(
            payment.paymentIntentId,
            paymentMethodId,
            token
          );
          
          // Check if payment succeeded immediately
          if (result.status === 'succeeded') {
            // Update payment status to succeeded
            const updatedPayment = await this.prisma.payment.update({
              where: { id: payment.id },
              data: {
                status: PaymentStatus.SUCCEEDED,
                updatedAt: new Date(),
              },
            });
            
            // Update order payment status
            await this.orderService.updatePaymentStatus(
              payment.orderId,
              PaymentStatus.SUCCEEDED,
              payment.paymentIntentId,
            );
            
            // Publish payment processed event
            await this.rabbitmqService.publishPaymentProcessed(updatedPayment);
            
            this.logger.log(`Payment ${paymentId} confirmed successfully`);
            
            return updatedPayment;
          } else if (result.status === 'requires_action') {
            // For 3D Secure or other additional authentication
            // In a real implementation, this would be handled by the frontend
            return await this.updatePaymentStatusFromStripe(payment, payment.paymentIntentId);
          } else {
            // Update payment status to reflect current state
            return this.checkPaymentStatus(paymentId, userId);
          }
        } catch (stripeError) {
          this.logger.error(`Stripe payment confirmation failed: ${stripeError.message}`, stripeError.stack);
          
          // Update payment status to failed
          const updatedPayment = await this.prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.FAILED,
              errorMessage: stripeError.message,
              metadata: {
                ...(payment.metadata as object || {}),
                errorDetails: stripeError.message
              } as Prisma.JsonObject,
              updatedAt: new Date(),
            },
          });
          
          // Update order payment status
          await this.orderService.updatePaymentStatus(
            payment.orderId,
            PaymentStatus.FAILED,
            payment.paymentIntentId,
          );
          
          throw new UnprocessableEntityException(`Payment confirmation failed: ${stripeError.message}`);
        }
      } else if (payment.paymentIntentId?.startsWith('mock_')) {
        // For mock payments, simulate success
        this.logger.log(`Processing mock payment ${paymentId}`);
        
        // Update payment status to succeeded
        const updatedPayment = await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.SUCCEEDED,
            receiptUrl: `https://example.com/receipt/${payment.paymentIntentId}`,
            updatedAt: new Date(),
          },
        });
        
        // Update order payment status
        await this.orderService.updatePaymentStatus(
          payment.orderId,
          PaymentStatus.SUCCEEDED,
          payment.paymentIntentId,
        );
        
        // Publish payment processed event
        await this.rabbitmqService.publishPaymentProcessed(updatedPayment);
        
        this.logger.log(`Mock payment ${paymentId} confirmed successfully`);
        
        return updatedPayment;
      } else {
        throw new BadRequestException('Unable to confirm payment with current provider configuration');
      }
    } catch (error) {
      this.logger.error(`Error confirming payment: ${error.message}`, error.stack);
      if (error instanceof NotFoundException || 
          error instanceof BadRequestException || 
          error instanceof UnprocessableEntityException) {
        throw error;
      }
      throw new InternalServerErrorException(`Failed to confirm payment: ${error.message}`);
    }
  }

  // Helper method to update payment status from Stripe
  private async updatePaymentStatusFromStripe(payment: Payment, paymentIntentId: string): Promise<Payment> {
    const paymentIntent = await this.stripeService.retrievePaymentIntent(paymentIntentId);
    const updatedStatus = this.stripeService.mapStripeStatusToPaymentStatus(paymentIntent.status);
    
    return await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: updatedStatus,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Create a quick checkout session that redirects directly to Stripe Checkout
   */
  async createQuickCheckout(checkoutDto: {
    orderId: string;
    items: Array<{
      name: string;
      description?: string;
      price: number;
      quantity: number;
      images?: string[];
      productId: string;
    }>;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
    currency?: string;
    metadata?: Record<string, any>;
  }, userId: string): Promise<{ checkoutUrl: string; sessionId: string }> {
    this.logger.log(`Creating quick checkout for order ${checkoutDto.orderId}`);
    
    try {
      // Validate that the order exists
      const order = await this.orderService.getOrderDetails(checkoutDto.orderId);
      
      if (!order) {
        throw new NotFoundException(`Order ${checkoutDto.orderId} not found`);
      }

      // Validate user owns the order
      if (order.userId !== userId) {
        throw new ForbiddenException('You do not have permission to pay for this order');
      }
      
      // Create Stripe checkout session
      const session = await this.stripeService.createCheckoutSession({
        orderId: checkoutDto.orderId,
        userId,
        items: checkoutDto.items,
        successUrl: checkoutDto.successUrl,
        cancelUrl: checkoutDto.cancelUrl,
        customerEmail: checkoutDto.customerEmail,
        currency: checkoutDto.currency,
        metadata: {
          ...checkoutDto.metadata,
          quickCheckout: true,
        }
      });

      // Record the checkout initiation
      await this.prisma.payment.create({
        data: {
          orderId: checkoutDto.orderId,
          userId,
          amount: order.totalAmount,
          currency: checkoutDto.currency || 'USD',
          status: PaymentStatus.PENDING,
          provider: PaymentProvider.STRIPE,
          paymentMethod: 'card',
          description: `Quick checkout for order ${checkoutDto.orderId}`,
          paymentIntentId: session.sessionId,
          metadata: {
            stripeCheckoutSession: session.sessionId,
            quickCheckout: true,
          } as Prisma.JsonObject,
        }
      });

      // Update order status
      await this.orderService.updatePaymentStatus(
        checkoutDto.orderId,
        PaymentStatus.PENDING,
        session.sessionId
      );

      return {
        checkoutUrl: session.url,
        sessionId: session.sessionId
      };
    } catch (error) {
      this.logger.error(`Failed to create quick checkout: ${error.message}`, error.stack);
      if (error instanceof NotFoundException || 
          error instanceof ForbiddenException || 
          error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException(`Failed to create checkout: ${error.message}`);
    }
  }
} 