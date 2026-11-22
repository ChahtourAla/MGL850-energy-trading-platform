import {timingSafeEqual} from 'node:crypto';
import {CanActivate,ExecutionContext,ForbiddenException,Inject,Injectable,ServiceUnavailableException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import type {Request} from 'express';
@Injectable()
export class B26AdminGuard implements CanActivate {
 constructor(@Inject(ConfigService) private readonly config:ConfigService){}
 canActivate(context:ExecutionContext){
  const expected=this.config.get<string>('B26_ADMIN_KEY'),readKey=this.config.get<string>('TRADING_API_READ_ADMIN_KEY');
  if(!expected||expected.length<32||/[\r\n]/.test(expected)||expected===readKey)throw new ServiceUnavailableException('B26 administration unavailable');
  const value=context.switchToHttp().getRequest<Request>().headers['x-b26-admin-key'];
  if(typeof value!=='string'||/[\r\n]/.test(value))throw new ForbiddenException('B26 administration required');
  const a=Buffer.from(value),b=Buffer.from(expected);
  if(a.length!==b.length||!timingSafeEqual(a,b))throw new ForbiddenException('B26 administration required');
  return true;
 }
}
