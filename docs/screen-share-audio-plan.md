# Bildschirmübertragung mit Audio – Technische Planung

Stand: 2026-02-22  
Bezug: Sharkord Desktop Client (Electron), v0.5.2  
Ziel: Bildschirm-/Fensterübertragung mit kontextabhängigem Audio unter **Windows** und **Linux**

---

## Inhaltsverzeichnis

1. [Zielsetzung und Anforderungen](#1-zielsetzung-und-anforderungen)
2. [Ist-Zustand und Probleme](#2-ist-zustand-und-probleme)
3. [Technische Analyse: Warum der aktuelle Ansatz scheitert](#3-technische-analyse-warum-der-aktuelle-ansatz-scheitert)
4. [Lösungsansätze im Vergleich](#4-lösungsansätze-im-vergleich)
5. [Empfohlene Architektur](#5-empfohlene-architektur)
6. [Windows-Implementierung](#6-windows-implementierung)
7. [Linux-Implementierung](#7-linux-implementierung)
8. [Electron-Integration (plattformübergreifend)](#8-electron-integration-plattformübergreifend)
9. [Implementierungs-Roadmap](#9-implementierungs-roadmap)
10. [Risiken und Gegenmaßnahmen](#10-risiken-und-gegenmaßnahmen)
11. [Testplan](#11-testplan)
12. [Anhang: Verworfene Ansätze](#12-anhang-verworfene-ansätze)

---

## 1. Zielsetzung und Anforderungen

### Zwei Modi der Audioübertragung

| Modus | Videoinhalt | Audioinhalt |
|---|---|---|
| **Fensterübertragung** | Ein bestimmtes Anwendungsfenster | **Nur** der Sound dieser Anwendung |
| **Bildschirmübertragung** | Gesamter Bildschirminhalt | Gesamter Systemsound, **ohne** den Ton des Sharkord-Desktop-Client selbst |

### Plattformen

- **Windows 10/11** (x64)
- **Linux** (X11 + Wayland, primär GNOME/KDE mit PipeWire)

### Qualitätsziele

- Audio-Latenz ≤ 50 ms (Capture → WebRTC-Track)
- Keine zusätzliche Treiberinstallation durch den Nutzer erforderlich
- Audio muss synchron zum Video-Stream laufen
- Robuster Fallback bei fehlender Unterstützung (nur Video statt Crash)
- Integration in den vorhandenen Source-Picker

---

## 2. Ist-Zustand und Probleme

### Vorhandene Komponenten

```
permissions.ts → setDisplayMediaRequestHandler()
  ├── desktopCapturer.getSources() → Source-Picker (eigenes Fenster)
  ├── audio: "loopback" (bei screenShareSystemAudio=true)
  └── Windows App-Audio:
      ├── C#-Helper (SharkordAppAudioHelper.exe) → NAudio/WASAPI
      ├── windowsAppAudio.ts → spawnt Helper, liest Device-ID
      └── Preload: getUserMedia({ audio: { deviceId: { exact: id } } })
```

### Bestehende Config-Werte

- `screenShareSystemAudio: boolean` – steuert `audio: "loopback"` im `setDisplayMediaRequestHandler`-Callback
- `windowsAppAudioCapture.enabled: boolean` – aktiviert den Windows-Helper-Pfad
- `windowsAppAudioCapture.helperExecutablePath: string` – optionaler expliziter Pfad zum Helper

### Bekannte Probleme

1. **Windows Helper funktioniert nicht:** Der C#-Helper gibt Windows MMDevice-Render-Endpoint-IDs zurück (z.B. `{0.0.0.00000000}.{GUID}`). Chromium/Electron hasht Device-IDs pro Origin und enumeriert nur **Capture**-Geräte (Mikrofone) für `getUserMedia`. Die vom Helper zurückgegebene ID ist keine gültige `deviceId` für `getUserMedia`.
2. **`audio: "loopback"` ist Alles-oder-Nichts:** Electrons `loopback`-Option fängt den gesamten Systemsound ohne Filterung – inklusive des eigenen Client-Tons.
3. **Linux hat gar keinen Audio-Capture-Pfad:** xdg-desktop-portal ScreenCast liefert nur Video, kein Audio.

---

## 3. Technische Analyse: Warum der aktuelle Ansatz scheitert

### Das Device-ID-Problem (Windows)

```
NAudio-Helper gibt zurück:     {0.0.1.00000000}.{GUID}  (MMDevice Capture Endpoint)
Chromium erwartete deviceId:    sha256-hash-per-origin    (interner Identifier)
→ getUserMedia({ audio: { deviceId: { exact: "..." } } }) → OverconstrainedError
```

Chromium's Media-Device-Enumeration funktioniert so:
1. `navigator.mediaDevices.enumerateDevices()` listet nur echte Hardware-Eingabegeräte (Mikrofone)
2. Device-IDs sind Origin-spezifische Hashes – keine Korrelation zu Windows MMDevice-IDs
3. Loopback/Monitor-Devices tauchen **nicht** in der Enumeration auf

**Fazit:** Es gibt keinen Weg, über `getUserMedia` mit einer MMDevice-ID Loopback-Audio abzugreifen. Der gesamte Ansatz „Helper findet Device-ID → Preload nutzt `getUserMedia`" ist ein Sackgasse.

### Die Loopback-Limitation (beide Plattformen)

Electrons `audio: "loopback"` in `setDisplayMediaRequestHandler`:
- Fängt **allen** Systemsound inklusive des eigenen App-Audio
- Kein Parameter zum Ausschließen einzelner Apps
- Kein Parameter für per-Window-Audio
- Electron bietet kein `loopbackInExcludeList` o.Ä.

---

## 4. Lösungsansätze im Vergleich

### Übersicht

| Ansatz | Per-Window Audio | System ohne Self | Windows | Linux | User-Friction | Komplexität |
|--------|:---:|:---:|:---:|:---:|:---:|:---:|
| **A) Nativer Helper (WASAPI / PipeWire)** | ✅ | ✅ | ✅ | ✅ | Keine | Hoch |
| **B) Virtual Audio Cable** | ⚠️ | ✅ | ✅ | ✅ | Treiberinstallation | Mittel |
| **C) Electron `loopback` + Workaround** | ❌ | ❌ | ✅ | ❌ | Keine | Niedrig |
| **D) Node.js Native Addon (N-API)** | ✅ | ✅ | ✅ | ✅ | Keine | Sehr hoch |

### Bewertung

- **Ansatz A (Empfohlen):** Zwei plattformspezifische Helper-Binaries, die rohe PCM-Daten über stdout streamen. In Electron über AudioWorklet in einen WebRTC-Track umgewandelt. Dies ist der Ansatz, den Discord und OBS Studio verwenden.
- **Ansatz B:** Funktioniert, aber erfordert Treiberinstallation → inakzeptable User-Friction für eine Consumer-App.
- **Ansatz C:** Löst keines der Kernprobleme (kein per-Window, kein Self-Exclude).
- **Ansatz D:** Höchste Performance, aber extreme Build-Komplexität (Cross-Compile native Addons für jede Plattform, Electron ABI-Kompatibilität).

---

## 5. Empfohlene Architektur

### Architektur-Diagramm

```
┌──────────────────────────────────────────────────────────────────┐
│                        Electron App                              │
│                                                                  │
│  ┌─────────────┐    IPC     ┌─────────────┐    postMessage       │
│  │  Main Process│◄─────────►│   Preload    │◄──────────────►Page │
│  │             │            │             │                      │
│  │  ┌──────────┤            │  ┌──────────┤                      │
│  │  │ Audio    │  stdout    │  │ AudioWork│                      │
│  │  │ Manager  │◄───────────┤  │ let Node │──►MediaStreamTrack   │
│  │  │          │  (PCM f32) │  │          │   ──►addTrack()      │
│  │  └────┬─────┤            │  └──────────┤      to stream       │
│  │       │     │            │             │                      │
│  └───────┼─────┘            └─────────────┘                      │
│          │                                                       │
│          │ spawn + pipe stdout                                   │
│          ▼                                                       │
│  ┌───────────────────┐                                           │
│  │  Platform Helper  │                                           │
│  │  (native binary)  │                                           │
│  │                   │                                           │
│  │  Windows: C++ exe │                                           │
│  │  (WASAPI Process  │                                           │
│  │   Loopback)       │                                           │
│  │                   │                                           │
│  │  Linux: C/Rust    │                                           │
│  │  (libpulse /      │                                           │
│  │   PipeWire)       │                                           │
│  └───────────────────┘                                           │
└──────────────────────────────────────────────────────────────────┘
```

### Datenfluss

```
1. User startet Screen Share im Source-Picker
2. Main Process erkennt Quellentyp (Fenster vs. Bildschirm)
3. Main spawnt plattformspezifischen Audio-Helper:
   - Fenster → --mode include --pid <target_pid>
   - Bildschirm → --mode exclude --pid <electron_pid>
4. Helper captured Audio, schreibt PCM float32 LE auf stdout
5. Main liest stdout, sendet Chunks per IPC an Preload
6. Preload: AudioWorkletNode nimmt PCM-Chunks entgegen
7. AudioWorkletNode → createMediaStreamDestination() → MediaStreamTrack
8. Track wird zum bestehenden DisplayMedia-Stream hinzugefügt (stream.addTrack())
9. WebRTC überträgt Audio zusammen mit Video
```

### Audio-Format-Konvention (Helper → Electron)

```
Format:    PCM, 32-bit float, little-endian
Kanäle:    2 (Stereo)
Samplerate: 48000 Hz
Byte/Frame: 8 (2 × 4 Byte)
Übertragung: stdout (raw binary, kein Header, kein Container)
```

Warum kein WAV/Opus? Raw PCM vermeidet Encoding-Overhead im Helper und Decoding in JS. Die AudioWorklet kann float32-Samples direkt verwenden.

---

## 6. Windows-Implementierung

### 6.1 API: WASAPI Process Loopback (Windows 10 2004+)

Windows 10 Version 2004 (Build 19041) hat eine spezifische API für per-Prozess Audio-Capture eingeführt: **AUDIOCLIENT_PROCESS_LOOPBACK_MODE**.

```
ActivateAudioInterfaceAsync()
  mit VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
  und AUDIOCLIENT_ACTIVATION_PARAMS:
    - PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
    - PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
    - ProcessLoopbackParams.TargetProcessId = <pid>
```

**Zwei Modi:**

| Modus | API-Konstante | Anwendungsfall |
|---|---|---|
| **Include** | `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` | Fensterübertragung: nur Audio der Ziel-App |
| **Exclude** | `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` | Bildschirmübertragung: alles außer Sharkord |

### 6.2 Neuer Windows-Helper (C++ statt C#)

Der bestehende C#-Helper wird **ersetzt** durch einen C++ Helper, der direkt WASAPI Process Loopback nutzt und PCM-Audio auf stdout streamt.

**Warum C++ statt C#?**
- Direkte COM/WASAPI-API-Nutzung ohne .NET-Runtime-Overhead
- Kleines Binary (~100-200 KB vs. ~60 MB self-contained .NET)
- Keine .NET-Runtime-Abhängigkeit auf dem Zielsystem
- Kompilierbar mit MSVC (Visual Studio Build Tools) oder MinGW

**Command-Line Interface:**

```bash
# Fensteraudio: nur Audio von Prozess mit PID 12345
sharkord-audio-helper.exe --mode include --pid 12345

# Systemsound ohne Sharkord: alles außer PID 6789
sharkord-audio-helper.exe --mode exclude --pid 6789

# Optionale Parameter
  --sample-rate 48000    # Default: 48000
  --channels 2           # Default: 2 (Stereo)
  --format f32le         # Default: f32le (float32 little-endian)
```

**Ausgabe:**
- **stdout:** Raw PCM Audio (float32 LE, stereo, 48 kHz) – binär, kein Header
- **stderr:** JSON-Statusmeldungen (Initialisierung, Fehler, Ende)

**Lifecycle:**
1. Helper startet, initialisiert COM & WASAPI
2. Gibt auf stderr: `{"status":"ready","sampleRate":48000,"channels":2}` aus
3. Streamt PCM auf stdout, solange Audio vorhanden
4. Bei Stille: sendet Stille-Frames (Null-Bytes) um den Stream aufrechtzuerhalten
5. Beendet sich bei:
   - stdin-Close / Pipe-Break (Parent-Prozess beendet)
   - Zielprozess beendet sich (bei Include-Mode)
   - Timeout bei Inaktivität (konfigurierbar)

**Build-Anforderungen:**
- Visual Studio Build Tools (MSVC) oder Cross-Compilation mit MinGW
- Windows SDK (für WASAPI-Header: `audioclient.h`, `mmdeviceapi.h`)
- Kein weiteres Framework nötig (rein Win32/COM)

### 6.3 Pseudo-Code Windows-Helper (Kern)

```cpp
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <AudioClientActivationParams.h>

// 1. Activation Params aufbauen
AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
activationParams.ProcessLoopbackParams.TargetProcessId = targetPid;
activationParams.ProcessLoopbackParams.ProcessLoopbackMode =
    includeMode
    ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
    : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

PROPVARIANT activateParams = {};
activateParams.vt = VT_BLOB;
activateParams.blob.cbSize = sizeof(activationParams);
activateParams.blob.pBlobData = (BYTE*)&activationParams;

// 2. Audio-Interface aktivieren
IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
ActivateAudioInterfaceAsync(
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    __uuidof(IAudioClient),
    &activateParams,
    &completionHandler,
    &asyncOp
);
// Warten auf Completion...

// 3. AudioClient initialisieren
audioClient->Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    0, 0, &waveFormat, nullptr
);

// 4. Capture-Loop
audioClient->Start();
while (running) {
    // GetBuffer → PCM-Daten → stdout schreiben
    captureClient->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
    if (numFrames > 0) {
        fwrite(data, sizeof(float) * channels, numFrames, stdout);
        fflush(stdout);
    }
    captureClient->ReleaseBuffer(numFrames);
    Sleep(10); // ~10ms Polling-Intervall
}
```

### 6.4 PID-Ermittlung aus Window-Handle

Der Source-Picker gibt eine `sourceId` im Format `window:<hwnd>:0` zurück. Die PID-Zuordnung ist auf Windows trivial:

```cpp
// Im Helper
DWORD processId;
GetWindowThreadProcessId((HWND)hwnd, &processId);
```

Alternativ kann die PID bereits in Electron ermittelt werden (über den bestehenden `GetWindowThreadProcessId`-Aufruf im alten C#-Helper oder direkt in Node.js via `ffi-napi` / kurzen Systemaufruf).

### 6.5 Mindest-Windows-Version

- **Windows 10, Version 2004** (Build 19041, Mai 2020) für Process Loopback
- Fallback für ältere Windows-Versionen: `audio: "loopback"` (gesamter Systemsound) oder kein Audio

---

## 7. Linux-Implementierung

### 7.1 PipeWire/PulseAudio-Landschaft

Modernes Linux (Ubuntu 22.04+, Fedora 34+, Arch) nutzt **PipeWire** als Audio-Server mit PulseAudio-Kompatibilitätsschicht (`pipewire-pulse`). Der Helper kann die **PulseAudio-API** (`libpulse`) nutzen – das funktioniert sowohl auf reinem PulseAudio als auch auf PipeWire.

### 7.2 Ansatz: Virtual Sink + Stream-Routing

```
┌──────────────────────────────────────────────────────────────┐
│                    PipeWire / PulseAudio                       │
│                                                               │
│  Modus "include" (Fenster-Audio):                            │
│  ┌─────────────┐    move-sink-input    ┌──────────────────┐  │
│  │ Target App  │ ───────────────────► │ Virtual Null-Sink │  │
│  │ (z.B. VLC)  │                      │ "sharkord_capture"│  │
│  └─────────────┘                      └────────┬─────────┘  │
│                                                 │ .monitor   │
│                                                 ▼            │
│                                         ┌──────────────┐     │
│                                         │ Helper liest │     │
│                                         │ PCM → stdout │     │
│                                         └──────────────┘     │
│                                                               │
│  Modus "exclude" (System ohne Self):                         │
│  ┌─────────────┐                                              │
│  │ Alle Apps   │ ──► Default Sink ──► .monitor ──► Helper    │
│  │ außer       │                                              │
│  │ Sharkord    │     Sharkord bleibt auf eigenem Sink         │
│  └─────────────┘     (oder wird auf Null-Sink umgeleitet)    │
└──────────────────────────────────────────────────────────────┘
```

### 7.3 Linux-Helper (C mit libpulse)

**Warum C mit libpulse?**
- `libpulse` ist auf nahezu allen Desktop-Linux-Distros vorhanden (als Teil von PulseAudio oder `pipewire-pulse`)
- Deutlich einfachere API als native `libpipewire`
- Funktioniert identisch auf PulseAudio und PipeWire
- Alternative: Rust mit `libpulse-binding` crate (sicherer, aber mehr Build-Aufwand)

**Command-Line Interface (identisch zum Windows-Helper):**

```bash
# Fensteraudio: nur Audio von App mit PID 12345
sharkord-audio-helper --mode include --pid 12345

# Systemsound ohne Sharkord: alles außer PID 6789
sharkord-audio-helper --mode exclude --pid 6789

# Optionale Parameter
  --sample-rate 48000
  --channels 2
  --format f32le
  --app-name "Firefox"    # Alternative Zuordnung über App-Name
```

### 7.4 Ablauf des Linux-Helpers

#### Include-Mode (Fenster-Audio)

```
1. Null-Sink erstellen:
   pactl load-module module-null-sink
     sink_name=sharkord_capture
     sink_properties=device.description="Sharkord Capture"

2. Audio-Stream der Ziel-App finden:
   - Alle Sink-Inputs auflisten (pa_context_get_sink_input_info_list)
   - Nach PID filtern (property "application.process.id")
   - Fallback: nach App-Name filtern ("application.name")

3. Ziel-Stream auf Null-Sink umleiten:
   pactl move-sink-input <input_index> sharkord_capture

4. Monitor-Source des Null-Sink lesen:
   pa_simple_new(..., "sharkord_capture.monitor", PA_STREAM_RECORD, ...)
   
5. Capture-Loop:
   while(running) {
     pa_simple_read(simple, buffer, bufferSize, &error);
     fwrite(buffer, 1, bufferSize, stdout);
   }

6. Cleanup:
   - Stream zurück auf Original-Sink bewegen
   - Null-Sink-Modul entladen
```

#### Exclude-Mode (System ohne Self)

```
1. Sharkords eigenen Sink-Input finden (PID = eigener PID oder Electron-PID)
2. Null-Sink erstellen: "sharkord_self_sink"  
3. Sharkord-Audio auf Null-Sink umleiten (Audio wird verworfen)
4. Default-Sink-Monitor lesen (= alles was die Lautsprecher abspielt, minus Sharkord)
5. Bei neuen Streams: prüfen ob Sharkord → auf Null-Sink leiten
   (über pa_context_subscribe für PA_SUBSCRIPTION_EVENT_SINK_INPUT)
6. Cleanup: Sharkord-Stream zurück auf Default-Sink
```

### 7.5 PID ↔ Fenster-Zuordnung auf Linux

| Session | Methode | Zuverlässigkeit |
|---|---|---|
| **X11** | `xdotool getwindowpid <window_id>` oder `_NET_WM_PID`-Property | Hoch |
| **Wayland** | Kein Standard-Mechanismus für Window→PID | Problematisch |

**Wayland Workaround-Strategien:**

1. **App-Name Matching:** Der Source-Picker gibt den Fenstertitel zurück. PipeWire-Nodes haben `application.name` und `media.name` Properties. Heuristisches Matching (case-insensitive contains).
2. **PID aus Portal-Info (experimentell):** Manche Portal-Implementierungen (GNOME) liefern PID-Information. Nicht standardisiert.
3. **Manuelle Audio-Quellen-Auswahl:** Fallback-UI im Source-Picker: „Audio von welcher Quelle?" mit einer Liste der aktiven PipeWire-Audio-Streams. Der User wählt explizit.
4. **`/proc`-Scanning:** Alle laufenden Prozesse durchsuchen und deren `comm`/`cmdline` mit dem Fensternamen abgleichen.

**Empfehlung:** X11-PID-Lookup als Primary, Wayland-Name-Matching als Heuristik, mit manuellem Picker als Fallback.

### 7.6 Voraussetzungen auf dem Zielsystem

```
Zwingend:
  - pipewire (oder pulseaudio)
  - pipewire-pulse (wenn PipeWire) ODER pulseaudio (wenn legacy)

Bereits vorhanden auf:
  - Ubuntu 22.04+ (PipeWire Standard seit 23.04, optional seit 22.04)
  - Fedora 34+ (PipeWire Standard)
  - Arch Linux (PipeWire Standard in Desktop-Installationen)
  - Debian 12+ (PipeWire als Option, teils Standard mit GNOME)

Für den Helper:
  - Die Binärdatei wird statisch gegen libpulse gelinkt oder
  - libpulse als dynamische Abhängigkeit (auf Desktop-Distros überall vorhanden)
```

---

## 8. Electron-Integration (plattformübergreifend)

### 8.1 Neuer Audio-Manager (Main Process)

Eine neue Klasse `AudioCaptureManager` in `src/main/audio-capture/` koordiniert den Lifecycle:

```typescript
// src/main/audio-capture/manager.ts

export interface AudioCaptureOptions {
  mode: "include" | "exclude";
  pid: number;
  sampleRate?: number;  // Default: 48000
  channels?: number;    // Default: 2
}

export class AudioCaptureManager {
  private helperProcess: ChildProcess | null = null;
  private mainWindow: BrowserWindow | null = null;
  
  constructor(private config: DesktopConfig) {}

  /** Startet den plattformspezifischen Audio-Helper */
  async startCapture(options: AudioCaptureOptions): Promise<boolean> {
    const helperPath = this.resolveHelperPath();
    if (!helperPath) return false;
    
    this.helperProcess = spawn(helperPath, [
      "--mode", options.mode,
      "--pid", String(options.pid),
      "--sample-rate", String(options.sampleRate ?? 48000),
      "--channels", String(options.channels ?? 2),
      "--format", "f32le"
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    
    // stdout-Chunks an Preload weiterleiten
    this.helperProcess.stdout.on("data", (chunk: Buffer) => {
      this.mainWindow?.webContents.send("sharkord-desktop:audio-chunk", chunk);
    });
    
    // stderr für Status-JSON lesen
    this.helperProcess.stderr.on("data", (data: Buffer) => {
      this.handleHelperStatus(data.toString());
    });
    
    return true;
  }

  /** Stoppt den Audio-Helper */
  stopCapture(): void {
    if (this.helperProcess) {
      this.helperProcess.kill();
      this.helperProcess = null;
    }
    this.mainWindow?.webContents.send("sharkord-desktop:audio-stop");
  }

  private resolveHelperPath(): string | null {
    // Plattformspezifischer Pfad
    const filename = process.platform === "win32"
      ? "sharkord-audio-helper.exe"
      : "sharkord-audio-helper";
    // ... Kandidaten durchsuchen (analog zu findHelperPath)
  }
}
```

### 8.2 Preload: AudioWorklet für PCM → MediaStreamTrack

```typescript
// In preload/index.ts oder separates Modul

// AudioWorklet-Processor als inline String (wird als Blob-URL geladen)
const AUDIO_WORKLET_PROCESSOR = `
class PcmInjectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    this.port.onmessage = (e) => {
      // Neue PCM-Daten anhängen
      const incoming = new Float32Array(e.data);
      const merged = new Float32Array(this.buffer.length + incoming.length);
      merged.set(this.buffer);
      merged.set(incoming, this.buffer.length);
      this.buffer = merged;
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channelCount = output.length;
    const frameCount = output[0].length; // typisch 128
    const samplesNeeded = frameCount * channelCount;
    
    if (this.buffer.length >= samplesNeeded) {
      // Deinterleave: [L,R,L,R,...] → separate Kanäle
      for (let frame = 0; frame < frameCount; frame++) {
        for (let ch = 0; ch < channelCount; ch++) {
          output[ch][frame] = this.buffer[frame * channelCount + ch];
        }
      }
      this.buffer = this.buffer.slice(samplesNeeded);
    } else {
      // Stille, wenn zu wenig Daten
      for (let ch = 0; ch < channelCount; ch++) {
        output[ch].fill(0);
      }
    }
    
    return true; // Keep processor alive
  }
}

registerProcessor('pcm-injector', PcmInjectorProcessor);
`;

async function createAudioTrackFromHelper(): Promise<MediaStreamTrack | null> {
  const audioContext = new AudioContext({ sampleRate: 48000 });
  
  // AudioWorklet registrieren
  const blob = new Blob([AUDIO_WORKLET_PROCESSOR], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  
  // Processor-Node erstellen
  const workletNode = new AudioWorkletNode(audioContext, "pcm-injector", {
    outputChannelCount: [2]
  });
  
  // MediaStream-Destination erstellen
  const destination = audioContext.createMediaStreamDestination();
  workletNode.connect(destination);
  
  // IPC-Listener: PCM-Chunks vom Main Process empfangen
  ipcRenderer.on("sharkord-desktop:audio-chunk", (_event, chunk: ArrayBuffer) => {
    workletNode.port.postMessage(chunk, [chunk]);
  });
  
  ipcRenderer.on("sharkord-desktop:audio-stop", () => {
    workletNode.disconnect();
    audioContext.close();
  });
  
  // MediaStreamTrack zurückgeben
  const [track] = destination.stream.getAudioTracks();
  return track ?? null;
}
```

### 8.3 Integration in den Display-Media-Handler

Der bestehende `applyDisplayMediaHandler` in `permissions.ts` wird erweitert:

```typescript
// In applyDisplayMediaHandler, nach Source-Picker-Auswahl:

const isWindowSource = selectedSource.id.startsWith("window:");
const isScreenSource = selectedSource.id.startsWith("screen:");

// PID ermitteln
let targetPid: number | null = null;
if (isWindowSource) {
  targetPid = await getProcessIdForSource(selectedSource.id);
}

// Audio-Capture starten
if (isWindowSource && targetPid) {
  // Fenster-Modus: nur Audio der Ziel-App
  await audioCaptureManager.startCapture({
    mode: "include",
    pid: targetPid
  });
} else if (isScreenSource) {
  // Bildschirm-Modus: System-Audio ohne Sharkord
  await audioCaptureManager.startCapture({
    mode: "exclude",
    pid: process.pid  // Electron-Prozess ausschließen
  });
}

// Der Audio-Track wird im Preload an den Stream angehängt
// (über den bestehenden getDisplayMedia-Patch)
```

### 8.4 IPC-Optimierung: SharedArrayBuffer oder Transfer

Für Audio-Streaming bei 48 kHz / Stereo / float32 fallen an:
```
48000 Samples × 2 Kanäle × 4 Bytes = 384.000 Bytes/Sekunde = ~375 KB/s
```

Bei 10ms-Chunks: ~3.840 Bytes pro Chunk, ~100 Chunks/Sekunde.

**Optimierungsmöglichkeiten:**
1. **Transferable Objects:** `postMessage(buffer, [buffer])` – Zero-Copy-Transfer (empfohlen)
2. **SharedArrayBuffer:** Ring-Buffer zwischen Main und Renderer – niedrigste Latenz, aber komplexer
3. **Batching:** Chunks in 20-30ms-Blöcken senden statt 10ms (weniger IPC-Overhead)

**Empfehlung v1:** Transferable Objects mit 20ms-Chunks.

---

## 9. Implementierungs-Roadmap

### Phase 0: Vorbereitung (1-2 Tage)

- [ ] Bestehenden C#-Helper und `windowsAppAudio.ts` als deprecated markieren
- [ ] Projektstruktur für neue Helper vorbereiten:
  ```
  helpers/
    audio-capture/
      windows/
        src/main.cpp
        CMakeLists.txt
      linux/
        src/main.c
        Makefile
  src/main/
    audio-capture/
      manager.ts
      types.ts
  ```
- [ ] Build-Skripte für die neuen Helper anlegen

### Phase 1: Windows Audio-Helper (3-5 Tage)

- [ ] C++ Helper mit WASAPI Process Loopback implementieren
  - COM-Initialisierung
  - `ActivateAudioInterfaceAsync` mit Include/Exclude-Mode
  - PCM-Capture-Loop → stdout
  - Status-JSON → stderr
  - Graceful Shutdown bei stdin-Close
- [ ] CLI-Parameter parsing (--mode, --pid, --sample-rate, etc.)
- [ ] Build mit CMake oder MSBuild
- [ ] Isolierter Test: Helper manuell starten, Audio zu WAV pipen
- [ ] electron-builder Config aktualisieren (neues Binary statt altes)

### Phase 2: AudioCaptureManager + Preload (3-4 Tage)

- [ ] `AudioCaptureManager` Klasse (Main Process)
  - Helper starten/stoppen
  - stdout-Chunks per IPC weiterleiten
  - Error-Handling und Timeout
- [ ] AudioWorklet Processor im Preload
  - PCM-Injection
  - MediaStreamTrack-Erzeugung
- [ ] Integration in `getDisplayMedia`-Patch
  - Track an DisplayMedia-Stream anhängen
  - Bei Stream-Ende: Helper stoppen
- [ ] Source-Picker aktualisieren: Audio-Status anzeigen

### Phase 3: Linux Audio-Helper (3-5 Tage)

- [ ] C Helper mit libpulse implementieren
  - Null-Sink erstellen
  - Sink-Inputs nach PID finden
  - Stream-Umleitung
  - Monitor-Source lesen → stdout
  - Cleanup bei Exit
- [ ] Exclude-Mode implementieren
  - Eigenen Stream auf Null-Sink leiten
  - Default-Monitor lesen
  - Neue Streams überwachen (pa_context_subscribe)
- [ ] PID-Ermittlung für X11 und Wayland-Heuristik
- [ ] Build (gcc/Makefile, statisch oder mit libpulse-Abhängigkeit)
- [ ] Isolierter Test auf Linux

### Phase 4: Integration und Testen (2-3 Tage)

- [ ] End-to-End-Test Windows: Fensterübertragung mit Ton
- [ ] End-to-End-Test Windows: Bildschirmübertragung ohne Self-Audio
- [ ] End-to-End-Test Linux X11: Fensterübertragung
- [ ] End-to-End-Test Linux Wayland: Bildschirmübertragung
- [ ] Fallback-Verhalten testen (Helper nicht vorhanden → nur Video)
- [ ] Audio-Latenz messen
- [ ] Config-Werte und Picker-UI finalisieren

### Phase 5: Packaging und Dokumentation (1-2 Tage)

- [ ] electron-builder: Helper-Binaries in extraResources
- [ ] Build-Skripte für Cross-Compilation
- [ ] `README.md` und Troubleshooting aktualisieren
- [ ] Changelog und Release Notes

### Geschätzter Gesamtaufwand: 13-21 Tage

---

## 10. Risiken und Gegenmaßnahmen

| Risiko | Wahrscheinlichkeit | Impact | Gegenmaßnahme |
|--------|:---:|:---:|---|
| WASAPI Process Loopback nicht auf Windows < 2004 | Mittel | Mittel | Fallback auf `audio: "loopback"` (Gesamtsystem) mit Warnung im Picker |
| PID-Zuordnung auf Wayland unzuverlässig | Hoch | Mittel | Name-Matching + manueller Audio-Source-Picker als Fallback |
| Audio-Latenz merkbar > 50ms | Niedrig | Mittel | Chunk-Größe reduzieren, SharedArrayBuffer evaluieren |
| IPC-Overhead bei hoher Chunk-Rate | Niedrig | Niedrig | Transferable Objects, größere Chunks |
| libpulse nicht verfügbar auf minimalen Linux-Installationen | Niedrig | Hoch | Statisches Linking, Fehlermeldung im Picker |
| Helper-Crash während Capture | Mittel | Mittel | `on("exit")` Handler, automatisches Cleanup, Graceful Degradation |
| Electron-Update bricht AudioWorklet | Niedrig | Hoch | AudioWorklet ist Web-Standard, stabil in Chromium |
| Ziel-App hat kein Audio bei Start des Captures | Mittel | Niedrig | Polling auf Audio-Session (Windows) / Sink-Input (Linux), Retry-Logik |
| Cross-Compilation der nativen Helper | Mittel | Mittel | CI/CD mit passenden Build-Targets, Docker für Linux-Builds |

---

## 11. Testplan

### Manuelle Testfälle

| ID | Test | Windows | Linux X11 | Linux Wayland |
|---|---|:---:|:---:|:---:|
| T-A1 | Fensterübertragung eines YouTube-Videos in Firefox: nur Firefox-Audio hörbar | ✓ | ✓ | ✓ |
| T-A2 | Während T-A1: eigene Musik-App spielt → deren Audio ist NICHT im Stream | ✓ | ✓ | ✓ |
| T-A3 | Bildschirmübertragung: Systemaudio hörbar | ✓ | ✓ | ✓ |
| T-A4 | Während T-A3: Sharkord-Client spielt Notification-Sound → NICHT im Stream | ✓ | ✓ | ✓ |
| T-A5 | Fensterübertragung einer App ohne Sound → kein Rauschen/Artefakte | ✓ | ✓ | ✓ |
| T-A6 | Stream-Ende: Audio-Capture stoppt sauber, kein Orphan-Helper-Prozess | ✓ | ✓ | ✓ |
| T-A7 | Ziel-App schließt sich während Capture → Graceful Stop | ✓ | ✓ | ✓ |
| T-A8 | Helper nicht vorhanden → Video-Stream funktioniert ohne Audio, kein Crash | ✓ | ✓ | ✓ |
| T-A9 | 30-Minuten-Dauertest: kein Memory-Leak, kein Drift | ✓ | ✓ | ✓ |
| T-A10 | Audio-Latenz subjektiv akzeptabel (< 100ms) | ✓ | ✓ | ✓ |

### Automatisierte Checks

- Helper startet und beendet sich korrekt (Unit/Integration-Test)
- Kein Orphan-Prozess nach App-Exit (`pkill -0` Check)
- AudioWorklet erzeugt gültige Samples aus Test-PCM-Daten

---

## 12. Anhang: Verworfene Ansätze

### A) Virtual Audio Cable / VB-Cable

**Problem:** Erfordert Treiberinstallation auf dem Endnutzer-System. Nicht automatisierbar, erfordert Admin-Rechte. Inakzeptable User-Friction.

### B) Node.js Native Addon (N-API)

**Problem:** Höchste potenzielle Performance, aber extreme Build-Komplexität. Electron-ABI-Versionierung, Cross-Compilation für Windows + Linux, Rebuild bei Electron-Updates. Wartungsaufwand unverhältnismäßig für dieses Feature.

### C) Electrons `audio: "loopback"` allein

**Problem:** Erfüllt keine der Kernanforderungen:
- Kein per-Window-Audio
- Kein Self-Exclude
- Nur Windows (nicht Linux)

### D) GStreamer Pipeline (Linux)

**Problem:** Funktionsfähig, aber Overkill. Große Abhängigkeit, komplexe Pipeline-Syntax, kein Vorteil gegenüber libpulse für einfaches PCM-Capture. Für zukünftiges Opus-Encoding im Helper ggf. re-evaluieren.

### E) Bestehender C#-Helper reparieren

**Problem:** Das fundamentale Problem (MMDevice-IDs ≠ Chromium-deviceId) ist nicht lösbar, ohne den Datenfluss komplett zu ändern. Der Helper müsste selbst PCM-Daten streamen statt nur eine Device-ID zurückzugeben → dann ist ein Neubau in C++ effizienter als den .NET-Wrapper beizubehalten.

### F) `navigator.mediaDevices.getUserMedia` mit Loopback-Device

**Problem:** Chromium enumeriert keine Loopback-Devices. Auch auf Linux mit PipeWire/PulseAudio-Monitoren: diese tauchen nicht als `audioinput`-Geräte in `enumerateDevices()` auf. Der MediaDevices-Ansatz ist für Loopback-Capture ungeeignet.

---

## Zusammenfassung

Der einzige gangbare Weg für kontextabhängiges Audio-Capture in Electron ist ein **nativer Helper-Prozess pro Plattform**, der OS-spezifische APIs (WASAPI Process Loopback / libpulse) nutzt und PCM-Audio über stdout an Electron streamt. Die Integration erfolgt über IPC + AudioWorklet → MediaStreamTrack → WebRTC.

Dieser Ansatz:
- Erfordert keine Treiberinstallation
- Funktioniert auf Windows 10 2004+ und Linux mit PipeWire/PulseAudio
- Unterstützt beide Modi (per-Window Include und System-Exclude)
- Ist wartbar und unabhängig von Electron-API-Änderungen
- Wird von Discord und OBS Studio in ähnlicher Form eingesetzt
