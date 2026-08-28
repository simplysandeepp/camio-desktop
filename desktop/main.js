const { app, BrowserWindow, ipcMain } = require('electron');
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

function createWindow() {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'assets/icons/icon-512x512.png')
  });

  mainWindow.loadURL(`http://localhost:${appPort}`);
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupIpcHandlers() {
  ipcMain.handle('get-cameras', async () => {
    // Reuse list-cameras.mjs from submodule by spawning it and capturing stdout
    return new Promise((resolve) => {
      const listProc = spawn('node', ['scripts/list-cameras.mjs'], { cwd: APP_DIR });
      let output = '';
      listProc.stdout.on('data', d => { output += d; });
      listProc.on('close', () => {
        try {
          resolve(JSON.parse(output));
        } catch {
          resolve([]);
        }
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
      // rudimentary check if it's running
      if (tsStatus.includes('Logged in')) {
        const ip = execSync('tailscale ip -4', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return `http://${ip}:${appPort}`;
      }
    } catch {
      // tailscale not installed or not running
    }
    return null;
  });

  ipcMain.handle('finish-wizard', async () => {
    if (mainWindow) {
      mainWindow.close();
      mainWindow = null;
    }
    spawnProcesses();
  });
}

function startApp() {
  setupIpcHandlers();

  if (!fs.existsSync(ENV_FILE)) {
    // Show setup wizard
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
    return;
  }

  spawnProcesses();
}

app.whenReady().then(() => {
  startApp();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && fs.existsSync(ENV_FILE)) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // We don't quit immediately if we want a tray app (Phase 5),
  // but for Phase 3, we can just quit.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (cameraProcess) cameraProcess.kill('SIGTERM');
  if (serverProcess) serverProcess.kill('SIGTERM');
});
