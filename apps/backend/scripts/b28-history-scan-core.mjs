/** Pure presentation + classification helpers for a READ-ONLY B11/B12 compatibility scan. */
import {auditData,expectedPayment} from './b28-b11-v2-candidate.mjs';

export function classifyHour(data) {
  const {slot,importRow,matchingRuns,matches,records,wallets,existingV2}=data;
  if(!Array.isArray(matchingRuns)||matchingRuns.length===0){
    const hasOrphanMatches=Array.isArray(matches)&&matches.length>0;
    return {slot, status:hasOrphanMatches?'BLOCKED':'NO_B12_RUN',matches:matches?.length??0,nonExact:0,remainders:[],errors:[hasOrphanMatches?'B12_MATCHES_WITHOUT_RUN':'NO_B12_MATCHING_RUN'],warnings:[]};
  }
  const audit=auditData({slot,importRow,matchingRuns,matches,records,wallets,existingV2});
  const remainders=[];
  for(const m of matches){
    try{
      const payment=expectedPayment(m.quantity_wh,m.unit_price_microusd_per_kwh);
      if(payment.remainder!==0n) remainders.push({matchId:String(m.id),remainder:payment.remainder.toString()});
    }catch{
      remainders.push({matchId:String(m.id),remainder:'INVALID'});
    }
  }
  const status=audit.errors.length?'BLOCKED':matches.length===0?'NO_MATCH':'PRECHECK_PASS_ONLY';
  return {slot,status,matches:matches.length,nonExact:remainders.length,remainders,errors:audit.errors,warnings:audit.warnings};
}
export function summarizeHours(rows){
  return {
    scanned:rows.length,
    preliminaryCandidates:rows.filter(x=>x.status==='PRECHECK_PASS_ONLY').length,
    blocked:rows.filter(x=>x.status==='BLOCKED').length,
    noMatch:rows.filter(x=>x.status==='NO_MATCH').length,
    missingMatchingRun:rows.filter(x=>x.status==='NO_B12_RUN').length,
    nonExactMatches:rows.reduce((n,r)=>n+r.nonExact,0),
  };
}
