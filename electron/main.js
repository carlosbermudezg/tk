const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ─── Logger a archivo ─────────────────────────────────────────────────────────
const LOG_DIR = path.join(process.env.APPDATA || process.env.HOME || '.', 'TikTok Games Launcher');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const LOG_FILE = path.join(LOG_DIR, 'launcher.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// Redirigir consola global al logger
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  log('[INFO]', ...args);
  originalLog(...args);
};
console.error = (...args) => {
  log('[ERROR]', ...args);
  originalError(...args);
};
console.warn = (...args) => {
  log('[WARN]', ...args);
  originalWarn(...args);
};

process.on('uncaughtException', (err) => log('CRASH:', err.stack || err.message));
process.on('unhandledRejection', (reason) => log('REJECTION:', reason?.stack || reason));

log('=== Iniciando ===', 'packaged:', app.isPackaged, 'dir:', __dirname);

// ─── Config ───────────────────────────────────────────────────────────────────
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-namespace-sandbox');

Menu.setApplicationMenu(null);

const SERVER_PORT = 3000;
const APP_DIR = path.join(__dirname, '..');
let mainWindow = null;

// ─── Descarga con redirecciones ───────────────────────────────────────────────
function downloadFile(urlStr, destPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const file = fs.createWriteStream(destPath);
    file.on('error', (err) => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
    const req = lib.get(url, { headers: { 'User-Agent': 'TikTok-Games-Launcher/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', (err) => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout 60s')); });
  });
}

// ─── Copia dir sin node_modules ───────────────────────────────────────────────
const SKIP = ['node_modules', '.git', 'dist-electron', 'central-server', 'scratch', 'temp_update', 'electron', 'package.json'];
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.includes(entry.name)) continue;
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ─── Auto-update en segundo plano ─────────────────────────────────────────────
async function autoUpdateBackground() {
  if (!app.isPackaged) { log('update: saltado en dev'); return; }
  log('update: iniciando en background...');
  const zipUrl = 'https://codeload.github.com/carlosbermudezg/tk/zip/refs/heads/main';
  const tempZip = path.join(app.getPath('temp'), 'tk_update.zip');
  const tempExtract = path.join(app.getPath('temp'), 'tk_update_ex');
  try {
    log('update: descargando...');
    await downloadFile(zipUrl, tempZip);
    log('update: descarga completa, extrayendo...');
    const { execSync } = require('child_process');
    if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true });
    fs.mkdirSync(tempExtract, { recursive: true });
    execSync(`powershell -Command "Expand-Archive -Path '${tempZip}' -DestinationPath '${tempExtract}' -Force"`, { timeout: 120000 });
    const entries = fs.readdirSync(tempExtract);
    const folder = entries.find(e => fs.statSync(path.join(tempExtract, e)).isDirectory());
    if (folder) { copyDir(path.join(tempExtract, folder), APP_DIR); log('update: ✅ listo'); }
  } catch (err) {
    log('update: ⚠️ falló -', err.message);
  } finally {
    try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch {}
    try { if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true }); } catch {}
  }
}

// ─── Ventana principal ────────────────────────────────────────────────────────
function createWindow() {
  log('createWindow: abriendo...');
  try {
    mainWindow = new BrowserWindow({
      width: 1280, height: 800, minWidth: 900, minHeight: 600,
      title: 'TikTok Games',
      backgroundColor: '#0a0a0f',
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    log('createWindow: BrowserWindow instanciada correctamente');
  } catch (err) {
    log('createWindow: ERROR crítico al instanciar BrowserWindow:', err.stack || err.message);
    return;
  }

  try {
    mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);
    log('createWindow: loadURL enviada');
  } catch (err) {
    log('createWindow: ERROR crítico al llamar loadURL:', err.stack || err.message);
  }

  mainWindow.once('ready-to-show', () => { 
    log('ready-to-show: mostrando ventana principal'); 
    mainWindow.show(); 
  });
  
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost')) return { action: 'allow' };
    shell.openExternal(url); return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  log('whenReady: inicio');

  // 1. Iniciar servidor Express directamente en el proceso principal
  const serverPath = path.join(APP_DIR, 'server.js');
  log('Iniciando Express directamente desde:', serverPath);
  try {
    const { pathToFileURL } = require('url');
    await import(pathToFileURL(serverPath).href);
    log('Servidor Express importado e iniciado correctamente.');
  } catch (err) {
    log('CRITICAL ERROR al iniciar Express:', err.stack || err.message);
  }

  // 2. Esperar 1.5s para asegurar que Express escuchó en el puerto
  log('Esperando 1.5 segundos para Express...');
  await new Promise(r => setTimeout(r, 1500));
  log('Espera de 1.5 segundos completada. Llamando a createWindow...');

  // 3. Abrir ventana principal
  createWindow();

  // 4. Auto-update en background
  autoUpdateBackground().catch((err) => log('update background error:', err.message));

  log('whenReady: setup completo');
});

app.on('window-all-closed', () => {
  log('window-all-closed → saliendo del proceso para liberar puerto');
  app.quit();
  process.exit(0);
});

app.on('will-quit', () => {
  log('will-quit → saliendo del proceso');
  process.exit(0);
});