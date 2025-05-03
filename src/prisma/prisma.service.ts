import { Injectable, OnModuleInit, OnModuleDestroy, INestApplication, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  
  constructor() {
    super({
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });

    // @ts-expect-error - Prisma Client doesn't export these event types correctly
    this.$on('error', (event: { message: string; target: string }) => {
      this.logger.error(`Prisma error: ${event.message}`, event.target);
    });

    // @ts-expect-error - Prisma Client doesn't export these event types correctly
    this.$on('warn', (event: { message: string; target: string }) => {
      this.logger.warn(`Prisma warning: ${event.message}`, event.target);
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Successfully connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Successfully disconnected from database');
  }

  /**
   * Sets up application shutdown hooks
   * This replaces the deprecated enableShutdownHooks method
   */
  setupShutdownHooks(app: INestApplication) {
    // Setup process listeners instead of Prisma beforeExit
    process.on('beforeExit', async () => {
      this.logger.log('Detected beforeExit event, closing application');
      await app.close();
    });
    
    // Additional safety: handle other termination signals
    ['SIGINT', 'SIGTERM'].forEach(signal => {
      process.on(signal, async () => {
        this.logger.log(`Received ${signal}, disconnecting Prisma client`);
        await this.$disconnect();
      });
    });
  }
} 