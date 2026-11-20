/** Developer-only offline proposal, deliberately has no database execution option. */
import {readFile} from 'node:fs/promises';
import {runHourlyDryRun} from './b22-hourly-core.mjs';
async function main(args) {
  const options={};
  for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--snapshot','--registry','--config','--expected-users','--python'].includes(key)||options[key]!==undefined||!args[i+1])throw Error('Unknown, duplicate or incomplete option');options[key]=args[i+1];}
  for(const key of ['--snapshot','--registry','--config','--expected-users'])if(!options[key])throw Error(`Missing ${key}`);
  if(!/^[1-9][0-9]*$/.test(options['--expected-users'])||!Number.isSafeInteger(Number(options['--expected-users'])))throw Error('Invalid expected user count');
  const [snapshot,registry,config]=await Promise.all(['--snapshot','--registry','--config'].map(async k=>JSON.parse(await readFile(options[k],'utf8'))));
  const result=await runHourlyDryRun(snapshot,registry,config,{sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:Number(options['--expected-users']),python:options['--python']});
  console.log(JSON.stringify(result,null,2));
}
main(process.argv.slice(2)).catch(error=>{console.error(`B22 dry run failed: ${error.message}`);process.exitCode=1;});
