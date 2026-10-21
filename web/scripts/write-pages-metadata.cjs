'use strict';
const { execFileSync } = require('node:child_process');
const { writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const build = process.env.FLAGHACK_BUILD_ID || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(build)) throw new Error('Pages metadata needs the exact source SHA');
const dir = join(__dirname, '..', 'dist');
writeFileSync(join(dir, '.nojekyll'), '');
writeFileSync(join(dir, 'build.json'), JSON.stringify({ build, hostDownload: `https://github.com/elmorei/flaghack-infinity-3d/releases/download/host-${build}/Flaghack-Host-Windows-x64.exe` }) + '\n');

let licenses = `FLAGHACK browser game\nSource: https://github.com/elmorei/flaghack-infinity-3d\nCommit: ${build}\n\nThird-party runtime assets and notices:\n`;
for (const name of ['three', '@fontsource/bungee', '@fontsource/cinzel', '@fontsource/cinzel-decorative', '@fontsource/rubik', '@fontsource/stardos-stencil']) {
  licenses += `\n--- ${name} ---\n` + readFileSync(join(__dirname, '..', 'node_modules', name, 'LICENSE'), 'utf8');
}
writeFileSync(join(dir, 'LICENSES.txt'), licenses);
