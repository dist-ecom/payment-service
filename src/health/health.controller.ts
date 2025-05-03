import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

interface HealthCheckResponse {
  status: string;
  timestamp: string;
  services: {
    database: string;
  };
  error?: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // @ts-ignore
  @Get()
  // @ts-ignore
  @ApiResponse({ status: 200, description: 'Health check passed' })
  @ApiResponse({ status: 503, description: 'Service unavailable' })
  async check(): Promise<HealthCheckResponse> {
    try {
      // Check the database connection
      await this.prisma.$queryRaw`SELECT 1`;
      
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
          database: 'up',
        },
      };
    } catch (error) {
      return {
        status: 'error',
        timestamp: new Date().toISOString(),
        services: {
          database: 'down',
        },
        error: error.message,
      };
    }
  }
} 