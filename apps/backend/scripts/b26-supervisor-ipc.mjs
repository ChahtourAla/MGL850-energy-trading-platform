/** Private Node parent/child IPC for the disposable local payment supervisor. */
import {randomUUID} from 'node:crypto';

/** Only attach this listener to a worker process forked by the trusted owner. */
export function attachSupervisorToWorker(child,supervisor){
 if(!child||typeof child.send!=='function'||!child.connected||!supervisor?.execute||!supervisor?.reconcile)throw Error('Connected supervised child required');
 const listener=async message=>{
  if(!message||message.channel!=='b26-supervisor-v1'||!/^[-a-f0-9]{36}$/i.test(message.id??'')||!['execute','reconcile'].includes(message.method))return;
  try{
   const assertActive=()=>{if(!child.connected)throw Error('Supervised worker disconnected');};
   assertActive();
   const result=message.method==='execute'
    ? await supervisor.execute(message.request,{assertActive})
    : await supervisor.reconcile(message.request);
   if(child.connected)child.send({channel:'b26-supervisor-v1',id:message.id,ok:true,result});
  }catch{
   // Do not return exception text: drivers can include credentials or keys.
   if(child.connected)child.send({channel:'b26-supervisor-v1',id:message.id,ok:false});
  }
 };
 child.on('message',listener);
 return ()=>child.off('message',listener);
}

/** Child adapter. A timeout means unknown outcome, never permission to retry. */
export function createSupervisorIpcClient(channel=process,{timeoutMs=120000}={}){
 if(!channel.connected||typeof channel.send!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>300000)throw Error('Private supervisor IPC required');
 const pending=new Map();
 const listener=message=>{
  if(!message||message.channel!=='b26-supervisor-v1')return;
  const entry=pending.get(message.id);if(!entry)return;
  pending.delete(message.id);clearTimeout(entry.timer);
  if(message.ok===true)entry.resolve(message.result);else entry.reject(Error('Supervised operation unavailable'));
 };
 const disconnected=()=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('Supervisor disconnected; outcome unknown'));}pending.clear();};
 channel.on('message',listener);channel.on('disconnect',disconnected);
 function call(method,request){
  return new Promise((resolve,reject)=>{
   if(!channel.connected){reject(Error('Supervisor disconnected; outcome unknown'));return;}
   const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('Supervisor timeout; outcome unknown'));},timeoutMs);
   pending.set(id,{resolve,reject,timer});
   try{channel.send({channel:'b26-supervisor-v1',id,method,request},error=>{if(error&&pending.has(id)){pending.delete(id);clearTimeout(timer);reject(Error('Supervisor IPC unavailable; outcome unknown'));}});}catch{pending.delete(id);clearTimeout(timer);reject(Error('Supervisor IPC unavailable; outcome unknown'));}
  });
 }
 return Object.freeze({execute:request=>call('execute',request),reconcile:request=>call('reconcile',request),close(){channel.off('message',listener);channel.off('disconnect',disconnected);disconnected();}});
}
