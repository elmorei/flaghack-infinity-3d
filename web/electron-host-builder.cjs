'use strict';
const productName = 'FLAGHACK∞3D Match Host';
module.exports = {
  appId: 'com.flaghack.infinity.matchhost',
  productName,
  directories: { output: 'host-release' },
  files: ['host-desktop/**/*', '!host-desktop/**/*.test.cjs', '!host-desktop/vendor/**/*', '!host-desktop/download-cloudflared.cjs', 'dist-host/**/*', 'desktop/icon.ico', 'desktop/icon.png', 'package.json'],
  extraResources: [{ from: 'host-desktop/vendor', to: 'vendor', filter: ['**/*'] }],
  extraMetadata: { main: 'host-desktop/main.cjs' },
  asar: true,
  npmRebuild: false,
  win: { executableName: productName, icon: 'desktop/icon.ico', target: [{ target: 'portable', arch: ['x64'] }], artifactName: 'Flaghack-Host-Windows-x64.${ext}' },
  portable: { artifactName: 'Flaghack-Host-Windows-x64.${ext}', requestExecutionLevel: 'user' },
  publish: null,
};
