# 🤖 DroidPilot — Android Test Automation Platform

A fully customisable web-based Android test automation tool powered by ADB.

## Features

| Module | What it does |
|---|---|
| **Suite Builder** | Build multi-step test flows visually (tap, swipe, type, assert, shell, monkey…) |
| **Test Runner** | Run suites against any connected device, live step-by-step results |
| **Device Controls** | Tap, swipe, key events, orientation, font scale, network toggle |
| **App Manager** | Install/uninstall APKs, launch/stop/clear apps, browse installed packages |
| **Logcat Viewer** | Live streaming logcat with filter by tag, level, and search |
| **Monkey Test** | Configurable random stress test with crash detection |
| **ADB Shell** | Full interactive shell with quick-command shortcuts |
| **Performance** | PSS memory, CPU %, gfx frame info per package |
| **Export/Import** | Save suites as JSON, share across machines |
| **WebSocket Live** | Real-time run updates pushed to browser |

## Quick Setup

### Prerequisites
- [Node.js 18+](https://nodejs.org)
- ADB installed and in PATH (`adb version` should work in terminal)
- Android device with USB Debugging enabled

### 1. Install & Run Server
```bash
cd droidpilot
npm install
node server.js
```
Server starts at **http://localhost:3737**

### 2. Connect Your Device
```bash
# USB connection (recommended)
adb devices

# WiFi (same network)
adb tcpip 5555
adb connect 192.168.x.x:5555
```

### 3. Open the UI
Open `http://localhost:3737` in your browser.

---

## Step Types in Suite Builder

| Step Type | Parameters | Description |
|---|---|---|
| `launch` | package name | Launch app via monkey |
| `stop` | package name | Force stop app |
| `clear_data` | package name | Clear app data |
| `tap` | x, y | Tap screen coordinate |
| `swipe` | x1,y1 / x2,y2 / duration | Swipe gesture |
| `type` | text | Type text into focused field |
| `keyevent` | keycode | Send hardware key event |
| `wait` | milliseconds | Pause execution |
| `shell` | command | Run arbitrary ADB shell command |
| `assert_text` | text | Assert text visible in window dump |
| `screenshot` | — | Capture screenshot to device |
| `orientation` | 0 or 1 | Set portrait/landscape |
| `monkey` | package / events | Quick monkey stress test |
| `grant_permission` | package / permission | Grant runtime permission |
| `set_prop` | key / value | Set system property |

Each step supports:
- **Delay after** — wait N ms before next step
- **Assert output** — fail step if string not found in output

---

## Common Key Codes
| Key | Code |
|---|---|
| Back | 4 |
| Home | 3 |
| Recents | 187 |
| Enter | 66 |
| Delete | 67 |
| Volume Up | 24 |
| Volume Down | 25 |
| Power | 26 |
| Menu | 82 |

---

## Architecture

```
Browser (index.html)
    ↕ REST API + WebSocket
Node.js Server (server.js)
    ↕ child_process.exec / spawn
ADB
    ↕ USB / WiFi
Android Device
```

## File Structure
```
droidpilot/
├── server.js        ← Node.js backend
├── package.json
└── public/
    └── index.html   ← Full web UI (single file)
```

---

## Tips

- **No server?** The UI still works in demo/simulation mode — suites are stored in localStorage and runs are simulated locally.
- **Multiple devices** — select the target device in the sidebar before running a suite.
- **Export suites** — use Settings → Export to back up your test suites as JSON.
- **Logcat filtering** — type a tag (e.g. `ExoPlayer`) to stream only that module's logs.
