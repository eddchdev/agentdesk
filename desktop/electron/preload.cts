import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentdesk", {
  snapshot: () => ipcRenderer.invoke("agentdesk:snapshot"),
  sendMessage: (to: string | null, message: string, type?: string) =>
    ipcRenderer.invoke("agentdesk:sendMessage", to, message, type ?? "alerta"),
});

contextBridge.exposeInMainWorld("terminal", {
  create: (id: string, name: string, cwd?: string) => ipcRenderer.invoke('terminal:create', id, name, cwd),
  homedir: () => ipcRenderer.invoke('terminal:homedir'),
  pickDir: () => ipcRenderer.invoke('terminal:pickDir'),
  write: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
  resize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', id, cols, rows),
  kill: (id: string) => ipcRenderer.send('terminal:kill', id),
  onData: (cb: (id: string, data: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, data: string) => cb(id, data);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },
  onExit: (cb: (id: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string) => cb(id);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },
});
