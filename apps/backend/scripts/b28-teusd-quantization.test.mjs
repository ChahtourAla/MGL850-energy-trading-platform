import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteTeusd,B28_POLICY,B22_LEGACY_POLICY} from './b28-teusd-quantization.mjs';
const q = (w,p,policy=B28_POLICY)=>quoteTeusd({quantityWh:w,unitPriceMicrousdPerKwh:p,policy});
test('exact payment remains unchanged',()=>{
  const result=q('246','85000');
  assert.equal(result.amountBaseUnits,'20910');
  assert.equal(result.remainderOf1000,'0');
  assert.equal(result.exactPayment,true);
});
test('fractional case rounds down when less than a half',()=>{
  const result=q('1','1499');
  assert.equal(result.amountBaseUnits,'1');
  assert.equal(result.errorNumeratorOf1000BaseUnits,'-499');
});
test('fractional case rounds up when greater than a half',()=>{
  const result=q('1','1501');
  assert.equal(result.amountBaseUnits,'2');
  assert.equal(result.errorNumeratorOf1000BaseUnits,'499');
});
test('half-even ties to lower even integer',()=>assert.equal(q('1','2500').amountBaseUnits,'2'));
test('half-even ties to higher even integer',()=>assert.equal(q('1','1500').amountBaseUnits,'2'));
test('half-even ties at even floor with 0.5 go down',()=>assert.equal(q('1','4500').amountBaseUnits,'4'));
test('legacy policy blocks fractional payment',()=>assert.throws(()=>q('1','1501',B22_LEGACY_POLICY),/LEGACY_EXACT/));
test('legacy policy allows exact payments',()=>assert.equal(q('1','2000',B22_LEGACY_POLICY).amountBaseUnits,'2'));
test('zero base-unit payments are blocked',()=>assert.throws(()=>q('1','499'),/rounds to zero/));
test('zero and negative values blocked',()=>{
  assert.throws(()=>q('0','1000'));
  assert.throws(()=>q('-1','1000'));
});
test('floating point inputs blocked',()=>assert.throws(()=>q(1,1501),/never a JS Number/));
test('scientific notation and hexadecimal rejected',()=>{
  assert.throws(()=>q('1e5','1000'));
  assert.throws(()=>q('0x10','1000'));
});
test('unknown policy blocked',()=>assert.throws(()=>q('1','1000','OTHER'),/Unsupported pricing policy/));
test('payment over uint256 is blocked',()=>{
  assert.throws(()=>q(String((1n<<256n)-1n),'1000'),/exceeds uint256/);
});
test('rounding error bounded by half base unit across many small remainders',()=>{
  for(let p=1000;p<2000;p++){
    const result=q('1',String(p));
    const err=BigInt(result.errorNumeratorOf1000BaseUnits);
    assert.ok(err>=-500n && err<=500n);
  }
});
