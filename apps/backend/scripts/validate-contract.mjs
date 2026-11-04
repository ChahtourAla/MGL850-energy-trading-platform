/**
 * Usage from repository root (after `pnpm --filter ... build`):
 * node apps/backend/scripts/validate-contract.mjs energy-snapshot path/to/snapshot.json
 * node apps/backend/scripts/validate-contract.mjs matching-output path/to/output.json path/to/input.json
 */
import { ContractValidator, assertMatchingOutputAgainstInput } from '../dist/contracts/contract-validator.js';

const [kind, payloadPath, matchingInputPath] = process.argv.slice(2);
if (!kind || !payloadPath) {
  console.error('Usage: node apps/backend/scripts/validate-contract.mjs <contract-kind> <json-file> [original-matching-input.json]');
  process.exitCode = 2;
} else {
  try {
    const validator = new ContractValidator();
    const result = await validator.readFile(kind, payloadPath);
    if (matchingInputPath) {
      if (kind !== 'matching-output') {
        throw new Error('The optional input file is only supported for matching-output');
      }
      const input = await validator.readFile('matching-input', matchingInputPath);
      assertMatchingOutputAgainstInput(validator, result, input);
    }
    console.log(`B05 PASS: ${kind} is valid${matchingInputPath ? ' against matching input' : ''}`);
  } catch (error) {
    console.error(`B05 FAIL: ${error instanceof Error ? error.message : 'validation failed'}`);
    process.exitCode = 1;
  }
}
