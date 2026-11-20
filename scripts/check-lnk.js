'use strict';
const { app, shell } = require('electron');
const path = require('path');
app.whenReady().then(() => {
  const lnk = path.join(app.getPath('desktop'), 'JobAid.lnk');
  try {
    console.log('[lnk]', JSON.stringify(shell.readShortcutLink(lnk), null, 1));
  } catch (e) {
    console.log('[lnk] 读取失败', e.message);
  }
  app.exit(0);
});
