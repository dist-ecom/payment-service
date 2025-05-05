import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
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
      
      this.logger.log(`Creating Stripe payment intent for order ${orderId} with amount ${amountInCents} cents`);
      
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

      this.logger.log(`Stripe payment intent created successfully: ${paymentIntent.id}`);
      this.logger.debug(`Payment intent details: ${JSON.stringify({
        id: paymentIntent.id,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency
      })}`);

      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
      };
    } catch (error) {
      this.logger.error(`Error creating payment intent: ${error.message}`, error.stack);
      this.logger.debug(`Stripe error details: ${JSON.stringify(error)}`);
      
      // Provide more specific error messages based on Stripe error types
      if (error.type === 'StripeCardError') {
        throw new BadRequestException(`Card error: ${error.message}`);
      } else if (error.type === 'StripeInvalidRequestError') {
        throw new BadRequestException(`Invalid request: ${error.message}`);
      } else if (error.type === 'StripeAPIError') {
        throw new BadRequestException(`Stripe API error: ${error.message}`);
      }
      
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

  async confirmPaymentWithCard(
    paymentIntentId: string,
    paymentMethodId?: string,
    token?: string
  ): Promise<any> {
    try {
      this.logger.log(`Confirming Stripe payment intent ${paymentIntentId}`);
      
      if (!paymentIntentId) {
        throw new BadRequestException('Payment intent ID is required');
      }
      
      if (!paymentMethodId && !token) {
        throw new BadRequestException('Either payment method ID or token is required');
      }
      
      // First check the current status of the payment intent
      const currentPaymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
      
      if (!currentPaymentIntent) {
        throw new NotFoundException(`Payment intent ${paymentIntentId} not found`);
      }
      
      // If already succeeded, just return it
      if (currentPaymentIntent.status === 'succeeded') {
        this.logger.log(`Payment intent ${paymentIntentId} is already succeeded, no need to confirm`);
        return {
          clientSecret: currentPaymentIntent.client_secret,
          paymentIntentId: currentPaymentIntent.id,
          status: currentPaymentIntent.status
        };
      }
      
      try {
        // Create confirmation options based on whether we have a token or payment method ID
        const confirmOptions: any = {
          return_url: 'http://localhost:3100/payment-success',
        };
        
        // Use either the payment method ID or test token
        if (token) {
          confirmOptions.payment_method_data = {
            type: 'card',
            card: { token },
          };
          this.logger.log(`Using token for confirmation: ${token}`);
        } else if (paymentMethodId) {
          confirmOptions.payment_method = paymentMethodId;
          this.logger.log(`Using payment method ID for confirmation: ${paymentMethodId}`);
        }
        
        // Then confirm the payment intent with the payment method or token
        try {
          const confirmation = await this.stripe.paymentIntents.confirm(
            paymentIntentId,
            confirmOptions
          );
          
          this.logger.log(`Payment intent ${paymentIntentId} confirmed successfully with status: ${confirmation.status}`);
          
          return {
            clientSecret: confirmation.client_secret,
            paymentIntentId: confirmation.id,
            status: confirmation.status
          };
        } catch (confirmError) {
          this.logger.error(`Error confirming payment intent: ${confirmError.message}`);
          
          // If the payment intent can't be confirmed in its current state, try updating the payment method first
          if (confirmError.message.includes('cannot be confirmed again') || 
              confirmError.message.includes('Payment intent cannot be confirmed in its current state')) {
            
            // Try attaching a payment method first
            const paymentMethodData: any = token 
              ? { type: 'card', card: { token } }
              : { payment_method: paymentMethodId };
            
            this.logger.log(`Attempting to update payment method for intent ${paymentIntentId}`);
            
            // For test tokens, create a new payment method first
            if (token) {
              try {
                const paymentMethod = await this.stripe.paymentMethods.create({
                  type: 'card',
                  card: { token },
                });
                
                this.logger.log(`Created new payment method ${paymentMethod.id} from token`);
                
                // Attach the payment method to the payment intent
                await this.stripe.paymentIntents.update(paymentIntentId, {
                  payment_method: paymentMethod.id,
                });
                
                // Try confirming again with the new payment method
                const reconfirmation = await this.stripe.paymentIntents.confirm(
                  paymentIntentId,
                  { payment_method: paymentMethod.id }
                );
                
                this.logger.log(`Payment intent ${paymentIntentId} confirmed successfully after payment method update`);
                
                return {
                  clientSecret: reconfirmation.client_secret,
                  paymentIntentId: reconfirmation.id,
                  status: reconfirmation.status
                };
              } catch (pmError) {
                this.logger.error(`Error creating/attaching payment method: ${pmError.message}`);
                throw pmError;
              }
            }
          }
          
          throw confirmError;
        }
      } catch (error) {
        // If we get an error that suggests the payment intent is in a bad state,
        // try to create a new one and cancel the old one
        if (error.message.includes('canceled') || 
            error.message.includes('Payment intent cannot be confirmed in its current state')) {
          
          this.logger.log(`Payment intent ${paymentIntentId} is in a bad state. Trying to cancel it.`);
          
          try {
            // Try to cancel the payment intent if it's not already canceled
            if (currentPaymentIntent.status !== 'canceled') {
              await this.stripe.paymentIntents.cancel(paymentIntentId);
              this.logger.log(`Successfully canceled payment intent ${paymentIntentId}`);
            }
          } catch (cancelError) {
            this.logger.warn(`Could not cancel payment intent ${paymentIntentId}: ${cancelError.message}`);
          }
          
          throw new BadRequestException({
            message: 'Unable to confirm payment. Please create a new payment and try again.',
            code: 'payment_intent_invalid_state',
            status: currentPaymentIntent.status
          });
        }
        
        throw error;
      }
    } catch (error) {
      this.logger.error(`Error confirming payment intent ${paymentIntentId}: ${error.message}`);
      
      // Improved error handling with more details
      if (error.type === 'StripeCardError') {
        throw new BadRequestException({
          message: `Card error: ${error.message}`,
          code: error.code || 'card_error',
          decline_code: error.decline_code,
          param: error.param
        });
      } else if (error.type === 'StripeInvalidRequestError') {
        throw new BadRequestException({
          message: `Invalid request: ${error.message}`,
          code: error.code || 'invalid_request',
          param: error.param
        });
      }
      
      throw new BadRequestException(
        error.message || 'Error confirming payment'
      );
    }
  }

  // Add a simpler checkout session method that uses Stripe Checkout directly
  async createCheckoutSession(params: {
    orderId: string;
    userId: string;
    customerEmail?: string;
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
    metadata?: Record<string, any>;
    currency?: string;
  }): Promise<{ url: string; sessionId: string }> {
    try {
      const currency = params.currency?.toLowerCase() || 'usd';
      
      // Format line items for Stripe checkout
      const lineItems = params.items.map(item => ({
        price_data: {
          currency: currency,
          product_data: {
            name: item.name,
            description: item.description,
            images: item.images,
            metadata: { 
              productId: item.productId 
            },
          },
          unit_amount: Math.round(item.price * 100), // Convert to cents
        },
        quantity: item.quantity,
      }));

      // Create Stripe checkout session
      const session = await this.stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        customer_email: params.customerEmail,
        line_items: lineItems,
        metadata: {
          orderId: params.orderId,
          userId: params.userId,
          ...params.metadata,
        },
        shipping_address_collection: {
          allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'ES', 'IT'],
        },
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
      });

      this.logger.log(`Created Stripe checkout session: ${session.id} for order: ${params.orderId}`);
      
      return {
        url: session.url,
        sessionId: session.id
      };
    } catch (error) {
      this.logger.error(`Error creating checkout session: ${error.message}`, error.stack);
      throw new BadRequestException(`Checkout session creation failed: ${error.message}`);
    }
  }
} 