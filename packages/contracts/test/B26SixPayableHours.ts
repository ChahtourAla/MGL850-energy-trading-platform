import {expect} from 'chai';
import {network} from 'hardhat';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from '../../../apps/backend/node_modules/pg/lib/index.js';
import {ingestLocalHour} from '../../../apps/backend/scripts/b22a-ingestion.mjs';
import {createEphemeralTestWalletRegistry} from '../../../apps/backend/scripts/b24-signing.mjs';
import {createLocalOperatorRegistry} from '../../../apps/backend/scripts/b25-settlement-executor.mjs';
import {createDisposableFixtureProvisioner} from '../../../apps/backend/scripts/b26-fixture-provisioner.mjs';
import {createOfflinePaymentSupervisor} from '../../../apps/backend/scripts/b26-payment-supervisor.mjs';
import {attachSupervisorToWorker} from '../../../apps/backend/scripts/b26-supervisor-ipc.mjs';

const {ethers}=await network.create();const {Client}=pg;
// Candidate identities were selected by running the unmodified B22 simulator
// with its committed configuration. No measurements are supplied by this test.
const pairs=[
 [1,0x1b,0xb6,1250,98464],[2,0x12,0x1a,1100,123290],
 [3,0x45,0x0c,1125,87336],[4,0x1f,0x66,1250,116912],
 [8,0x46,0x5b,50,102220],[9,0x06,0xa7,810,109100],
];
const userId=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
describe('B26 accelerated six-payable-hour market',function(){
 this.timeout(300000);
 it('discovers and settles six genuine hourly allocations without duplicate payments',async function(){
  if(process.env.B24_A2_TEST!=='1'||process.env.B26_TEST_COORDINATOR!=='1'){this.skip();return;}
  const names=['B22_TEST_DATABASE_URL','B22_ROSTER_DATABASE_URL','B22_INGEST_DATABASE_URL','B22_MATCH_DATABASE_URL','B24_APPROVER_DATABASE_URL','B24_EVALUATOR_DATABASE_URL','B24_PREFLIGHT_DATABASE_URL','B24_SIGNER_DATABASE_URL','B24_RECEIPT_DATABASE_URL','B24_FUNDING_DATABASE_URL','B24_ALLOWANCE_DATABASE_URL','B25_EXECUTOR_DATABASE_URL','B25_VERIFIER_DATABASE_URL','B25_REPORTER_DATABASE_URL','B26_WORKER_DATABASE_URL'];
  for(const name of names){const u=new URL(process.env[name]!);if(u.hostname!=='127.0.0.1'||u.pathname!=='/b22_disposable_review')throw Error('unsafe database');}
  const clients=names.map(name=>new Client({connectionString:process.env[name]}));await Promise.all(clients.map(c=>c.connect()));
  const [owner,roster,ingest,matcher,approver,evaluator,preflight,signer,receiptVerifier,funder,allowance,executor,verifier,reporter,coord]=clients;
  let child:any;
  try{
   const [admin,operator,pauser]=await ethers.getSigners();
   // Other tests share the isolated chain. Distinct deployments avoid colliding
   // with an earlier test's approved deployment identity.
   await (await admin.sendTransaction({to:admin.address,value:0})).wait();
   const token:any=await ethers.deployContract('TestEnergyUSD',[admin.address]);
   const contract:any=await ethers.deployContract('EnergyTradingDirectSettlement',[await token.getAddress(),admin.address,operator.address,pauser.address]);
   const tokenAddress=(await token.getAddress()).toLowerCase(),contractAddress=(await contract.getAddress()).toLowerCase();
   const artifact=JSON.parse(readFileSync(new URL('../artifacts/contracts/EnergyTradingDirectSettlement.sol/EnergyTradingDirectSettlement.json',import.meta.url),'utf8'));
   const deployment=randomUUID();
   await approver.query('INSERT INTO "B24Deployment"(id,status,"chainId","contractAddress","tokenAddress","tokenDecimals","codeHash","artifactHash","approvalPrincipal","approvalEvidence","verifiedAt") VALUES($1,\'TEST_FIXTURE\',31337,$2,$3,6,$4,$5,\'ignored\',\'six-hour fixture\',now())',[deployment,contractAddress,tokenAddress,ethers.keccak256(artifact.deployedBytecode),ethers.keccak256(artifact.bytecode)]);
   const registry=await createEphemeralTestWalletRegistry({client:signer,provider:ethers.provider});
   const operatorRegistry=await createLocalOperatorRegistry({client:executor,provider:ethers.provider});
   await (await admin.sendTransaction({to:operatorRegistry.address,value:ethers.parseEther('1')})).wait();
   await (await contract.grantRole(await contract.OPERATOR_ROLE(),operatorRegistry.address)).wait();
   const profiles=new Map<number,any>(),buyerApprovals=new Map(),sessions=new Map(),grantsBySession=new Map();
   const buyerIds=new Set(pairs.map(x=>x[1]));
   for(const n of new Set(pairs.flatMap(x=>[x[1],x[2]]))){
    const wallet=buyerIds.has(n)?registry.createBuyer():null;
    const address=wallet?wallet.address.toLowerCase():`0x${n.toString(16).padStart(40,'0')}`;
    const p={userId:userId(n),name:'Sim',email:`u${n}@example.com`,physicalAddress:'Simulation',xKm:0,yKm:0,preferredEnergyType:'ANY',reputation:80,hederaAccountId:`0.0.${n}`,evmAddress:address};profiles.set(n,p);
    await owner.query('INSERT INTO users(id,name,email,password_hash,physical_address,x_km,y_km,reputation,preferred_energy_type,updated_at) VALUES($1,$2,$3,\'synthetic\',$4,0,0,80,\'ANY\',now())',[p.userId,p.name,p.email,p.physicalAddress]);
    await owner.query('INSERT INTO wallets(id,user_id,hedera_account_id,evm_address,public_key,encrypted_private_key,encryption_iv,encryption_auth_tag,updated_at) VALUES($1,$2,$3,$4,\'synthetic\',\'synthetic\',\'synthetic\',\'synthetic\',now())',[randomUUID(),p.userId,p.hederaAccountId,p.evmAddress]);
   }
   for(const [,buyer,,quantity,price] of pairs){
    const p=profiles.get(buyer),amount=BigInt(quantity)*BigInt(price)/1000n,policy=randomUUID(),budget=randomUUID();
    expect(BigInt(quantity)*BigInt(price)%1000n).eq(0n);
    await approver.query('INSERT INTO "B24SpendingPolicy"(id,"buyerId","buyerAddress","deploymentId","tokenAddress","marketId","perAllocationLimit","cumulativeLimit","effectiveAt","expiresAt",status,"consentKind",version,approver,"auditReference") VALUES($1,$2,$3,$4,$5,NULL,$6,$6,now()-interval \'1 minute\',now()+interval \'1 hour\',\'ACTIVE\',\'SIMULATED_TEST\',1,\'ignored\',\'six-hour fixture\')',[policy,p.userId,p.evmAddress,deployment,tokenAddress,String(amount)]);
    await approver.query('INSERT INTO "B24LocalFundingBudget"(id,"buyerAddress","tokenAddress","minterAddress","cumulativeLimit","approvedBy") VALUES($1,$2,$3,$4,$5,\'ignored\')',[budget,p.evmAddress,tokenAddress,admin.address.toLowerCase(),String(amount)]);
    const anchor=await (await admin.sendTransaction({to:p.evmAddress,value:ethers.parseEther('1')})).wait();
    buyerApprovals.set(p.evmAddress,{deploymentId:deployment,budgetId:budget,anchorTransactionHash:anchor.hash});
   }
   const start=new Date('2026-10-04T00:00:00Z');
   for(let hour=0;hour<24;hour++){
    const begin=new Date(start.getTime()+hour*3600000),end=new Date(begin.getTime()+3600000),pair=pairs.find(x=>x[0]===hour);
    const list=pair?[profiles.get(pair[1]),profiles.get(pair[2])]:[profiles.get(pairs[0][2])];
    await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,\'ignored\',1)',[randomUUID(),begin,end,JSON.stringify(list)]);
    await ingestLocalHour(ingest,begin.toISOString().replace('.000Z','Z'),{execute:true});
   }
   const localPayments={clients:{evaluator,preflight,signer,funder,receiptVerifier,allowance,executor,verifier,reporter},provider:ethers.provider,registry,operatorRegistry,minter:admin,grantsBySession,sessions};
   const fixtureProvisioner=await createDisposableFixtureProvisioner({approvalClient:approver,evaluator,preflight,provider:ethers.provider,registry,minter:admin,buyerApprovals,sessions,grantsBySession});
   const supervisor=createOfflinePaymentSupervisor({coordinationClient:coord,matchingClient:matcher,localPayments,fixtureProvisioner});
   child=fork(fileURLToPath(new URL('../../../apps/backend/scripts/b26-scheduler-cli.mjs',import.meta.url)),[],{env:{...process.env,B26_START_UTC:'2026-10-04T00:00:00Z',B26_OFFLINE_SCHEDULER:'1',B26_SCHEDULER_MODE:'SUPERVISED_TEST'},stdio:['ignore','pipe','pipe','ipc']});
   child.stdout.resume();child.stderr.resume();
   const firstPid=child.pid;let beforeRestart=0;
   const detach=attachSupervisorToWorker(child,supervisor);
   try{
    const deadline=Date.now()+150000;let rows:any[]=[];
    while(Date.now()<deadline){
     if(child.exitCode!==null)throw Error(`Scheduler exited: ${child.exitCode}`);
     rows=(await owner.query('SELECT status FROM "B26MarketRun" WHERE "intervalStart">=$1 AND "intervalStart"<$2',[start,new Date(start.getTime()+24*3600000)])).rows;
     if(rows.filter(r=>r.status==='SETTLED').length>=3)break;
     await new Promise(resolve=>setTimeout(resolve,200));
    }
    beforeRestart=rows.filter(r=>r.status==='SETTLED').length;
    expect(beforeRestart).gte(3);expect(beforeRestart).lessThan(6);
   }finally{detach();child.kill();child=undefined;}
   // Restart after three settled hours while the supervising process retains
   // the original test wallets. The new worker must sign new allocations.
   child=fork(fileURLToPath(new URL('../../../apps/backend/scripts/b26-scheduler-cli.mjs',import.meta.url)),[],{env:{...process.env,B26_START_UTC:'2026-10-04T00:00:00Z',B26_OFFLINE_SCHEDULER:'1',B26_SCHEDULER_MODE:'SUPERVISED_TEST'},stdio:['ignore','pipe','pipe','ipc']});
   child.stdout.resume();child.stderr.resume();
   expect(child.pid).not.eq(firstPid);
   const detachRetry=attachSupervisorToWorker(child,supervisor);
   try{
    const deadline=Date.now()+150000;let rows:any[]=[];
    while(Date.now()<deadline){
     if(child.exitCode!==null)throw Error(`Restarted scheduler exited: ${child.exitCode}`);
     rows=(await owner.query('SELECT status FROM "B26MarketRun" WHERE "intervalStart">=$1 AND "intervalStart"<$2',[start,new Date(start.getTime()+24*3600000)])).rows;
     if(rows.length===24&&rows.filter(r=>r.status==='SETTLED').length===6&&rows.filter(r=>r.status==='NO_MATCH').length===18)break;
     await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(rows.filter(r=>r.status==='SETTLED').length!==6){
     const diagnostics=await owner.query('SELECT "intervalStart",status,"failureCode",attempts,retryable,"nextRetryAt","leaseUntil" FROM "B26MarketRun" WHERE "intervalStart">=$1 AND "intervalStart"<$2 ORDER BY "intervalStart"',[start,new Date(start.getTime()+24*3600000)]);
     console.log('B26_RESTART_DIAGNOSTICS',JSON.stringify(diagnostics.rows));
    }
    expect(rows.length).eq(24);expect(rows.filter(r=>r.status==='SETTLED').length).eq(6);expect(rows.filter(r=>r.status==='NO_MATCH').length).eq(18);
   }finally{detachRetry();child.kill();child=undefined;}
   const rows=(await owner.query('SELECT a."quantityWh",a."unitPriceMicrousdPerKwh",a."amountBaseUnits",a."buyerAddress",r.nonce,r."settlementId" FROM "V2Allocation" a JOIN "V2Market" m ON m.id=a."marketId" JOIN "B24AuthorizationReservation" r ON r."allocationId"=a.id WHERE m."intervalStart">=$1 AND m."intervalStart"<$2',[start,new Date(start.getTime()+24*3600000)])).rows;
   expect(rows.length).eq(6);expect(new Set(rows.map(r=>r.settlementId)).size).eq(6);
   expect(new Set(rows.map(r=>`${r.buyerAddress}:${r.nonce}`)).size).eq(6);
   for(const row of rows)expect(BigInt(row.quantityWh)*BigInt(row.unitPriceMicrousdPerKwh)).eq(BigInt(row.amountBaseUnits)*1000n);
   for(const [,buyer,seller,quantity,price] of pairs){const amount=BigInt(quantity)*BigInt(price)/1000n;expect(await token.balanceOf(profiles.get(buyer).evmAddress)).eq(0n);expect(await token.balanceOf(profiles.get(seller).evmAddress)).eq(amount);}
   const totals=(await owner.query('SELECT count(*)::int n,count(DISTINCT a."intentId")::int intents FROM "B25LocalAttempt" a JOIN "V2SettlementIntent" i ON i.id=a."intentId" JOIN "V2Market" m ON m.id=i."marketId" WHERE m."intervalStart">=$1 AND m."intervalStart"<$2',[start,new Date(start.getTime()+24*3600000)])).rows[0];
   expect(totals).deep.eq({n:6,intents:6});expect(await token.balanceOf(contractAddress)).eq(0n);
   console.log(JSON.stringify({test:'B26_SIX_PAYABLE',hours:24,settled:6,noMatch:18,attempts:totals.n}));
  }finally{if(child)child.kill();await Promise.allSettled(clients.map(c=>c.end()));}
 });
});
