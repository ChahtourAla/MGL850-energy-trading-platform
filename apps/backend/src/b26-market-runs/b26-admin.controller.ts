import {BadRequestException,Body,Controller,HttpCode,Inject,Param,ParseUUIDPipe,Post,UseGuards} from '@nestjs/common';
import {B26AdminGuard} from './b26-admin.guard.js';
import {B26AdminService} from './b26-admin.service.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requestId(body:unknown,keys:string[]):Record<string,string>{
 if(!body||typeof body!=='object'||Array.isArray(body))throw new BadRequestException('Invalid request');
 const value=body as Record<string,unknown>;
 if(Object.keys(value).some(k=>!keys.includes(k))||typeof value.requestId!=='string'||!uuid.test(value.requestId))throw new BadRequestException('Invalid request');
 return value as Record<string,string>;
}
@Controller('internal/v2/market-runs')
@UseGuards(B26AdminGuard)
export class B26AdminController {
 constructor(@Inject(B26AdminService) private readonly admin:B26AdminService){}
 @Post('catch-up') @HttpCode(202)
 catchUp(@Body() body:unknown){
  const x=requestId(body,['requestId','from','to']);
  if(typeof x.from!=='string'||typeof x.to!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:00:00Z$/.test(x.from)||!/^\d{4}-\d\d-\d\dT\d\d:00:00Z$/.test(x.to))throw new BadRequestException('Invalid UTC interval');
  const from=new Date(x.from),to=new Date(x.to);
  if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from.toISOString().replace('.000Z','Z')!==x.from||to.toISOString().replace('.000Z','Z')!==x.to||to.getTime()<=from.getTime()||to.getTime()>Date.now()||to.getTime()-from.getTime()>86400000)throw new BadRequestException('Invalid UTC interval');
  return this.admin.request(x.requestId,'CATCH_UP',null,from,to);
 }
 @Post(':id/recover') @HttpCode(202)
 recover(@Param('id',new ParseUUIDPipe()) id:string,@Body() body:unknown){const x=requestId(body,['requestId']);return this.admin.request(x.requestId,'RECOVER',id,null,null);}
}
