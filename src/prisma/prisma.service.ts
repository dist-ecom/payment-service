import { Injectable, OnModuleInit, INestApplication, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
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

  async enableShutdownHooks(app: INestApplication) {
    // @ts-expect-error - Prisma Client doesn't export these event types correctly
    this.$on('beforeExit', async () => {
      await app.close();
    });
  }
} 