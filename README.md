# Sharkord Desktop

> ⚠️ **Note:** This project was largely built with the help of AI (GitHub Copilot / Claude) and is **unfinished**. Code quality, architecture, and feature coverage do not reflect a fully mature project. Use at your own risk.

An Electron-based desktop client for [Sharkord](https://github.com/sharkord/sharkord) – a self-hosted communication platform. The client loads the Sharkord web app inside a native window and extends it with desktop-specific features.

## Status

| Feature | Windows | Linux |
|---|:---:|:---:|
| Load & use webapp | ✅ | ✅ |
| Global hotkey (mute toggle) | ✅ | ⚠️ experimental (Wayland) |
| Tray icon with mute status | ✅ | ✅ |
| Screen share (video) | ✅ | ✅ |
| Screen share with audio | ❌ planned | ❌ planned (difficult…) |
| Basic Auth support | ✅ | ✅ |

**Planned:** Screen share with audio – when sharing a window, capture only that window's audio; when sharing the entire screen, capture system audio excluding the client's own output.

## Prerequisites

- Node.js >= 20
- npm >= 10
  

## Installation & Getting Started

```bash
git clone https://github.com/nohudev/sharkord-electron-client.git
cd sharkord-electron-client
npm install
npm run dev
```

## Build

```bash
# Compile TypeScript
npm run build

# Linux (AppImage + deb)
npm run dist:linux

# Windows (NSIS installer + portable)
npm run dist:win
```

Build artifacts are placed in `release/`.

## Configuration

On launch a setup window is shown where you can enter the server URL, mute hotkey, and optional Basic Auth credentials. These settings are saved to 
- Windows: `%APPDATA%/Sharkord Desktop/config.json`
- Linux: `~/.config/sharkord-desktop/config.json`

```json
{
  "serverUrl": "https://your-sharkord-instance.example.com",
  "hotkeyToggleMute": "Ctrl+Alt+M",
  "startMinimized": false,
  "enableTray": true,
  "screenShareSystemAudio": false,
  "basicAuth": {
    "enabled": false,
    "username": "",
    "password": ""
  }
}
```

| Field | Description |
|---|---|
| `serverUrl` | URL of the Sharkord instance (must use `https://`, exception: `http://localhost`) |
| `hotkeyToggleMute` | Electron accelerator for the global mute hotkey |
| `startMinimized` | Start the app minimized |
| `enableTray` | Enable tray icon with context menu |
| `screenShareSystemAudio` | Capture system audio (loopback) during screen share |
| `basicAuth` | HTTP Basic Auth credentials for protected instances |

## Project Structure

```
├── assets/              Tray icons
├── docs/                Technical documentation & planning
├── src/
│   ├── config/          Configuration loading & validation
│   ├── main/            Electron main process
│   ├── preload/         Bridge between main process and webapp
│   └── shared/          Shared types (bridge protocol)
├── electron-builder.yml Build configuration
├── tsconfig.json
└── package.json
```

## Credits

- [Sharkord](https://github.com/sharkord/sharkord) – the self-hosted communication platform this client is built for
- [Electron](https://www.electronjs.org/) – the framework powering this desktop application

## License

MIT
