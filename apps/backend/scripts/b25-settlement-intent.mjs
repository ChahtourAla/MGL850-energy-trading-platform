/** Local-only fixture intent creation. It does not authorize a transaction or claim payment. */
import {createHash} from 'node:crypto';
import {verifySigningPreflight} from './b24a2-signing-preflight.mjs';
import {inspectLocalReadiness} from './b24-readiness.mjs';
import {verifyRecordedAuthorization} from './b24-signature-verification.mjs';

export function localFixtureIntentId(allocationId,tokenAddress){
 if(!/^0x[0-9a-f]{64}$/.test(allocationId)||!/^0x[0-9a-f]{40}$/.test(tokenAddress))throw Error('Invalid fixture identity');
 return '0x'+createHash('sha256').update(JSON.stringify(['mgl850:b25:local-fixture-intent:1',allocationId,'31337',tokenAddress]),'ascii').digest('hex');
}
export async function createLocalSettlementIntent({client,preflightClient,reservationId,provider,session}){
 const t=client?.connectionParameters;
 if(t?.host!=='127.0.0.1'||t?.database!=='b22_disposable_review'||t?.user!=='b25_executor')throw Error('Refusing non-disposable B25 executor');
 const verified=await verifySigningPreflight(preflightClient,{reservationId});
 if(verified.state!=='SIMULATION_ELIGIBLE')throw Error('B25 preflight blocked');
 const ready=await inspectLocalReadiness(preflightClient,{reservationId,provider,session});
 if(ready.state!=='READY_FOR_LOCAL_SETTLEMENT')throw Error(`B25 readiness blocked: ${ready.state}`);
 const q=await preflightClient.query('SELECT r.*,d."tokenAddress",d."contractAddress" FROM "B24AuthorizationReservation" r JOIN "B24Deployment" d ON d.id=r."deploymentId" WHERE r.id=$1',[reservationId]);
 if(q.rowCount!==1)throw Error('Reservation missing');
 const r=q.rows[0],e=(await preflightClient.query('SELECT "b24_local_readiness_evidence"($1,$2) evidence',[reservationId,session.id])).rows[0]?.evidence;
 if(!verifyRecordedAuthorization(r,e?.signature))throw Error('B25 buyer signature invalid');
 const id=localFixtureIntentId(r.allocationId,r.tokenAddress);
 const result=await client.query('SELECT "b25_create_local_intent"($1,$2,$3) AS intent',[reservationId,session.id,id]);
 if(result.rows[0]?.intent?.intentId!==id)throw Error('B25 intent readback mismatch');
 return {state:'PLANNED',...result.rows[0].intent,simulationOnly:true,realHederaExecutionAuthorized:false};
}
