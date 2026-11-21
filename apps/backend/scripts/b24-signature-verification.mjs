/** Verify recorded EIP-712 evidence without trusting a database success state. */
import {TypedDataEncoder,verifyTypedData,getAddress} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';

export function verifyRecordedAuthorization(reservation, signature) {
 try {
  const payload=reservation?.terms;
  if(typeof signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(signature)||!payload?.domain||!payload?.types||!payload?.terms)return false;
  const buyer=getAddress(reservation.buyerAddress);
  const digest=TypedDataEncoder.hash(payload.domain,payload.types,payload.terms);
  return digest===reservation.settlementId && payload.settlementId===digest &&
   getAddress(payload.terms.buyer)===buyer &&
   getAddress(verifyTypedData(payload.domain,payload.types,payload.terms,signature))===buyer;
 } catch { return false; }
}
