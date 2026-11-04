import {
  Body, Controller, HttpCode, HttpStatus,
  Inject, Post, UseGuards,
} from '@nestjs/common';
import {
  ApiBody, ApiCreatedResponse, ApiOkResponse,
  ApiOperation, ApiTags, ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService, type LoginResult, type RegistrationResult } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';

@ApiTags('Auth')
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @ApiOperation({ summary: 'Register an application user (wallet created in B07)' })
  @ApiBody({ type: RegisterDto })
  @ApiCreatedResponse({ description: 'User created; wallet not yet provisioned' })
  @ApiTooManyRequestsResponse({ description: 'Too many registration attempts' })
  register(@Body() dto: RegisterDto): Promise<RegistrationResult> {
    return this.auth.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @ApiOperation({ summary: 'Login with email/password and return a short-lived JWT' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ description: 'JWT access token issued' })
  @ApiTooManyRequestsResponse({ description: 'Too many login attempts' })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto);
  }
}
