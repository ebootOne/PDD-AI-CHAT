'use strict';

/**
 * preload-app.js —— 渲染进程与主进程之间的桥
 * 只暴露明确的能力，不透传 ipcRenderer。
 */

const { contextBridge, ipcRenderer } = require('electron');

const listeners = {
  'store:active': new Set(),
  'cs:changed': new Set(),
  'cs:log': new Set(),
  'sync:status': new Set(),
  'sync:stale': new Set(),
  'stores:changed': new Set(),
  'auth:expired': new Set(),
};

for (const ch of Object.keys(listeners)) {
  ipcRenderer.on(ch, (_e, data) => {
    for (const cb of listeners[ch]) {
      try {
        cb(data);
      } catch (_) {}
    }
  });
}

contextBridge.exposeInMainWorld('bridge', {
  stores: {
    list: () => ipcRenderer.invoke('stores:list'),
    add: (payload) => ipcRenderer.invoke('stores:add', payload),
    remove: (id) => ipcRenderer.invoke('stores:remove', id),
    switch: (id) => ipcRenderer.invoke('stores:switch', id),
  },
  view: {
    setBounds: (rect) => ipcRenderer.invoke('view:bounds', rect),
    setVisible: (v) => ipcRenderer.invoke('view:visible', v),
  },
  page: {
    capture: () => ipcRenderer.invoke('cs:capture'),
    fill: (text) => ipcRenderer.invoke('cs:fill', text),
    send: () => ipcRenderer.invoke('cs:send'),
    clear: () => ipcRenderer.invoke('cs:clear'),
    sendProduct: (goodsId) => ipcRenderer.invoke('cs:sendProduct', goodsId),
  },
  api: (path, method = 'GET', body) => ipcRenderer.invoke('api:request', { path, method, body }),
  auth: {
    relogin: () => ipcRenderer.invoke('auth:relogin'),
  },
  power: {
    setKeepAwake: (on) => ipcRenderer.invoke('power:keepAwake', on),
    state: () => ipcRenderer.invoke('power:state'),
  },
  sync: {
    run: () => ipcRenderer.invoke('sync:run'),
    status: () => ipcRenderer.invoke('sync:status'),
  },
  win: {
    min: () => ipcRenderer.invoke('win:min'),
    max: () => ipcRenderer.invoke('win:max'),
    close: () => ipcRenderer.invoke('win:close'),
  },
  on: (channel, cb) => {
    if (listeners[channel]) listeners[channel].add(cb);
  },
});
