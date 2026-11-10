import {test} from 'node:test';
import assert from 'node:assert/strict';
import { patchAppModule } from './install-b18-api.mjs';
const original=`import { Module } from '@nestjs/common';\nimport { AuthModule } from './auth/auth.module.js';\n\n@Module({\n  imports: [\n    AuthModule,\n  ],\n  controllers: [],\n  providers: [],\n})\nexport class AppModule {}\n`;
test('B18 AppModule additive registration only',()=>{
  const patched=patchAppModule(original);
  assert.equal(patched.includes('TradingApiModule,'),true);
  assert.equal(patched.includes('AuthModule,'),true);
  assert.equal(patched.includes('controllers: []'),true);
});
test('AppModule installer is idempotent',()=>{
  const once=patchAppModule(original);
  assert.equal(patchAppModule(once),once);
});
for(const x of ['', 'class OtherModule {}',original.replace('imports: [','providers: ['),original.replace('export class AppModule','export class RandomModule')]){
  test('installer refuses unsupported module shape',()=>assert.throws(()=>patchAppModule(x)));
}
test('partial B18 module registration fails closed',()=>assert.throws(()=>patchAppModule(original+'\n// TradingApiModule')));
