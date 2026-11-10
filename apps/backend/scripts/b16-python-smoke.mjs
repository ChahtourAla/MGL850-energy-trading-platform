/** Standalone Python delivery simulator integration test. No Hedera/DB access. */
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateDelivery} from './b16-oracle-core.mjs';
import {selectB16Python,b16PythonEnv,b16PythonFailure} from './b16-python-runner.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const now=Math.floor(Date.now()/1000);
const iso=n=>new Date(n*1000).toISOString().replace('.000Z','Z');
const trade={tradeId:randomUUID(),onChainTradeId:999999999,sellerId:randomUUID(),buyerId:randomUUID(),expectedWh:2188,
 deliveryStart:iso(now-1800),deliveryDeadline:iso(now+1800),status:'AWAITING_DELIVERY'};
const config={scenario:'SUCCESS',deliveredWh:2188,reportedAt:iso(now)};
const temp=mkdtempSync(join(tmpdir(),'b16-python-smoke-'));
try{
 const input=join(temp,'trade.json'),settings=join(temp,'config.json'),output=join(temp,'delivery.json');
 writeFileSync(input,JSON.stringify(trade));writeFileSync(settings,JSON.stringify(config));
 const python=selectB16Python(root);
 const result=spawnSync(python,['-m','data_generator.cli','generate-delivery','--input',input,'--config',settings,'--output',output],{
   cwd:join(root,'services','data-generator'),encoding:'utf8',env:b16PythonEnv(root),timeout:30_000,maxBuffer:128*1024});
 if(result.error||result.status!==0)throw new Error(b16PythonFailure(result,python));
 if(!existsSync(output))throw new Error('Simulator exited 0 but delivery output is missing');
 const record=JSON.parse(readFileSync(output,'utf8'));
 validateDelivery(record,{tradeId:trade.tradeId,onChainTradeId:String(trade.onChainTradeId),sellerId:trade.sellerId,buyerId:trade.buyerId,
  expectedWh:String(trade.expectedWh),deliveryStart:String(now-1800),deliveryDeadline:String(now+1800)},BigInt(Math.floor(Date.now()/1000)));
 console.log(`B16 PYTHON SMOKE PASS: ${record.status}, ${record.deliveredWh} Wh; isolated test record validated`);
 console.log('B16 SAFE: temporary evidence deleted; no B14/B15 records, oracle journal, Hedera transaction or payout');
}catch(err){console.error('B16 PYTHON SMOKE STOP: '+String(err?.message??err));process.exitCode=1;}
finally{rmSync(temp,{recursive:true,force:true});}
