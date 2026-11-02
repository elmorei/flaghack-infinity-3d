'use strict';
const channel = process.env.FLAGHACK_CHANNEL || 'iteration';
if (!['stable', 'iteration'].includes(channel)) throw new Error('FLAGHACK_CHANNEL must be stable or iteration');
module.exports = {
  appId: 'com.flaghack.infinity', productName: 'FLAGHACK∞3D',
  directories: { output: 'desktop-release' },
  files: ['desktop/**/*', '!desktop/**/*.test.cjs', 'dist/**/*', 'package.json'],
  extraMetadata: { desktopChannel: channel },
  asar: true,
  npmRebuild: false,
  win: { icon: 'desktop/icon.ico', target: [{ target: 'nsis', arch: ['x64'] }], artifactName: 'Flaghack-${version}-win-${arch}.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, artifactName: 'Flaghack-Setup-${version}-${arch}.${ext}' },
  publish: [{ provider: 'generic', url: `https://github.com/elmorei/flaghack-infinity-3d/releases/download/desktop-${channel}/`, channel: channel === 'stable' ? 'latest' : 'iteration' }],
};
