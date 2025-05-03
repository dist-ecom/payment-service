import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitmqService } from './rabbitmq.service';
import { OrdersConsumer } from './consumers/orders.consumer';

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
            queue: 'payments_queue',
            queueOptions: {
              durable: true,
            },
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  providers: [RabbitmqService, OrdersConsumer],
  exports: [RabbitmqService],
})
export class RabbitmqModule {} 