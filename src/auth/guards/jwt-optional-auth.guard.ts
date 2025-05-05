import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtOptionalAuthGuard extends AuthGuard('jwt') {
  // Override handleRequest to allow requests without a token
  handleRequest(err: any, user: any, info: any) {
    // If there's an error but not related to missing token, throw it
    if (err && err.message !== 'No auth token') {
      throw err;
    }
    
    // Return the user if authenticated, or null if not
    return user || null;
  }
} 