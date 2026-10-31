// Writes the tauri-plugin-updater manifest (latest.json) for the NSIS installer
// that `pnpm tauri build` produced. Usage:
//   node desktop/scripts/latest-json.mjs <base-url> [notes] [--config <file|json>]...   > latest.json
// <base-url> is where the installer will be served, e.g.
//   https://api.discgo.awpsoft.com.br/releases
// --config takes the same overlays given to `tauri build --config` (a JSON file or a JSON
// string, merged in order over tauri.conf.json), so the product name and version match the
// build, e.g. the "DiscGo Dev" app (PLAN fase 10.6).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const overlays = [];
for (let i = args.indexOf('--config'); i !== -1; i = args.indexOf('--config')) {
  if (i + 1 >= args.length) throw new Error('--config needs a value');
  overlays.push(args.splice(i, 2)[1]);
}
const [base, notes = ''] = args;
if (!base) throw new Error('usage: latest-json.mjs <base-url> [notes] [--config <file|json>]...');

const read = (v) => JSON.parse(v.trimStart().startsWith('{') ? v : fs.readFileSync(v, 'utf8'));
// The keys used here are top-level strings, so a shallow merge equals Tauri's JSON merge.
const conf = overlays.reduce(
  (c, v) => ({ ...c, ...read(v) }),
  read(path.join(here, '../src-tauri/tauri.conf.json')),
);
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
