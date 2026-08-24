/**
 * migrate-v2: service switchover prompts.
 *
 * Writes a single word to the output file:
 *   --offer-switch   → "switch" | "skip"
 *   --keep-or-revert → "keep" | "revert"
 *
 * Clack renders to the terminal normally.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/switchover-prompt.ts --offer-switch <output-file>
 */
import fs from 'fs';

import * as p from '@clack/prompts';

async function main(): Promise<void> {
  const mode = process.argv[2];
  const outFile = process.argv[3];

  if (!outFile) {
    console.error('Usage: tsx setup/migrate-v2/switchover-prompt.ts <--offer-switch|--keep-or-revert> <output-file>');
    process.exit(1);
  }

  if (mode === '--offer-switch') {
    const answer = await p.select({
      message: 'Want to stop the v1 service and start v2 so you can test?',
      options: [
        { value: 'switch', label: 'Yes, switch to v2 now', hint: 'you can switch back after' },
        { value: 'skip', label: 'No, skip for now', hint: 'start v2 manually later' },
      ],
    });
    fs.writeFileSync(outFile, p.isCancel(answer) ? 'skip' : String(answer));
    return;
  }

  if (mode === '--keep-or-revert') {
    const answer = await p.select({
      message: 'Keep v2 running, or switch back to v1?',
      options: [
        { value: 'keep', label: 'Keep v2', hint: 'v1 stays stopped' },
        { value: 'revert', label: 'Switch back to v1', hint: 'stop v2, restart v1' },
      ],
    });
    fs.writeFileSync(outFile, p.isCancel(answer) ? 'revert' : String(answer));
    return;
  }

  console.error('Usage: --offer-switch | --keep-or-revert');
  process.exit(1);
}

main();
