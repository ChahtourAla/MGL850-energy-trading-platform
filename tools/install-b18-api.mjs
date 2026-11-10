/**
 * B18: ADDITIVE AppModule import registrar; never changes schema, .env, wallets,
 * prior modules, scripts or database. Default --check is read-only.
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REGISTRATION_IMPORT = "import { TradingApiModule } from './trading-api/trading-api.module.js';";
export function patchAppModule(source) {
  if (typeof source !== 'string' || !/export\s+class\s+AppModule\s*\{/.test(source)) {
    throw new Error('Cannot find AppModule in backend; refuse modification');
  }
  const decorators=[...source.matchAll(/@Module\s*\(\s*\{/g)];
  if (decorators.length !== 1) throw new Error('Expected exactly one @Module decorator');
  const imports=[...source.matchAll(/\bimports\s*:\s*\[/g)];
  if (imports.length !== 1) throw new Error('Expected exactly one imports array');
  const declaration=[...source.matchAll(/\bTradingApiModule\b/g)];
  if (declaration.length) {
    if (declaration.length !== 2 || !source.includes(REGISTRATION_IMPORT) ||
        !/\bimports\s*:\s*\[\s*TradingApiModule\s*,/.test(source)) {
      throw new Error('B18 module partially registered; inspect manually to avoid duplication');
    }
    return source;
  }
  const pos=imports[0].index + imports[0][0].length;
  const patched=source.slice(0,pos)+'\n    TradingApiModule,'+source.slice(pos);
  return REGISTRATION_IMPORT+'\n'+patched;
}

function prismaModel(schema, model) {
  const match=schema.match(new RegExp(`(?:^|\\n)model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, 'm'));
  if (!match) throw new Error(`B18 requires Prisma model ${model}`);
  return match[1];
}

export function preflightB18Files(root) {
  const required=[
    'apps/backend/src/app.module.ts',
    'apps/backend/src/auth/jwt-auth.guard.ts',
    'apps/backend/src/auth/auth.module.ts',
    'apps/backend/src/prisma/prisma.service.ts',
    'apps/backend/src/hedera-contracts/hedera-contracts.service.ts',
    'apps/backend/src/trading-api/trading-api.module.ts',
    'apps/backend/src/trading-api/trading-api.service.ts',
    'apps/backend/scripts/b18-api-core.mjs',
    'apps/backend/scripts/b18-api-core.d.mts',
    'database/schema.prisma',
  ];
  for (const path of required) if (!existsSync(join(root,path))) {
    throw new Error(`B18 required dependency missing: ${path}`);
  }
  const schema=readFileSync(join(root,'database/schema.prisma'),'utf8');
  const requirements={
    Match:['id','buyerId','sellerId'],
    Trade:['id','matchId','buyerId','sellerId','onChainTradeId','status'],
    DeliveryRecord:['id','tradeId'],
    Wallet:['userId','evmAddress'],
    B14TransactionIntent:['matchId','operation','txHash','status'],
    B16OracleIntent:['matchId','txHash','status'],
    B17OperatorIntent:['matchId','operation','txHash','status'],
  };
  for (const [model,fields] of Object.entries(requirements)) {
    const body=prismaModel(schema,model);
    for (const field of fields) {
      if (!new RegExp(`^\\s*${field}\\s+`, 'm').test(body)) {
        throw new Error(`B18 required ${model}.${field} missing; no schema writes attempted`);
      }
    }
  }
  const trade=prismaModel(schema,'Trade');
  if (!/@@unique\(\[\s*matchId\s*\]/.test(trade) &&
      !/^\s*matchId\s+[^\n]*@unique/m.test(trade)) {
    throw new Error('B18 requires Trade.matchId unique for trusted B15 synchronization');
  }
  return true;
}

const main=process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  try {
    if (!['--check','--apply'].includes(process.argv[2]) || process.argv.length !== 3) {
      throw new Error('Usage: node tools/install-b18-api.mjs --check | --apply');
    }
    const root=resolve('.');
    preflightB18Files(root);
    const target=join(root,'apps/backend/src/app.module.ts');
    const original=readFileSync(target,'utf8');
    const updated=patchAppModule(original);
    if (process.argv[2] === '--check') {
      console.log('B18 INSTALL CHECK PASS: compatible dependencies, schema and AppModule; no writes');
      console.log(updated===original?'B18 module already registered':'B18 module can be registered additively');
    } else if (updated===original) {
      console.log('B18 module already registered; no changes');
    } else {
      const backupDir=mkdtempSync(join(tmpdir(),'mgl850-b18-appmodule-'));
      const backup=join(backupDir,'app.module.ts');
      writeFileSync(backup,original,{encoding:'utf8',flag:'wx'});
      writeFileSync(target,updated,{encoding:'utf8',flag:'w'});
      console.log('B18 MODULE REGISTERED: apps/backend/src/app.module.ts');
      console.log('Original AppModule backup (outside repo): '+backup);
    }
  } catch (error) {
    console.error('B18 INSTALL STOP: '+(error instanceof Error?error.message:'Unknown failure'));
    process.exitCode=1;
  }
}
