const { contextBridge, ipcRenderer } = require("electron");

// 렌더러 프로세스에 안전한 API만 노출한다.
contextBridge.exposeInMainWorld("api", {
  removeBackground: (dataUrl) => ipcRenderer.invoke("remove-background", dataUrl),
  listItems: () => ipcRenderer.invoke("list-items"),
  addItem: (kind, dataUrl) => ipcRenderer.invoke("add-item", { kind, dataUrl }),
  deleteItem: (id) => ipcRenderer.invoke("delete-item", id),
  listLooks: () => ipcRenderer.invoke("list-looks"),
  saveLook: (look) => ipcRenderer.invoke("save-look", look),
  deleteLook: (id) => ipcRenderer.invoke("delete-look", id),
});
