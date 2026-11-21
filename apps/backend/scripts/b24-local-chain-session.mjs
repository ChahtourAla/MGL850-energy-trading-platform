/** Approved disposable Hardhat identity; no network-facing enrollment API exists. */
import {randomUUID} from 'node:crypto';
import {Contract,getAddress,keccak256} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {verifySigningPreflight} from './b24a2-signing-preflight.mjs';
import {verifyLocalRuntime} from './b24-local-bytecode.mjs';

const sessions=new WeakMap();
const blockTag=n=>'0x'+BigInt(n).toString(16);
async function rawBlock(provider,number){return provider.send('eth_getBlockByNumber',[blockTag(number),false]);}

/** The anchor is a successful local transaction funding the archived ephemeral buyer. */
export async function establishLocalChainSession(client,{reservationId,provider,anchorTransactionHash,approvalClient}){
 const target=approvalClient?.connectionParameters;
 if(target?.host!=='127.0.0.1'||target?.database!=='b22_disposable_review'||target?.user!=='b24_approver')throw Error('Refusing non-disposable session approver');
 const preflight=await verifySigningPreflight(client,{reservationId});
 if(preflight.state!=='SIMULATION_ELIGIBLE')throw Error('Local session preflight blocked');
 const q=await client.query('SELECT r."buyerAddress",r."deploymentId",d."chainId",d."tokenAddress",d."contractAddress",d.status FROM "B24AuthorizationReservation" r JOIN "B24Deployment" d ON d.id=r."deploymentId" WHERE r.id=$1',[reservationId]);
 if(q.rowCount!==1||q.rows[0].status!=='TEST_FIXTURE'||q.rows[0].chainId!==31337)throw Error('Local session deployment blocked');
 const row=q.rows[0];
 if((await provider.getNetwork()).chainId!==31337n)throw Error('Unapproved local chain');
 const [tx,receipt,tokenCode,contractCode]=await Promise.all([provider.getTransaction(anchorTransactionHash),provider.getTransactionReceipt(anchorTransactionHash),provider.getCode(row.tokenAddress),provider.getCode(row.contractAddress)]);
 if(!tx||!receipt||receipt.status!==1||!tx.to||getAddress(tx.to)!==getAddress(row.buyerAddress)||tx.value<=0n||tokenCode==='0x'||contractCode==='0x')throw Error('Invalid local session anchor');
 verifyLocalRuntime(tokenCode,contractCode);
 const token=new Contract(row.tokenAddress,['function decimals() view returns(uint8)'],provider);
 const settlement=new Contract(row.contractAddress,['function paymentToken() view returns(address)'],provider);
 if(await token.decimals()!==6n||getAddress(await settlement.paymentToken())!==getAddress(row.tokenAddress))throw Error('Local token configuration mismatch');
 const block=await rawBlock(provider,receipt.blockNumber);
 if(!block||block.hash.toLowerCase()!==receipt.blockHash.toLowerCase())throw Error('Local session anchor mismatch');
 const session=Object.freeze({id:randomUUID(),simulationOnly:true});
 const state={provider,client,reservationId,buyer:getAddress(row.buyerAddress),token:getAddress(row.tokenAddress),contract:getAddress(row.contractAddress),blockNumber:receipt.blockNumber,blockHash:receipt.blockHash.toLowerCase(),tokenHash:keccak256(tokenCode),contractHash:keccak256(contractCode),active:true};
 await approvalClient.query('INSERT INTO "B24LocalChainSession"(id,"reservationId","deploymentId","buyerAddress","tokenAddress","contractAddress","chainId","anchorTransactionHash","anchorBlockHash","anchorBlockNumber","tokenRuntimeHash","contractRuntimeHash","approvedBy") VALUES($1,$2,$3,$4,$5,$6,31337,$7,$8,$9,$10,$11,\'ignored\')',[session.id,reservationId,row.deploymentId,row.buyerAddress,row.tokenAddress,row.contractAddress,anchorTransactionHash.toLowerCase(),state.blockHash,state.blockNumber,state.tokenHash,state.contractHash]);
 sessions.set(session,state);
 return session;
}

/** Restore a recorded session for receipt recovery without granting permission to submit. */
export async function restoreLocalChainSession(client,{sessionId,provider}){
 const target=client?.connectionParameters;
 if(target?.host!=='127.0.0.1'||target?.database!=='b22_disposable_review'||target?.user!=='b24_preflight')throw Error('Refusing non-disposable session reader');
 const guard=await client.query("SELECT session_user actor,EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') guarded");
 if(guard.rows[0]?.actor!=='b24_preflight'||!guard.rows[0]?.guarded)throw Error('Session reader not authorized');
 const q=await client.query('SELECT * FROM "B24LocalChainSession" WHERE id=$1',[sessionId]);
 if(q.rowCount!==1||q.rows[0].status!=='ACTIVE')throw Error('Local chain session unavailable');
 const x=q.rows[0],session=Object.freeze({id:x.id,simulationOnly:true});
 sessions.set(session,{provider,client,reservationId:x.reservationId,buyer:getAddress(x.buyerAddress),token:getAddress(x.tokenAddress),contract:getAddress(x.contractAddress),blockNumber:x.anchorBlockNumber,blockHash:x.anchorBlockHash,tokenHash:x.tokenRuntimeHash,contractHash:x.contractRuntimeHash,active:true});
 await assertLocalChainSession(session,{provider,reservationId:x.reservationId,buyer:x.buyerAddress,token:x.tokenAddress,contract:x.contractAddress});
 return session;
}

export async function assertLocalChainSession(session,{provider,reservationId,buyer,token,contract}){
 const s=sessions.get(session);
 if(!s||!s.active||s.provider!==provider||s.reservationId!==reservationId||s.buyer!==getAddress(buyer)||s.token!==getAddress(token)||s.contract!==getAddress(contract))throw Error('Unknown or mismatched local chain session');
 const stored=await s.client.query('SELECT status FROM "B24LocalChainSession" WHERE id=$1',[session.id]);
 if(stored.rowCount!==1||stored.rows[0].status!=='ACTIVE')throw Error('Local chain session retired');
 if((await provider.getNetwork()).chainId!==31337n)throw Error('Unapproved local chain');
 const [block,tokenCode,contractCode]=await Promise.all([rawBlock(provider,s.blockNumber),provider.getCode(s.token),provider.getCode(s.contract)]);
 if(!block||block.hash.toLowerCase()!==s.blockHash)throw Error('Stale local chain session');
 if(keccak256(tokenCode)!==s.tokenHash||keccak256(contractCode)!==s.contractHash)throw Error('Local runtime code mismatch');
}

export async function localSessionAnchor(session,context){
 await assertLocalChainSession(session,context);
 return BigInt(sessions.get(session).blockNumber);
}

export async function retireLocalChainSession(session,approvalClient){const s=sessions.get(session);if(!s)throw Error('Unknown local chain session');const q=await approvalClient.query('UPDATE "B24LocalChainSession" SET status=\'RETIRED\' WHERE id=$1 AND status=\'ACTIVE\'',[session.id]);if(q.rowCount!==1)throw Error('Local chain session unavailable');s.active=false;}
