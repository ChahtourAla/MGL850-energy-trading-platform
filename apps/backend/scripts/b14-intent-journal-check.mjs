/** Read-only DB readiness check for B14 transaction intent ledger. Never signs or broadcasts. */
import { requireUuid } from './b14-trade-core.mjs';
import { STATES, OPERATIONS } from './b14-intent-journal-core.mjs';

async function main() {
  const argv=process.argv.slice(2);
  if(argv.length!==2||argv[0]!=='--match-id')throw new Error('Usage: b14-intent-journal-check.mjs --match-id <committed-B12-UUID>');
  const matchId=requireUuid(argv[1], 'match-id');
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured');
  const [{PrismaPg},{PrismaClient}]=await Promise.all([import('@prisma/adapter-pg'),import('../dist/generated/prisma/client.js')]);
  const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
  try {
    const match=await prisma.match.findUnique({where:{id:matchId},select:{id:true,status:true,timeSlot:true}});
    if(!match)throw new Error('B12 match does not exist');
    if(match.status!=='SELECTED')throw new Error('B12 match not SELECTED; do not create new intents');
    let rows;
    try {rows=await prisma.b14TransactionIntent.findMany({where:{matchId},orderBy:{createdAt:'asc'}});}
    catch(e) {throw new Error('B14 journal table/client unavailable; verify schema, migration and pnpm prisma generate ('+(e?.code??'DB error')+')');}
    for(const row of rows) {
      if(!OPERATIONS.includes(row.operation)||!STATES.includes(row.status)||row.chainId!==296)throw new Error('Unrecognized B14 journal state/operation/chain');
      if(row.status!=='PLANNED' && (!row.txHash||!row.signedTxCiphertext||!row.signedTxIv||!row.signedTxTag)) throw new Error('Incomplete signed B14 intent: STOP and reconcile before signing');
    }
    console.log(`B14 JOURNAL READY: match=${match.id} status=${match.status} timeSlot=${match.timeSlot.toISOString()}`);
    console.log(`B14 JOURNAL RECORDS: ${rows.length}`);
    for(const row of rows) console.log(`B14 JOURNAL: operation=${row.operation} status=${row.status} txHash=${row.txHash??'NOT_SIGNED'}`);
    console.log('B14 READ-ONLY PASS: no signing, HBAR spending, token minting, trade creation or DB changes');
  } finally {await prisma.$disconnect();}
}
main().catch(e=>{console.error('B14 JOURNAL CHECK FAILED:',e instanceof Error?e.message:String(e));process.exitCode=1;});
