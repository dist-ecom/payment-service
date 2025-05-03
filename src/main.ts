import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as fs from 'fs';
import * as os from 'os';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: true,
  });
  
  const logger = new Logger('Bootstrap');
  const configService = app.get(ConfigService);
  
  // Get application config
  const port = configService.get<number>('PORT') || 3003;
  const serviceName = configService.get<string>('SERVICE_NAME') || 'payment-service';
  const serviceDescription = configService.get<string>('SERVICE_DESCRIPTION') || 'Payment Processing Service';
  const serviceRegistryUrl = configService.get<string>('SERVICE_REGISTRY_URL');
  const rabbitmqUrl = configService.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672';
  
  // Connect to RabbitMQ
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl],
      queue: 'payments_queue',
      queueOptions: {
        durable: true,
      },
      noAck: false,
    },
  });

  // Start microservices
  await app.startAllMicroservices();
  logger.log('Microservice is listening');

  // Enable global validation
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }));

  // Setup Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Payment Service API')
    .setDescription('API documentation for the Payment Service')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
  
  // Save Swagger JSON to file for external documentation
  fs.writeFileSync('./api-docs.json', JSON.stringify(document, null, 2));

  // Enable Prisma shutdown hooks (updated to use new method)
  const prismaService = app.get(PrismaService);
  prismaService.setupShutdownHooks(app);

  // Start the server
  await app.listen(port);
  
  // Register with service registry if configured
  if (serviceRegistryUrl) {
    try {
      const httpService = app.get(HttpService);
      
      // Get hostname and IP
      const hostname = os.hostname();
      const interfaces = os.networkInterfaces();
      let ipAddress = '';
      
      // Find a suitable IP address (prefer non-internal IPv4)
      Object.keys(interfaces).forEach((interfaceName) => {
        const networkInterface = interfaces[interfaceName];
        if (networkInterface !== undefined) {
          networkInterface.forEach((iface) => {
            if (iface.family === 'IPv4' && !iface.internal) {
              ipAddress = iface.address;
            }
          });
        }
      });
      
      // If no external IP found, use localhost
      if (!ipAddress) {
        ipAddress = '127.0.0.1';
      }
      
      // Use IP address for local development, hostname for production
      const serviceAddress = process.env.NODE_ENV === 'production' ? hostname : ipAddress;
      
      // Create service ID (same format that worked in our test)
      const serviceId = `${serviceName}-${hostname}-${port}`;
      
      // Simple Consul registration payload - exact format from successful test
      const consulRegistration = {
        ID: serviceId,
        Name: serviceName,
        Address: serviceAddress,
        Port: Number(port),
        Check: {
          HTTP: `http://${serviceAddress}:${port}/health`,
          Interval: '15s'
        }
      };
      
      logger.log(`Registering service with Consul at: ${serviceRegistryUrl}`);
      logger.log(`Using service ID: ${serviceId}`);
      logger.log(`Address: ${serviceAddress}, Port: ${port}`);
      
      try {
        // First verify Consul is reachable
        const statusResponse = await firstValueFrom(
          httpService.get(`${serviceRegistryUrl}/v1/status/leader`)
        );
        logger.log(`Consul status check OK: ${statusResponse.status}`);
        
        // Then register service
        const response = await firstValueFrom(
          httpService.put(`${serviceRegistryUrl}/v1/agent/service/register`, consulRegistration)
        );
        
        logger.log(`Service registered successfully with status: ${response.status}`);
      } catch (regError: any) {
        logger.error(`Consul error: ${regError.message}`);
        if (regError.response) {
          logger.error(`Status: ${regError.response.status}`);
          logger.error(`Data: ${JSON.stringify(regError.response.data || {})}`);
        } else if (regError.request) {
          logger.error('No response from Consul - service may not be running');
        }
        throw regError;
      }
      
      // Setup deregistration on app shutdown
      app.enableShutdownHooks();
      
      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        try {
          logger.log(`Deregistering service with ID: ${serviceId}`);
          await firstValueFrom(
            httpService.put(`${serviceRegistryUrl}/v1/agent/service/deregister/${serviceId}`)
          );
          logger.log('Service deregistered from Consul');
          process.exit(0);
        } catch (error: any) {
          logger.error(`Failed to deregister service: ${error.message}`);
          process.exit(1);
        }
      });
    } catch (error: any) {
      logger.error(`Consul registration failed: ${error.message}`);
    }
  }
  
  logger.log(`Payment service running on port ${port}`);
}

bootstrap(); 