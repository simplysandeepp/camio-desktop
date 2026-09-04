const { app, BrowserWindow, ipcMain, Tray, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const http = require('http');
const crypto = require('crypto');

let mainWindow;
let cameraProcess;
let serverProcess;

const APP_DIR = app.isPackaged 
  ? path.join(process.resourcesPath, 'app')
  : path.resolve(__dirname, '../app');
const ENV_FILE = path.join(APP_DIR, '.env.local');

// Get port from .env.local if it exists
let appPort = 3000;
function readPort() {
  if (fs.existsSync(ENV_FILE)) {
    const env = fs.readFileSync(ENV_FILE, 'utf8');
    const match = env.match(/^APP_PORT=(\d+)/m);
    if (match) {
      appPort = parseInt(match[1], 10);
    }
  }
  return appPort;
}

function spawnProcesses() {
  readPort();
  
  // Note: assuming 'node' is in PATH.
  // Spawn camera pipeline
  cameraProcess = spawn('node', ['scripts/camera.mjs'], {
    cwd: APP_DIR,
    stdio: 'inherit'
  });

  // Spawn web server
  serverProcess = spawn('node', ['scripts/start.mjs'], {
    cwd: APP_DIR,
    stdio: 'inherit'
  });

  waitForServer();
}

function waitForServer() {
  const url = `http://localhost:${appPort}/api/health`;
  const poll = () => {
    http.get(url, (res) => {
      if (res.statusCode === 200) {
        createWindow();
      } else {
        setTimeout(poll, 1000);
      }
    }).on('error', () => {
      setTimeout(poll, 1000);
    });
  };
  poll();
}

let tray = null;
let isQuitting = false;

function createTray() {
  if (tray) return;

  // Use appropriate size
  let iconName = 'tray-24x24.png';
  if (process.platform === 'darwin') {
    iconName = 'tray-22x22.png';
  }
  
  const iconPath = path.join(__dirname, 'assets/icons', iconName);
  // Ensure native image for template support on macOS (changes color based on light/dark mode)
  const { nativeImage } = require('electron');
  let trayIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') {
    trayIcon = trayIcon.resize({ width: 22, height: 22 });
    trayIcon.setTemplateImage(true);
  }

  tray = new Tray(trayIcon);
  updateTrayMenu('Connecting...');

  // Poll status every 5 seconds
  setInterval(pollCameraStatus, 5000);
}

function updateTrayMenu(statusText) {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    { label: `Camio — ${statusText}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => { shell.openExternal(`http://localhost:${appPort}`); } },
    { label: 'Settings', click: showWizard },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

function pollCameraStatus() {
  const url = `http://localhost:${appPort}/api/stream/status`;
  http.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const statuses = JSON.parse(data);
        const anyLive = Object.values(statuses).some(s => s === 'live');
        updateTrayMenu(anyLive ? 'Live ●' : 'Camera offline');
      } catch {
        updateTrayMenu('Camera offline');
      }
    });
  }).on('error', () => {
    updateTrayMenu('Disconnected');
  });
}

function showWizard() {
  if (mainWindow) {
    mainWindow.show();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 900,
    height: 550,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets/icons/icon-512x512.png'),
    resizable: false
  });
  mainWindow.loadFile('wizard.html');
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createWindow() {
  createTray();
  // We no longer automatically open the Dashboard in an Electron window (Phase 5).
  // The goal says "after setup, the app lives in the tray/menu bar, not as a visible window"
  // Wait, the Phase 3 goal said: "Create a BrowserWindow loading http://localhost:<APP_PORT> once ready."
  // Phase 5 says: "Closing the main window (if one is ever shown, e.g. right after setup) should minimize to tray... 'Open Dashboard' opens the default system browser (not another Electron window)"
  // So `createWindow` logic needs to be removed/changed to just opening the URL in browser or showing the tray.
  // We will just open the external browser once server is ready, or do nothing.
}

