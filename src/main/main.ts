import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { type DesktopConfig, loadDesktopConfig, loadPartialConfig, needsSetup, saveDesktopConfig } from "../config/config";
import { HotkeyManager } from "./hotkeys";
import { configurePermissions } from "./permissions";
import { TrayManager } from "./tray";
import {
  BRIDGE_CHANNEL,
  BRIDGE_COMMAND_TYPES,
  BRIDGE_EVENT_TYPES,
  type BridgeCommand,
  type BridgeEvent,
  isBridgeEvent
} from "../shared/bridge";

// Wayland: systemweite Hotkeys über D-Bus (GlobalShortcutsPortal)
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
}

let mainWindow: BrowserWindow | null = null;
const hotkeyManager = new HotkeyManager();
let trayManager: TrayManager | null = null;
let bridgeReady = false;
let lastKnownMuted: boolean | null = null;
let muteStatePollIntervalId: ReturnType<typeof setInterval> | null = null;

const IPC_COMMAND_CHANNEL = "sharkord-desktop:command";
const IPC_EVENT_CHANNEL = "sharkord-desktop:event";

const MUTE_STATE_POLL_MS = 750;

const SETUP_LOAD_CHANNEL = "sharkord-setup:load";
const SETUP_SAVE_CHANNEL = "sharkord-setup:save";

