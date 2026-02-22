# Windows Audio Capture Research for Electron Desktop App

> Date: 2026-02-22  
> Context: Sharkord Desktop — per-app audio capture (window share) and system-minus-self audio capture (full screen share)

---

## Current Implementation & Why It Fails

The current approach spawns a .NET helper (`SharkordAppAudioHelper`) that:
1. Receives a `window:<handle>:0` source ID from Electron's `desktopCapturer`
2. Calls `GetWindowThreadProcessId` to get the process ID
3. Enumerates WASAPI render endpoints via `MMDeviceEnumerator`
4. Finds audio sessions matching the process ID
5. Attempts to map the render endpoint ID (`{0.0.0.00000000}.{GUID}`) to a capture endpoint ID (`{0.0.1.00000000}.{GUID}`)
6. Returns this "capture device ID" to the preload script
7. The preload calls `navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: captureDeviceId } } })`

**Why it fails:** Windows MMDevice endpoint IDs (e.g., `{0.0.0.00000000}.{e6327cad-...}`) are **not** valid Chromium `deviceId` values. Chromium generates its own opaque device IDs (base64-encoded hashes like `communications` or `default` or a SHA-256 derived string). There is no 1:1 mapping between MMDevice IDs and Chromium device IDs exposed to `getUserMedia`. The render→capture ID string replacement (`0.0.0` → `0.0.1`) is also incorrect — loopback capture in WASAPI doesn't work by swapping data flow direction in the endpoint ID.

---

## Topic 1: Windows Audio Session API (WASAPI) Loopback Capture

### Standard WASAPI Loopback

WASAPI has a well-documented **loopback capture** mode: you open a render endpoint in `AUDCLNT_STREAMFLAGS_LOOPBACK` mode and receive a copy of all audio being rendered to that endpoint.

```cpp
// Standard WASAPI loopback — captures ALL audio on the endpoint
IAudioClient* pAudioClient;
pDevice->Activate(IID_IAudioClient, CLSCTX_ALL, NULL, (void**)&pAudioClient);

WAVEFORMATEX* pwfx;
pAudioClient->GetMixFormat(&pwfx);
pAudioClient->Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK,  // ← loopback flag
    bufferDuration, 0, pwfx, NULL
);
```

**Limitation:** This captures the **entire mix** on that endpoint — all applications outputting to that device. It does NOT support per-process filtering.

### Windows 10 2004+ Process Loopback (IAudioClient3)

Starting with **Windows 10 version 2004 (build 19041)**, Microsoft added per-process audio loopback via `AUDCLNT_STREAMFLAGS_LOOPBACK` combined with `SetClientProperties` and activation parameters:

```cpp
// Windows 10 2004+ per-process loopback capture
AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
activationParams.ProcessLoopbackParams.ProcessLoopbackMode = 
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;   // capture ONLY this process
    // or: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE  // capture ALL EXCEPT this process
activationParams.ProcessLoopbackParams.TargetProcessId = targetPid;

PROPVARIANT activateParams = {};
activateParams.vt = VT_BLOB;
activateParams.blob.cbSize = sizeof(activationParams);
activateParams.blob.pBlobData = (BYTE*)&activationParams;

// Use ActivateAudioInterfaceAsync instead of MMDevice
IActivateAudioInterfaceAsyncOperation* asyncOp;
ActivateAudioInterfaceAsync(
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,  // special device string
    __uuidof(IAudioClient),
    &activateParams,
    completionHandler,
    &asyncOp
);
```

