import { beforeEach, describe, expect, it } from 'vitest';

import { Test, type TestingModule } from '@nestjs/testing';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return backend information', () => {
    const response = controller.getInfo();

    expect(response).toEqual({
      service: 'p2p-energy-backend',
      status: 'ok',
      message: 'MGL850 P2P Energy Trading Backend is running',
      version: '0.1.0',
    });
  });
});
