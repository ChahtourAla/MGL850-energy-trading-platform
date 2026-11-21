// A PostgreSQL client is one session; concurrent transactions must not interleave.
const queues=new WeakMap();
export async function withClientLock(client,operation){
 const previous=queues.get(client)??Promise.resolve();let release;
 const current=new Promise(resolve=>{release=resolve;});queues.set(client,current);
 await previous;
 try{return await operation();}finally{release();if(queues.get(client)===current)queues.delete(client);}
}