function setupIpcHandlers() {
  ipcMain.handle('get-cameras', async () => {
    return new Promise((resolve) => {
      const listProc = spawn('node', ['scripts/list-cameras.mjs'], { cwd: APP_DIR });
      let output = '';
      listProc.stdout.on('data', d => { output += d; });
      listProc.stderr.on('data', d => { output += d; });
      listProc.on('close', () => {
        const cameras = [];
        if (process.platform === 'darwin') {
          // Output looks like:
          // [AVFoundation indev @ ...] AVFoundation video devices:
          // [AVFoundation indev @ ...] [0] MacBook Air Camera
          // [AVFoundation indev @ ...] [1] Capture screen 0
          // [AVFoundation indev @ ...] AVFoundation audio devices:
          const lines = output.split('\n');
          let inVideo = false;
          for (const line of lines) {
            if (line.includes('AVFoundation video devices:')) inVideo = true;
            else if (line.includes('AVFoundation audio devices:')) inVideo = false;
            else if (inVideo) {
              const match = line.match(/\[(\d+)\]\s+(.+)$/);
              if (match) {
                // Ignore screens
                if (!match[2].toLowerCase().includes('screen')) {
                  cameras.push({ id: match[1], name: match[2].trim(), source: 'mac' });
                }
              }
            }
          }
        } else {
          // Linux v4l2-ctl output:
          // UVC Camera (046d:0825) (usb-0000:00:14.0-1):
          //         /dev/video0
          //         /dev/video1
          const lines = output.split('\n');
          let currentName = 'Unknown Camera';
          for (const line of lines) {
            if (line.includes('/dev/video')) {
              cameras.push({ id: line.trim(), name: currentName, source: 'linux' });
              currentName = 'Unknown Camera'; // reset for next
            } else if (line.trim().length > 0 && !line.includes('Linux video devices:') && !line.startsWith('  (')) {
              currentName = line.trim().replace(/:$/, '');
            }
          }
        }
        resolve(cameras);
      });
    });
  });

  ipcMain.handle('hash-password', async (event, password) => {
    return new Promise((resolve) => {
      const proc = spawn('node', ['scripts/hash-password.mjs', password], { cwd: APP_DIR });
      let output = '';
      proc.stdout.on('data', d => { output += d; });
      proc.on('close', () => {
        const hashMatch = output.match(/CAMIO_PASSWORD_HASH=(.+)/);
        const secretMatch = output.match(/SESSION_SECRET=(.+)/);
        resolve({
          hash: hashMatch ? hashMatch[1].trim() : null,
          secret: secretMatch ? secretMatch[1].trim() : null
        });
      });
    });
  });

  ipcMain.handle('save-env', async (event, envData) => {
    const lines = [
      `CAMERA_SOURCE=${envData.cameraSource}`,
      `CAMERA_DEVICE=${envData.cameraDevice}`,
      `CAMERA_FPS=30`,
      `CAMIO_USER=${envData.username}`,
      `CAMIO_PASSWORD_HASH=${envData.hash}`,
      `SESSION_SECRET=${envData.secret}`,
      `APP_PORT=3000` // default
    ];
    fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n');
    appPort = 3000;
    return true;
  });

  ipcMain.handle('get-tailscale-url', async () => {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      
      const { stdout: tsStatus } = await execAsync('tailscale status');
      if (tsStatus.includes('Logged in')) {
        const { stdout: ipOut } = await execAsync('tailscale ip -4');
        return `http://${ipOut.trim()}:${appPort}`;
      }
    } catch {}
    return null;
  });

  ipcMain.handle('finish-wizard', async () => {
    if (mainWindow) {
      mainWindow.hide();
    }
    spawnProcesses();
  });
}

function startApp() {
  setupIpcHandlers();

  if (!fs.existsSync(ENV_FILE)) {
    showWizard();
    return;
  }

  spawnProcesses();
}

app.whenReady().then(() => {
  startApp();

  app.on('activate', () => {
    if (fs.existsSync(ENV_FILE) && !tray) {
      createTray();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

function terminateChildren() {
  const procs = [cameraProcess, serverProcess].filter((p) => p && p.exitCode === null);
  if (procs.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    let remaining = procs.length;
    const finish = () => {
      remaining -= 1;
      if (remaining <= 0) {
        clearTimeout(forceKillTimer);
        resolve();
      }
    };
    const forceKillTimer = setTimeout(() => {
      for (const p of procs) {
        if (p.exitCode === null) p.kill('SIGKILL');
      }
    }, 5000);

    for (const p of procs) {
      p.once('exit', finish);
      p.kill('SIGTERM');
    }
  });
}

let readyToQuit = false;
app.on('before-quit', (event) => {
  if (readyToQuit) return;
  event.preventDefault();
  isQuitting = true;
  terminateChildren().then(() => {
    readyToQuit = true;
    app.quit();
  });
});
