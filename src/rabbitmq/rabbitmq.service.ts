import { Injectable, Inject, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

@Injectable()
export class RabbitmqService {
  private readonly logger = new Logger(RabbitmqService.name);

  constructor(
    // @ts-ignore
    @Inject('RABBITMQ_CLIENT') private readonly client: ClientProxy,
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.client.connect();
      this.logger.log('Connected to RabbitMQ');
    } catch (err) {
      this.logger.error('Failed to connect to RabbitMQ', err);
    }
  }

  async publishPaymentProcessed(payment: any) {
    try {
      this.client.emit('payment.processed', payment);
      this.logger.log(`Payment processed event published for payment ${payment.id}`);
    } catch (error) {
      this.logger.error('Failed to publish payment processed event', error);
    }
  }

  async publishPaymentFailed(payment: any) {
    try {
      this.client.emit('payment.failed', payment);
      this.logger.log(`Payment failed event published for payment ${payment.id}`);
    } catch (error) {
      this.logger.error('Failed to publish payment failed event', error);
    }
  }
} 