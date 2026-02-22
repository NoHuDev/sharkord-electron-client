import { globalShortcut } from "electron";

export interface HotkeyRegistrationResult {
  success: boolean;
  reason?: "invalid-accelerator" | "already-in-use";
}

export class HotkeyManager {
  private registeredAccelerator: string | null = null;

  registerToggleMute(accelerator: string, callback: () => void): HotkeyRegistrationResult {
    const normalized = accelerator.trim();
    if (!normalized) {
      return { success: false, reason: "invalid-accelerator" };
    }

    this.unregisterAll();

    let registered = false;
    try {
      registered = globalShortcut.register(normalized, callback);
    } catch {
      return { success: false, reason: "invalid-accelerator" };
    }

    if (!registered) {
      return { success: false, reason: "already-in-use" };
    }

    this.registeredAccelerator = normalized;
    return { success: true };
  }

  unregisterAll(): void {
    if (this.registeredAccelerator) {
      globalShortcut.unregister(this.registeredAccelerator);
      this.registeredAccelerator = null;
    }
  }
}
