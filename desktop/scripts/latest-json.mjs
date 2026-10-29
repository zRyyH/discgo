// Writes the tauri-plugin-updater manifest (latest.json) for the NSIS installer
// that `pnpm tauri build` produced. Usage:
//   node desktop/scripts/latest-json.mjs <base-url> [notes]   > latest.json
// <base-url> is where the installer will be uploaded, e.g.
//   https://discgo-releases.s3.sa-east-1.amazonaws.com/releases
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [base, notes = ''] = process.argv.slice(2);
if (!base) throw new Error('usage: latest-json.mjs <base-url> [notes]');

const conf = JSON.parse(fs.readFileSync(path.join(here, '../src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version;
const installer = `${conf.productName}_${version}_x64-setup.exe`;
const sigPath = path.join(here, '../../target/release/bundle/nsis', installer + '.sig');
const signature = fs.readFileSync(sigPath, 'utf8').trim();

process.stdout.write(
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: { 'windows-x86_64': { signature, url: `${base.replace(/\/$/, '')}/${encodeURIComponent(installer)}` } },
    },
    null,
    2,
  ) + '\n',
);
