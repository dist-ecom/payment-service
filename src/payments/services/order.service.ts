import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PaymentStatus } from '@prisma/client';
import { ServiceDiscoveryService } from '../../service-discovery/service-discovery.service';

interface OrderDetails {
  id: string;
  userId: string;
  totalAmount: number;
  status: string;
  paymentStatus: string;
}

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);
  private readonly orderServiceUrl: string | undefined;
  private readonly serviceToken: string | undefined;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly serviceDiscovery: ServiceDiscoveryService,
  ) {
    // Initialize with fallback URL from env, will be dynamically updated via service discovery
    this.orderServiceUrl = this.configService.get<string>('ORDER_SERVICE_URL');
    this.serviceToken = this.configService.get<string>('SERVICE_TOKEN');
    
    if (!this.serviceToken) {
      this.logger.warn('SERVICE_TOKEN not configured - service-to-service authentication will fail');
    }
  }

  private async getOrderServiceUrl(): Promise<string> {
    try {
      return await this.serviceDiscovery.getServiceUrl('order-service');
    } catch (error) {
      if (!this.orderServiceUrl) {
        throw new Error('No order service URL available - both service discovery and fallback URL failed');
      }
      this.logger.warn(`Failed to get order service URL from discovery, using fallback: ${error.message}`);
      return this.orderServiceUrl;
    }
  }

  async getOrderDetails(orderId: string): Promise<OrderDetails> {
    try {
      const serviceUrl = await this.getOrderServiceUrl();
      
      if (!this.serviceToken) {
        throw new HttpException(
          'Service authentication token not configured',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }
      
      const response = await firstValueFrom(
        this.httpService.get<OrderDetails>(
          `${serviceUrl}/orders/${orderId}`,
          {
            headers: {
              Authorization: `Bearer ${this.serviceToken}`,
            },
          },
        ),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error getting order details: ${error.message}`, error.stack);
      throw new HttpException(
        `Order with ID ${orderId} not found or service unavailable`,
        error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async updatePaymentStatus(
    orderId: string,
    paymentStatus: PaymentStatus,
    paymentIntentId?: string,
  ): Promise<void> {
    try {
      const serviceUrl = await this.getOrderServiceUrl();
      
      if (!this.serviceToken) {
        throw new HttpException(
          'Service authentication token not configured',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }
      
      // Convert our internal payment status to the order service's expected format
      const orderPaymentStatus = this.mapPaymentStatusToOrderPaymentStatus(paymentStatus);
      
      await firstValueFrom(
        this.httpService.patch(
          `${serviceUrl}/orders/${orderId}/payment-status`,
          {
            paymentStatus: orderPaymentStatus,
            paymentIntentId,
          },
          {
            headers: {
              Authorization: `Bearer ${this.serviceToken}`,
            },
          },
        ),
      );
    } catch (error) {
      this.logger.error(`Error updating order payment status: ${error.message}`, error.stack);
      throw new HttpException(
        `Failed to update payment status for order ${orderId}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Map our payment service statuses to the order service payment statuses
  // Order service uses PaymentStatus enum: PENDING, PAID, COMPLETED, FAILED, REFUNDED
  mapPaymentStatusToOrderPaymentStatus(status: PaymentStatus): string {
    switch (status) {
      case PaymentStatus.PENDING:
        return 'pending';
      case PaymentStatus.PROCESSING:
        return 'pending'; // Order service considers processing as still pending
      case PaymentStatus.SUCCEEDED:
        return 'completed'; // Map SUCCEEDED to COMPLETED in order service
      case PaymentStatus.FAILED:
        return 'failed';
      case PaymentStatus.REFUNDED:
        return 'refunded';
      case PaymentStatus.CANCELLED:
        return 'failed'; // Map CANCELLED to FAILED in order service
      default:
        return 'pending';
    }
  }
} 