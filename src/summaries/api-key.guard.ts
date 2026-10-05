import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AppConfig } from '../config/config.js';
import { CONFIG } from './tokens.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Shared-secret auth for the write endpoints: X-API-Key, constant-time compare (digests are
 *  fixed-length, so a wrong-length key cannot throw or leak its length). */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header = req.headers['x-api-key'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (
      typeof provided !== 'string' ||
      !timingSafeEqual(digest(provided), digest(this.config.serviceApiKey))
    ) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
