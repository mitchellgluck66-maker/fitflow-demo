/**
 * npm run credentials:encrypt — seal every plaintext secret row in the
 * settings table with CREDENTIALS_KEY (AES-256-GCM). Idempotent; `npm run
 * db:migrate` runs the same step. Prints counts only, never values.
 */
import { encryptPlaintextSecrets } from '../lib/settings';
import { keyStatus, keyStatusMessage } from '../lib/crypto/credentials';

async function main() {
  const status = keyStatus();
  if (status.mode !== 'on') {
    console.error(`✗ ${keyStatusMessage(status)}`);
    process.exit(1);
  }
  const r = await encryptPlaintextSecrets();
  console.log(`✓ ${r.sealed} credential(s) encrypted; everything stored is now sealed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('✗ credentials:encrypt failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
