const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// The bootstrapper: checks if a patched core.js exists in userData.
// If it does, we run the patched version. Otherwise, we run the original bundled core.js.

const userDataPath = app.getPath('userData');
const patchDir = path.join(userDataPath, 'patch');
const patchedCorePath = path.join(patchDir, 'core.js');

try {
  if (fs.existsSync(patchedCorePath)) {
    console.log('[BOOTSTRAP] Loading patched core.js from:', patchedCorePath);
    global.IS_HOT_PATCH = true;
    global.PATCH_DIR = patchDir;
    require(patchedCorePath);
  } else {
    console.log('[BOOTSTRAP] Loading original bundled core.js');
    global.IS_HOT_PATCH = false;
    global.PATCH_DIR = patchDir;
    require('./core.js');
  }
} catch (err) {
  console.error('[BOOTSTRAP] Error loading patch, falling back to original core.js', err);
  global.IS_HOT_PATCH = false;
  require('./core.js');
}