This is **exactly** what's needed:
- **`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`** → captures audio from a specific process (window share)
- **`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`** → captures all system audio except a specific process (full screen share, exclude Electron's own PID)

**Key API details:**
- Requires `ActivateAudioInterfaceAsync` (not `IMMDevice::Activate`) with the virtual device string `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`
- The capture format is the default mix format of the default render device
- Available since Windows 10 2004 (May 2020 Update) — widespread coverage by 2026
- Audio is received as PCM data via `IAudioCaptureClient::GetBuffer`

### How to Feed Captured Audio Back to Electron/WebRTC

This is the critical integration challenge. The WASAPI loopback gives raw PCM buffers. To get this into WebRTC:

**Option A: Named Pipe / Shared Memory → Node.js Addon → Web Audio API → MediaStreamTrack**
1. Native process captures WASAPI loopback PCM data
2. Sends it to Node.js via a named pipe, shared memory, or direct N-API addon
3. In the renderer, create a `MediaStreamTrackGenerator` (if available) or use `AudioWorkletNode` + `AudioContext.createMediaStreamDestination()` to produce a `MediaStreamTrack`
4. Add that track to the WebRTC peer connection

**Option B: Virtual Audio Cable (loopback → VAC → getUserMedia)**
1. Native process captures WASAPI loopback PCM data  
2. Writes it to a virtual audio device driver
3. Chromium sees the virtual device as a regular audio input
4. `getUserMedia({ audio: { deviceId: { exact: vacDeviceId } } })` captures from it

**Option C: Electron patch / custom Chromium build**
1. Modify Chromium's audio capture to natively support process loopback
2. Not practical for a shipping application

### Feasibility Assessment

| Aspect | Rating |
|--------|--------|
| Technical Feasibility | **High** — the Windows API exists and works |
| Complexity | **High** — requires native C++ code, IPC to Node.js, and audio pipeline integration |
| End-User Friction | **Low** — no driver install needed, just Windows 10 2004+ |
| Known Limitations | Only captures process tree (child processes included); requires admin/no special privileges; target process must be running and producing audio |

---

## Topic 2: Electron's Built-in Capabilities

### `desktopCapturer` on Windows

`desktopCapturer.getSources({ types: ['screen', 'window'] })` returns a list of capturable screens and windows. Each source has an `id` like `screen:0:0` or `window:12345678:0`.

**Audio:** `desktopCapturer` itself does **not** capture audio. Audio capture is handled separately through `setDisplayMediaRequestHandler`.

### `audio: "loopback"` in `setDisplayMediaRequestHandler`

When you pass `{ video: selectedSource, audio: "loopback" }` in the callback of `setDisplayMediaRequestHandler`:

```typescript
session.setDisplayMediaRequestHandler(async (request, callback) => {
  callback({ video: selectedSource, audio: "loopback" });
});
```

This tells Chromium to capture **all system audio** via WASAPI loopback on the default render endpoint. It's the equivalent of the standard `AUDCLNT_STREAMFLAGS_LOOPBACK` capture.

**What it captures:** ALL audio being rendered on the system's default audio output device — every application's audio mixed together, including the Electron app's own audio.

**What it does NOT do:**
- No per-window/per-process audio isolation
- No exclusion of the Electron app's own audio
- Just a raw system-wide loopback

### `loopbackInExcludeList` — Electron's Approach to Self-Exclusion

Electron (Chromium) does NOT currently have a `loopbackInExcludeList` parameter or equivalent. The standard `audio: "loopback"` captures everything.

**Chromium bug tracker references:**
- There has been discussion about adding process-loopback support to Chromium's `getDisplayMedia`, but as of early 2026, Chromium still uses simple WASAPI loopback without per-process filtering.
- The `excludeSelfBrowserSurface` constraint in the Screen Capture API only affects which surfaces are offered in the picker — it does NOT exclude audio.

### Per-Window Audio Through Electron APIs

**Not available.** Electron has no built-in API to capture audio from a specific window. The `desktopCapturer` source picker selects a video source; audio is either "loopback" (all system audio) or nothing.

### Feasibility Assessment

| Aspect | Rating |
|--------|--------|
| Per-window audio via Electron | **Not possible** — no API exists |
| System audio (loopback) | **High feasibility** — works out of the box with `audio: "loopback"` |
| Excluding own audio | **Not possible** via Electron APIs alone |
| Complexity | **Low** for system-wide loopback; **N/A** for per-process |
| End-User Friction | **None** for system loopback |

---

## Topic 3: Virtual Audio Cable / Virtual Audio Device Approach

### Concept

A virtual audio device driver creates a "fake" audio device visible to Windows and Chromium. Audio written to the driver's render endpoint appears on its capture endpoint. The workflow:

1. Install a virtual audio cable (VAC) driver
2. Native code captures per-process audio (via WASAPI process loopback) and writes it to the VAC's render endpoint
3. Chromium sees the VAC as a regular audio input device
4. `getUserMedia({ audio: { deviceId: { exact: vacDeviceId } } })` captures from it
5. The resulting `MediaStreamTrack` is added to the WebRTC connection

### Available Solutions

| Solution | Type | License | Notes |
|----------|------|---------|-------|
| **VB-Audio VB-Cable** | Driver | Donationware | Popular, single virtual cable free, additional cables paid |
| **Virtual Audio Cable (VAC)** by Muzychenko | Driver | Commercial ($30+) | Up to 256 virtual cables, professional-grade |
| **BlackHole** | Driver | Open-source (MIT) | macOS only — not applicable |
| **Windows Audio Device Graph Isolation** | N/A | N/A | Not a virtual cable — it's Microsoft's audio engine process |
| **Voicemeeter** | Driver | Donationware | Virtual mixer with routing — overkill for this use case |
| **SoundVolumeView / NirSoft** | Utility | Freeware | No virtual driver — just a UI for audio sessions |
| **obs-virtual-cam** / OBS approach | Driver/Plugin | Open-source | OBS uses WASAPI loopback + its own virtual devices |

### Custom Driver Option

Writing a custom virtual audio device driver is possible using:
- **Windows Audio Device Driver (WaveRT)**: Kernel-mode driver — extremely complex, requires WHQL signing for Windows 10+
- **AVStream Virtual Audio**: Using the AVStream mini-driver framework — still kernel-mode, requires signing
- **Windows.Devices.Custom + UWP**: Not applicable for audio devices

**Audio Loopback + VAC Pipeline:**
```
[Target App] → Windows Audio Engine → WASAPI Process Loopback (native code)
  → PCM data → Write to VAC input → VAC output → Chromium getUserMedia → WebRTC
```

### Feasibility Assessment

| Aspect | Rating |
|--------|--------|
| Technical Feasibility | **High** — proven approach used by OBS, Discord, etc. |
| Complexity | **Medium** if using existing VAC; **Very High** if writing custom driver |
| End-User Friction | **High** — requires third-party driver installation, admin rights, potential compatibility issues, some VACs cost money |
| Known Limitations | Users must install and configure a separate driver; some antivirus software flags virtual audio drivers; Windows driver signing requirements for custom drivers |

**Verdict:** Using an existing VAC as a dependency is workable but creates significant end-user friction. Not recommended as the primary approach for a consumer app.

---

## Topic 4: Windows Audio Graph API (AudioGraph)

### Overview

`Windows.Media.Audio.AudioGraph` is a UWP/WinRT API for building audio processing graphs. It provides higher-level abstractions than WASAPI.

```csharp
// C# / WinRT
var settings = new AudioGraphSettings(AudioRenderCategory.Media);
var result = await AudioGraph.CreateAsync(settings);
var audioGraph = result.Graph;

// Create a loopback capture node (all system audio)
var loopbackResult = await audioGraph.CreateDeviceInputNodeAsync(
    MediaCategory.Media,
    audioGraph.EncodingProperties,
    loopbackDevice  // the render device to capture from
);
```

### Per-Process Capture via AudioGraph

**AudioGraph does NOT natively support per-process audio capture.** It can create a loopback capture input node from a render device, but this captures the full mix on that device — same limitation as basic WASAPI loopback.

The per-process loopback functionality (`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`) is **only** available through the low-level WASAPI/`ActivateAudioInterfaceAsync` API. AudioGraph does not expose this.

### Advantages Over WASAPI

- Simpler API for basic audio graph construction
- Built-in audio effect pipeline
- Automatic format negotiation
- Better for simple scenarios (record system audio to file)

### Disadvantages for This Use Case

- **No per-process loopback** — the critical feature is missing
- Runs in a UWP/WinRT context which may have sandboxing constraints
- Less control over buffer sizes and latency
- Not a good fit for real-time streaming to WebRTC

### Feasibility Assessment

| Aspect | Rating |
|--------|--------|
| Technical Feasibility for per-process | **Low** — API doesn't support it |
| Technical Feasibility for system-wide | **High** — AudioGraph handles this easily |
| Complexity | **Low-Medium** for system-wide; **N/A** for per-process |
| Advantages over WASAPI | **None** for per-process capture |

**Verdict:** AudioGraph is not useful for the per-process use case. WASAPI with `ActivateAudioInterfaceAsync` is the only Windows API that supports per-process audio loopback.

---

## Topic 5: Native Node.js Addon Approach

### Architecture

A native Node.js addon (N-API / node-addon-api) could directly call the Windows WASAPI Process Loopback API and expose captured audio as a readable stream to JavaScript.

```
┌────────────────────────────────────────────────────────────┐
│ Native Addon (C++)                                         │
│  ┌──────────────────────────────┐                          │
│  │ WASAPI Process Loopback      │                          │
│  │ ActivateAudioInterfaceAsync  │                          │
│  │ IAudioCaptureClient          │                          │
│  └──────────┬───────────────────┘                          │
│             │ PCM float32 buffers                          │
│  ┌──────────▼───────────────────┐                          │
│  │ N-API ThreadSafeFunction     │                          │
│  │ → calls JS callback with    │                          │
│  │   Buffer/Float32Array        │                          │
│  └──────────────────────────────┘                          │
└────────────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────┐
│ Electron Main Process                                      │
│  - Receives PCM chunks via IPC or SharedArrayBuffer        │
│  - Sends to renderer via MessagePort/IPC                   │
└────────────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────┐
│ Electron Renderer Process                                  │
│  ┌──────────────────────────────┐                          │
│  │ AudioWorkletNode             │                          │
│  │ (receives PCM chunks via     │                          │
│  │  MessagePort/SAB)            │                          │
│  └──────────┬───────────────────┘                          │
│             │                                              │
│  ┌──────────▼───────────────────┐                          │
│  │ MediaStreamDestination       │                          │
│  │ audioContext                 │                          │
│  │   .createMediaStreamDest()  │                          │
│  └──────────┬───────────────────┘                          │
│             │ MediaStreamTrack                             │
│  ┌──────────▼───────────────────┐                          │
│  │ WebRTC PeerConnection        │                          │
│  │ pc.addTrack(audioTrack)      │                          │
│  └──────────────────────────────┘                          │
└────────────────────────────────────────────────────────────┘
```

### Key Implementation Details

**Native addon (C++ with node-addon-api):**
```cpp
#include <napi.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>

// Simplified — production code needs proper async handling
class ProcessLoopbackCapture : public Napi::ObjectWrap<ProcessLoopbackCapture> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    ProcessLoopbackCapture(const Napi::CallbackInfo& info);
    
    // Start capturing audio from a specific process
    Napi::Value StartCapture(const Napi::CallbackInfo& info);
    // pid: number, mode: 'include' | 'exclude', callback: (buffer: Float32Array) => void
    
    // Stop capturing
    Napi::Value StopCapture(const Napi::CallbackInfo& info);
    
private:
    IAudioClient* m_audioClient = nullptr;
    IAudioCaptureClient* m_captureClient = nullptr;
    std::thread m_captureThread;
    std::atomic<bool> m_running{false};
    Napi::ThreadSafeFunction m_tsfn;
    
    void CaptureLoop();
};

Napi::Value ProcessLoopbackCapture::StartCapture(const Napi::CallbackInfo& info) {
    uint32_t pid = info[0].As<Napi::Number>().Uint32Value();
    std::string mode = info[1].As<Napi::String>().Utf8Value();
    auto callback = info[2].As<Napi::Function>();
    
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = 
        (mode == "include") 
        ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE 
        : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    
    // ... ActivateAudioInterfaceAsync + capture setup ...
    
    m_tsfn = Napi::ThreadSafeFunction::New(
        info.Env(), callback, "AudioCapture", 0, 1);
    
    m_running = true;
    m_captureThread = std::thread(&ProcessLoopbackCapture::CaptureLoop, this);
    
    return info.Env().Undefined();
}
```

**Renderer-side AudioWorklet integration:**
```javascript
// AudioWorklet processor
class AudioBufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.port.onmessage = (event) => {
      // Receive PCM data from main process
      this.buffer.push(new Float32Array(event.data));
    };
  }
  
  process(inputs, outputs) {
    const output = outputs[0];
    if (this.buffer.length > 0) {
      const chunk = this.buffer.shift();
      for (let channel = 0; channel < output.length; channel++) {
        output[channel].set(chunk.subarray(0, output[channel].length));
      }
    }
    return true;
  }
}

// In renderer:
const audioContext = new AudioContext({ sampleRate: 48000 });
await audioContext.audioWorklet.addModule('audio-buffer-processor.js');
const workletNode = new AudioWorkletNode(audioContext, 'audio-buffer-processor');
const destination = audioContext.createMediaStreamDestination();
workletNode.connect(destination);

const audioTrack = destination.stream.getAudioTracks()[0];
// → Add to WebRTC peer connection
peerConnection.addTrack(audioTrack, stream);
```

### Alternative: MediaStreamTrackGenerator (Insertable Streams)

If Electron's Chromium version supports `MediaStreamTrackGenerator` (behind `--enable-blink-features=MediaStreamInsertableStreams`):

```javascript
const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
const writer = generator.writable.getWriter();

// When PCM data arrives from native addon via IPC:
ipcRenderer.on('audio-data', (event, pcmBuffer) => {
  const audioData = new AudioData({
    format: 'f32-planar',
    sampleRate: 48000,
    numberOfFrames: pcmBuffer.length / 4,
    numberOfChannels: 2,
    timestamp: performance.now() * 1000,
    data: pcmBuffer
  });
  writer.write(audioData);
});

// generator is a MediaStreamTrack — add directly to WebRTC
peerConnection.addTrack(generator);
```

**Note:** `MediaStreamTrackGenerator` was removed from the standard track and is not available in current Chromium builds. The `AudioWorklet` + `createMediaStreamDestination` approach is the reliable path.

### Existing npm Packages

| Package | Status | Notes |
|---------|--------|-------|
| `node-audio-loopback` | Does not exist | No published package for per-process loopback |
| `naudiodon` | Exists | Uses PortAudio — supports standard audio I/O but NOT process loopback |
| `node-core-audio` | Exists | Low-level audio I/O — no process loopback |
| `audify` | Exists | Uses RtAudio — no per-process loopback |
| `win-audio` | Exists | Basic volume/mute control via WASAPI — no loopback capture |
| `electron-screen-recorder` | Exists | Uses `desktopCapturer` — same limitations |

**No existing npm package provides Windows per-process audio loopback.** This would need to be a custom native addon.

### Feasibility Assessment

| Aspect | Rating |
|--------|--------|
| Technical Feasibility | **High** — WASAPI process loopback is well-documented; N-API is mature |
| Complexity | **High** — requires C++ native addon, COM initialization, audio format handling, thread-safe IPC to renderer, AudioWorklet pipeline |
| End-User Friction | **Low** — native addon ships with the app, no extra installs |
| Build Complexity | **Medium** — needs Windows SDK, C++ compiler, `node-gyp` or `cmake-js`, must match Electron's Node.js ABI |
| Known Limitations | Windows 10 2004+ only; captures process tree (not just single process); requires the target app to be producing audio; latency from IPC + AudioWorklet pipeline (~50-150ms typical) |

---

## Topic 6: Chromium/WebRTC Constraints

### Can `getUserMedia` Capture Loopback Audio?

**No.** `navigator.mediaDevices.getUserMedia` with a specific `deviceId` can only capture from **audio input devices** (microphones, line-in, virtual audio inputs). It cannot capture from render/output devices.

Chromium does not expose WASAPI loopback endpoints as audio input devices. The `deviceId` values Chromium returns from `navigator.mediaDevices.enumerateDevices()` are:
- `"default"` — the default input device
- `"communications"` — the communications input device
- Opaque hashed strings like `"abc123def456..."` — derived from the device's interface path, NOT the MMDevice endpoint ID

**There is no mapping** from `{0.0.0.00000000}.{GUID}` (MMDevice render endpoint) to a Chromium `deviceId`.

### What Audio Device IDs Does Chromium Enumerate?

Chromium on Windows uses the `IMMDeviceEnumerator` API internally but:
1. Only enumerates `DataFlow::Capture` (input) devices for `getUserMedia`
2. Hashes the device's unique ID through a per-origin hash to produce the `deviceId` (for privacy)
3. The hash is `SHA-256(origin + raw_device_id + salt)`, then base64url-encoded
4. The hash is deterministic per origin+device but NOT reversible

```
Chromium enumeration:
  IMMDeviceEnumerator::EnumerateAudioEndPoints(eCapture, DEVICE_STATE_ACTIVE)
    → for each device: generate deviceId = hash(origin, device.GetId(), salt)
    → expose to JavaScript via enumerateDevices()
```

Render (output) devices are available for selection as audio output (`setSinkId`) but NOT for capture.

### How Does Discord Handle Per-App Audio?

Discord uses a multi-pronged approach on Windows:

1. **System audio (screen share):** Uses the same Chromium loopback mechanism (`audio: "loopback"` equivalent) for full screen/monitor shares. This captures all system audio including Discord's own — Discord handles echo/self-audio issues at the receiving end or by ducking.

2. **Per-app audio (application share):** Discord introduced "Streamer Mode" and application-specific audio capture. Their approach (as of 2024-2025):
   - Uses a **native module** that employs WASAPI Process Loopback (`ActivateAudioInterfaceAsync` with `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`) on Windows 10 2004+
   - The native module captures PCM audio data from the target process
   - Feeds it back into their WebRTC pipeline via an internal audio bridge (likely through a custom `AudioSource` in their native WebRTC implementation — Discord uses their own native WebRTC, not Chromium's)
   - Falls back to system-wide loopback on older Windows versions

3. **Key architectural difference:** Discord's desktop app uses **native WebRTC** (libwebrtc compiled as a native module), NOT Chromium's built-in WebRTC. This gives them direct access to create custom `webrtc::AudioSourceInterface` objects that feed PCM data directly into the WebRTC pipeline without going through `getUserMedia` or Web Audio API.

### Feasibility Assessment for Chromium/WebRTC Integration

| Aspect | Rating |
|--------|--------|
| getUserMedia for loopback | **Not possible** — Chromium doesn't expose render devices as inputs |
| Matching MMDevice IDs to Chromium IDs | **Not possible** — different ID schemes, hashed per-origin |
| Per-app audio via standard Web APIs | **Not possible** — no Web API exists for this |
| AudioWorklet → MediaStreamDestination → WebRTC | **High feasibility** — standard Web Audio API pipeline |
| Native WebRTC (like Discord) | **Very High complexity** — requires building libwebrtc as native addon |

---

## Recommended Architecture

Based on this research, the recommended approach combines **Topic 1** (WASAPI Process Loopback) + **Topic 5** (Native Node.js Addon):

### For Window-Specific Audio (Screen Share a Window)

```
┌─────────────────┐     ┌──────────────────────────────────┐
│  Electron Main   │────▶│  Native Addon (C++)              │
│  Process          │     │  ActivateAudioInterfaceAsync     │
│                   │     │  INCLUDE_TARGET_PROCESS_TREE     │
│  get PID from    │     │  targetPid = windowOwnerPid      │
│  window handle   │     │                                  │
└─────────────────┘     │  Capture loop → PCM buffers      │
                         └──────────┬───────────────────────┘
                                    │ IPC (MessagePort / SharedArrayBuffer)
                         ┌──────────▼───────────────────────┐
                         │  Electron Renderer               │
                         │  AudioWorkletNode ← PCM data     │
                         │  → MediaStreamDestination         │
                         │  → audioTrack                     │
                         │  → peerConnection.addTrack()      │
                         └──────────────────────────────────┘
```

### For Full Screen Audio (Exclude Own Audio)

```
┌─────────────────┐     ┌──────────────────────────────────┐
│  Electron Main   │────▶│  Native Addon (C++)              │
│  Process          │     │  ActivateAudioInterfaceAsync     │
│                   │     │  EXCLUDE_TARGET_PROCESS_TREE     │
│  get own PID:    │     │  targetPid = process.pid         │
│  process.pid     │     │                                  │
└─────────────────┘     │  Capture loop → PCM buffers      │
                         └──────────┬───────────────────────┘
                                    │ IPC
                         ┌──────────▼───────────────────────┐
                         │  Same AudioWorklet pipeline       │
                         └──────────────────────────────────┘
```

### Implementation Plan

1. **Phase 1: Native Addon**
   - Create a C++ N-API addon using `node-addon-api` and `cmake-js`
   - Implement WASAPI Process Loopback capture using `ActivateAudioInterfaceAsync`
   - Expose `startCapture(pid, mode)` and `stopCapture()` to JavaScript
   - Use `Napi::ThreadSafeFunction` to deliver PCM buffers to the main process
   - Build with `prebuild` or `electron-rebuild` for Electron's Node ABI

2. **Phase 2: Audio Pipeline**
   - Create an `AudioWorkletProcessor` that receives PCM chunks via `MessagePort`
   - Connect to `AudioContext.createMediaStreamDestination()`
   - Handle sample rate conversion if needed (WASAPI may give 44.1kHz, WebRTC wants 48kHz)
   - Manage buffer underrun/overrun with a ring buffer

3. **Phase 3: Integration**
   - In `setDisplayMediaRequestHandler`: determine if window share or screen share
   - For window: get PID via `GetWindowThreadProcessId` (can be done in the addon), start capture in INCLUDE mode
   - For screen: start capture in EXCLUDE mode with the Electron app's own PID
   - Pass the generated `MediaStreamTrack` to the WebRTC pipeline
   - Handle cleanup when sharing stops

### Alternative Simpler Approach (Hybrid)

If the full native addon is too complex initially:

1. **Replace the .NET helper** with a standalone C++ executable that:
   - Uses WASAPI Process Loopback
   - Outputs PCM data to **stdout** as a raw audio stream
   - Electron reads stdout, pipes to renderer via IPC
   
   ```
   // Spawn native process
   const capture = spawn('sharkord-audio-capture.exe', [
     '--pid', targetPid.toString(),
     '--mode', 'include',  // or 'exclude'
     '--format', 'f32le',
     '--rate', '48000',
     '--channels', '2'
   ]);
   
   capture.stdout.on('data', (pcmChunk) => {
     // Send to renderer via IPC/MessagePort
     mainWindow.webContents.send('audio-data', pcmChunk);
   });
   ```

   This avoids the complexity of building a native Node.js addon while still getting per-process audio.

---

## Comparison Matrix

| Approach | Per-App Audio | Exclude Self | User Friction | Complexity | Latency | Windows Version |
|----------|:---:|:---:|:---:|:---:|:---:|:---:|
| Electron `audio: "loopback"` | ❌ | ❌ | None | Low | Low | Any |
| WASAPI Process Loopback (native addon) | ✅ | ✅ | None | High | Medium | 10 2004+ |
| WASAPI Process Loopback (standalone exe) | ✅ | ✅ | None | Medium | Medium | 10 2004+ |
| Virtual Audio Cable | ✅ | ✅ | **High** (driver install) | Medium | Low | Any |
| AudioGraph | ❌ | ❌ | None | Low | Low | 10+ |
| Native WebRTC (Discord-style) | ✅ | ✅ | None | **Very High** | Low | 10 2004+ |
| Current .NET helper approach | ❌ | ❌ | None | Medium | N/A | N/A (broken) |

## Final Recommendation

**Primary approach: Standalone C++ executable using WASAPI Process Loopback → stdout PCM → Electron IPC → AudioWorklet → WebRTC**

This is the best balance of:
- ✅ Full per-process audio support (include and exclude modes)
- ✅ No end-user friction (no driver installs)
- ✅ Lower complexity than a full N-API addon (simpler build, no `electron-rebuild` needed)
- ✅ Replaces the broken .NET helper with something that actually works
- ✅ Can be upgraded to a native addon later for lower latency
- ⚠️ Requires Windows 10 2004+ (99%+ of Windows users by 2026)
- ⚠️ ~50-150ms audio latency (acceptable for screen sharing)

The current .NET/NAudio approach should be abandoned entirely — the fundamental premise (mapping render endpoint IDs to capture device IDs for `getUserMedia`) is architecturally incorrect.
