import { Menu, nativeImage, Tray } from "electron";

const isLinux = process.platform === "linux";

interface TrayManagerOptions {
  onToggleMute: () => void;
  onToggleWindowVisibility: () => void;
  onQuit: () => void;
  isWindowVisible: () => boolean;
  /** Pfad zu icon_on.png (Mikrofon an / Mute: aus) */
  iconOnPath?: string;
  /** Pfad zu icon_off.png (Mikrofon stumm / Mute: an) */
  iconOffPath?: string;
}

export class TrayManager {
  private tray: Tray | null = null;
  private muted: boolean | null = null;
  private readonly options: TrayManagerOptions;
  private iconOn: Electron.NativeImage | null = null;
  private iconOff: Electron.NativeImage | null = null;

  constructor(options: TrayManagerOptions) {
    this.options = options;
  }

  create(): void {
    if (this.tray) {
      return;
    }

    this.loadIcons();
    const icon = this.getIconForMuted(this.muted);
    this.tray = new Tray(icon);
    this.tray.setToolTip("Sharkord Desktop");
    this.tray.on("click", () => {
      this.options.onToggleMute();
      this.refreshMenu();
    });
    if (isLinux) {
      this.tray.on("right-click", () => {
        this.tray?.popUpContextMenu(this.buildContextMenu());
      });
      this.tray.setContextMenu(null);
    } else {
      this.refreshMenu();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.tray) {
      this.tray.setImage(this.getIconForMuted(muted));
      this.tray.setToolTip(`Sharkord Desktop (${muted ? "Muted" : "Unmuted"})`);
    }
  }

  refreshMenu(): void {
    if (!this.tray) {
      return;
    }
    const menu = this.buildContextMenu();
    if (!isLinux) {
      this.tray.setContextMenu(menu);
    }
  }

  private buildContextMenu(): Menu {
    const showHideLabel = this.options.isWindowVisible() ? "Fenster verstecken" : "Fenster anzeigen";
    const muteLabel = this.muted === null ? "Mute: unbekannt" : this.muted ? "Mute: an" : "Mute: aus";

    return Menu.buildFromTemplate([
      {
        label: muteLabel,
        enabled: false
      },
      {
        type: "separator"
      },
      {
        label: "Mute toggeln",
        click: () => this.options.onToggleMute()
      },
      {
        label: showHideLabel,
        click: () => {
          this.options.onToggleWindowVisibility();
          this.refreshMenu();
        }
      },
      {
        type: "separator"
      },
      {
        label: "Beenden",
        click: () => this.options.onQuit()
      }
    ]);
  }

  destroy(): void {
    if (!this.tray) {
      return;
    }

    this.tray.destroy();
    this.tray = null;
  }

  private loadIcons(): void {
    if (this.options.iconOnPath && this.options.iconOffPath) {
      const onImg = nativeImage.createFromPath(this.options.iconOnPath);
      const offImg = nativeImage.createFromPath(this.options.iconOffPath);
      if (!onImg.isEmpty() && !offImg.isEmpty()) {
        this.iconOn = onImg;
        this.iconOff = offImg;
      }
    }
  }

  private getIconForMuted(muted: boolean | null): Electron.NativeImage {
    if (muted === true && this.iconOff) {
      return this.iconOff;
    }
    if ((muted === false || muted === null) && this.iconOn) {
      return this.iconOn;
    }
    return this.createFallbackIcon();
  }

  private createFallbackIcon(): Electron.NativeImage {
    const svg = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#93a4c3"/></svg>'
    );
    return nativeImage.createFromDataURL(`data:image/svg+xml,${svg}`);
  }
}
