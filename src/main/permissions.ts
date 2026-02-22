import { BrowserWindow, desktopCapturer, ipcMain, type Session } from "electron";
import path from "node:path";
import type { DesktopConfig } from "../config/config";

const PICKER_SUBMIT_CHANNEL = "sharkord-picker:submit";
const PICKER_CANCEL_CHANNEL = "sharkord-picker:cancel";

function isAllowedRequestUrl(requestUrl: string | undefined, serverUrl: string): boolean {
  if (!requestUrl) {
    return false;
  }

  try {
    const request = new URL(requestUrl);
    const server = new URL(serverUrl);
    return request.origin === server.origin;
  } catch {
    return false;
  }
}

function applyPermissionHandlers(session: Session, config: DesktopConfig): void {
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (permission === "media") {
      return isAllowedRequestUrl(requestingOrigin, config.serverUrl);
    }

    return false;
  });

  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const allowed =
      (permission === "media" || permission === "display-capture") &&
      isAllowedRequestUrl(details.requestingUrl, config.serverUrl);

    if (!allowed) {
      console.warn(`[permission] denied permission=${permission} url=${details.requestingUrl}`);
      callback(false);
      return;
    }

    console.log(`[permission] granted permission=${permission} url=${details.requestingUrl}`);
    callback(true);
  });
}

function applyDisplayMediaHandler(window: BrowserWindow, session: Session, config: DesktopConfig): void {
  session.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const requestUrl = request.frame?.url;
      if (!isAllowedRequestUrl(requestUrl, config.serverUrl)) {
        console.warn(`[screen-share] denied request from url=${requestUrl ?? "unknown"}`);
        callback({});
        return;
      }

      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 320, height: 180 }
        });

        if (sources.length === 0) {
          console.warn("[screen-share] no capture sources available");
          callback({});
          return;
        }

        const selected = await showSourcePicker({
          sources: sources.map((source) => ({ id: source.id, name: source.name })),
          config
        });

        if (!selected) {
          console.log("[screen-share] user cancelled picker");
          callback({});
          return;
        }

        const selectedSource = sources.find((source) => source.id === selected.sourceId);
        if (!selectedSource) {
          console.warn(`[screen-share] selected source not found id=${selected.sourceId}`);
          callback({});
          return;
        }

        const streams: { video: typeof selectedSource; audio?: "loopback" } = { video: selectedSource };
        if (request.audioRequested && config.screenShareSystemAudio) {
          streams.audio = "loopback";
          console.log("[screen-share] system audio (loopback) requested via config");
        }
        callback(streams);
      } catch (error) {
        console.error(`[screen-share] failed to enumerate sources: ${String(error)}`);
        callback({});
      }
    },
    {
      useSystemPicker: true
    }
  );
}

interface PickerSource {
  id: string;
  name: string;
}

interface PickerPayload {
  sources: PickerSource[];
  config: DesktopConfig;
}

interface PickerSelection {
  sourceId: string;
}

function showSourcePicker(payload: PickerPayload): Promise<PickerSelection | null> {
  return new Promise((resolve) => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const pickerWindow = new BrowserWindow({
      width: 560,
      height: 620,
      title: "Bildschirmübertragung",
      resizable: false,
      minimizable: false,
      maximizable: false,
      modal: parent !== null,
      parent: parent ?? undefined,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/picker.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });

    const cleanup = () => {
      ipcMain.removeListener(PICKER_SUBMIT_CHANNEL, submitListener);
      ipcMain.removeListener(PICKER_CANCEL_CHANNEL, cancelListener);
      pickerWindow.removeAllListeners("closed");
    };

    const finish = (result: PickerSelection | null) => {
      cleanup();
      if (!pickerWindow.isDestroyed()) {
        pickerWindow.close();
      }
      resolve(result);
    };

    const submitListener = (_event: Electron.IpcMainEvent, selection: PickerSelection) => {
      if (_event.sender.id !== pickerWindow.webContents.id) {
        return;
      }

      if (!selection || typeof selection.sourceId !== "string") {
        finish(null);
        return;
      }

      finish({
        sourceId: selection.sourceId
      });
    };

    const cancelListener = (_event: Electron.IpcMainEvent) => {
      if (_event.sender.id !== pickerWindow.webContents.id) {
        return;
      }
      finish(null);
    };

    ipcMain.on(PICKER_SUBMIT_CHANNEL, submitListener);
    ipcMain.on(PICKER_CANCEL_CHANNEL, cancelListener);

    pickerWindow.on("closed", () => {
      cleanup();
      resolve(null);
    });

    const html = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bildschirmübertragung</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 16px; color: #e5e7eb; background: #111827; }
      h1 { font-size: 18px; margin-bottom: 12px; color: #f9fafb; }
      .hint { font-size: 13px; color: #9ca3af; margin-bottom: 12px; }
      .list { border: 1px solid #374151; background: #1f2937; border-radius: 8px; max-height: 320px; overflow: auto; }
      .item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #374151; }
      .item:last-child { border-bottom: none; }
      .item label { cursor: pointer; width: 100%; }
      .footer { margin-top: 14px; display: flex; justify-content: flex-end; gap: 10px; }
      button { border: 1px solid #4b5563; border-radius: 6px; padding: 8px 12px; cursor: pointer; background: #1f2937; color: #e5e7eb; }
      button:hover { background: #374151; }
      button.primary { background: #2563eb; color: #ffffff; border-color: #1d4ed8; }
      button.primary:hover { background: #1d4ed8; }
      input[type="radio"] { accent-color: #3b82f6; }
    </style>
  </head>
  <body>
    <h1>Bildschirm oder Fenster auswählen</h1>
    <div class="hint">Wähle die Anwendung oder den Bildschirm für die Übertragung.</div>
    <div id="sources" class="list"></div>
    <div class="footer">
      <button id="cancel">Abbrechen</button>
      <button id="share" class="primary">Teilen</button>
    </div>
    <script>
      let selectedSourceId = null;
      const sourcesContainer = document.getElementById('sources');

      window.sharkordPicker.onInit((payload) => {
        sourcesContainer.innerHTML = '';

        payload.sources.forEach((source, index) => {
          const row = document.createElement('div');
          row.className = 'item';

          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'source';
          radio.value = source.id;
          radio.id = 'source-' + index;
          if (index === 0) {
            radio.checked = true;
            selectedSourceId = source.id;
          }
          radio.addEventListener('change', () => {
            selectedSourceId = radio.value;
          });

          const label = document.createElement('label');
          label.htmlFor = radio.id;
          label.textContent = source.name;

          row.appendChild(radio);
          row.appendChild(label);
          sourcesContainer.appendChild(row);
        });
      });

      document.getElementById('cancel').addEventListener('click', () => {
        window.sharkordPicker.cancel();
      });

      document.getElementById('share').addEventListener('click', () => {
        if (!selectedSourceId) {
          return;
        }

        window.sharkordPicker.submit({
          sourceId: selectedSourceId
        });
      });
    </script>
  </body>
</html>`;

    void pickerWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
    pickerWindow.webContents.on("did-finish-load", () => {
      pickerWindow.webContents.send("sharkord-picker:init", { sources: payload.sources });
    });
  });
}

export function configurePermissions(window: BrowserWindow, config: DesktopConfig): void {
  const targetSession = window.webContents.session;
  applyPermissionHandlers(targetSession, config);
  applyDisplayMediaHandler(window, targetSession, config);
}
