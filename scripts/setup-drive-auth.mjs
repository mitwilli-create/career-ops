#!/usr/bin/env node
// scripts/setup-drive-auth.mjs — one-time interactive OAuth setup for the
// Drive integration shipped in lib/drive-sync.mjs (Cluster E3, 2026-05-21).
//
// Walks you through:
//   1. Verifying GOOGLE_DRIVE_CLIENT_ID + GOOGLE_DRIVE_CLIENT_SECRET are
//      in .env (from a Google Cloud OAuth client you created).
//   2. Generating an OAuth consent URL with the right scopes.
//   3. Opening that URL in your default browser.
//   4. Prompting you to paste the authorization code from the redirect.
//   5. Exchanging the code for a refresh token.
//   6. Writing GOOGLE_DRIVE_REFRESH_TOKEN + DRIVE_SYNC_ENABLED=true to .env.
//
// One-shot. After this completes, every lib/drive-sync.mjs call works
// transparently from any agent / script / launchd job.
//
// Prerequisite: create an OAuth 2.0 Client ID in Google Cloud Console with
// these scopes enabled (Drive API → drive.file is the narrowest that
// works for our pattern). Use "Desktop app" application type. Copy the
// client ID + client secret into .env as GOOGLE_DRIVE_CLIENT_ID and
// GOOGLE_DRIVE_CLIENT_SECRET. Then run this script.
//
// Usage:
//   node scripts/setup-drive-auth.mjs

import dotenv from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');
dotenv.config({ path: ENV_PATH, override: true });

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',  // narrowest — only files we create/open
];

function fail(msg) { console.error('\n❌', msg); process.exit(1); }

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Drive OAuth setup — career-ops Cluster E3 (2026-05-21)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Step 1: validate env
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    fail(`Missing GOOGLE_DRIVE_CLIENT_ID or GOOGLE_DRIVE_CLIENT_SECRET in .env.

   Steps to get them:
     1. Go to console.cloud.google.com → APIs & Services → Credentials
     2. Create OAuth client ID → Application type: Desktop app
     3. Enable Google Drive API (APIs & Services → Library → Drive API)
     4. Copy the client ID + client secret into .env:
          GOOGLE_DRIVE_CLIENT_ID=...
          GOOGLE_DRIVE_CLIENT_SECRET=...
     5. Re-run this script.`);
  }

  // Step 2: build OAuth client + consent URL
  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'urn:ietf:wg:oauth:2.0:oob'
  );

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',     // required for refresh_token
    prompt: 'consent',          // force re-consent so we always get a refresh_token
    scope: SCOPES,
  });

  console.log('1. Opening the OAuth consent URL in your browser...\n');
  console.log(`   ${authUrl}\n`);
  try { execSync(`open "${authUrl}"`, { stdio: 'ignore' }); } catch { /* manual fallback */ }

  console.log('2. After approving, Google will show you an authorization code.');
  console.log('   Copy that code (it looks like "4/0AeaY..." — long string).\n');

  // Step 3: prompt for the code
  const rl = createInterface({ input, output });
  const code = (await rl.question('   Paste the authorization code here: ')).trim();
  rl.close();
  if (!code || code.length < 20) fail(`Authorization code looks too short: "${code}"`);

  // Step 4: exchange code → tokens
  console.log('\n3. Exchanging code for refresh token...');
  let tokens;
  try {
    const r = await oauth2.getToken(code);
    tokens = r.tokens;
  } catch (e) {
    fail(`Token exchange failed: ${e.message}\n   The code may have expired (they're single-use, 10-min TTL). Re-run the script.`);
  }

  if (!tokens.refresh_token) {
    fail(`No refresh_token in the response. This usually means you've previously
   approved this OAuth client and Google reused a cached grant. To force a
   fresh refresh_token, revoke the app at:
     myaccount.google.com → Security → Third-party apps with account access
   then re-run this script.`);
  }

  // Step 5: write to .env
  console.log('4. Writing GOOGLE_DRIVE_REFRESH_TOKEN + DRIVE_SYNC_ENABLED=true to .env...');
  const envText = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
  const envLines = envText.split('\n');
  const upserted = new Set();
  const ensureLine = (key, value) => {
    const idx = envLines.findIndex(l => l.startsWith(`${key}=`));
    if (idx >= 0) { envLines[idx] = `${key}=${value}`; }
    else { envLines.push(`${key}=${value}`); }
    upserted.add(key);
  };
  ensureLine('GOOGLE_DRIVE_REFRESH_TOKEN', tokens.refresh_token);
  ensureLine('DRIVE_SYNC_ENABLED', 'true');
  writeFileSync(ENV_PATH, envLines.join('\n'));

  // Step 6: smoke test
  console.log('5. Smoke-testing the connection (listing 1 file from your Drive)...');
  try {
    const drive = google.drive({ version: 'v3', auth: oauth2 });
    const r = await drive.files.list({ pageSize: 1, fields: 'files(id, name)' });
    console.log(`   ✓ Drive API reachable. Saw ${r.data.files?.length || 0} file(s).`);
  } catch (e) {
    console.error(`   ⚠ Smoke test failed: ${e.message}`);
    console.error(`   The refresh token is saved, but the test query failed.`);
    console.error(`   Try restarting any process that has .env cached.`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Drive OAuth setup complete. lib/drive-sync.mjs is now active.');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('Next: the next polish run will push polished artifacts to');
  console.log('Drive:/career-ops/<slug>/polished/<ts>/ automatically, and CREATE');
  console.log('runs will push originals to /career-ops/<slug>/originals/.');
}

main().catch(err => {
  console.error('\n❌ setup-drive-auth.mjs FAILED:', err.message);
  process.exit(1);
});
