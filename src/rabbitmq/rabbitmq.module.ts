import { Module, forwardRef, OnModuleInit } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitmqService } from './rabbitmq.service';
import { OrdersConsumer } from './consumers/orders.consumer';
import { PaymentsModule } from '../payments/payments.module';
import { Logger } from '@nestjs/common';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: 'RABBITMQ_CLIENT',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672'],
            queue: 'payment_events_queue',
            queueOptions: {
              durable: true,
            },
            socketOptions: {
              heartbeatIntervalInSeconds: 5,
              reconnectTimeInSeconds: 5,
            },
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'ORDERS_RABBITMQ_CLIENT',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672'],
            queue: 'orders_queue',
            queueOptions: {
              durable: true,
            },
            socketOptions: {
              heartbeatIntervalInSeconds: 5,
              reconnectTimeInSeconds: 5,
            },
          },
        }),
        inject: [ConfigService],
      },
    ]),
    forwardRef(() => PaymentsModule),
  ],
  controllers: [OrdersConsumer],
  providers: [RabbitmqService],
  exports: [RabbitmqService],
})
export class RabbitmqModule implements OnModuleInit {
  private readonly logger = new Logger(RabbitmqModule.name);
  
  constructor() {}
  
  onModuleInit() {
    this.logger.log('RabbitmqModule initialized');
  }
} 