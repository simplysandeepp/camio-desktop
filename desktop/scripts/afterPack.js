const fs = require('fs');
const path = require('path');

// electron-builder's default file matcher hard-excludes **/node_modules/**
// (even inside extraResources), so the submodule's production node_modules
// has to be copied in manually after packaging.
exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const resourcesDir =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');

  const src = path.resolve(__dirname, '..', '..', 'app', 'node_modules');
  const dest = path.join(resourcesDir, 'app', 'node_modules');

  if (!fs.existsSync(src)) {
    throw new Error(`[afterPack] source node_modules not found: ${src}`);
  }

  console.log(`[afterPack] copying node_modules -> ${dest}`);
  fs.cpSync(src, dest, { recursive: true, dereference: true });
};
