import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_CHANNEL,
  BRIDGE_COMMAND_TYPES,
  BRIDGE_EVENT_TYPES,
  type BridgeCommand,
  type BridgeEvent,
  isBridgeCommand,
  isBridgeEvent
} from "../shared/bridge";

const IPC_COMMAND_CHANNEL = "sharkord-desktop:command";
const IPC_EVENT_CHANNEL = "sharkord-desktop:event";
let desiredMuted = false;

const trackedMicrophoneTracks = new Set<MediaStreamTrack>();
const MUTE_TOGGLE_SELECTORS = [
  '[data-testid="mute-button"]',
  '[data-testid="voice-mute-toggle"]',
  'button[title*="microphone" i]',
  'button[title*="mikrofon" i]',
  'button[aria-label*="mute" i]',
  'button[aria-label*="stumm" i]',
  'button[title*="Mute microphone (Ctrl+Shift+M)" i]',
  'button[title*="stumm" i]',
  '[aria-label*="microphone" i]',
  '[aria-label*="mikrofon" i]'
];

function postCommandToPage(command: BridgeCommand): void {
  window.postMessage(command, "*");
}

function postEventToMain(event: BridgeEvent): void {
  ipcRenderer.send(IPC_EVENT_CHANNEL, event);
}

function emitReadyEvent(): void {
  postEventToMain({
    channel: BRIDGE_CHANNEL,
    type: BRIDGE_EVENT_TYPES.READY,
    payload: {
      version: "preload-local-mute-v1"
    }
  });
}

function emitMuteState(source: "user" | "desktop-hotkey" | "sync"): void {
  postEventToMain({
    channel: BRIDGE_CHANNEL,
    type: BRIDGE_EVENT_TYPES.MUTE_STATE,
    payload: {
      muted: desiredMuted,
      source
    }
  });
}

function trackMicrophoneStream(stream: MediaStream): void {
  for (const track of stream.getAudioTracks()) {
    if (track.readyState !== "live") {
      continue;
    }

    trackedMicrophoneTracks.add(track);
    track.enabled = !desiredMuted;

    track.addEventListener(
      "ended",
      () => {
        trackedMicrophoneTracks.delete(track);
      },
      { once: true }
    );
  }
}

function findMuteToggleElement(): HTMLElement | null {
  for (const selector of MUTE_TOGGLE_SELECTORS) {
    const element = document.querySelector(selector);
    if (element instanceof HTMLElement) {
      return element;
    }
  }

  const candidateButtons = Array.from(document.querySelectorAll("button"));
  for (const button of candidateButtons) {
    const hasMicIcon = button.querySelector("svg.lucide-mic, svg.lucide-mic-off") !== null;
    const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();

    if (hasMicIcon && /mute|unmute|stumm|mikrofon|microphone/.test(label)) {
      return button;
    }

    if (button.getAttribute("data-slot") === "button" && /mute|unmute|stumm|mikrofon|microphone/.test(label)) {
      return button;
    }
  }

  return null;
}

function readMutedStateFromActionLabel(label: string): boolean | null {
  if (/\bunmute\b|stumm\s*aufheben|mikrofon\s*aktivieren/.test(label)) {
    return true;
  }

  if (/\bmute\b|stumm\s*schalten|stummschalten|mikrofon\s*stummschalten/.test(label)) {
    return false;
  }

  return null;
}

function readMutedStateFromElement(element: HTMLElement): boolean | null {
  const ariaPressed = element.getAttribute("aria-pressed");
  if (ariaPressed === "true") {
    return true;
  }
  if (ariaPressed === "false") {
    return false;
  }

  const dataMuted = element.getAttribute("data-muted");
  if (dataMuted === "true") {
    return true;
  }
  if (dataMuted === "false") {
    return false;
  }

  const title = element.getAttribute("title")?.toLowerCase();
  if (title) {
    const mutedFromTitle = readMutedStateFromActionLabel(title);
    if (mutedFromTitle !== null) {
      return mutedFromTitle;
    }
  }

  const ariaLabel = element.getAttribute("aria-label")?.toLowerCase();
  if (ariaLabel) {
    const mutedFromAria = readMutedStateFromActionLabel(ariaLabel);
    if (mutedFromAria !== null) {
      return mutedFromAria;
    }
  }

  return null;
}

