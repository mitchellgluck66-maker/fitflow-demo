# FitFlow — database restore runbook

Backups come from `.github/workflows/backup.yml`: every night at 09:15 UTC a
GitHub Action `pg_dump`s the `public` and `drizzle` schemas of the production
Supabase database, encrypts the dump with AES-256 (OpenSSL, PBKDF2-SHA256,
200,000 iterations) using the `BACKUP_PASSPHRASE` repo secret, and keeps it as
a workflow artifact named `fitflow-db-<UTC timestamp>` for **90 days**.

You need:

- `gh` (GitHub CLI), logged in with access to the repo
- `openssl` (the macOS built-in works)
- PostgreSQL client tools **version 17** (`pg_restore`, `psql`) —
  macOS: `brew install postgresql@17` then
  `export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"`
- the backup passphrase (from the password manager — it is also the
  `BACKUP_PASSPHRASE` repo secret, but GitHub will not show it back)
- for a production restore: the Supabase **session-pooler** connection string

Commands below assume the repo root as the working directory and bash/zsh.

---

## 1. Pick and download a backup

```bash
# Recent backup runs (newest first) — note the run id
gh run list --workflow backup.yml --limit 10

# Artifacts in a run (one per night: fitflow-db-2026-09-30T0915Z …)
gh run view <run-id>

mkdir -p ~/fitflow-restore && cd ~/fitflow-restore
gh run download <run-id> --repo mitchellgluck66-maker/fitflow-demo --dir .
ls -R
```

Run a backup on demand (e.g. right before a risky migration):

```bash
gh workflow run backup.yml && sleep 5 && gh run watch "$(gh run list --workflow backup.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

## 2. Verify and decrypt

```bash
cd ~/fitflow-restore/fitflow-db-<stamp>
shasum -a 256 -c fitflow-db-<stamp>.dump.enc.sha256     # must print: OK

read -rs BACKUP_PASSPHRASE && export BACKUP_PASSPHRASE    # paste, Enter (not echoed)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
  -pass env:BACKUP_PASSPHRASE \
  -in fitflow-db-<stamp>.dump.enc -out fitflow-db.dump
unset BACKUP_PASSPHRASE

pg_restore --list fitflow-db.dump | grep 'TABLE DATA'     # payments, contacts, settings, fx_rates …
```

"bad decrypt" = wrong passphrase. A checksum mismatch = corrupted download; fetch it again.

## 3. Rehearse on a scratch database first (always)

```bash
# Local Postgres 17 (brew services start postgresql@17)
createdb fitflow_restore_test
pg_restore --no-owner --no-privileges --exit-on-error \
  -d postgresql://localhost/fitflow_restore_test fitflow-db.dump

psql postgresql://localhost/fitflow_restore_test -c "
  select 'payments' t, count(*) from payments union all
  select 'contacts', count(*) from contacts union all
  select 'ad_spend', count(*) from ad_spend union all
  select 'fx_rates', count(*) from fx_rates;"
psql postgresql://localhost/fitflow_restore_test -c "select max(paid_at) from payments;"   # how fresh is it?
```

Point a local app at it to look around — `DATABASE_URL=postgresql://localhost/fitflow_restore_test CREDENTIALS_KEY=<prod key> npm run dev` — then `dropdb fitflow_restore_test` when done.

## 4. Restore production

**This overwrites live data. Take a fresh backup first (section 1, on-demand
run) so the restore itself can be undone.** Pause the crons while restoring:
Vercel → Settings → Cron Jobs → disable, or just avoid the 12:00/13:00 UTC runs.

### Option A (preferred): restore into a NEW Supabase project, then switch

1. Create a new Supabase project (same region), copy its **session-pooler** URL.
2. ```bash
   export TARGET_URL='postgresql://postgres.<new-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres'
   pg_restore --no-owner --no-privileges --exit-on-error --single-transaction \
     -d "$TARGET_URL" fitflow-db.dump
   DATABASE_URL="$TARGET_URL" npm run db:migrate    # applies any migration newer than the backup
   ```
3. Check counts as in section 3, and that RLS survived:
   ```bash
   psql "$TARGET_URL" -c "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;"   # must return 0 rows
   ```
4. Vercel → Settings → Environment Variables → `DATABASE_URL` = the new URL (and
   the `DATABASE_URL` repo secret for backups), redeploy. Keep the old project
   until you are satisfied.

### Option B: restore in place over the existing project

```bash
export TARGET_URL='<production session-pooler URL>'
pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction \
  -d "$TARGET_URL" fitflow-db.dump
DATABASE_URL="$TARGET_URL" npm run db:migrate
```

`--single-transaction` means it either fully restores or changes nothing.

### Restore one table only (e.g. a bad script emptied `payments`)

```bash
pg_restore --data-only --no-owner --no-privileges --single-transaction \
  -t payments -d "$TARGET_URL" fitflow-db.dump
```

Empty the table first (`psql "$TARGET_URL" -c 'truncate payments cascade'` — mind the
cascade) or the unique `stripe_id` index will reject the rows. Most rows can
also simply be re-synced: `npm run backfill`, `npm run sync:stripe`,
`npm run sync:meta` rebuild everything that came from GHL / Stripe / Meta.
What a re-sync CANNOT rebuild — restore it from the backup: manual stage role
mappings, manual payment matches, attribution overrides, manual weekly spend,
FX rates, digest history, AI reports, settings.

## 5. After any restore

- **Credentials**: stored keys are encrypted with `CREDENTIALS_KEY`. The app
  must run with the SAME key that was set when the backup was taken. If that
  key is lost, re-enter every credential in Setup (and rotate them).
- Open Setup → Sync health, click Sync now, and confirm GHL / Meta / Stripe
  all complete; the stale banner clears within a run.
- Check the Revenue tab footer shows the expected FX rate (Setup → Currency).
- Re-enable crons if you paused them.
- `rm -rf ~/fitflow-restore` — the decrypted dump holds client PII.

## Notes

- The dump is logical (`pg_dump`), so it restores into any Postgres ≥ 15 with
  client tools 17. It covers the `public` schema (every FitFlow table, with
  its row-level-security flag) and `drizzle` (applied-migrations journal).
  Supabase-managed schemas (auth, storage) are not used by FitFlow and are
  not included.
- Artifacts older than 90 days are deleted by GitHub. If the repo's artifact
  retention limit is lower than 90 days (Settings → Actions → General), the
  lower limit wins — check it once.
- A failed backup run emails the repo owner (GitHub's default for failed
  scheduled workflows). Missing secrets fail the first step with a clear error.
