/** Pure B28 commit authorization helpers. No database, network, secrets or signing. */
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HEX=/^0x[0-9a-f]{64}$/;
const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const str=v=>typeof v==='string'?v:String(v);

/** Binds human approval to market, plan, exact allocations AND financial amounts. */
export function b28ProposalDigest(plan){
 if(!plan||!HEX.test(plan.marketId)||!HEX.test(plan.snapshotHash)||!HEX.test(plan.planId)||!HEX.test(plan.manifestHash)||!Array.isArray(plan.allocations)||plan.allocations.length<1||!Array.isArray(plan.positions))throw Error('Invalid B28 proposal for confirmation');
 const allocations=plan.allocations.map(a=>[a.id,a.buyerId,a.sellerId,a.buyerAddress,a.sellerAddress,str(a.quantityWh),str(a.unitPriceMicrousdPerKwh),str(a.amountBaseUnits),str(a.remainder),a.pricingVersion,a.planVersion]).sort((a,b)=>a[0].localeCompare(b[0]));
 const positions=plan.positions.map(p=>[p.userId,p.role,str(p.productionWh),str(p.consumptionWh),str(p.matchedBoughtWh),str(p.matchedSoldWh)]).sort((a,b)=>a[0].localeCompare(b[0]));
 return '0x'+createHash('sha256').update(JSON.stringify(['mgl850:b28:human-commit-approval:1',plan.marketId,plan.snapshotId,plan.snapshotHash,plan.planId,plan.manifestHash,plan.policy,allocations,positions]),'utf8').digest('hex');
}

export function parseB28Args(args){
 const out={};
 for(const arg of args){
  if(arg==='--commit'){if(out.commit)throw Error('Duplicate --commit');out.commit=true;continue;}
  const m=/^(--snapshot|--python|--confirm-market|--confirm-plan|--confirm-proposal)=(.+)$/.exec(arg);
  if(!m||Object.hasOwn(out,m[1]))throw Error('B28 unknown, empty or duplicate command option');
  out[m[1]]=m[2];
 }
 if(!out['--snapshot'])throw Error('Original B11 snapshot JSON required: --snapshot=<path>');
 if(out.commit!==true&&(out['--confirm-market']||out['--confirm-plan']||out['--confirm-proposal']))throw Error('Confirmation IDs are only valid with --commit');
 if(out.commit===true&&(!HEX.test(out['--confirm-market']??'')||!HEX.test(out['--confirm-plan']??'')||!HEX.test(out['--confirm-proposal']??'')))throw Error('--commit requires --confirm-market, --confirm-plan, AND --confirm-proposal from preview');
 return {snapshot:resolve(out['--snapshot']),python:out['--python']??(process.platform==='win32'?resolve(ROOT,'.venv/Scripts/python.exe'):resolve(ROOT,'.venv/bin/python')),commit:out.commit===true,confirmation:out['--confirm-market'],planConfirmation:out['--confirm-plan'],proposalConfirmation:out['--confirm-proposal']};
}

export function validateB28Approval(options,plan,approval){
 if(approval!=='I_APPROVE_SIMULATED_V2_MARKET')throw Error('B28 commit disabled: B28_PERSIST_APPROVAL missing');
 if(options.confirmation!==plan.marketId)throw Error('B28 market ID differs from explicit confirmation');
 if(options.planConfirmation!==plan.planId)throw Error('B28 plan ID differs from explicit confirmation');
 if(options.proposalConfirmation!==b28ProposalDigest(plan))throw Error('B28 proposal digest differs from explicit confirmation: amounts/participants may have changed');
}
