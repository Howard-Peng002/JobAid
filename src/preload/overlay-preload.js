'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const LISTEN = ['llm:start', 'llm:delta', 'llm:done', 'llm:error', 'listen:state', 'overlay:state', 'overlay:cfg', 'session:clear', 'overlay:wake', 'overlay:sleep'];

contextBridge.exposeInMainWorld('api', {
  on(channel, cb) {
    if (!LISTEN.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  regen: () => ipcRenderer.invoke('answer:regen'),
  resize: (height) => ipcRenderer.send('overlay:resize', height),
  setInteractive: (on) => ipcRenderer.send('overlay:interactive', !!on),
  resetPos: () => ipcRenderer.send('overlay:resetpos'),
  beginDrag: () => ipcRenderer.send('overlay:dragstart'),
  moveTo: (x, y) => ipcRenderer.send('overlay:moveto', { x, y }),
  endDrag: () => ipcRenderer.send('overlay:enddrag'),
  resizeTo: (edge, x, y, w, h) => ipcRenderer.send('overlay:resizeto', { edge, x, y, w, h }),
  endResize: () => ipcRenderer.send('overlay:endresize'),
  compact: () => ipcRenderer.send('overlay:compact'),
  maximize: () => ipcRenderer.send('overlay:maximize'),
  close: () => ipcRenderer.send('overlay:hide'),
});