function clickElement(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  element.click();
}

function tryToggleMuteViaDom(): boolean {
  const element = findMuteToggleElement();
  if (!element) {
    return false;
  }

  const currentMuted = readMutedStateFromElement(element);
  clickElement(element);

  if (currentMuted === null) {
    desiredMuted = !desiredMuted;
  } else {
    desiredMuted = !currentMuted;
  }

  emitMuteState("desktop-hotkey");
  return true;
}

function trySetMuteViaDom(targetMuted: boolean): boolean {
  const element = findMuteToggleElement();
  if (!element) {
    return false;
  }

  const currentMuted = readMutedStateFromElement(element);
  if (currentMuted === null) {
    return false;
  }

  if (currentMuted !== targetMuted) {
    clickElement(element);
  }

  desiredMuted = targetMuted;
  emitMuteState("sync");
  return true;
}

function isAudioRequested(constraints: MediaStreamConstraints | undefined): boolean {
  if (!constraints) {
    return false;
  }

  if (constraints.audio === true) {
    return true;
  }

  if (typeof constraints.audio === "object" && constraints.audio !== null) {
    return true;
  }

  return false;
}

function applyMutedState(muted: boolean, source: "desktop-hotkey" | "sync"): void {
  desiredMuted = muted;

  for (const track of trackedMicrophoneTracks) {
    if (track.readyState !== "live") {
      trackedMicrophoneTracks.delete(track);
      continue;
    }

    track.enabled = !muted;
  }

  emitMuteState(source);
}

function toggleMutedState(): void {
  applyMutedState(!desiredMuted, "desktop-hotkey");
}

function handleIncomingBridgeCommand(command: BridgeCommand): void {
  if (command.type === BRIDGE_COMMAND_TYPES.PING) {
    emitReadyEvent();
    return;
  }

  if (command.type === BRIDGE_COMMAND_TYPES.TOGGLE_MUTE) {
    if (!tryToggleMuteViaDom()) {
      toggleMutedState();
    }
    return;
  }

  if (command.type === BRIDGE_COMMAND_TYPES.SET_MUTE) {
    if (!trySetMuteViaDom(command.payload.muted)) {
      applyMutedState(command.payload.muted, "sync");
    }
  }
}

ipcRenderer.on(IPC_COMMAND_CHANNEL, (_event, command: unknown) => {
  if (!isBridgeCommand(command)) {
    return;
  }

  handleIncomingBridgeCommand(command);
  postCommandToPage(command);
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window) {
    return;
  }

  if (!isBridgeEvent(event.data)) {
    return;
  }

  ipcRenderer.send(IPC_EVENT_CHANNEL, event.data);
});

window.addEventListener("DOMContentLoaded", () => {
  const pingCommand: BridgeCommand = {
    channel: BRIDGE_CHANNEL,
    type: BRIDGE_COMMAND_TYPES.PING
  };
  postCommandToPage(pingCommand);

  patchMediaDevices();
});

function patchMediaDevices(): void {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    return;
  }

  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (
    ...args: Parameters<MediaDevices["getUserMedia"]>
  ): Promise<MediaStream> => {
    const stream = await originalGetUserMedia(...args);
    const [constraints] = args;

    if (isAudioRequested(constraints)) {
      trackMicrophoneStream(stream);
    }

    return stream;
  };

  if (typeof navigator.mediaDevices.getDisplayMedia !== "function") {
    return;
  }

}

contextBridge.exposeInMainWorld("sharkordDesktop", {
  platform: process.platform,
  version: "0.1.0",
  channel: BRIDGE_CHANNEL,
  ipcChannels: {
    command: IPC_COMMAND_CHANNEL,
    event: IPC_EVENT_CHANNEL
  }
});
