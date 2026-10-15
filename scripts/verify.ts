/**
 * `npm run verify` — the acceptance harness CLI (lib/verify/harness.ts#runVerify). READ-ONLY.
 *
 *   npx tsx scripts/verify.ts            # engine vs independent SQL + sources + health → docs/verification-<date>.md
 *   npx tsx scripts/verify.ts engine     # engine vs SQL only
 *   npx tsx scripts/verify.ts sources    # provider comparisons + health only
 *
 * Exit 0 = no FAIL (PENDING and INFO do not fail), 1 = a FAIL, 2 = refused to run (business timezone).
 */
import { runVerify, VerifyRefused } from '../lib/verify/harness';

async function main() {
  const what = process.argv[2] ?? 'all';
  if (what !== 'all' && what !== 'engine' && what !== 'sources') {
    console.error(`unknown mode "${what}" — use all | engine | sources`);
    process.exit(2);
  }
  try {
    const r = await runVerify({ mode: what });
    process.exit(r.failN === 0 ? 0 : 1);
  } catch (e) {
    if (e instanceof VerifyRefused) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
main();
