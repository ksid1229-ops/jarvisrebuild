/** Copies the manifest/icons check and reports the build contents. */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const required = ['manifest.json', 'background.js', 'content-d2l.js', 'content-gdocs.js', 'dashboard.html', 'sidepanel.html', 'icons/icon128.png'];
const missing = required.filter((f) => !existsSync(join(dist, f)));
if (missing.length) {
  console.error(`Build is missing required files: ${missing.join(', ')}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const version = readFileSync('VERSION', 'utf8').trim();
if (manifest.version !== version) {
  console.error(`manifest.json version ${manifest.version} does not match VERSION ${version}`);
  process.exit(1);
}

// MV3 content scripts cannot be ES modules. If Rollup ever splits shared code
// out of one, the import statement it emits would silently break the script.
for (const cs of ['content-d2l.js', 'content-gdocs.js']) {
  const code = readFileSync(join(dist, cs), 'utf8');
  if (/(^|[;\n])\s*import[\s{("']/.test(code) || /\bexport\s/.test(code)) {
    console.error(`${cs} contains ESM import/export syntax. MV3 content scripts must be self-contained.`);
    process.exit(1);
  }
}

let bytes = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else bytes += s.size;
  }
};
walk(dist);
console.log(`Build OK — v${manifest.version}, ${(bytes / 1024).toFixed(0)} KB unpacked.`);
