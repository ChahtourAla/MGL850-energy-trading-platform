/** B14 Phase B1: pure, guarded transaction-intent primitives. No network, DB, signers or broadcasts. */
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const HEX_40 = /^0x[0-9a-fA-F]{40}$/;
const HEX_64 = /^0x[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UINT256 = (1n << 256n)-1n;
export const OPERATIONS = Object.freeze(['FUND_BUYER_HBAR','MINT_TEUSD','APPROVE_ESCROW','CREATE_TRADE','FUND_TRADE']);
export const STATES = Object.freeze(['PLANNED','SIGNED','SUBMITTED','CONFIRMED','REVERTED','NEEDS_RECONCILIATION']);
const NEXT = Object.freeze({
  PLANNED:['SIGNED'], SIGNED:['SUBMITTED','CONFIRMED','REVERTED','NEEDS_RECONCILIATION'],
  SUBMITTED:['CONFIRMED','REVERTED','NEEDS_RECONCILIATION'],
  NEEDS_RECONCILIATION:['SUBMITTED','CONFIRMED','REVERTED'], CONFIRMED:[], REVERTED:[],
});
const canonicalAddress = (a,name)=> {
  if(typeof a!=='string'||!HEX_40.test(a)|| /^0x0{40}$/i.test(a))throw new Error(`${name} must be a nonzero EVM address`);
  return a.toLowerCase();
};
const decimal = (v,name,nonzero=false)=>{
  if(typeof v!=='string'||!/^(0|[1-9]\d*)$/.test(v)||v.length>78) throw new Error(`${name} must be a canonical decimal string`);
  const n=BigInt(v); if(n>UINT256||(nonzero&&n===0n)) throw new Error(`${name} out of range`);return v;
};
export function canonicalIntent({ matchId, operation, externalTradeId, signerAddress, targetAddress, valueWei, callData, deliveryStart, deliveryDeadline }) {
  if(typeof matchId!=='string'||!UUID.test(matchId))throw new Error('matchId must be UUID');
  if(!OPERATIONS.includes(operation))throw new Error('invalid B14 operation');
  if(typeof externalTradeId!=='string'||!HEX_64.test(externalTradeId))throw new Error('externalTradeId must be bytes32');
  const data=callData??'0x';
  if(typeof data!=='string'||!/^0x(?:[0-9a-fA-F]{2})*$/.test(data))throw new Error('callData must be even-length hex');
  const start=deliveryStart??null, deadline=deliveryDeadline??null;
  if((start===null)!==(deadline===null))throw new Error('delivery times must both be provided or both omitted');
  if(start!==null) {decimal(start,'deliveryStart',true);decimal(deadline,'deliveryDeadline',true);if(BigInt(deadline)<=BigInt(start))throw new Error('deadline must be later');}
  const payload={version:1,chainId:296,matchId:matchId.toLowerCase(),operation,
    externalTradeId:externalTradeId.toLowerCase(),signerAddress:canonicalAddress(signerAddress,'signerAddress'),
    targetAddress:canonicalAddress(targetAddress,'targetAddress'),valueWei:decimal(valueWei,'valueWei'),
    callData:data.toLowerCase(),deliveryStart:start,deliveryDeadline:deadline};
  const hash=createHash('sha256').update(`mgl850:b14:intent:v1:${JSON.stringify(payload)}`,'utf8').digest('hex');
  return Object.freeze({...payload,payloadSha256:hash});
}
export function compareImmutableIntent(existing, planned) {
  if(!existing||!planned)throw new Error('Both intents required');
  if(existing.matchId.toLowerCase()!==planned.matchId||existing.operation!==planned.operation||
      existing.chainId!==296||existing.payloadSha256!==planned.payloadSha256||
      existing.signerAddress.toLowerCase()!==planned.signerAddress||
      existing.targetAddress.toLowerCase()!==planned.targetAddress) {
    throw new Error('B14 immutable intent conflict: never replace or re-sign');
  }
  if(existing.status!=='PLANNED')throw new Error('Intent already started: reconcile existing hash; never create a replacement');
  return true;
}
export function checkTransition(before,after){
  if(!STATES.includes(before)||!STATES.includes(after)||!NEXT[before].includes(after)){
    throw new Error(`Unsafe B14 transaction state transition: ${before} -> ${after}`);
  }
  return true;
}
function readKey(keyBase64){
  if(typeof keyBase64!=='string'|| !/^[A-Za-z0-9+/]{43}=$/.test(keyBase64))throw new Error('B14 journal encryption key must be base64 of 32 bytes');
  const key=Buffer.from(keyBase64,'base64');
  if(key.length!==32||key.toString('base64')!==keyBase64)throw new Error('B14 journal encryption key invalid');
  return key;
}
export function encryptSignedTransaction(rawSignedTx, keyBase64, intentId){
  if(typeof rawSignedTx!=='string'|| !/^0x(?:[0-9a-fA-F]{2})+$/.test(rawSignedTx))throw new Error('signed transaction must be hexadecimal bytes');
  if(typeof intentId!=='string'||!UUID.test(intentId))throw new Error('intentId UUID required for encryption AAD');
  const key=readKey(keyBase64), iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(`b14:v1:${intentId.toLowerCase()}`,'utf8'));
  const ciphertext=Buffer.concat([cipher.update(rawSignedTx,'utf8'),cipher.final()]);
  return {ciphertext:ciphertext.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function decryptSignedTransaction(bundle,keyBase64,intentId){
  if(!bundle||typeof bundle!=='object'||typeof intentId!=='string'||!UUID.test(intentId))throw new Error('invalid journal bundle or intent id');
  const key=readKey(keyBase64);
  const iv=Buffer.from(bundle.iv??'','base64'),tag=Buffer.from(bundle.tag??'','base64');
  if(iv.length!==12||tag.length!==16)throw new Error('invalid encrypted transaction IV/tag');
  const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(`b14:v1:${intentId.toLowerCase()}`,'utf8'));decipher.setAuthTag(tag);
  const plaintext=Buffer.concat([decipher.update(Buffer.from(bundle.ciphertext??'','base64')),decipher.final()]).toString('utf8');
  if(!/^0x(?:[0-9a-fA-F]{2})+$/.test(plaintext))throw new Error('decrypted transaction invalid');
  return plaintext;
}
export function assertBeforeBroadcast(row){
  if(row?.status!=='SIGNED'||!row?.txHash||!row?.signedTxCiphertext||!row?.signedTxIv||!row?.signedTxTag||row.nonce===null||row.nonce===undefined){
    throw new Error('Cannot broadcast: signed transaction, hash, nonce and encrypted recovery bytes must be durably recorded');
  }
  return true;
}
