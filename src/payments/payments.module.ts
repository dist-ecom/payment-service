import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { StripeService } from './services/stripe.service';
import { OrderService } from './services/order.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 5,
    }),
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, StripeService, OrderService],
  exports: [PaymentsService],
})
export class PaymentsModule {} 