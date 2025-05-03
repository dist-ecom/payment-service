import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ServiceDiscoveryModule } from './service-discovery/service-discovery.module';
import { HealthModule } from './health/health.module';
import { RabbitmqModule } from './rabbitmq/rabbitmq.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    PaymentsModule,
    AuthModule,
    ServiceDiscoveryModule,
    HealthModule,
    RabbitmqModule,
  ],
})
export class AppModule {} 