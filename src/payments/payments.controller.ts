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
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Payment } from './entities/payment.entity';
import { PaymentResponseDto } from './dto/payment-response.dto';
import { WebhookEventDto } from './dto/payment-webhook.dto';
import { StripeService } from './services/stripe.service';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
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
    const payment = await this.paymentsService.createPayment(
      createPaymentDto,
      req.user.userId,
    );
    return this.mapPaymentToResponseDto(payment);
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
  async handleWebhook(
    @Body() eventDto: WebhookEventDto,
    @Headers('stripe-signature') signature: string,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ received: boolean }> {
    // If signature is provided, validate it (Stripe webhook)
    if (signature) {
      const payload = request.rawBody;
      const event = await this.stripeService.constructEventFromPayload(
        payload,
        signature,
      );
      await this.paymentsService.handleWebhook(event as unknown as WebhookEventDto);
    } else {
      // Process webhook without signature validation (for testing)
      await this.paymentsService.handleWebhook(eventDto);
    }
    
    return { received: true };
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

  private mapPaymentToResponseDto(payment: Payment): PaymentResponseDto {
    const responseDto = new PaymentResponseDto();
    
    responseDto.id = payment.id;
    responseDto.orderId = payment.orderId;
    responseDto.amount = Number(payment.amount);
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