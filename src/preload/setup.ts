import { contextBridge, ipcRenderer } from "electron";

const SETUP_LOAD_CHANNEL = "sharkord-setup:load";
const SETUP_SAVE_CHANNEL = "sharkord-setup:save";

export interface SetupConfig {
  serverUrl: string;
  hotkeyToggleMute: string;
  basicAuth: {
    enabled: boolean;
    username: string;
    password: string;
  };
}

contextBridge.exposeInMainWorld("sharkordSetup", {
  loadConfig: (): Promise<SetupConfig> => {
    return ipcRenderer.invoke(SETUP_LOAD_CHANNEL) as Promise<SetupConfig>;
  },
  saveConfig: (config: SetupConfig): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(SETUP_SAVE_CHANNEL, config) as Promise<{ success: boolean; error?: string }>;
  }
});
