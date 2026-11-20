'use strict';
/**
 * 在桌面创建 JobAid 快捷方式（开发版启动方式）。
 * 运行：node_modules\electron\dist\electron.exe scripts\make-shortcut.js
 *
 * 用 Electron 自带的 shell.writeShortcutLink，避免 PowerShell COM 被安全策略拦。
 */
const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
  const ROOT = path.join(__dirname, '..');
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const icon = path.join(ROOT, 'build', 'icon.ico');
  const vbs = path.join(ROOT, 'JobAid.vbs');
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const desktop = app.getPath('desktop');
  const lnk = path.join(desktop, 'JobAid.lnk');

  if (!fs.existsSync(exe)) {
    console.error('[shortcut] 找不到 electron.exe:', exe);
    app.exit(1);
    return;
  }

  // 走 VBS 启动器：它会清掉 ELECTRON_RUN_AS_NODE 再拉主程序。
  // 直接指向 electron.exe 时，只要环境里带着这个变量，Electron 就退化成 Node，
  // 表现为"双击没反应"（实测报 app.isPackaged 为 undefined）。
  const useVbs = fs.existsSync(vbs) && fs.existsSync(wscript);

  const ok = shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
    target: useVbs ? wscript : exe,
    args: useVbs ? `"${vbs}"` : ROOT,
    cwd: ROOT,
    description: 'JobAid · 面试实时助理',
    icon: fs.existsSync(icon) ? icon : exe,
    iconIndex: 0,
  });

  console.log('[shortcut]', ok ? '已创建' : '创建失败', lnk, useVbs ? '(via wscript)' : '(direct)');
  app.exit(ok ? 0 : 1);
});
