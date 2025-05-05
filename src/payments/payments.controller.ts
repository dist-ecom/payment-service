import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  UseGuards,
  Request,
  Req,
  HttpCode,
  HttpStatus,
  Headers,
  RawBodyRequest,
  Patch,
  BadRequestException,
  Logger,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtOptionalAuthGuard } from '../auth/guards/jwt-optional-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { Payment } from './entities/payment.entity';
import { PaymentResponseDto } from './dto/payment-response.dto';
import { WebhookEventDto } from './dto/payment-webhook.dto';
import { StripeService } from './services/stripe.service';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly stripeService: StripeService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new payment' })
  @ApiResponse({ 
    status: 201, 
    description: 'The payment has been successfully created',
    type: PaymentResponseDto
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 409, description: 'Payment already exists for this order' })
  async create(
    @Body() createPaymentDto: CreatePaymentDto,
    @Request() req,
  ): Promise<PaymentResponseDto> {
    this.logger.log(`Creating payment for order ${createPaymentDto.orderId} with amount ${createPaymentDto.amount}`);
    
    // Validate the incoming data
    if (!createPaymentDto.amount || createPaymentDto.amount <= 0) {
      this.logger.error('Invalid payment amount provided');
      throw new Error('Invalid payment amount');
    }
    
    try {
      // Create payment with the user's ID from JWT token
      const payment = await this.paymentsService.createPayment(
        createPaymentDto,
        req.user.userId,
      );
      
      this.logger.log(`Payment created successfully: ${payment.id}`);
      
      return this.mapPaymentToResponseDto(payment);
    } catch (error) {
      this.logger.error(`Failed to create payment: ${error.message}`);
      throw error;
    }
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all payments for the authenticated user' })
  @ApiResponse({ 
    status: 200, 
    description: 'Returns all payments',
    type: [PaymentResponseDto]
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async findAll(@Request() req): Promise<PaymentResponseDto[]> {
    const payments = await this.paymentsService.findAll(req.user.userId);
    return payments.map(payment => this.mapPaymentToResponseDto(payment));
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a payment by ID' })
  @ApiResponse({ 
    status: 200, 
    description: 'Returns the payment',
    type: PaymentResponseDto
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async findOne(
    @Param('id') id: string,
    @Request() req,
  ): Promise<PaymentResponseDto> {
    const payment = await this.paymentsService.findOne(id, req.user.userId);
    return this.mapPaymentToResponseDto(payment);
  }

  @Get('by-order/:orderId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a payment by order ID' })
  @ApiResponse({ 
    status: 200, 
    description: 'Returns the payment for the order',
    type: PaymentResponseDto
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async findByOrder(
    @Param('orderId') orderId: string,
    @Request() req,
  ): Promise<PaymentResponseDto> {
    const payment = await this.paymentsService.findByOrder(orderId, req.user.userId);
    return this.mapPaymentToResponseDto(payment);
  }

  @Delete(':id/cancel')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel a payment' })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment cancelled successfully',
    type: PaymentResponseDto
  })
  @ApiResponse({ status: 400, description: 'Cannot cancel payment in current state' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async cancel(
    @Param('id') id: string,
    @Request() req,
  ): Promise<PaymentResponseDto> {
    const payment = await this.paymentsService.cancelPayment(id, req.user.userId);
    return this.mapPaymentToResponseDto(payment);
  }

  @Post(':id/refund')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Refund a payment' })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment refunded successfully',
    type: PaymentResponseDto
  })
  @ApiResponse({ status: 400, description: 'Cannot refund payment in current state' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async refund(
    @Param('id') id: string,
    @Request() req,
  ): Promise<PaymentResponseDto> {
    const payment = await this.paymentsService.refundPayment(id, req.user.userId);
    return this.mapPaymentToResponseDto(payment);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Handle payment provider webhooks' })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid webhook payload' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handleWebhook(
    @Body() eventDto: WebhookEventDto,
    @Headers('stripe-signature') signature: string,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ received: boolean }> {
    try {
      // Require signature for production environment
      if (process.env.NODE_ENV === 'production' && !signature) {
        this.logger.error('Missing Stripe signature in production environment');
        return { received: false };
      }

      // If signature is provided, validate it (Stripe webhook)
      if (signature) {
        if (!request.rawBody) {
          this.logger.error('Missing raw body for Stripe webhook signature verification');
          return { received: false };
        }
        
        const payload = request.rawBody;
        try {
          const event = await this.stripeService.constructEventFromPayload(
            payload,
            signature,
          );
          await this.paymentsService.handleWebhook(event as unknown as WebhookEventDto);
        } catch (error) {
          this.logger.error(`Webhook signature verification failed: ${error.message}`);
          throw new BadRequestException('Invalid signature');
        }
      } else if (process.env.NODE_ENV !== 'production') {
        // Only allow unsigned webhooks in non-production environments
        this.logger.warn('Processing unsigned webhook in non-production environment');
        await this.paymentsService.handleWebhook(eventDto);
      }
      
      return { received: true };
    } catch (error) {
      this.logger.error(`Webhook processing error: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get(':id/status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check the current status of a payment' })
  @ApiResponse({ 
    status: 200, 
    description: 'Returns the current payment status',
    type: PaymentResponseDto
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async checkStatus(
    @Param('id') id: string,
    @Request() req,
  ): Promise<PaymentResponseDto> {
    const payment = await this.paymentsService.checkPaymentStatus(id, req.user.userId);
    return this.mapPaymentToResponseDto(payment);
  }

  @Get('by-order/:orderId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment by order ID' })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment found',
    type: PaymentResponseDto 
  })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async getByOrderId(
    @Param('orderId') orderId: string,
    @Request() req,
  ): Promise<Payment> {
    this.logger.log(`Getting payment for order ${orderId}`);
    return this.paymentsService.findByOrderId(orderId, req.user.userId);
  }

  @Post(':id/confirm')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ 
    summary: 'Confirm an existing payment',
    description: 'Confirm a payment using either a Stripe payment method ID or a test token (e.g., tok_visa for test mode)'
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment confirmed successfully',
    type: PaymentResponseDto
  })
  @ApiResponse({ status: 400, description: 'Bad request - Either payment method ID or token is required' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  @HttpCode(HttpStatus.OK)
  async confirmPayment(
    @Param('id') id: string,
    @Body() confirmPaymentDto: ConfirmPaymentDto,
    @Request() req,
  ): Promise<Payment> {
    this.logger.log(`Confirming payment ${id}`);
    return this.paymentsService.confirmPayment(id, confirmPaymentDto, req.user.userId);
  }

  @Post('quick-checkout')
  @UseGuards(JwtAuthGuard)
  async createQuickCheckout(
    @Body() checkoutDto: {
      orderId: string;
      items: Array<{
        name: string;
        description?: string;
        price: number;
        quantity: number;
        images?: string[];
        productId: string;
      }>;
      successUrl: string;
      cancelUrl: string;
      customerEmail?: string;
      currency?: string;
      metadata?: Record<string, any>;
    },
    @Req() req,
  ) {
    // This endpoint simplifies the checkout process by redirecting directly to Stripe
    return this.paymentsService.createQuickCheckout(checkoutDto, req.user.userId);
  }

  private mapPaymentToResponseDto(payment: Payment): PaymentResponseDto {
    const responseDto = new PaymentResponseDto();
    
    responseDto.id = payment.id;
    responseDto.orderId = payment.orderId;
    responseDto.amount = typeof payment.amount === 'number' 
      ? payment.amount 
      : Number(payment.amount);
    responseDto.currency = payment.currency;
    responseDto.status = payment.status;
    responseDto.provider = payment.provider;
    responseDto.paymentMethod = payment.paymentMethod;
    responseDto.createdAt = payment.createdAt;
    responseDto.updatedAt = payment.updatedAt;
    
    // Only include client secret for pending payments
    if (payment.status === 'PENDING' || payment.status === 'PROCESSING') {
      responseDto.clientSecret = payment.clientSecret;
    }
    
    // Only include receipt URL for successful payments
    if (payment.status === 'SUCCEEDED') {
      responseDto.receiptUrl = payment.receiptUrl;
    }
    
    // Include error message for failed payments
    if (payment.status === 'FAILED') {
      responseDto.errorMessage = payment.errorMessage;
    }
    
    return responseDto;
  }
} 