function showSetupWindow(): Promise<void> {
  return new Promise((resolve) => {
    const setupWindow = new BrowserWindow({
      width: 520,
      height: 560,
      title: "Sharkord – Einrichtung",
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/setup.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });

    ipcMain.handle(SETUP_LOAD_CHANNEL, () => {
      const partial = loadPartialConfig();
      return {
        serverUrl: partial.serverUrl,
        hotkeyToggleMute: partial.hotkeyToggleMute,
        basicAuth: partial.basicAuth
      };
    });

    ipcMain.handle(SETUP_SAVE_CHANNEL, (_event, incoming: unknown) => {
      try {
        if (!incoming || typeof incoming !== "object") {
          return { success: false, error: "Ungültige Daten." };
        }

        const data = incoming as {
          serverUrl?: unknown;
          hotkeyToggleMute?: unknown;
          basicAuth?: { enabled?: unknown; username?: unknown; password?: unknown };
        };

        if (typeof data.serverUrl !== "string" || !data.serverUrl.trim()) {
          return { success: false, error: "Server-URL darf nicht leer sein." };
        }

        try {
          const parsed = new URL(data.serverUrl);
          if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) {
            return { success: false, error: "Server-URL muss https:// verwenden (Ausnahme: http://localhost)." };
          }
        } catch {
          return { success: false, error: "Ungültige Server-URL." };
        }

        const existing = loadPartialConfig();
        const updated: DesktopConfig = {
          ...existing,
          serverUrl: data.serverUrl.trim(),
          hotkeyToggleMute:
            typeof data.hotkeyToggleMute === "string" && data.hotkeyToggleMute.trim()
              ? data.hotkeyToggleMute.trim()
              : existing.hotkeyToggleMute,
          basicAuth: {
            enabled: data.basicAuth && typeof data.basicAuth.enabled === "boolean" ? data.basicAuth.enabled : false,
            username:
              data.basicAuth && typeof data.basicAuth.username === "string" ? data.basicAuth.username : "",
            password:
              data.basicAuth && typeof data.basicAuth.password === "string" ? data.basicAuth.password : ""
          }
        };

        saveDesktopConfig(updated);
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    });

    const cleanup = () => {
      ipcMain.removeHandler(SETUP_LOAD_CHANNEL);
      ipcMain.removeHandler(SETUP_SAVE_CHANNEL);
    };

    setupWindow.on("closed", () => {
      cleanup();
      resolve();
    });

    const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sharkord – Einrichtung</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: #111827; color: #e5e7eb; padding: 28px 32px; }
    h1 { font-size: 20px; color: #f9fafb; margin-bottom: 4px; }
    .subtitle { font-size: 13px; color: #9ca3af; margin-bottom: 24px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #d1d5db; margin-bottom: 5px; margin-top: 16px; }
    label:first-of-type { margin-top: 0; }
    input[type="text"], input[type="url"], input[type="password"] {
      width: 100%; padding: 9px 12px; border: 1px solid #374151; border-radius: 6px;
      background: #1f2937; color: #f9fafb; font-size: 14px; outline: none;
    }
    input:focus { border-color: #3b82f6; }
    .toggle-row { display: flex; align-items: center; gap: 10px; margin-top: 18px; }
    .toggle-row input[type="checkbox"] { accent-color: #3b82f6; width: 16px; height: 16px; }
    .toggle-row label { margin: 0; font-weight: 400; cursor: pointer; }
    .auth-fields { margin-top: 10px; padding-left: 26px; }
    .auth-fields.hidden { display: none; }
    .error { color: #f87171; font-size: 13px; margin-top: 8px; min-height: 18px; }
    .footer { margin-top: 24px; display: flex; justify-content: flex-end; }
    button { border: none; border-radius: 6px; padding: 10px 24px; cursor: pointer; font-size: 14px; font-weight: 600; }
    button.primary { background: #2563eb; color: #fff; }
    button.primary:hover { background: #1d4ed8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <h1>Sharkord Einrichtung</h1>
  <p class="subtitle">Konfiguriere die Verbindung zu deiner Sharkord-Instanz.</p>

  <label for="serverUrl">Server-URL</label>
  <input type="url" id="serverUrl" placeholder="https://example.com" autocomplete="off" spellcheck="false" />

  <label for="hotkey">Mute-Hotkey</label>
  <input type="text" id="hotkey" placeholder="Ctrl+Alt+M" autocomplete="off" spellcheck="false" />

  <div class="toggle-row">
    <input type="checkbox" id="authEnabled" />
    <label for="authEnabled">Basic-Auth aktivieren</label>
  </div>

  <div class="auth-fields hidden" id="authFields">
    <label for="authUser">Benutzername</label>
    <input type="text" id="authUser" autocomplete="off" />
    <label for="authPass">Passwort</label>
    <input type="password" id="authPass" autocomplete="off" />
  </div>

  <div class="error" id="error"></div>

  <div class="footer">
    <button class="primary" id="save">Speichern & Starten</button>
  </div>

  <script>
    const serverUrlInput = document.getElementById('serverUrl');
    const hotkeyInput = document.getElementById('hotkey');
    const authEnabledInput = document.getElementById('authEnabled');
    const authFieldsDiv = document.getElementById('authFields');
    const authUserInput = document.getElementById('authUser');
    const authPassInput = document.getElementById('authPass');
    const errorDiv = document.getElementById('error');
    const saveBtn = document.getElementById('save');

    authEnabledInput.addEventListener('change', () => {
      authFieldsDiv.classList.toggle('hidden', !authEnabledInput.checked);
    });

    window.sharkordSetup.loadConfig().then((config) => {
      if (config.serverUrl) serverUrlInput.value = config.serverUrl;
      if (config.hotkeyToggleMute) hotkeyInput.value = config.hotkeyToggleMute;
      if (config.basicAuth) {
        authEnabledInput.checked = config.basicAuth.enabled;
        authFieldsDiv.classList.toggle('hidden', !config.basicAuth.enabled);
        if (config.basicAuth.username) authUserInput.value = config.basicAuth.username;
        if (config.basicAuth.password) authPassInput.value = config.basicAuth.password;
      }
    });

    saveBtn.addEventListener('click', async () => {
      errorDiv.textContent = '';
      saveBtn.disabled = true;

      const config = {
        serverUrl: serverUrlInput.value.trim(),
        hotkeyToggleMute: hotkeyInput.value.trim(),
        basicAuth: {
          enabled: authEnabledInput.checked,
          username: authUserInput.value,
          password: authPassInput.value
        }
      };

      const result = await window.sharkordSetup.saveConfig(config);
      if (result.success) {
        window.close();
      } else {
        errorDiv.textContent = result.error || 'Unbekannter Fehler.';
        saveBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

    void setupWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  });
}

function attachBasicAuthHandler(window: BrowserWindow, config: DesktopConfig): void {
  const serverHost = new URL(config.serverUrl).host;
  if (config.basicAuth.enabled) {
    console.log(`[auth] basic-auth enabled for host=${serverHost} user=${config.basicAuth.username}`);
  } else {
    console.log(`[auth] basic-auth disabled`);
  }

  window.webContents.on("login", (event, details, authInfo, callback) => {
    if (!authInfo.isProxy && authInfo.scheme === "basic" && config.basicAuth.enabled) {
      const requestHost = new URL(details.url).host;
      if (requestHost === serverHost) {
        console.log(`[auth] providing credentials for ${requestHost}`);
        event.preventDefault();
        callback(config.basicAuth.username, config.basicAuth.password);
        return;
      }

      console.warn(`[auth] challenge host mismatch requested=${requestHost} expected=${serverHost}`);
    }

    console.warn(`[auth] no credentials provided for url=${details.url}`);
    callback();
  });
}

/**
 * Liest den Mute-Status aus der Webapp-DOM (Button-Titel "Mute microphone..." / "Unmute microphone...").
 * Läuft im Seitenkontext; durchsucht auch Shadow DOM.
 */
async function readMuteStateFromPage(): Promise<boolean | null> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  try {
    const result = await mainWindow.webContents.executeJavaScript(
      `(function(){
        function search(root) {
          var buttons = root.querySelectorAll('button, [role="button"]');
          for (var i = 0; i < buttons.length; i++) {
            var t = (buttons[i].getAttribute('title') || '').trim();
            if (t.indexOf('Unmute microphone') !== -1) return true;
            if (t.indexOf('Mute microphone') !== -1) return false;
          }
          var all = root.querySelectorAll('*');
          for (var j = 0; j < all.length; j++) {
            if (all[j].shadowRoot) {
              var r = search(all[j].shadowRoot);
              if (r !== undefined) return r;
            }
          }
          return undefined;
        }
        var result = search(document);
        return result === undefined ? null : result;
      })();`,
      true
    );

    if (typeof result === "boolean") {
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

function startMuteStatePolling(): void {
  if (muteStatePollIntervalId !== null) {
    clearInterval(muteStatePollIntervalId);
    muteStatePollIntervalId = null;
  }

  muteStatePollIntervalId = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || !trayManager) {
      return;
    }
    const muted = await readMuteStateFromPage();
    if (muted !== null && lastKnownMuted !== muted) {
      lastKnownMuted = muted;
      trayManager.setMuted(muted);
    }
  }, MUTE_STATE_POLL_MS);
}

function stopMuteStatePolling(): void {
  if (muteStatePollIntervalId !== null) {
    clearInterval(muteStatePollIntervalId);
    muteStatePollIntervalId = null;
  }
}

function sendBridgeCommand(command: BridgeCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_COMMAND_CHANNEL, command);
}

interface DomToggleResult {
  clicked: boolean;
  muted: boolean | null;
}

async function tryToggleMuteViaDomInPage(): Promise<DomToggleResult> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { clicked: false, muted: null };
  }

  try {
    const result = await mainWindow.webContents.executeJavaScript(
      `(() => {
        const rootQueue = [document];
        const visited = new Set();

        const collectButtons = () => {
          const buttons = [];
          while (rootQueue.length > 0) {
            const root = rootQueue.shift();
            if (!root || visited.has(root)) {
              continue;
            }
            visited.add(root);

            const found = root.querySelectorAll?.('button, [role="button"]') ?? [];
            buttons.push(...found);

            const allElements = root.querySelectorAll?.('*') ?? [];
            for (const element of allElements) {
              if (element && element.shadowRoot) {
                rootQueue.push(element.shadowRoot);
              }
            }
          }
          return buttons;
        };

        const readMutedState = (element) => {
          const ariaPressed = element.getAttribute('aria-pressed');
          if (ariaPressed === 'true') return true;
          if (ariaPressed === 'false') return false;

          const dataMuted = element.getAttribute('data-muted');
          if (dataMuted === 'true') return true;
          if (dataMuted === 'false') return false;

          const text = [element.getAttribute('title'), element.getAttribute('aria-label'), element.textContent]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          if (/\\bunmute\\b|stumm\\s*aufheben|mikrofon\\s*aktivieren/.test(text)) {
            return true;
          }

          if (/\\bmute\\b|stumm\\s*schalten|stummschalten|mikrofon\\s*stummschalten/.test(text)) {
            return false;
          }

          return null;
        };

        const buttons = collectButtons();
        let candidate = null;

        for (const button of buttons) {
          const text = [button.getAttribute('title'), button.getAttribute('aria-label'), button.textContent]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          const hasMicIcon = Boolean(button.querySelector('svg.lucide-mic, svg.lucide-mic-off'));

          if (hasMicIcon && /mute|unmute|stumm|mikrofon|microphone/.test(text)) {
            candidate = button;
            break;
          }

          if (/mute microphone|unmute microphone|mikrofon|stumm/.test(text)) {
            candidate = button;
            break;
          }
        }

        if (!candidate) {
          return { clicked: false, muted: null };
        }

        const before = readMutedState(candidate);
        candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        candidate.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        candidate.click();

        const after = readMutedState(candidate);
        if (after !== null) {
          return { clicked: true, muted: after };
        }

        if (before !== null) {
          return { clicked: true, muted: !before };
        }

        return { clicked: true, muted: null };
      })();`,
      true
    );

    if (!result || typeof result !== "object") {
      return { clicked: false, muted: null };
    }

    const clicked = (result as { clicked?: unknown }).clicked === true;
    const mutedValue = (result as { muted?: unknown }).muted;
    const muted = typeof mutedValue === "boolean" ? mutedValue : null;
    return { clicked, muted };
  } catch (error) {
    console.warn(`[mute] DOM toggle via executeJavaScript failed: ${String(error)}`);
    return { clicked: false, muted: null };
  }
}

async function sendToggleMuteCommand(): Promise<void> {
  if (bridgeReady) {
    sendBridgeCommand({
      channel: BRIDGE_CHANNEL,
      type: BRIDGE_COMMAND_TYPES.TOGGLE_MUTE
    });
    return;
  }

  const domResult = await tryToggleMuteViaDomInPage();
  if (domResult.clicked) {
    if (domResult.muted !== null) {
      lastKnownMuted = domResult.muted;
      trayManager?.setMuted(domResult.muted);
    } else if (lastKnownMuted !== null) {
      lastKnownMuted = !lastKnownMuted;
      trayManager?.setMuted(lastKnownMuted);
    }
    return;
  }

  console.warn("[mute] bridge not ready and DOM fallback failed");
}

function sendPingCommand(): void {
  sendBridgeCommand({
    channel: BRIDGE_CHANNEL,
    type: BRIDGE_COMMAND_TYPES.PING
  });
}

function toggleMainWindowVisibility(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

function createWindow(): void {
  const config = loadDesktopConfig();
  const serverOrigin = new URL(config.serverUrl).origin;
  console.log(`[config] serverUrl=${config.serverUrl}`);

  if (process.platform === "linux") {
    const waylandDisplay = process.env.WAYLAND_DISPLAY;
    const xdgSessionType = process.env.XDG_SESSION_TYPE;
    if (waylandDisplay || xdgSessionType === "wayland") {
      console.warn(
        "[hotkey] Linux Wayland erkannt: die App nutzt das GlobalShortcutsPortal für systemweite Hotkeys. " +
          "Unter einigen Setups (z. B. KDE Wayland) kann es zu Verzögerungen kommen; bei Problemen X11-Session testen."
      );
    }
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !config.startMinimized,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[load] failed code=${errorCode} url=${validatedURL} reason=${errorDescription}`);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    console.log(`[load] finished url=${mainWindow?.webContents.getURL()}`);
    bridgeReady = false;
    sendPingCommand();

    if (config.enableTray) {
      startMuteStatePolling();
    }

    if (process.env.SHARKORD_DESKTOP_DEBUG_AUTO_TOGGLE === "1") {
      setTimeout(() => {
        void sendToggleMuteCommand();
      }, 1500);
    }
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const targetOrigin = new URL(url).origin;
    if (targetOrigin !== serverOrigin) {
      console.warn(`[navigation] blocked and opened externally: ${url}`);
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  attachBasicAuthHandler(mainWindow, config);
  configurePermissions(mainWindow, config);
  void mainWindow.loadURL(config.serverUrl);

  if (config.startMinimized) {
    mainWindow.minimize();
  }

  const hotkeyResult = hotkeyManager.registerToggleMute(config.hotkeyToggleMute, () => {
    void sendToggleMuteCommand();
  });

  if (!hotkeyResult.success) {
    console.error(
      `[hotkey] registration failed for "${config.hotkeyToggleMute}": ${hotkeyResult.reason ?? "unknown"}`
    );
  } else {
    console.log(`[hotkey] registered: ${config.hotkeyToggleMute}`);
  }

  if (config.enableTray) {
    const iconDir = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), "assets");
    const iconOnPath = path.join(iconDir, "icon_on.png");
    const iconOffPath = path.join(iconDir, "icon_off.png");

    trayManager?.destroy();
    trayManager = new TrayManager({
      onToggleMute: () => void sendToggleMuteCommand(),
      onToggleWindowVisibility: () => toggleMainWindowVisibility(),
      onQuit: () => app.quit(),
      isWindowVisible: () => (mainWindow ? mainWindow.isVisible() && !mainWindow.isMinimized() : false),
      iconOnPath,
      iconOffPath
    });

    trayManager.create();

    mainWindow.on("show", () => trayManager?.refreshMenu());
    mainWindow.on("hide", () => trayManager?.refreshMenu());
    mainWindow.on("minimize", () => trayManager?.refreshMenu());
    mainWindow.on("restore", () => trayManager?.refreshMenu());
  }

  mainWindow.on("closed", () => {
    stopMuteStatePolling();
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  ipcMain.on(IPC_EVENT_CHANNEL, (_event, payload: unknown) => {
    if (!isBridgeEvent(payload)) {
      return;
    }

    const bridgeEvent = payload as BridgeEvent;

    if (bridgeEvent.type === BRIDGE_EVENT_TYPES.READY) {
      bridgeReady = true;
      console.log(`[bridge] ready: version=${bridgeEvent.payload.version}`);
    }

    if (bridgeEvent.type === BRIDGE_EVENT_TYPES.MUTE_STATE) {
      console.log(`[bridge] mute-state: muted=${bridgeEvent.payload.muted} source=${bridgeEvent.payload.source}`);
      lastKnownMuted = bridgeEvent.payload.muted;
      trayManager?.setMuted(bridgeEvent.payload.muted);
    }

    if (bridgeEvent.type === BRIDGE_EVENT_TYPES.ERROR) {
      console.error(`[bridge] error: ${bridgeEvent.payload.code} ${bridgeEvent.payload.message}`);
    }
  });

  await showSetupWindow();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  hotkeyManager.unregisterAll();
  trayManager?.destroy();
  trayManager = null;

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  hotkeyManager.unregisterAll();
  trayManager?.destroy();
  trayManager = null;
});
