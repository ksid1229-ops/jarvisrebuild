/**
 * Packs dist/ into release/school-helper-<version>.zip and writes a
 * release-notes file carrying the source commit, date and checksum.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const version = readFileSync('VERSION', 'utf8').trim();
if (!existsSync('dist/manifest.json')) {
  console.error('No dist/ build found. Run `npm run build` first.');
  process.exit(1);
}

mkdirSync('release', { recursive: true });
const zipName = `school-helper-${version}.zip`;
const zipPath = join('release', zipName);

execSync(`cd dist && zip -qr ../${zipPath} . -x '*.map'`, { stdio: 'inherit' });

const bytes = readFileSync(zipPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');

let commit = 'uncommitted';
try {
  commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
} catch {}

const date = new Date().toISOString();
const notes = `# School Helper v${version}

- **Artifact:** \`${zipName}\`
- **Source commit:** \`${commit}\`
- **Built:** ${date}
- **SHA-256:** \`${sha256}\`
- **Size:** ${(bytes.length / 1024).toFixed(0)} KB

## Install (Chrome or Opera GX)
1. Unzip \`${zipName}\`.
2. Open \`chrome://extensions\` (Chrome) or \`opera://extensions\` (Opera GX).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped folder.

Verify the download before installing:
\`\`\`
certutil -hashfile ${zipName} SHA256
\`\`\`
`;

writeFileSync(join('release', `RELEASE-NOTES-${version}.md`), notes);
writeFileSync(join('release', `${zipName}.sha256`), `${sha256}  ${zipName}\n`);
console.log(`Packed ${zipPath}\nsha256 ${sha256}\ncommit ${commit}`);
