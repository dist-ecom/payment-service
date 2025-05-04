import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentStatus } from '@prisma/client';

@Injectable()
export class StripeService {
  private stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);
  private readonly maxRetries = 3;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!apiKey) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required');
    }
    
    this.stripe = new Stripe(apiKey, {
      apiVersion: '2023-08-16',
      maxNetworkRetries: 2, // Enable automatic network retries
    });
  }

  async createPaymentIntent(
    amount: number,
    currency: string = 'usd',
    orderId: string,
    metadata: Record<string, any> = {},
  ): Promise<{ clientSecret: string; paymentIntentId: string }> {
    try {
      // Validate required parameters
      if (!amount || amount <= 0) {
        throw new BadRequestException('Invalid payment amount');
      }
      
      if (!orderId) {
        throw new BadRequestException('Order ID is required');
      }
      
      // Format amount to cents with proper rounding
      const amountInCents = Math.round(Number(amount) * 100);
      
      // Create Stripe payment intent with idempotency key to prevent duplicates
      const paymentIntent = await this.stripe.paymentIntents.create(
        {
          amount: amountInCents,
          currency: currency.toLowerCase(),
          metadata: {
            orderId,
            ...metadata,
          },
          payment_method_types: ['card'],
          description: `Payment for Order ${orderId}`,
          // Automatically capture payment when authorized
          capture_method: 'automatic',
          // Set statement descriptor for customer recognition
          statement_descriptor_suffix: 'ORDER PAYMENT',
        },
        {
          // Use the order ID as idempotency key to prevent duplicate orders
          idempotencyKey: `order_${orderId}_${Date.now()}`,
        }
      );

      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
      };
    } catch (error) {
      this.logger.error(`Error creating payment intent: ${error.message}`, error.stack);
      throw this.formatStripeError(error);
    }
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    try {
      return await this.retryOperation(() => 
        this.stripe.paymentIntents.retrieve(paymentIntentId, {
          expand: ['charges.data', 'latest_charge'],
        })
      );
    } catch (error) {
      this.logger.error(`Error retrieving payment intent: ${error.message}`, error.stack);
      throw this.formatStripeError(error);
    }
  }

  async cancelPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    try {
      return await this.retryOperation(() => 
        this.stripe.paymentIntents.cancel(paymentIntentId)
      );
    } catch (error) {
      this.logger.error(`Error cancelling payment intent: ${error.message}`, error.stack);
      throw this.formatStripeError(error);
    }
  }

  async refundPayment(paymentIntentId: string, amount?: number): Promise<Stripe.Refund> {
    try {
      const refundParams: Stripe.RefundCreateParams = {
        payment_intent: paymentIntentId,
      };

      if (amount) {
        refundParams.amount = Math.round(Number(amount) * 100);
      }

      // Create the refund with idempotency to prevent duplicate refunds
      return await this.stripe.refunds.create(
        refundParams,
        {
          idempotencyKey: `refund_${paymentIntentId}_${Date.now()}`,
        }
      );
    } catch (error) {
      this.logger.error(`Error refunding payment: ${error.message}`, error.stack);
      throw this.formatStripeError(error);
    }
  }

  async constructEventFromPayload(
    payload: Buffer,
    signature: string,
  ): Promise<Stripe.Event> {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required');
    }
    
    try {
      return this.stripe.webhooks.constructEvent(
        payload,
        signature,
        webhookSecret,
      );
    } catch (error) {
      this.logger.error(`Error constructing webhook event: ${error.message}`, error.stack);
      throw new BadRequestException(`Webhook error: ${error.message}`);
    }
  }

  mapStripeStatusToPaymentStatus(stripeStatus: string): PaymentStatus {
    switch (stripeStatus) {
      case 'requires_payment_method':
      case 'requires_confirmation':
      case 'requires_action':
      case 'processing':
        return PaymentStatus.PROCESSING;
      case 'succeeded':
        return PaymentStatus.SUCCEEDED;
      case 'canceled':
        return PaymentStatus.CANCELLED;
      case 'requires_capture':
        return PaymentStatus.PENDING;
      default:
        return PaymentStatus.FAILED;
    }
  }
  
  // Helper method for retrying operations with exponential backoff
  private async retryOperation<T>(operation: () => Promise<T>): Promise<T> {
    let retries = 0;
    let lastError: any;
    
    while (retries < this.maxRetries) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        retries++;
        
        // Don't retry if the error is not retryable
        if (error.type === 'StripeCardError' || error.type === 'StripeInvalidRequestError') {
          throw error;
        }
        
        if (retries >= this.maxRetries) {
          break;
        }
        
        // Exponential backoff
        const delay = 1000 * Math.pow(2, retries);
        this.logger.warn(`Retrying operation after ${delay}ms (attempt ${retries} of ${this.maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError;
  }
  
  // Format Stripe errors for better client-side handling
  private formatStripeError(error: any): Error {
    if (error.type === 'StripeCardError') {
      // Card errors should be shown to the user
      return new BadRequestException({
        code: error.code || 'card_error',
        message: error.message || 'Your card was declined',
        param: error.param,
        type: error.type,
      });
    } else if (error.type === 'StripeInvalidRequestError') {
      // Invalid parameters were supplied to Stripe's API
      return new BadRequestException({
        code: 'invalid_request',
        message: error.message || 'Invalid request to payment processor',
        param: error.param,
        type: error.type,
      });
    } else {
      // For other types of errors, hide the details in production
      if (process.env.NODE_ENV === 'production') {
        return new Error('An error occurred processing your payment.');
      } else {
        return error;
      }
    }
  }
} 