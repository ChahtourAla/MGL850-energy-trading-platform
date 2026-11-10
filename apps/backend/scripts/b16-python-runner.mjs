/** B16 Python data-generator subprocess integration. No chain keys, RPC, or DB writes. */
import { existsSync } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';

/** B16_PYTHON is an executable/path (not a shell command with arguments).
 * Prefer this repo's previously configured virtual environment when present. */
export function selectB16Python(root, env=process.env, platform=process.platform, exists=existsSync) {
  const requested=env.B16_PYTHON?.trim();
  if(requested){
    const unquoted=requested.startsWith('"')&&requested.endsWith('"')?requested.slice(1,-1):requested;
    if(!unquoted || /[\r\n]/.test(unquoted))throw new Error('Invalid B16_PYTHON executable; set a Python executable path only');
    return unquoted;
  }
  const suffix=platform==='win32'?['Scripts','python.exe']:['bin','python'];
  for(const base of [join(root,'.venv'),join(root,'services','data-generator','.venv')]){
    const candidate=join(base,...suffix);
    if(exists(candidate))return candidate;
  }
  return 'python';
}

/** Make local shared Pydantic models available without requiring editable pip installs.
 * Preserve any existing user-provided import path, including on Windows. */
export function b16PythonEnv(root, env=process.env, separator=delimiter) {
  const result={...env};
  let prior='';
  for(const key of Object.keys(result)){
    if(key.toUpperCase()==='PYTHONPATH'){
      prior=prior||String(result[key]??'');
      delete result[key];
    }
  }
  result.PYTHONPATH=[join(root,'packages','shared','python'),join(root,'services','data-generator'),prior].filter(Boolean).join(separator);
  return result;
}

function scrub(input){
  return String(input??'')
   .replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/ig,'[REDACTED_URL]')
   .replace(/(?:PRIVATE_KEY|PASSWORD|DATABASE_URL|ACCESS_TOKEN)\s*[:=]\s*[^\s]+/ig,'[REDACTED_SECRET]')
   .replace(/\b(?:0x)?[0-9a-f]{64,}\b/ig,'[REDACTED_HEX]')
   .trim().slice(-900);
}

/** Print only a short scrubbed diagnostic, never subprocess env or evidence input. */
export function b16PythonFailure(result,interpreter){
  const status=result?.status===null?'unknown':String(result?.status??'unknown');
  const reason=scrub(result?.stderr)||scrub(result?.error?.message)||scrub(result?.stdout)||'No stderr available';
  return `Python delivery simulator failed (exit=${status}; interpreter=${interpreter}): ${reason}. Set B16_PYTHON to your installed project Python or install pydantic>=2.12 in that environment. No settlement evidence written.`;
}
