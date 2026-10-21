import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';

const build = process.env.FLAGHACK_BUILD_ID ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(build)) throw new Error('FLAGHACK_BUILD_ID must be the full source commit SHA');

export default defineConfig({
  define: { __FLAGHACK_BUILD_ID__: JSON.stringify(build) },
  // Trusted host runtime is built from this source revision, never from launcher downloads.
  ssr: { noExternal: ['ws'] },
  build: {
    ssr: 'server/host-api.ts',
    target: 'node22',
    outDir: 'dist-host',
    sourcemap: true,
    copyPublicDir: false,
  },
});
