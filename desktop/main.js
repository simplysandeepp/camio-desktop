const { app, BrowserWindow, ipcMain, Tray, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const http = require('http');
const crypto = require('crypto');

let mainWindow;
let cameraProcess;
let serverProcess;

const APP_DIR = path.resolve(__dirname, '../app');
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
      listProc.on('close', () => {
        try { resolve(JSON.parse(output)); } catch { resolve([]); }
      });
    });
  });

  ipcMain.handle('hash-password', async (event, password) => {
    return new Promise((resolve) => {
      const proc = spawn('node', ['scripts/hash-password.mjs', '--', password], { cwd: APP_DIR });
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
      const tsStatus = execSync('tailscale status', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (tsStatus.includes('Logged in')) {
        const ip = execSync('tailscale ip -4', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return `http://${ip}:${appPort}`;
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

app.on('will-quit', () => {
  if (cameraProcess) cameraProcess.kill('SIGTERM');
  if (serverProcess) serverProcess.kill('SIGTERM');
});
