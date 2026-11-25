/**
 * B30: independent, deterministic validation for the *one* approved B28.1
 * simulated hourly market. No network/database/private-key access.
 * Future hours require a new independently authorized plan; never infer one.
 */
export const MARKET_ID = '0x5661be2e34e1c2631f517dca6e879932671b78f8d4edc3df85350d2e80972188';
export const PLAN_ID = '0x72bfa3a65778cf258563c6acf6813f615c974f5a7a222547ee477f247e1f1a25';
export const DEPLOYED_CONTRACT = '0x1946713C8f6Ec56cb6c641F0d56a17B30EEd82dB';
export const CHAIN_ID = 296;
export const ALLOCATIONS = Object.freeze([
  Object.freeze({ id:'0xe6fbf2bb022c6d7b11b4a9831f53cc378ee912f29d34f98eb7e3bdc1b5719d99', buyer:'0x5e77aa89c832f9d1cd2d7a28ecc622563031cb0f', seller:'0x133b23b613209ca21ea8a6138f7215c288e5c99f', quantityWh:'246', amount:'20956' }),
  Object.freeze({ id:'0xccfcdffc28c22806aaf27047dc00ca2815fe10d815fc98e7a167447c8e02c308', buyer:'0xbccc4f9091bd4e5d5d9448d675199c9d97d06006', seller:'0x34095c456de7106d037ae9668c4b4c65bf4e6538', quantityWh:'254', amount:'39297' }),
  Object.freeze({ id:'0x24a3e81f81ea25e6e360f8a32565288bcc5743cfa1ade73235aa368a542731b6', buyer:'0x255d93780b72aeb3c29187765d900eae4cf67f31', seller:'0x34095c456de7106d037ae9668c4b4c65bf4e6538', quantityWh:'2572', amount:'397924' }),
]);
const sameAddress = (a,b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = (reason) => { throw new Error(`B30 STOP: ${reason}`); };
export function parseJsonOutput(stdout){
  const start=stdout.indexOf('{');
  if(start < 0) fail('Missing JSON response');
  try { return JSON.parse(stdout.slice(start)); } catch { return fail('Malformed JSON response'); }
}
export function validateSummary(summary){
  if(!summary || summary.mode !== 'B28_DB_READ_ONLY_SUMMARY' || summary.marketId !== MARKET_ID || summary.planId !== PLAN_ID || !Array.isArray(summary.allocations) || summary.allocations.length !== ALLOCATIONS.length || summary.totals?.count !== 3 || summary.totals.totalBaseUnits !== '458177') fail('Authoritative market identity/total mismatch');
  if(new Set(summary.allocations.map(a=>a.allocationId)).size !== 3) fail('Duplicate allocation');
  const map=new Map(summary.allocations.map(a=>[a.allocationId,a]));
  for(const a of ALLOCATIONS){
    const r=map.get(a.id);
    if(!r || !sameAddress(r.buyerAddress,a.buyer) || !sameAddress(r.sellerAddress,a.seller) || r.quantityWh !== a.quantityWh || r.amountBaseUnits !== a.amount || !Number.isInteger(r.attempts) || r.attempts < 0 || !Number.isInteger(r.verifiedEvidence) || r.verifiedEvidence < 0) fail(`Unexpected allocation identity/status ${a.id}`);
  }
  return summary;
}
export function classify(summaryRow,preflight,expected){
  if(!summaryRow || !preflight || !expected || summaryRow.allocationId !== expected.id || preflight.mode !== 'B28_TESTNET_READ_ONLY_PREFLIGHT' || preflight.simulationOnly !== true || preflight.chainId !== CHAIN_ID || preflight.marketId !== MARKET_ID || preflight.planId !== PLAN_ID || preflight.allocationId !== expected.id || !sameAddress(preflight.buyer,expected.buyer) || !sameAddress(preflight.seller,expected.seller) || preflight.quantityWh !== expected.quantityWh || preflight.paymentBaseUnits !== expected.amount || !sameAddress(preflight.contract,DEPLOYED_CONTRACT) || preflight.contractStatus !== 'VERSIONED_CONTRACT_VERIFIED' || preflight.policy !== 'b28-teusd-half-even-1') fail(`Unverified contract or allocation ${expected.id}`);
  if(preflight.onChainPaid === true){
    if(summaryRow.intentStatus !== 'CONFIRMED' || preflight.existingIntentStatus !== 'CONFIRMED' || preflight.previousAttempts !== summaryRow.attempts || summaryRow.verifiedEvidence !== 1 || summaryRow.attempts < 1) fail(`On-chain payment not matched by verified database receipt ${expected.id}`);
    return 'CONFIRMED';
  }
  if(preflight.onChainPaid !== false) fail(`Unknown blockchain payment state ${expected.id}`);
  if(summaryRow.verifiedEvidence !== 0) fail(`Conflicting payment evidence ${expected.id}`);
  if((summaryRow.intentStatus === null && summaryRow.attempts === 0) || (summaryRow.intentStatus === 'READY' && summaryRow.attempts === 1)){
    // The runner checks sufficient gas/funds for both execute and resume.
    if(!/^\d+$/.test(String(preflight.buyerBalanceBaseUnits)) || BigInt(preflight.buyerBalanceBaseUnits) < BigInt(expected.amount) || !/^\d+$/.test(String(preflight.buyerHbarWei)) || BigInt(preflight.buyerHbarWei) <= 0n || !/^\d+$/.test(String(preflight.operatorHbarWei)) || BigInt(preflight.operatorHbarWei) <= 0n) fail(`Insufficient on-chain balance or unknown operator funding ${expected.id}`);
    if(preflight.existingIntentStatus !== summaryRow.intentStatus || preflight.previousAttempts !== summaryRow.attempts) fail('DB changed between queries');
    return summaryRow.intentStatus === null ? 'ELIGIBLE' : 'RESUME_AFTER_APPROVAL';
  }
  fail(`Ambiguous prior settlement state for ${expected.id}; manual reconciliation required`);
}
export function validateAll(summary,preflights){
  validateSummary(summary);
  if(!Array.isArray(preflights)||preflights.length!==3) fail('Expected three preflights');
  return ALLOCATIONS.map((a,i)=>({ ...a, state:classify(summary.allocations.find(r=>r.allocationId===a.id),preflights[i],a)}));
}
