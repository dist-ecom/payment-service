import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaymentsService } from '../../src/payments/payments.service';
import { StripeService } from '../../src/payments/services/stripe.service';
import { OrderService } from '../../src/payments/services/order.service';
import { HttpModule } from '@nestjs/axios';
import { PaymentStatus, PaymentProvider } from '@prisma/client';
import { of } from 'rxjs';
import { CreatePaymentDto } from '../../src/payments/dto/create-payment.dto';

// Mock axios response to avoid real HTTP calls
const mockHttpService = {
  get: jest.fn(),
  patch: jest.fn(),
};

// Mock Stripe service to avoid real Stripe API calls
const mockStripeService = {
  createPaymentIntent: jest.fn(),
  retrievePaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(),
  refundPayment: jest.fn(),
  mapStripeStatusToPaymentStatus: jest.fn(),
};

// Mock Prisma service to avoid database calls
const mockPrismaService = {
  payment: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  webhookEvent: {
    create: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn((fn) => fn()),
};

describe('Payment-Order Integration', () => {
  let app: INestApplication;
  let paymentsService: PaymentsService;
  let orderService: OrderService;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          // Mock environment variables
          load: [
            () => ({
              ORDER_SERVICE_URL: 'http://localhost:3002',
              SERVICE_TOKEN: 'test-token',
            }),
          ],
        }),
        HttpModule,
      ],
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: StripeService, useValue: mockStripeService },
        OrderService,
      ],
    })
      .overrideProvider(HttpModule)
      .useValue(mockHttpService)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    paymentsService = moduleFixture.get<PaymentsService>(PaymentsService);
    orderService = moduleFixture.get<OrderService>(OrderService);

    // Reset mocks
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Payment Creation with Order Validation', () => {
    it('should validate the order before creating a payment', async () => {
      const userId = 'user123';
      const orderId = 'order123';
      
      // Mock the order service response
      mockHttpService.get.mockReturnValue(
        of({
          data: {
            id: orderId,
            userId,
            totalAmount: 99.99,
            status: 'pending',
            paymentStatus: 'pending',
          },
        }),
      );

      // Mock the Stripe service
      mockStripeService.createPaymentIntent.mockResolvedValue({
        clientSecret: 'secret123',
        paymentIntentId: 'pi_123456',
      });

      // Mock the Prisma payment creation
      mockPrismaService.payment.create.mockResolvedValue({
        id: 'payment123',
        orderId,
        userId,
        amount: 99.99,
        currency: 'USD',
        status: PaymentStatus.PENDING,
        provider: PaymentProvider.STRIPE,
        paymentMethod: 'card',
        paymentIntentId: 'pi_123456',
        clientSecret: 'secret123',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create payment DTO
      const createPaymentDto: CreatePaymentDto = {
        orderId,
        amount: 99.99,
        currency: 'USD',
        paymentMethod: 'card',
        provider: PaymentProvider.STRIPE,
      };

      // Call the service
      const payment = await paymentsService.createPayment(createPaymentDto, userId);

      // Assertions
      expect(mockHttpService.get).toHaveBeenCalledWith(
        `http://localhost:3002/orders/${orderId}`,
        expect.any(Object),
      );
      expect(mockStripeService.createPaymentIntent).toHaveBeenCalledWith(
        99.99,
        'USD',
        orderId,
        undefined,
      );
      expect(mockPrismaService.payment.create).toHaveBeenCalled();
      expect(payment.orderId).toBe(orderId);
      expect(payment.userId).toBe(userId);
      expect(payment.status).toBe(PaymentStatus.PENDING);
    });
  });

  describe('Payment Status Update to Order Service', () => {
    it('should update the order when payment is successful', async () => {
      // Mock the patch request
      mockHttpService.patch.mockReturnValue(of({ data: {} }));

      // Call the order service
      await orderService.updatePaymentStatus(
        'order123',
        PaymentStatus.SUCCEEDED,
        'pi_123456',
      );

      // Assertions
      expect(mockHttpService.patch).toHaveBeenCalledWith(
        'http://localhost:3002/orders/order123/payment-status',
        {
          paymentStatus: 'completed',
          paymentIntentId: 'pi_123456',
        },
        {
          headers: {
            Authorization: 'Bearer test-token',
          },
        },
      );
    });

    it('should update the order when payment fails', async () => {
      // Mock the patch request
      mockHttpService.patch.mockReturnValue(of({ data: {} }));

      // Call the order service
      await orderService.updatePaymentStatus(
        'order123',
        PaymentStatus.FAILED,
        'pi_123456',
      );

      // Assertions
      expect(mockHttpService.patch).toHaveBeenCalledWith(
        'http://localhost:3002/orders/order123/payment-status',
        {
          paymentStatus: 'failed',
          paymentIntentId: 'pi_123456',
        },
        {
          headers: {
            Authorization: 'Bearer test-token',
          },
        },
      );
    });
  });

  describe('Status Mapping', () => {
    it('should correctly map payment service statuses to order service statuses', () => {
      // Test status mapping for all payment statuses
      const mappings = [
        { from: PaymentStatus.PENDING, to: 'pending' },
        { from: PaymentStatus.PROCESSING, to: 'pending' },
        { from: PaymentStatus.SUCCEEDED, to: 'completed' },
        { from: PaymentStatus.FAILED, to: 'failed' },
        { from: PaymentStatus.REFUNDED, to: 'refunded' },
        { from: PaymentStatus.CANCELLED, to: 'failed' },
      ];

      mappings.forEach(({ from, to }) => {
        expect(orderService.mapPaymentStatusToOrderPaymentStatus(from)).toBe(to);
      });
    });
  });
}); 