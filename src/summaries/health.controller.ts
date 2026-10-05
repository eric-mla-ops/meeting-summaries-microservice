import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** Liveness only: no secrets, no database or HubSpot detail. */
  @Get()
  health() {
    return { status: 'ok' };
  }
}
