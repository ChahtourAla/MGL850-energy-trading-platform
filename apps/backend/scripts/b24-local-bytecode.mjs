import {readFileSync} from 'node:fs';
import {getBytes} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';

const artifact=name=>JSON.parse(readFileSync(new URL(`../../../packages/contracts/artifacts/contracts/${name}.sol/${name}.json`,import.meta.url),'utf8'));
function matchesRuntime(code,compiled){
 const actual=getBytes(code),expected=getBytes(compiled.deployedBytecode);if(actual.length!==expected.length)return false;
 const masked=new Uint8Array(expected.length);
 for(const refs of Object.values(compiled.immutableReferences??{}))for(const {start,length} of refs){if(!Number.isInteger(start)||!Number.isInteger(length)||start<0||length<1||start+length>masked.length)throw Error('Invalid immutable references');masked.fill(1,start,start+length);}
 return expected.every((value,i)=>masked[i]===1||actual[i]===value);
}
export function verifyLocalRuntime(tokenCode,contractCode){
 if(!matchesRuntime(tokenCode,artifact('TestEnergyUSD'))||!matchesRuntime(contractCode,artifact('EnergyTradingDirectSettlement')))throw Error('Local runtime code mismatch');
}
