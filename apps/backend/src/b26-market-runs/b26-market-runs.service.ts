import {Inject, Injectable, NotFoundException, ServiceUnavailableException, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import pg from 'pg';

@Injectable()
export class B26MarketRunsService implements OnModuleDestroy {
 private pool:pg.Pool|null=null;
 constructor(@Inject(ConfigService) private readonly config:ConfigService) {}
 private getPool():pg.Pool {
  if(this.pool)return this.pool;
  const raw=this.config.get<string>('B26_REPORTER_DATABASE_URL');
  if(!raw)throw new ServiceUnavailableException('B26 reporting unavailable');
  let url:URL;
  try{url=new URL(raw);}catch{throw new ServiceUnavailableException('B26 reporting unavailable');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.pathname!=='/b22_disposable_review'||decodeURIComponent(url.username)!=='b26_reporter')throw new ServiceUnavailableException('B26 reporting unavailable');
  this.pool=new pg.Pool({connectionString:raw,max:2,connectionTimeoutMillis:2000});return this.pool;
 }
 private async read(sql:string,args:unknown[]){
  const client=await this.getPool().connect().catch(()=>{throw new ServiceUnavailableException('B26 database unavailable');});
  try{
   const guard=await client.query("SELECT session_user actor, EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') guarded");
   if(guard.rows[0]?.actor!=='b26_reporter'||guard.rows[0]?.guarded!==true)throw new ServiceUnavailableException('B26 reporting unavailable');
   return (await client.query(sql,args)).rows;
  }finally{client.release();}
 }
 async list(from:Date,to:Date,limit:number){
  const rows=await this.read('SELECT id,"intervalStart","intervalEnd",configuration,status,"snapshotId","snapshotHash","planId",attempts,retryable,"nextRetryAt","failureCode",summary,"createdAt","updatedAt","completedAt" FROM "B26MarketRun" WHERE "intervalStart">=$1 AND "intervalStart"<$2 ORDER BY "intervalStart",id LIMIT $3',[from,to,limit]);
  return {runs:rows.map(row=>this.conservativeStatus(row)),simulationOnly:true,financialSummaryVerified:false};
 }
 async health(){
  const rows=await this.read('SELECT max("lastTickAt") AS "lastTickAt" FROM "B26WorkerHeartbeat"',[]);
  return {lastSuccessfulTick:rows[0]?.lastTickAt??null,simulationOnly:true};
 }
 async get(id:string){
  const rows=await this.read('SELECT id,"intervalStart","intervalEnd",configuration,status,"snapshotId","snapshotHash","planId",attempts,retryable,"nextRetryAt","failureCode",summary,"createdAt","updatedAt","completedAt" FROM "B26MarketRun" WHERE id=$1',[id]);
  if(!rows.length)throw new NotFoundException('Market run not found');
  return {run:this.conservativeStatus(rows[0]),simulationOnly:true,financialSummaryVerified:false};
 }
 private conservativeStatus(row:Record<string,unknown>){
  const recordedStatus=row.status;
  const status=recordedStatus==='SETTLED'||recordedStatus==='PARTIALLY_SETTLED'?'NEEDS_RECONCILIATION':recordedStatus;
  return {...row,lastRecordedStatus:recordedStatus,status};
 }
 async onModuleDestroy(){if(this.pool)await this.pool.end();}
}
