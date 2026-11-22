import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createSupervisorIpcClient,attachSupervisorToWorker} from './b26-supervisor-ipc.mjs';

function channel(){
 const c=new EventEmitter();
 c.connected=true;
 c.sent=[];
 c.send=(message,callback)=>{c.sent.push(message);callback?.(null);};
 c.disconnect=()=>{c.connected=false;c.emit('disconnect');};
 return c;
}
const next=()=>new Promise(resolve=>setImmediate(resolve));

test('B26 supervisor IPC returns only scoped replies and never accepts a wrong request ID',async()=>{
 const c=channel(),client=createSupervisorIpcClient(c,{timeoutMs:1000});
 const pending=client.execute({allocationId:'fixture-only'});
 assert.equal(c.sent.length,1);
 const id=c.sent[0].id;
 assert.match(id,/^[0-9a-f-]{36}$/);
 assert.equal(c.sent[0].method,'execute');
 c.emit('message',{channel:'b26-supervisor-v1',id:'wrong',ok:true,result:{state:'UNAUTHORIZED'}});
 c.emit('message',{channel:'b26-supervisor-v1',id,ok:true,result:{state:'UNRESOLVED'}});
 assert.deepEqual(await pending,{state:'UNRESOLVED'});
 client.close();
});

test('B26 supervisor IPC fails closed on error replies, disconnect and late responses',async()=>{
 const c=channel(),client=createSupervisorIpcClient(c,{timeoutMs:1000});
 const error=client.reconcile({runId:'fixture-only'});
 c.emit('message',{channel:'b26-supervisor-v1',id:c.sent[0].id,ok:false,secret:'SHOULD_NOT_ECHO'});
 await assert.rejects(error,/Supervised operation unavailable/);
 const pending=client.execute({runId:'fixture-only'});
 const id=c.sent[1].id;
 c.disconnect();
 await assert.rejects(pending,/Supervisor disconnected; outcome unknown/);
 c.emit('message',{channel:'b26-supervisor-v1',id,ok:true,result:{state:'SETTLED'}});
 await assert.rejects(client.execute({}),/Supervisor disconnected; outcome unknown/);
 client.close();
});

test('B26 supervisor owner rejects invalid method and disconnected worker',async()=>{
 const c=channel();let operations=0;
 const supervisor={
  execute:async(request,{assertActive})=>{assertActive();operations++;return {state:'BLOCKED'};},
  reconcile:async()=>{operations++;return {state:'SETTLED'};}
 };
 const detach=attachSupervisorToWorker(c,supervisor);
 c.emit('message',{channel:'b26-supervisor-v1',id:'00000000-0000-4000-8000-000000000001',method:'delete',request:{}});
 await next();assert.equal(operations,0);assert.equal(c.sent.length,0);
 c.emit('message',{channel:'b26-supervisor-v1',id:'00000000-0000-4000-8000-000000000002',method:'execute',request:{}});
 await next();assert.equal(operations,1);assert.deepEqual(c.sent[0].result,{state:'BLOCKED'});
 c.disconnect();
 c.emit('message',{channel:'b26-supervisor-v1',id:'00000000-0000-4000-8000-000000000003',method:'execute',request:{}});
 await next();assert.equal(operations,1);assert.equal(c.sent.length,1);
 detach();
});
