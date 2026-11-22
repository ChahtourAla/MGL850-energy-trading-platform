/** Disposable B26 run persistence. Financial evidence stays under B22-B25 roles. */
import {randomUUID} from 'node:crypto';

export async function assertB26Worker(client) {
 const c=client?.connectionParameters;
 if(c?.host!=='127.0.0.1'||c?.database!=='b22_disposable_review'||c?.user!=='b26_worker')throw Error('Refusing non-disposable B26 worker');
 const result=await client.query("SELECT session_user AS actor, EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') AS guarded");
 if(result.rows[0]?.actor!=='b26_worker'||result.rows[0]?.guarded!==true)throw Error('B26 worker authentication failed');
}

/** Creates or reuses one logical run. Closed-hour validation uses database time. */
export async function ensureMarketRun(client,{start,configuration='v1-default'}) {
 await assertB26Worker(client);
 if(!(start instanceof Date)||!Number.isFinite(start.getTime())||start.getTime()%3600000!==0||configuration!=='v1-default')throw Error('Invalid B26 interval or configuration');
 const result=await client.query('SELECT b26_ensure_run($1,$2,$3) AS run',[randomUUID(),start,configuration]);
 return result.rows[0].run;
}
/** Lease is serialized by PostgreSQL and increments the fencing token on every claim. */
export async function claimMarketRun(client,{runId,workerId,leaseSeconds=60}) {
 await assertB26Worker(client);
 if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>300)throw Error('Invalid B26 lease');
 return (await client.query('SELECT b26_claim_run($1,$2,$3) AS run',[runId,workerId,leaseSeconds])).rows[0].run;
}
/** Renewal never revives an expired lease or changes its fencing token. */
export async function renewMarketRun(client,{runId,workerId,fence,leaseSeconds=60}) {
 await assertB26Worker(client);
 if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>300)throw Error('Invalid B26 lease');
 return (await client.query('SELECT b26_renew_run($1,$2,$3,$4) AS run',[runId,workerId,String(fence),leaseSeconds])).rows[0].run;
}
/** Only verified snapshot and matching checkpoints are supported here. */
export async function checkpointMarketRun(client,{runId,workerId,fence,state,snapshotId,snapshotHash,planId}) {
 await assertB26Worker(client);
 return (await client.query('SELECT b26_checkpoint_run($1,$2,$3,$4,$5,$6,$7) AS run',[runId,workerId,String(fence),state,snapshotId??null,snapshotHash??null,planId??null])).rows[0].run;
}

/** Release or defer only under the current, unexpired fencing token. */
export async function releaseMarketRun(client,{runId,workerId,fence,state,code='NONE',retrySeconds=0}) {
 await assertB26Worker(client);
 return (await client.query('SELECT b26_release_run($1,$2,$3,$4,$5,$6) AS run',[runId,workerId,String(fence),state,code,retrySeconds])).rows[0].run;
}
