import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentStatus } from '@prisma/client';

@Injectable()
export class StripeService {
  private stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    this.stripe = new Stripe(apiKey, {
      apiVersion: '2023-08-16', // Match the expected type in Stripe's type definition
    });
  }

  async createPaymentIntent(
    amount: number,
    currency: string,
    orderId: string,
    metadata: Record<string, any> = {},
  ): Promise<{ clientSecret: string; paymentIntentId: string }> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Stripe uses smallest currency unit (cents)
        currency: currency.toLowerCase(),
        metadata: {
          orderId,
          ...metadata,
        },
        payment_method_types: ['card'],
        description: `Payment for Order ${orderId}`,
      });

      return {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
      };
    } catch (error) {
      this.logger.error(`Error creating payment intent: ${error.message}`, error.stack);
      throw error;
    }
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    try {
      // Expand charges to get receipt URLs and other charge details
      return await this.stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['charges.data', 'latest_charge'],
      });
    } catch (error) {
      this.logger.error(`Error retrieving payment intent: ${error.message}`, error.stack);
      throw error;
    }
  }

  async cancelPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    try {
      return await this.stripe.paymentIntents.cancel(paymentIntentId);
    } catch (error) {
      this.logger.error(`Error cancelling payment intent: ${error.message}`, error.stack);
      throw error;
    }
  }

  async refundPayment(paymentIntentId: string, amount?: number): Promise<Stripe.Refund> {
    try {
      const refundParams: Stripe.RefundCreateParams = {
        payment_intent: paymentIntentId,
      };

      if (amount) {
        refundParams.amount = Math.round(amount * 100);
      }

      return await this.stripe.refunds.create(refundParams);
    } catch (error) {
      this.logger.error(`Error refunding payment: ${error.message}`, error.stack);
      throw error;
    }
  }

  async constructEventFromPayload(
    payload: Buffer,
    signature: string,
  ): Promise<Stripe.Event> {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    try {
      return this.stripe.webhooks.constructEvent(
        payload,
        signature,
        webhookSecret,
      );
    } catch (error) {
      this.logger.error(`Error constructing webhook event: ${error.message}`, error.stack);
      throw error;
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
} 