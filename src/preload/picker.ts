import { contextBridge, ipcRenderer } from "electron";

const INIT_CHANNEL = "sharkord-picker:init";
const SUBMIT_CHANNEL = "sharkord-picker:submit";
const CANCEL_CHANNEL = "sharkord-picker:cancel";

interface PickerInitPayload {
  sources: Array<{ id: string; name: string }>;
}

interface PickerSubmitPayload {
  sourceId: string;
}

contextBridge.exposeInMainWorld("sharkordPicker", {
  onInit: (callback: (payload: PickerInitPayload) => void) => {
    ipcRenderer.on(INIT_CHANNEL, (_event, payload: PickerInitPayload) => callback(payload));
  },
  submit: (payload: PickerSubmitPayload) => {
    ipcRenderer.send(SUBMIT_CHANNEL, payload);
  },
  cancel: () => {
    ipcRenderer.send(CANCEL_CHANNEL);
  }
});
