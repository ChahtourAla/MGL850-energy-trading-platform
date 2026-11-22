import {BadRequestException,ConflictException,Inject,Injectable,ServiceUnavailableException,type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import pg from 'pg';
@Injectable()
export class B26AdminService implements OnModuleDestroy {
 private pool:pg.Pool|null=null;
 constructor(@Inject(ConfigService) private readonly config:ConfigService){}
 private getPool(){
  if(this.pool)return this.pool;
  const raw=this.config.get<string>('B26_ADMIN_DATABASE_URL');
  if(!raw)throw new ServiceUnavailableException('B26 administration unavailable');
  let url:URL;try{url=new URL(raw);}catch{throw new ServiceUnavailableException('B26 administration unavailable');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.pathname!=='/b22_disposable_review'||decodeURIComponent(url.username)!=='b26_admin')throw new ServiceUnavailableException('B26 administration unavailable');
  this.pool=new pg.Pool({connectionString:raw,max:2,connectionTimeoutMillis:2000});return this.pool;
 }
 async request(id:string,kind:'CATCH_UP'|'RECOVER',runId:string|null,from:Date|null,to:Date|null){
  const client=await this.getPool().connect().catch(()=>{throw new ServiceUnavailableException('B26 database unavailable');});
  try{
   const q=await client.query('SELECT b26_request_control($1,$2,$3,$4,$5) AS request',[id,kind,runId,from,to]);
   const result=q.rows[0].request;return {requestId:result.id,status:result.status,simulationOnly:true,realHederaExecutionAuthorized:false};
  }catch(error){
   const e=error as {code?:string,message?:string};
   if(e.code==='P0001'&&e.message?.includes('conflicting control request'))throw new ConflictException('Request identity already used');
   if(e.code==='P0001'&&e.message?.includes('invalid'))throw new BadRequestException('Invalid administrative request');
   throw new ServiceUnavailableException('B26 administration unavailable');
  }finally{client.release();}
 }
 async onModuleDestroy(){if(this.pool)await this.pool.end();}
}
