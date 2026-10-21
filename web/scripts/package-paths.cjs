'use strict';
// @electron/asar lists with node:path.join, so separators follow the build OS.
function normalizeArchivePaths(paths) { return paths.map(path => path.replace(/\\/g, '/')); }
module.exports = { normalizeArchivePaths };
