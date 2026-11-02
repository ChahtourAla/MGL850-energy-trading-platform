import { Controller, Get, Inject } from '@nestjs/common';

import { AppService, type BackendInfo } from './app.service.js';

/**
 * Initial REST API controller.
 *
 * GET /
 *
 * Returns basic application information.
 */
@Controller()
export class AppController {
  constructor(
    @Inject(AppService)
    private readonly appService: AppService,
  ) {}

  @Get()
  getInfo(): BackendInfo {
    return this.appService.getInfo();
  }
}
