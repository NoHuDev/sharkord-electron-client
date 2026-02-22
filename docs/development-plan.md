# Sharkord Desktop Client (Electron Wrapper) – Entwicklungsplan

Stand: 2026-02-20  
Ziel: Ein Open-Source Desktop-Wrapper (Windows + Linux), der die selbstgehostete Sharkord-Webapp (https://github.com/sharkord/sharkord) lädt, komplett darstellt und **systemweite (globale) Hotkeys** bereitstellt, um **nur in Sharkord** das Mikrofon per **Toggle Mute** zu schalten – auch wenn die App nicht fokussiert ist.  
Wichtig: **WebRTC Voice & Screen Share** sollen „so gut wie im Browser“ funktionieren.

Dieses Dokument ist jetzt nicht nur ein Konzept, sondern ein **ausführbarer Projekt-Blueprint**: Es dient als verbindliche Arbeitsgrundlage für die Umsetzung in kleinen, prüfbaren Schritten.

---

## 1. Anforderungen / Nicht-Ziele

### Muss
- Windows + Linux Builds (AppImage/DEB/RPM optional; mindestens AppImage oder .deb).
- **Globaler Hotkey** (OS-weit): Toggle Mic Mute innerhalb Sharkord.
- Funktioniert unabhängig vom Browser (eigene Runtime).
- Voicechat (WebRTC Audio) muss zuverlässig funktionieren.
- Bildschirmübertragung (Screen Share) muss unter Linux Wayland und Windows 10/11 funktionieren; X11 Unterstützung zusätzlich wünschenswert.
- Selbstgehostete Sharkord-Instanz als URL konfigurierbar (z.B. `https://sharkord.example.com`).
- Zugriff auf Basic-Auth-geschützte Sharkord-Instanzen muss unterstützt werden.

### Soll
- Tray-Icon + Menü (Mute toggeln, Fenster zeigen/verstecken, Beenden).
- Mute-Status im Tray (Iconwechsel oder Checkmark).
- Autostart optional (OS-Integration).
- Update-Mechanismus optional (später).

### Nicht-Ziele (für v1)
- Kein nativer Audio-Stack (wir nutzen Chromium/Electron WebRTC).
- Kein OS-weites Hardware-Mic-Mute (wir muten nur Sharkord-intern).

### Erfolgskriterien (messbar)
- App startet auf Linux/Windows und lädt die konfigurierte `serverUrl` ohne manuelles Eingreifen.
- Globaler Hotkey toggelt Mute zuverlässig in Sharkord bei fokussiertem, minimiertem und unfokussiertem Fenster.
- Voicechat funktioniert in mindestens 30-minütigem Test ohne reproduzierbare Audio-Aussetzer durch den Wrapper.
- Screen Share funktioniert unter Windows 10/11 und Linux Wayland (GNOME), inkl. Source-Picker.

---

## 2. Technologie-Entscheidung

### Electron (empfohlen)
Begründung:
- Chromium-basierte Runtime → bestmögliche Kompatibilität für WebRTC & Screen Share.
- `globalShortcut` unterstützt echte systemweite Hotkeys.
- Gute Packaging-Story (electron-builder / electron-forge).
- Auf Linux besser kontrollierbar als reine WebViews.

Tooling (Vorschlag):
- Node.js LTS
- Electron
- TypeScript (verbindlich für dieses Projekt)
- electron-builder (Packaging)
- ESLint/Prettier
- (Optional) Playwright für Smoke Tests

Festlegung:
- Paketmanager: `npm` (v1, um Setup-Reibung zu minimieren)
- Node-Version: aktuelle LTS (über `.nvmrc` fixieren)
- Build-Tooling: `electron-vite` oder `vite + electron` ist möglich; v1: klassischer TypeScript-Compile + Electron Start reicht aus

---

## 3. High-Level Architektur

### Prozesse
- **Main Process**
  - Erstellt BrowserWindow, lädt Sharkord URL.
  - Registriert globalen Hotkey (`globalShortcut`).
  - Optional: Tray, Auto-start, Single-instance lock.
  - IPC zur Renderer/Preload-Schicht.
  - Permission- und Navigation-Policy erzwingen.

- **Preload Script (Bridge)**
  - Sichere Brücke zwischen Main und der geladenen Sharkord-Seite.
  - Exponiert minimalen API-Surface (z.B. `window.sharkordDesktop`).
  - Empfängt „toggleMute“ Events vom Main und leitet sie an die Web-App weiter.
  - Meldet Mute-Status an Main zurück (für Tray/UI-Status).

- **Sharkord Web-App (Server-seitig, von dir kontrolliert)**
  - Implementiert eine stabile Desktop-API:
    - `toggleMute()`
    - optional `setMute(boolean)`, `getMuteState()`
  - Diese API soll **ohne DOM-Hacks** arbeiten (kein „Button klicken“ als einzige Methode).

### Verantwortlichkeiten (Contract)
- Main kennt **keine** Details der Sharkord-UI.
- Preload kennt nur Message-Typen, keine Businesslogik.
- Sharkord-Webapp besitzt die Wahrheit über Mute-State.
- Mute-Befehle sind idempotent über `setMute(boolean)`; `toggleMute()` bleibt Komfort-API.

---

## 4. „Desktop Bridge“ – Schnittstelle zwischen Electron und Sharkord

### Empfehlung: Event-basierte Bridge + optionale Status-Abfrage
**In Sharkord:**
- Listener registrieren, der Desktop-Kommandos empfängt, z.B. per:
  - `window.addEventListener("message", ...)` (oder eigenes CustomEvent)
  - oder globales Objekt `window.__sharkordDesktopApi`

**In Electron (Preload):**
- Eine kontrollierte API zur Seite:
  - Senden: `postMessage({ type: "SHARKORD_TOGGLE_MUTE" })`
  - Empfangen: `postMessage({ type: "SHARKORD_MUTE_STATE", muted: true/false })`

### Verbindliches Message-Schema (v1)

#### Commands (Electron → Sharkord)
- `SHARKORD_DESKTOP_TOGGLE_MUTE`
- `SHARKORD_DESKTOP_SET_MUTE` mit Payload `{ muted: boolean }`
- `SHARKORD_DESKTOP_PING`

#### Events (Sharkord → Electron)
- `SHARKORD_DESKTOP_MUTE_STATE` mit Payload `{ muted: boolean, source: "user" | "desktop-hotkey" | "sync" }`
- `SHARKORD_DESKTOP_READY` mit Payload `{ version: string }`
- `SHARKORD_DESKTOP_ERROR` mit Payload `{ code: string, message: string }`

#### Rahmenbedingungen
- Jede Nachricht enthält `channel: "sharkord-desktop-v1"`.
- Unbekannte Events werden verworfen (fail-safe).
- Preload validiert Payloads minimal zur Laufzeit.

Ziel:
- Global Hotkey → Electron → Sharkord: Toggle Mute
- Sharkord → Electron: optionaler Status (für Tray Icon)

Warum nicht nur DOM klicken?
- UI/Selectors ändern sich; API bleibt stabil.
- Bessere Testbarkeit und weniger „Brittleness“.

### Minimaler Handshake-Ablauf
1. Main lädt URL.
2. Preload wartet auf `did-finish-load` und sendet `PING`.
3. Sharkord antwortet mit `READY`.
4. Erst ab dann sind globale Hotkey-Aktionen „scharf“.

---

## 5. Hotkey-Konzept

### Globaler Hotkey
- Default-Vorschlag: `Ctrl+Alt+M` (relativ konfliktarm)
- Muss konfigurierbar sein (Settings-Datei; UI später).
- Registrierung:
  - Main process: `globalShortcut.register(accelerator, callback)`
  - Unter Linux wird zusätzlich `GlobalShortcutsPortal` (D-Bus) aktiviert, damit Hotkeys auch unter Wayland systemweit funktionieren.

### Verhalten
- Hotkey toggelt Mute in Sharkord, egal ob Window fokussiert/minimiert ist.
- Optional: Kurzer Sound/Tray-Badge zur Bestätigung.

### Edge Cases (v1)
- Hotkey kollidiert / kann nicht registriert werden → sichtbare Fehlermeldung + Fallback auf Menüeintrag.
- Kein aktiver Call → Command wird ignoriert oder Statusmeldung „kein aktiver Call“ (Sharkord-seitig).
- Nicht eingeloggt → kein Crash, nur no-op + optional Hinweis.

---

## 6. Linux Screen Share (Wayland + X11) – Kompatibilitätsplan

### Grundsatz
- Wayland Screen Share läuft i.d.R. über **PipeWire + xdg-desktop-portal**.
- Unter X11 kann Screen Capture meist direkter funktionieren.

### Maßnahmen (v1)
- Testmatrix:
  - GNOME Wayland (Standard)
  - KDE Wayland (wenn möglich)
  - X11 Session (GNOME/KDE)
- Dokumentation:
  - Benötigte Pakete/Services (PipeWire, Portal-Backends)
  - Hinweise zu Permissions/Dialogs (Source Picker)

### Risiko/ToDo
- Je nach Distro können zusätzliche Electron/Chromium Flags nötig sein.
- Das wird als eigener Abschnitt im README dokumentiert (Troubleshooting).

### Systemaudio (Loopback) vs. Anwendungsaudio
- `screenShareSystemAudio` (Config) steuert, ob **Systemaudio** (Loopback) mit übertragen wird. Unter Windows von Electron unterstützt; unter Linux ggf. experimentell. Nicht verwechseln mit **Anwendungsaudio** (nur das geteilte Fenster) – siehe Windows-Helper bzw. Linux-Backlog.

### Linux App-Audio (Backlog)
- Das xdg-desktop-portal ScreenCast-API liefert nur **Video**; es gibt keine Portal-Unterstützung für „Audio dieses Fensters“.
- **Anwendungsaudio** (nur geteiltes Fenster, kein Systemmix) unter Linux wäre über einen **PipeWire-basierten Helper** (analog zum Windows WASAPI-Helper) oder zukünftige Portal-Erweiterungen machbar (PipeWire unterstützt per-app Capture; die Zuordnung Fenster↔Audio-Node ist derzeit nicht aus dem Portal ableitbar).
- Backlog: „Linux App-Audio (PipeWire/Portal)“ – optional mit manueller Audio-Quellen-Auswahl oder heuristischer Zuordnung.

### Linux Voraussetzungen (für Doku/QA)
- `pipewire`
- `xdg-desktop-portal`
- passendes Portal-Backend (`xdg-desktop-portal-gnome` oder `...-kde`)
- laufende User-Session mit aktiven Portal-Diensten

---

## 7. Projektstruktur (Vorschlag)

- `apps/desktop/`
  - `src/main/` (Electron Main)
  - `src/preload/` (Bridge)
  - `src/renderer/` (optional, z.B. kleines Settings UI; v1 kann ohne)
  - `src/shared/` (Message-Typen / Schemas)
  - `src/config/` (Default-Konfiguration + Loader)
  - `assets/` (Icons)
  - `scripts/` (Build/Release Hilfsskripte)
  - `package.json`
  - `tsconfig.json`
  - `.eslintrc.*`
  - `.prettierrc`
  - `electron-builder.yml` (oder in package.json)
- `docs/`
  - `client.md` (dieses Dokument)
  - `troubleshooting.md`
  - `qa-checklist.md`

### Dateiverantwortung (v1)
- `src/main/main.ts`: Fenster, Lifecycle, Hotkeys, Tray, Security-Policy.
- `src/main/permissions.ts`: Permission-Handling.
- `src/main/hotkeys.ts`: Registrierung/Neuregistrierung inkl. Fehlerfälle.
- `src/preload/index.ts`: Bridge-API + Event Dispatch.
- `src/shared/bridge.ts`: Typsichere Event-Namen und Payload-Interfaces.
- `src/config/config.ts`: Laden, Validieren, Persistieren.

---

## 8. Konfiguration

### Settings-Datei (v1)
- JSON/YAML, z.B. unter:
  - Windows: `%APPDATA%/Sharkord Desktop/config.json`
  - Linux: `~/.config/sharkord-desktop/config.json`

Werte:
- `serverUrl`: Sharkord URL
- `hotkeyToggleMute`: z.B. `Ctrl+Alt+M`
- `startMinimized`: bool
- `enableTray`: bool
- `basicAuth.enabled`: bool
- `basicAuth.username`: string
- `basicAuth.password`: string

Empfohlene Defaults:
```json
{
  "serverUrl": "https://sharkord.example.com",
  "hotkeyToggleMute": "Ctrl+Alt+M",
  "startMinimized": false,
  "enableTray": true,
  "basicAuth": {
    "enabled": false,
    "username": "",
    "password": ""
  }
}
```

Validierungsregeln:
- `serverUrl` muss `https://` nutzen (Ausnahme `http://localhost` für Dev).
- `hotkeyToggleMute` darf nicht leer sein und muss Electron-Accelerator-konform sein.
- Wenn `basicAuth.enabled=true`, müssen Username/Password gesetzt sein (v1: technisch optional, aber empfohlen verpflichtend zu belegen).
- Bei ungültiger Config: Backup schreiben + mit Defaults starten.

Später:
- UI in der App zum Ändern (Settings Window).

---

## 9. Sicherheits- und Permission-Policy

- `contextIsolation: true`
- `nodeIntegration: false`
- Nur notwendige APIs im Preload exposen.
- `Content-Security-Policy` (so weit möglich) dokumentieren.
- Navigation lock:
  - Nur `serverUrl` und ggf. erlaubte Subdomains zulassen
  - Externe Links im Systembrowser öffnen

Media Permissions:
- `getUserMedia` Prompts wie im Browser.
- Optional: in Electron `setPermissionRequestHandler` sauber behandeln.

Zusätzlich verbindlich:
- `webSecurity: true`
- `sandbox: true` (sofern mit eingesetzter Bridge kompatibel)
- `setWindowOpenHandler`: externe Links nur via Systembrowser
- Navigation Whitelist auf `serverUrl` Host

---

## 10. Meilensteine

### Milestone 0 – Setup (VS Code Ready)
- Repo/Ordnerstruktur
- npm/pnpm Setup
- Electron Hello World + lädt `serverUrl`
- Dev-Start: `npm run dev`

### Milestone 1 – Global Hotkey → Sharkord Toggle Mute (MVP)
- `globalShortcut` registrieren
- Preload Bridge implementieren
- In Sharkord Server-Code: `toggleMute()` API einbauen
- End-to-end Test: Hotkey mutet/unmutet in Sharkord, auch ohne Fokus

### Milestone 2 – Tray + Status
- Tray Icon + Menüeinträge
- Mute-Status Feedback (wenn Sharkord Status sendet)

### Milestone 3 – Packaging
- Windows Installer (NSIS) oder portable zip
- Linux AppImage (und optional .deb)
- Codesigning optional (später)

### Milestone 4 – Screen Share Hardening (Wayland/X11)
- Dokumentation + Troubleshooting
- Testmatrix durchführen und offene Issues sammeln

### Milestone 5 – v1 Release Readiness
- Versionierung (`0.1.0`)
- Changelog + Known Issues
- Artefakte: Windows + Linux Upload
- Installations-/Nutzungsanleitung finalisieren

---

## 11. Tests / Qualität

- Smoke Test: App startet, lädt URL, WebRTC Mic Zugriff möglich.
- Manual QA:
  - Hotkey bei minimiertem Fenster
  - Hotkey bei anderer App im Vordergrund
  - Screen Share unter Wayland + X11
- Optional automatisiert:
  - Playwright: Startet App, prüft Window title / URL loaded (E2E light)

### Definition of Done (projektweit)
- Build läuft lokal reproduzierbar mit dokumentierten Befehlen.
- Hotkey-Funktion inkl. Fehlerpfade manuell getestet.
- Keine kritischen Security-Warnungen in Main/Preload-Konfiguration.
- Readme + Troubleshooting + QA-Checklist sind aktuell.

### Konkrete Testfälle (MVP)
- T1: Hotkey bei fokussiertem Fenster toggelt Mute.
- T2: Hotkey bei minimiertem Fenster toggelt Mute.
- T3: Hotkey bei anderer App im Vordergrund toggelt Mute.
- T4: Hotkey vor Login erzeugt keinen Fehler/Crash.
- T5: Screen Share unter GNOME Wayland erfolgreich startbar.
- T6: Externer Link öffnet Systembrowser, nicht Embedded Navigation.

---

## 12. Offene Fragen (vor Implementierungsstart klären)
- Exakte Sharkord-URL(s): prod/staging?
- Wie ist „Mute“ im Sharkord Code aktuell implementiert (state store, WebRTC track enabled, server signalling)?
- Soll der Hotkey auch funktionieren, wenn der User nicht eingeloggt ist / kein Call aktiv?
- Soll die App mehrere Server/Profile unterstützen?

Entscheidungsvorschlag (wenn unklar, als Default nehmen):
- v1 startet mit **einem** Serverprofil.
- Hotkey ist global aktiv, führt aber ohne aktiven Call nur ein no-op aus.
- Mute-State basiert auf lokalem Audio-Track-Enabled Zustand in Sharkord.

---

## 13. Konkreter Implementierungs-Backlog (arbeitbar)

### Paket A – Desktop-Basis
- Electron + TypeScript Grundgerüst erzeugen.
- BrowserWindow mit Security-Defaults und URL-Load.
- Konfigurationsdatei laden/speichern.

**Abnahme Paket A:**
- `npm run dev` startet App und lädt `serverUrl`.

### Paket B – Bridge v1
- Gemeinsame Message-Typen definieren (`src/shared/bridge.ts`).
- Preload Message-Bus implementieren.
- Main → Preload Triggerpfad für `toggleMute` bereitstellen.

**Abnahme Paket B:**
- Simulierter Command im Main erzeugt Event in Sharkord-Seite (nachweisbar via Log).

### Paket C – Global Hotkey MVP
- Hotkey Registrierung/Unregistrierung kapseln.
- Fehlerbehandlung bei nicht registrierbaren Accelerators.
- Trigger an Bridge senden.

**Abnahme Paket C:**
- Hotkey toggelt Mute auch ohne Fensterfokus.

### Paket D – Tray + Status
- Tray Menü (Toggle Mute, Show/Hide, Quit).
- Status-Rückkanal aus Sharkord anbinden.
- Mute-Indikator im Menü/Icon.

**Abnahme Paket D:**
- Status ändert sich sichtbar bei Hotkey und UI-Mute.

### Paket E – Packaging
- `electron-builder` Konfiguration für Linux + Windows.
- Artefakt-Output testen (mind. AppImage oder .deb + Windows portable/installer).
- Release-Doku ergänzen.

**Build-Befehle (v1):**
- `npm run dist:linux` → Linux AppImage + deb
- `npm run dist:win` → Windows nsis + portable
- `npm run dist:dir` → schneller Smoke-Test ohne Installer

**Output:**
- Artefakte liegen unter `apps/desktop/release/`

**Abnahme Paket E:**
- Installierbares Artefakt startet und erfüllt T1–T3.

---

## 14. Arbeitsmodus mit Copilot (so setzen wir es gemeinsam um)

### Iterationsprinzip
- Wir arbeiten in kleinen Slices: **Plan → Implementierung → lokaler Test → kurzer Review**.
- Jede Iteration endet mit: geänderte Dateien, Start-/Testbefehl, nächster Schritt.

### Prompt-Format für effiziente Zusammenarbeit
Nutze pro Schritt idealerweise:
1. Ziel (z.B. „Implementiere Paket B vollständig“)
2. Scope (welche Dateien dürfen geändert werden)
3. Akzeptanzkriterien (z.B. Testfall T1/T2)
4. Verbote/Nicht-Ziele (z.B. „kein UI, nur Main+Preload“)

Beispiel:
> „Implementiere Paket C (Global Hotkey MVP) in `apps/desktop`. Nutze die Message-Typen aus `src/shared/bridge.ts`, ändere nur Main/Preload/Config. Danach führe einen lokalen Smoke-Test aus und dokumentiere verbleibende Risiken.“

### Reihenfolge für den Start (empfohlen)
1. Paket A
2. Paket B
3. Paket C
4. Paket D
5. Paket E

---

## 15. Risiken & Gegenmaßnahmen (kompakt)

- **Wayland Screen Share inkonsistent je Distro** → frühe QA auf GNOME/KDE + Troubleshooting-Doku.
- **Hotkey-Konflikte mit OS/anderen Apps** → konfigurierbarer Accelerator + klare Fehlermeldung.
- **Bridge driftet gegenüber Sharkord-Webapp** → versionierter Kanal `sharkord-desktop-v1` + READY-Handshake.
- **Security-Regressions in Electron** → feste Security-Checkliste bei jedem Milestone-Review.

---