import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosResponse } from 'axios';

interface ServiceInstance {
  ServiceAddress: string;
  ServicePort: number;
  Checks: { Status: string }[];
}

@Injectable()
export class ServiceDiscoveryService {
  private readonly logger = new Logger(ServiceDiscoveryService.name);
  private readonly serviceCache: Map<string, string> = new Map();
  private readonly serviceCacheTTL: number = 60000; // 1 minute in milliseconds
  private readonly serviceRegistry: string;
  private readonly fallbackServiceUrls: { [key: string]: string };
  
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.serviceRegistry = this.configService.get<string>('SERVICE_REGISTRY_URL') || '';
    
    // Fallback to environment variables if service discovery fails
    this.fallbackServiceUrls = {
      'user-service': this.configService.get<string>('USER_SERVICE_URL') || 'http://localhost:3000',
      'product-service': this.configService.get<string>('PRODUCT_SERVICE_URL') || 'http://localhost:3001',
      'order-service': this.configService.get<string>('ORDER_SERVICE_URL') || 'http://localhost:3002',
      'payment-service': this.configService.get<string>('PAYMENT_SERVICE_URL') || 'http://localhost:3003',
    };
    
    this.logger.log(`Service discovery initialized with registry: ${this.serviceRegistry}`);
  }
  
  async getServiceUrl(serviceName: string): Promise<string> {
    // Check cache first
    const cachedUrl = this.getFromCache(serviceName);
    if (cachedUrl) {
      return cachedUrl;
    }
    
    // If service registry is not configured, use fallback
    if (!this.serviceRegistry) {
      const fallbackUrl = this.fallbackServiceUrls[serviceName];
      if (!fallbackUrl) {
        this.logger.error(`No fallback URL configured for service: ${serviceName}`);
        throw new Error(`No URL available for service: ${serviceName}`);
      }
      this.logger.warn(`Service registry not configured, using fallback URL for ${serviceName}: ${fallbackUrl}`);
      return fallbackUrl;
    }
    
    try {
      // Query service registry
      const response: AxiosResponse<ServiceInstance[]> = await firstValueFrom(
        this.httpService.get<ServiceInstance[]>(`${this.serviceRegistry}/v1/catalog/service/${serviceName}`),
      );
      
      if (response.data && response.data.length > 0) {
        // Get the first healthy instance
        const instance = response.data.find(svc => svc.Checks.every(check => check.Status === 'passing'));
        
        if (instance) {
          const serviceUrl = `http://${instance.ServiceAddress}:${instance.ServicePort}`;
          this.setCache(serviceName, serviceUrl);
          return serviceUrl;
        }
      }
      
      this.logger.warn(`No healthy instances found for ${serviceName}, using fallback URL`);
      const fallbackUrl = this.fallbackServiceUrls[serviceName];
      if (!fallbackUrl) {
        this.logger.error(`No fallback URL configured for service: ${serviceName}`);
        throw new Error(`No URL available for service: ${serviceName}`);
      }
      return fallbackUrl;
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Error discovering service ${serviceName}: ${err.message}`);
      const fallbackUrl = this.fallbackServiceUrls[serviceName];
      if (!fallbackUrl) {
        this.logger.error(`No fallback URL configured for service: ${serviceName}`);
        throw new Error(`No URL available for service: ${serviceName}`);
      }
      return fallbackUrl;
    }
  }
  
  private getFromCache(serviceName: string): string | null {
    const cacheEntry = this.serviceCache.get(serviceName);
    if (!cacheEntry) return null;
    
    const [url, timestamp] = cacheEntry.split('|');
    const cacheTime = parseInt(timestamp, 10);
    
    if (Date.now() - cacheTime > this.serviceCacheTTL) {
      this.serviceCache.delete(serviceName);
      return null;
    }
    
    return url;
  }
  
  private setCache(serviceName: string, url: string): void {
    this.serviceCache.set(serviceName, `${url}|${Date.now()}`);
  }
} 