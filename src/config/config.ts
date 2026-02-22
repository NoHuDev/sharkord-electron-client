import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface DesktopConfig {
  serverUrl: string;
  hotkeyToggleMute: string;
  startMinimized: boolean;
  enableTray: boolean;
  screenShareSystemAudio: boolean;
  basicAuth: {
    enabled: boolean;
    username: string;
    password: string;
  };
}

const DEFAULT_CONFIG: DesktopConfig = {
  serverUrl: "",
  hotkeyToggleMute: "Ctrl+Alt+M",
  startMinimized: false,
  enableTray: true,
  screenShareSystemAudio: false,
  basicAuth: {
    enabled: false,
    username: "",
    password: ""
  }
};

function getConfigPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

function isValidServerUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") {
      return true;
    }

    return parsed.protocol === "http:" && parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function coerceConfig(raw: unknown): DesktopConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Partial<DesktopConfig>;

  if (!isValidServerUrl(candidate.serverUrl)) {
    return null;
  }

  if (typeof candidate.hotkeyToggleMute !== "string" || candidate.hotkeyToggleMute.trim().length === 0) {
    return null;
  }

  if (typeof candidate.startMinimized !== "boolean") {
    return null;
  }

  if (typeof candidate.enableTray !== "boolean") {
    return null;
  }

  const screenShareSystemAudio =
    typeof candidate.screenShareSystemAudio === "boolean"
      ? candidate.screenShareSystemAudio
      : DEFAULT_CONFIG.screenShareSystemAudio;

  if (!candidate.basicAuth || typeof candidate.basicAuth !== "object") {
    return null;
  }

  const basicAuth = candidate.basicAuth as Partial<DesktopConfig["basicAuth"]>;
  if (typeof basicAuth.enabled !== "boolean") {
    return null;
  }

  if (typeof basicAuth.username !== "string") {
    return null;
  }

  if (typeof basicAuth.password !== "string") {
    return null;
  }

  return {
    serverUrl: candidate.serverUrl,
    hotkeyToggleMute: candidate.hotkeyToggleMute,
    startMinimized: candidate.startMinimized,
    enableTray: candidate.enableTray,
    screenShareSystemAudio,
    basicAuth: {
      enabled: basicAuth.enabled,
      username: basicAuth.username,
      password: basicAuth.password
    }
  };
}

function writeConfig(config: DesktopConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function saveDesktopConfig(config: DesktopConfig): void {
  writeConfig(config);
}

/**
 * Loads whatever is in the config file, merging with defaults.
 * Returns a partial-safe config even if serverUrl is empty (for pre-filling the setup UI).
 */
export function loadPartialConfig(): DesktopConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const basicAuthRaw = raw.basicAuth as Partial<DesktopConfig["basicAuth"]> | undefined;

    return {
      serverUrl: typeof raw.serverUrl === "string" ? raw.serverUrl : DEFAULT_CONFIG.serverUrl,
      hotkeyToggleMute:
        typeof raw.hotkeyToggleMute === "string" && raw.hotkeyToggleMute.trim()
          ? raw.hotkeyToggleMute
          : DEFAULT_CONFIG.hotkeyToggleMute,
      startMinimized: typeof raw.startMinimized === "boolean" ? raw.startMinimized : DEFAULT_CONFIG.startMinimized,
      enableTray: typeof raw.enableTray === "boolean" ? raw.enableTray : DEFAULT_CONFIG.enableTray,
      screenShareSystemAudio:
        typeof raw.screenShareSystemAudio === "boolean"
          ? raw.screenShareSystemAudio
          : DEFAULT_CONFIG.screenShareSystemAudio,
      basicAuth: {
        enabled:
          basicAuthRaw && typeof basicAuthRaw.enabled === "boolean"
            ? basicAuthRaw.enabled
            : DEFAULT_CONFIG.basicAuth.enabled,
        username:
          basicAuthRaw && typeof basicAuthRaw.username === "string"
            ? basicAuthRaw.username
            : DEFAULT_CONFIG.basicAuth.username,
        password:
          basicAuthRaw && typeof basicAuthRaw.password === "string"
            ? basicAuthRaw.password
            : DEFAULT_CONFIG.basicAuth.password
      }
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Returns true if the config is missing critical fields (serverUrl) and the setup UI should be shown.
 */
export function needsSetup(config: DesktopConfig): boolean {
  return !isValidServerUrl(config.serverUrl);
}

export function loadDesktopConfig(): DesktopConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    writeConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
    const config = coerceConfig(raw);

    if (!config) {
      const backupPath = `${configPath}.invalid-${Date.now()}`;
      fs.copyFileSync(configPath, backupPath);
      writeConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }

    return config;
  } catch {
    const backupPath = `${configPath}.invalid-${Date.now()}`;
    fs.copyFileSync(configPath, backupPath);
    writeConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}
