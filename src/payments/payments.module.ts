import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeService } from './services/stripe.service';
import { OrderService } from './services/order.service';
import { ServiceDiscoveryModule } from '../service-discovery/service-discovery.module';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    PrismaModule,
    ServiceDiscoveryModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, StripeService, OrderService],
  exports: [PaymentsService],
})
export class PaymentsModule {} 