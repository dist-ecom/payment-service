import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PaymentStatus } from '@prisma/client';

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
  private readonly orderServiceUrl: string;
  private readonly serviceToken: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.orderServiceUrl = this.configService.get<string>('ORDER_SERVICE_URL');
    this.serviceToken = this.configService.get<string>('SERVICE_TOKEN');
  }

  async getOrderDetails(orderId: string): Promise<OrderDetails> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<OrderDetails>(`${this.orderServiceUrl}/orders/${orderId}`, {
          headers: {
            Authorization: `Bearer ${this.serviceToken}`,
          },
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`Error fetching order details: ${error.message}`, error.stack);
      throw new HttpException(
        `Order with ID ${orderId} not found or inaccessible`,
        HttpStatus.NOT_FOUND,
      );
    }
  }

  async updatePaymentStatus(
    orderId: string,
    paymentStatus: PaymentStatus,
    paymentIntentId?: string,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.patch(
          `${this.orderServiceUrl}/orders/${orderId}/payment-status`,
          {
            paymentStatus,
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
  mapPaymentStatusToOrderPaymentStatus(status: PaymentStatus): string {
    switch (status) {
      case PaymentStatus.PENDING:
        return 'pending';
      case PaymentStatus.PROCESSING:
        return 'pending';
      case PaymentStatus.SUCCEEDED:
        return 'completed';
      case PaymentStatus.FAILED:
        return 'failed';
      case PaymentStatus.REFUNDED:
        return 'refunded';
      case PaymentStatus.CANCELLED:
        return 'failed';
      default:
        return 'pending';
    }
  }
} 