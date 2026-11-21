/** A timeout never proves non-submission; callers must retain the operation as unresolved. */
export async function withLocalTimeout(operation,milliseconds=15000){
 if(!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>60000)throw Error('Invalid local timeout');
 let timer;
 try{return await Promise.race([Promise.resolve(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Local operation timed out; outcome uncertain')),milliseconds);})]);}
 finally{clearTimeout(timer);}
}
