import {randomUUID} from 'node:crypto';

// A verifier reads chain data itself before recording any transition. The SQL
// function serializes the attempt and checks the prior observation identity.
export async function currentOutcome(client,attemptId){
 return (await client.query('SELECT id,outcome,"blockHash","blockNumber","settlementLogIndex","transferLogIndex" FROM "B25CanonicalOutcomeEvent" WHERE "attemptId"=$1 ORDER BY sequence DESC LIMIT 1',[attemptId])).rows[0]??null;
}
export async function recordOutcome(client,attemptId,kind,evidence,previous){
 const row=(await client.query('SELECT "b25_record_outcome"($1,$2,$3,$4,$5,$6,$7,$8) result',[
  attemptId,randomUUID(),kind,evidence.blockHash.toLowerCase(),evidence.blockNumber,
  kind==='SUCCESS'?evidence.settlementLogIndex:null,kind==='SUCCESS'?evidence.transferLogIndex:null,previous?.id??null
 ])).rows[0]?.result;
 if(!row)throw Error('B25 outcome persistence failed');
 return row;
}
