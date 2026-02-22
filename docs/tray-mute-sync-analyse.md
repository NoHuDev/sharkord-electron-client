# Analyse: Tray-Anzeige mit aktuellem Mikrofonstatus der Webapp synchronisieren

## Ausgangslage

- Die Tray-Anzeige („Mute: an“ / „Mute: aus“) wird aktuell nur aktualisiert, wenn der **Hotkey** oder ein **Tray-Klick** („Mute toggeln“) ausgelöst wird – also nur bei Aktionen, die der Desktop-Client selbst ausführt.
- Wenn der Nutzer das Mikrofon **in der Sharkord-Webapp** (z. B. per Klick auf den Mute-Button in der UI) umschaltet, erfährt der Desktop-Client davon nichts; die Tray-Anzeige bleibt veraltet.
- Ziel: Tray soll den **tatsächlichen** Mikrofonstatus der Webapp anzeigen – **ohne Anpassung am Server** (Backend). Linux und Windows müssen unterstützt werden.

---

## Mögliche Umsetzungen (ohne Server-Änderung)

### Option A: Polling aus dem Main Process (nur Desktop-Client, keine Webapp-Änderung)

**Idee:** Der Main Process führt in regelmäßigen Abständen (z. B. alle 1–2 Sekunden) Code **im Kontext der geladenen Webseite** aus und liest den sichtbaren Mute-Status aus dem DOM. Derselbe Ansatz wie im Preload (Mute-Button per Selektoren finden, `aria-pressed`, `title`, `data-muted` etc. auslesen) – nur von Main aus per `webContents.executeJavaScript()` aufgerufen.

**Ablauf:**

1. Nach `did-finish-load` (und optional bei Fokus auf dem Fenster) startet ein Timer im Main Process.
2. In jedem Tick: `mainWindow.webContents.executeJavaScript(<script>)`. Das Script läuft in der **Seite** (Sharkord-Webapp), sucht den Mute-Button mit denselben Selektoren wie im Preload (`[data-testid="mute-button"]`, `button[title*="mikrofon" i]`, Buttons mit Lucide-Mic-Icon usw.) und liest den Zustand aus (`aria-pressed`, `data-muted`, `title`/`aria-label`).
3. Rückgabe: z. B. `{ muted: boolean | null }`. Main wertet aus und ruft `trayManager?.setMuted(muted)` auf (nur wenn `muted !== null` und ggf. nur bei Änderung, um Flackern zu vermeiden).

**Vorteile:**

- Keine Änderung an der Sharkord-Webapp und kein Server-Touch.
- Funktioniert unter **Linux und Windows** gleich (nur DOM + Electron-API).
- Einmal umgesetzt, keine Abhängigkeit von einer anderen Codebasis.

**Nachteile:**

- Polling-Intervall (Latenz bis zur Anzeige; etwas CPU/Load).
- Abhängig von der **DOM-Struktur** der Webapp: Wenn Sharkord die Selektoren (z. B. `data-testid`, Aria-Labels) ändert, kann die Erkennung brechen. Die gleichen Heuristiken wie bereits im Preload nutzen, reduziert das Risiko.

**Technische Hinweise:**

- Die Logik für „Mute-Button finden“ und „Status aus Element lesen“ existiert bereits im Preload ([`findMuteToggleElement`, `readMutedStateFromElement`](apps/desktop/src/preload/index.ts)). Für `executeJavaScript` muss eine **in den Page-Kontext injizierbare** Variante als String übergeben werden (gleiche Selektoren und Regeln, kompakt als IIFE die `muted` zurückgibt).
- Timer beim Navigieren/Beenden des Fensters stoppen; nur laufen lassen, wenn `mainWindow` existiert und die URL zur konfigurierten Sharkord-Origin gehört.

