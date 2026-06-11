/**
 * DroidPilot — Android Test Automation Backend
 * Node.js + Express + WebSocket + ADB bridge
 * 
 * Run: npm install && node server.js
 * Requires: ADB installed and in PATH, Android device connected (USB or WiFi)
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3737;
const UPLOAD_DIR = path.join(os.tmpdir(), 'droidpilot_uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,PUT');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── ADB HELPER ─────────────────────────────────────────────────────────────
function adb(args, serial = null) {
  return new Promise((resolve, reject) => {
    const cmd = serial ? `adb -s ${serial} ${args}` : `adb ${args}`;
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });
}

function adbStream(args, serial, onData, onClose) {
  const fullArgs = serial ? ['-s', serial, ...args.split(' ')] : args.split(' ');
  const proc = spawn('adb', fullArgs);
  proc.stdout.on('data', d => onData(d.toString()));
  proc.stderr.on('data', d => onData(d.toString()));
  proc.on('close', code => onClose(code));
  return proc;
}

// ─── IN-MEMORY TEST SUITE STORE ──────────────────────────────────────────────
let testSuites = [];
let testResults = [];
let runningTests = {};

// ─── ROUTES ─────────────────────────────────────────────────────────────────

// Device listing
app.get('/api/devices', async (req, res) => {
  try {
    const out = await adb('devices -l');
    const lines = out.split('\n').slice(1).filter(l => l.trim() && !l.includes('offline'));
    const devices = lines.map(line => {
      const parts = line.trim().split(/\s+/);
      const serial = parts[0];
      const status = parts[1];
      const model = (line.match(/model:(\S+)/) || [])[1] || 'Unknown';
      const product = (line.match(/product:(\S+)/) || [])[1] || '';
      return { serial, status, model, product };
    }).filter(d => d.serial && d.status === 'device');
    res.json({ devices });
  } catch (e) {
    res.status(500).json({ error: e.toString(), devices: [] });
  }
});

// Device info
app.get('/api/device/:serial/info', async (req, res) => {
  const s = req.params.serial;
  try {
    const [brand, model, sdk, android, battery, resolution, density, cpuAbi, totalRam] = await Promise.all([
      adb('shell getprop ro.product.brand', s).catch(() => '?'),
      adb('shell getprop ro.product.model', s).catch(() => '?'),
      adb('shell getprop ro.build.version.sdk', s).catch(() => '?'),
      adb('shell getprop ro.build.version.release', s).catch(() => '?'),
      adb('shell dumpsys battery | grep level', s).catch(() => ''),
      adb('shell wm size', s).catch(() => '?'),
      adb('shell wm density', s).catch(() => '?'),
      adb('shell getprop ro.product.cpu.abi', s).catch(() => '?'),
      adb('shell cat /proc/meminfo | grep MemTotal', s).catch(() => '?'),
    ]);
    const battLevel = (battery.match(/level:\s*(\d+)/) || [])[1] || '?';
    res.json({ brand, model, sdk, android, battery: battLevel, resolution, density, cpuAbi, totalRam, serial: s });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Installed packages
app.get('/api/device/:serial/packages', async (req, res) => {
  const s = req.params.serial;
  try {
    const out = await adb('shell pm list packages -3', s);
    const packages = out.split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean);
    res.json({ packages });
  } catch (e) {
    res.status(500).json({ error: e.toString(), packages: [] });
  }
});

// Install APK
app.post('/api/device/:serial/install', upload.single('apk'), async (req, res) => {
  const s = req.params.serial;
  if (!req.file) return res.status(400).json({ error: 'No APK file provided' });
  try {
    const out = await adb(`install -r "${req.file.path}"`, s);
    res.json({ success: out.includes('Success'), output: out });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Uninstall package
app.delete('/api/device/:serial/package/:pkg', async (req, res) => {
  const { serial: s, pkg } = req.params;
  try {
    const out = await adb(`uninstall ${pkg}`, s);
    res.json({ success: out.includes('Success'), output: out });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Launch app
app.post('/api/device/:serial/launch', async (req, res) => {
  const s = req.params.serial;
  const { packageName, activity } = req.body;
  try {
    const target = activity ? `${packageName}/${activity}` : packageName;
    const out = await adb(`shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, s);
    res.json({ success: true, output: out });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Force stop
app.post('/api/device/:serial/stop', async (req, res) => {
  const s = req.params.serial;
  const { packageName } = req.body;
  try {
    const out = await adb(`shell am force-stop ${packageName}`, s);
    res.json({ success: true, output: out });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Clear app data
app.post('/api/device/:serial/clear', async (req, res) => {
  const s = req.params.serial;
  const { packageName } = req.body;
  try {
    const out = await adb(`shell pm clear ${packageName}`, s);
    res.json({ success: out.includes('Success'), output: out });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Screenshot
app.get('/api/device/:serial/screenshot', async (req, res) => {
  const s = req.params.serial;
  const tmpFile = path.join(UPLOAD_DIR, `screen_${Date.now()}.png`);
  try {
    await adb(`exec-out screencap -p > "${tmpFile}"`, s);
    if (fs.existsSync(tmpFile)) {
      res.setHeader('Content-Type', 'image/png');
      res.sendFile(tmpFile);
    } else {
      // Fallback: pull method
      await adb(`shell screencap -p /sdcard/droid_screen.png`, s);
      await adb(`pull /sdcard/droid_screen.png "${tmpFile}"`, s);
      res.setHeader('Content-Type', 'image/png');
      res.sendFile(tmpFile);
    }
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Tap
app.post('/api/device/:serial/tap', async (req, res) => {
  const s = req.params.serial;
  const { x, y } = req.body;
  try {
    await adb(`shell input tap ${x} ${y}`, s);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Swipe
app.post('/api/device/:serial/swipe', async (req, res) => {
  const s = req.params.serial;
  const { x1, y1, x2, y2, duration = 300 } = req.body;
  try {
    await adb(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`, s);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Type text
app.post('/api/device/:serial/type', async (req, res) => {
  const s = req.params.serial;
  const { text } = req.body;
  try {
    const escaped = text.replace(/ /g, '%s').replace(/['"]/g, '\\$&');
    await adb(`shell input text "${escaped}"`, s);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Key event
app.post('/api/device/:serial/key', async (req, res) => {
  const s = req.params.serial;
  const { keycode } = req.body;
  try {
    await adb(`shell input keyevent ${keycode}`, s);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Get logcat (last N lines)
app.get('/api/device/:serial/logcat', async (req, res) => {
  const s = req.params.serial;
  const lines = req.query.lines || 100;
  const tag = req.query.tag || '';
  try {
    const filter = tag ? `${tag}:V *:S` : '*:V';
    const out = await adb(`logcat -d -v time -t ${lines} ${filter}`, s);
    res.json({ lines: out.split('\n').filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.toString(), lines: [] });
  }
});

// Clear logcat
app.delete('/api/device/:serial/logcat', async (req, res) => {
  const s = req.params.serial;
  try {
    await adb('logcat -c', s);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// ADB shell command
app.post('/api/device/:serial/shell', async (req, res) => {
  const s = req.params.serial;
  const { command } = req.body;
  // Block dangerous commands
  const blocked = ['rm -rf /', 'format', 'dd if='];
  if (blocked.some(b => command.includes(b))) {
    return res.status(403).json({ error: 'Command blocked for safety' });
  }
  try {
    const out = await adb(`shell ${command}`, s);
    res.json({ output: out });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Performance dump (CPU, Memory)
app.get('/api/device/:serial/perf/:pkg', async (req, res) => {
  const { serial: s, pkg } = req.params;
  try {
    const [memInfo, cpuInfo, fps] = await Promise.all([
      adb(`shell dumpsys meminfo ${pkg}`, s).catch(() => ''),
      adb(`shell top -n 1 -b | grep ${pkg}`, s).catch(() => ''),
      adb(`shell dumpsys gfxinfo ${pkg} | grep "Total frames"`, s).catch(() => ''),
    ]);
    const totalPss = (memInfo.match(/TOTAL PSS:\s+(\d+)/) || memInfo.match(/TOTAL:\s+(\d+)/))?.[1] || '?';
    const cpuPct = (cpuInfo.match(/(\d+\.?\d*)%/) || [])[1] || '?';
    res.json({ totalPss, cpuPct, fps: fps.trim(), raw: { memInfo: memInfo.slice(0, 800) } });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Network throttle
app.post('/api/device/:serial/network', async (req, res) => {
  const s = req.params.serial;
  const { enable } = req.body;
  try {
    if (enable) {
      await adb('shell svc wifi disable', s);
      await adb('shell svc data disable', s);
    } else {
      await adb('shell svc wifi enable', s);
      await adb('shell svc data enable', s);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Set device orientation
app.post('/api/device/:serial/orientation', async (req, res) => {
  const s = req.params.serial;
  const { value } = req.body; // 0=portrait, 1=landscape
  try {
    await adb(`shell settings put system accelerometer_rotation 0`, s);
    await adb(`shell settings put system user_rotation ${value}`, s);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Font scale
app.post('/api/device/:serial/fontscale', async (req, res) => {
  const s = req.params.serial;
  const { scale } = req.body;
  try {
    await adb(`shell settings put system font_scale ${scale}`, s);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// Monkey test
app.post('/api/device/:serial/monkey', async (req, res) => {
  const s = req.params.serial;
  const { packageName, events = 500, seed = 0, throttle = 100 } = req.body;
  try {
    const out = await adb(
      `shell monkey -p ${packageName} --throttle ${throttle} -s ${seed} -v ${events}`, s
    );
    const crashed = out.includes('CRASH') || out.includes('Exception');
    res.json({ success: !crashed, crashed, events: parseInt(events), output: out.slice(-1000) });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// ── TEST SUITES (in-memory) ──────────────────────────────────────────────────
app.get('/api/suites', (req, res) => res.json({ suites: testSuites }));

app.post('/api/suites', (req, res) => {
  const suite = { id: Date.now().toString(), createdAt: new Date().toISOString(), results: [], ...req.body };
  testSuites.push(suite);
  res.json({ suite });
});

app.put('/api/suites/:id', (req, res) => {
  const idx = testSuites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Suite not found' });
  testSuites[idx] = { ...testSuites[idx], ...req.body };
  res.json({ suite: testSuites[idx] });
});

app.delete('/api/suites/:id', (req, res) => {
  testSuites = testSuites.filter(s => s.id !== req.params.id);
  res.json({ success: true });
});

// ── TEST RESULTS ─────────────────────────────────────────────────────────────
app.get('/api/results', (req, res) => res.json({ results: testResults }));

app.get('/api/results/:suiteId', (req, res) => {
  res.json({ results: testResults.filter(r => r.suiteId === req.params.suiteId) });
});

// Run test suite
app.post('/api/suites/:id/run', async (req, res) => {
  const suite = testSuites.find(s => s.id === req.params.id);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  const serial = req.body.serial || suite.serial;
  if (!serial) return res.status(400).json({ error: 'No device serial provided' });

  const runId = Date.now().toString();
  const runRecord = {
    id: runId, suiteId: suite.id, suiteName: suite.name,
    serial, startedAt: new Date().toISOString(),
    status: 'running', steps: [], passed: 0, failed: 0, skipped: 0
  };
  testResults.unshift(runRecord);

  // Broadcast start
  broadcast({ type: 'run_started', runId, suiteId: suite.id, suiteName: suite.name });
  res.json({ runId });

  // Execute steps asynchronously
  (async () => {
    for (const step of (suite.steps || [])) {
      if (runningTests[runId] === 'stop') break;
      const stepStart = Date.now();
      let result = 'passed', output = '', error = '';
      try {
        output = await executeStep(step, serial);
        if (step.assert && !output.includes(step.assert)) {
          result = 'failed'; error = `Expected "${step.assert}" in output`;
        }
      } catch (e) {
        result = 'failed'; error = e.toString();
      }
      const stepResult = { ...step, result, output, error, duration: Date.now() - stepStart };
      runRecord.steps.push(stepResult);
      if (result === 'passed') runRecord.passed++;
      else if (result === 'failed') runRecord.failed++;
      broadcast({ type: 'step_done', runId, step: stepResult });
      if (step.delay) await sleep(step.delay);
    }
    runRecord.status = runRecord.failed > 0 ? 'failed' : 'passed';
    runRecord.endedAt = new Date().toISOString();
    runRecord.duration = new Date(runRecord.endedAt) - new Date(runRecord.startedAt);
    broadcast({ type: 'run_done', runId, status: runRecord.status, passed: runRecord.passed, failed: runRecord.failed });
  })();
});

app.post('/api/runs/:id/stop', (req, res) => {
  runningTests[req.params.id] = 'stop';
  res.json({ success: true });
});

async function executeStep(step, serial) {
  switch (step.type) {
    case 'launch':       return adb(`shell monkey -p ${step.value} -c android.intent.category.LAUNCHER 1`, serial);
    case 'stop':         return adb(`shell am force-stop ${step.value}`, serial);
    case 'clear_data':   return adb(`shell pm clear ${step.value}`, serial);
    case 'tap':          return adb(`shell input tap ${step.x} ${step.y}`, serial);
    case 'swipe':        return adb(`shell input swipe ${step.x1} ${step.y1} ${step.x2} ${step.y2} ${step.duration||300}`, serial);
    case 'type':         return adb(`shell input text "${step.value.replace(/ /g,'%s')}"`, serial);
    case 'keyevent':     return adb(`shell input keyevent ${step.value}`, serial);
    case 'wait':         await sleep(parseInt(step.value)||1000); return 'waited';
    case 'shell':        return adb(`shell ${step.value}`, serial);
    case 'assert_text':  return adb(`shell dumpsys window windows | grep -i "${step.value}"`, serial);
    case 'screenshot':   return adb(`shell screencap -p /sdcard/droid_auto_${Date.now()}.png`, serial);
    case 'orientation':  
      await adb(`shell settings put system accelerometer_rotation 0`, serial);
      return adb(`shell settings put system user_rotation ${step.value}`, serial);
    case 'monkey':       return adb(`shell monkey -p ${step.value} --throttle 100 ${step.events||100}`, serial);
    case 'grant_permission': return adb(`shell pm grant ${step.package} ${step.value}`, serial);
    case 'set_prop':     return adb(`shell setprop ${step.key} ${step.value}`, serial);
    default:             throw new Error(`Unknown step type: ${step.type}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'connected', message: 'DroidPilot server connected' }));

  // Stream logcat for a device
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'logcat_start') {
        const args = msg.tag ? `logcat -v time ${msg.tag}:V *:S` : `logcat -v time`;
        const proc = adbStream(args, msg.serial,
          data => ws.send(JSON.stringify({ type: 'logcat', data })),
          () => ws.send(JSON.stringify({ type: 'logcat_end' }))
        );
        ws._logcatProc = proc;
      }
      if (msg.type === 'logcat_stop' && ws._logcatProc) {
        ws._logcatProc.kill();
        ws._logcatProc = null;
      }
    } catch (e) {}
  });

  ws.on('close', () => { if (ws._logcatProc) ws._logcatProc.kill(); });
});

// ─── START ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   DroidPilot Server running          ║`);
  console.log(`║   http://localhost:${PORT}             ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});
