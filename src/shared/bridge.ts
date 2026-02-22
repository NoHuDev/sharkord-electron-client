export const BRIDGE_CHANNEL = "sharkord-desktop-v1" as const;

export const BRIDGE_COMMAND_TYPES = {
  TOGGLE_MUTE: "SHARKORD_DESKTOP_TOGGLE_MUTE",
  SET_MUTE: "SHARKORD_DESKTOP_SET_MUTE",
  PING: "SHARKORD_DESKTOP_PING"
} as const;

export const BRIDGE_EVENT_TYPES = {
  MUTE_STATE: "SHARKORD_DESKTOP_MUTE_STATE",
  READY: "SHARKORD_DESKTOP_READY",
  ERROR: "SHARKORD_DESKTOP_ERROR"
} as const;

export type BridgeCommandType = (typeof BRIDGE_COMMAND_TYPES)[keyof typeof BRIDGE_COMMAND_TYPES];
export type BridgeEventType = (typeof BRIDGE_EVENT_TYPES)[keyof typeof BRIDGE_EVENT_TYPES];

export interface ToggleMuteCommand {
  channel: typeof BRIDGE_CHANNEL;
  type: typeof BRIDGE_COMMAND_TYPES.TOGGLE_MUTE;
}

export interface SetMuteCommand {
  channel: typeof BRIDGE_CHANNEL;
  type: typeof BRIDGE_COMMAND_TYPES.SET_MUTE;
  payload: {
    muted: boolean;
  };
}

export interface PingCommand {
  channel: typeof BRIDGE_CHANNEL;
  type: typeof BRIDGE_COMMAND_TYPES.PING;
}

export type BridgeCommand = ToggleMuteCommand | SetMuteCommand | PingCommand;

export interface ReadyEvent {
  channel: typeof BRIDGE_CHANNEL;
  type: typeof BRIDGE_EVENT_TYPES.READY;
  payload: {
    version: string;
  };
}

export interface MuteStateEvent {
  channel: typeof BRIDGE_CHANNEL;
  type: typeof BRIDGE_EVENT_TYPES.MUTE_STATE;
  payload: {
    muted: boolean;
    source: "user" | "desktop-hotkey" | "sync";
  };
}

export interface ErrorEvent {
  channel: typeof BRIDGE_CHANNEL;
  type: typeof BRIDGE_EVENT_TYPES.ERROR;
  payload: {
    code: string;
    message: string;
  };
}

export type BridgeEvent = ReadyEvent | MuteStateEvent | ErrorEvent;

export function isBridgeCommand(value: unknown): value is BridgeCommand {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<BridgeCommand>;

  if (maybe.channel !== BRIDGE_CHANNEL || typeof maybe.type !== "string") {
    return false;
  }

  if (maybe.type === BRIDGE_COMMAND_TYPES.TOGGLE_MUTE || maybe.type === BRIDGE_COMMAND_TYPES.PING) {
    return true;
  }

  if (maybe.type === BRIDGE_COMMAND_TYPES.SET_MUTE) {
    return (
      typeof maybe.payload === "object" &&
      maybe.payload !== null &&
      typeof (maybe.payload as { muted?: unknown }).muted === "boolean"
    );
  }

  return false;
}

export function isBridgeEvent(value: unknown): value is BridgeEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<BridgeEvent>;
  if (maybe.channel !== BRIDGE_CHANNEL || typeof maybe.type !== "string") {
    return false;
  }

  if (maybe.type === BRIDGE_EVENT_TYPES.READY) {
    return (
      typeof maybe.payload === "object" &&
      maybe.payload !== null &&
      typeof (maybe.payload as { version?: unknown }).version === "string"
    );
  }

  if (maybe.type === BRIDGE_EVENT_TYPES.MUTE_STATE) {
    const payload = maybe.payload as { muted?: unknown; source?: unknown } | undefined;
    return (
      typeof payload === "object" &&
      payload !== null &&
      typeof payload.muted === "boolean" &&
      (payload.source === "user" || payload.source === "desktop-hotkey" || payload.source === "sync")
    );
  }

  if (maybe.type === BRIDGE_EVENT_TYPES.ERROR) {
    const payload = maybe.payload as { code?: unknown; message?: unknown } | undefined;
    return (
      typeof payload === "object" &&
      payload !== null &&
      typeof payload.code === "string" &&
      typeof payload.message === "string"
    );
  }

  return false;
}
