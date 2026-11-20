'use strict';
/**
 * 启动器
 * ------------------------------------------------------------
 * 某些环境会带上 ELECTRON_RUN_AS_NODE=1，这会让 Electron 退化成
 * 纯 Node 进程（窗口起不来）。这里显式清掉它再启动真正的 Electron。
 */
const { spawn } = require('child_process');
const path = require('path');

// 在普通 node 进程中 require('electron') 返回的是可执行文件路径
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [path.join(__dirname)];
if (process.argv.includes('--dev')) args.push('--dev');

const child = spawn(electronBin, args, {
  stdio: 'inherit',
  env,
  windowsHide: false,
  cwd: __dirname,
});

child.on('close', (code) => process.exit(code === null ? 0 : code));
child.on('error', (err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});