**Umsetzung (Option A):** Im Main Process ([`main.ts`](../apps/desktop/src/main/main.ts)) sind umgesetzt: `readMuteStateFromPage()` liest den Status anhand der Button-Titel „Mute microphone (Ctrl+Shift+M)“ / „Unmute microphone (Ctrl+Shift+M)“ (inkl. Shadow DOM). `startMuteStatePolling()` startet ein Intervall (1,5 s); bei Änderung wird `trayManager.setMuted(muted)` aufgerufen. Das Polling startet in `did-finish-load` (nur wenn Tray aktiv) und wird in `closed` gestoppt.

---

### Option B: Webapp sendet MUTE_STATE bei UI-Änderung (kleine Frontend-Anpassung, kein Server)

**Idee:** Die **Sharkord-Webapp** (Frontend, das im Browser/Electron läuft) sendet beim Umschalten des Mute-Buttons ein Bridge-Event per `postMessage`. Der Desktop-Client (Preload) lauscht bereits auf `window.addEventListener("message", ...)` und leitet gültige Bridge-Events an den Main Process weiter; Main aktualisiert wie heute bei `MUTE_STATE` den Tray.

**Ablauf:**

1. Im Sharkord-**Frontend** (z. B. in der Komponente/ dem Handler, der den Mute-Button bedient): Nach dem Setzen des neuen Mute-Status `window.postMessage({ channel: "sharkord-desktop-v1", type: "SHARKORD_DESKTOP_MUTE_STATE", payload: { muted: <aktueller Wert>, source: "user" } }, "*")` aufrufen.
2. Preload empfängt die Nachricht (sofern im gleichen Fenster/Kontext sichtbar), prüft `isBridgeEvent`, sendet per IPC an Main.
3. Main verarbeitet wie heute: `trayManager?.setMuted(bridgeEvent.payload.muted)`.

**Vorteile:**

- Kein Polling, sofortige und exakte Synchronisation.
- Keine Abhängigkeit von DOM-Selektoren; die Webapp ist die Quelle der Wahrheit.
- Läuft unter **Linux und Windows** identisch (nur postMessage + bestehende Bridge).

**Nachteile:**

- Erfordert eine **punktuelle Anpassung im Sharkord-Webapp-Code** (nur Frontend, kein Backend/Server). Wenn du den Webapp-Code nicht anpassen willst oder kannst, scheidet Option B aus.

**Hinweis Kontext-Isolation:** Unter Electron mit `contextIsolation: true` laufen Preload und Seiteninhalt in getrennten Kontexten. Ob `postMessage` von der Seite im Preload ankommt, hängt von der konkreten Electron-Architektur ab. Falls nötig, müsste getestet werden; ggf. muss die Webapp über ein vom Preload exponiertes API-Objekt (z. B. `window.sharkordDesktop.reportMuteState(muted)`) den Status melden, das im Preload dann in ein Bridge-Event packt und per IPC an Main sendet.

---

## Empfehlung

- **Ohne jegliche Änderung an der Sharkord-Webapp:** **Option A** (Polling aus dem Main Process mit DOM-Auslesen). Einmalig im Desktop-Client umsetzbar, plattformunabhängig (Linux/Windows).
- **Falls eine kleine Anpassung im Sharkord-Frontend möglich ist:** **Option B** ist die sauberere und robustere Lösung (kein Polling, keine Selektoren-Pflege).

Beide Optionen kommen **ohne Server-/Backend-Änderung** aus und sind unter Linux und Windows nutzbar.

---

## Kurz: Tray-Linksklick = Mute toggeln (bereits umgesetzt)

Der erste Punkt (Linksklick auf das Tray-Icon soll das Mikrofon toggeln wie „Mute toggeln“ im Kontextmenü) ist umgesetzt: Der Handler von `tray.on("click", ...)` ruft nun `onToggleMute()` statt `onToggleWindowVisibility()` auf. Unter Linux kann das Verhalten je nach Desktop-Umgebung variieren (manche zeigen bei Linksklick trotzdem das Kontextmenü); unter Windows entspricht ein Klick auf das Tray-Icon in der Regel dem Linksklick und löst damit das Mute-Toggle aus.
