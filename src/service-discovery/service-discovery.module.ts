import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { ServiceDiscoveryService } from './service-discovery.service';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
  ],
  providers: [ServiceDiscoveryService],
  exports: [ServiceDiscoveryService],
})
export class ServiceDiscoveryModule {} 