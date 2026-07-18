const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
Menu.setApplicationMenu(null);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ─── Config ──────────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, '..', 'config.json');
const localConfigPath = path.join(__dirname, '..', 'config.local.json');
let config = { centralApiUrl: 'http://localhost:4000', githubRepo: 'carlosbermudezg/tk' };

if (fs.existsSync(configPath)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) }; } catch {}
}
if (fs.existsSync(localConfigPath)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(localConfigPath, 'utf-8')) }; } catch {}
}

const CENTRAL_API_URL = config.centralApiUrl || 'http://localhost:4000';
let SESSION_API_KEY = '';
let mainWindow = null;
let serverProcess = null;
const SERVER_PORT = 3000;
const GAMES_DIR   = path.join(__dirname, '..', 'games');

if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });

// ─── Network Helpers ─────────────────────────────────────────────────────────
function postJSON(urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(bodyObj);

    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let respData = '';
      res.on('data', chunk => respData += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(respData)); } catch { resolve(respData); }
        } else {
          try { reject(JSON.parse(respData)); } catch { reject(new Error(respData || `HTTP ${res.statusCode}`)); }
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function downloadZip(urlStr, destPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/Launcher'
      }
    };

    const req = lib.get(url, options, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return downloadZip(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });
    req.on('error', reject);
  });
}

function copyDirectoryRecursive(src, dest, exclude = []) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath, exclude);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function checkForLauncherUpdates() {
  if (fs.existsSync(localConfigPath)) {
    console.log('⚙️ Bypass de desarrollo: config.local.json detectado. Omitiendo actualizaciones.');
    return;
  }

  console.log('🔍 Buscando actualizaciones del launcher...');
  const repo = config.githubRepo || 'carlosbermudezg/tk';
  const zipUrl = `https://codeload.github.com/${repo}/zip/refs/heads/main`;
  const tempZip = path.join(app.getPath('temp'), 'launcher_update.zip');
  const extractDir = path.join(app.getPath('temp'), 'launcher_update_extracted');

  try {
    await downloadZip(zipUrl, tempZip);
    
    const { execSync } = require('child_process');
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });

    if (process.platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Path '${tempZip}' -DestinationPath '${extractDir}' -Force"`);
    } else {
      execSync(`unzip -o "${tempZip}" -d "${extractDir}"`);
    }

    const rootFolders = fs.readdirSync(extractDir);
    const extractedRepoFolder = rootFolders.find(f => fs.statSync(path.join(extractDir, f)).isDirectory());
    
    if (extractedRepoFolder) {
      const sourceDir = path.join(extractDir, extractedRepoFolder);
      const targetDir = path.join(__dirname, '..');
      
      console.log('📦 Aplicando actualización del launcher...');
      copyDirectoryRecursive(sourceDir, targetDir, ['config.local.json', '.env', 'node_modules', '.git']);
      console.log('✅ Launcher actualizado con éxito!');
    }
  } catch (err) {
    console.error('⚠️ No se pudo actualizar el launcher desde GitHub:', err.message);
  } finally {
    try {
      if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
      if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    } catch(e){}
  }
}

// ─── Show Login Window ────────────────────────────────────────────────────────
function showLoginWindow() {
  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 420, height: 520, frame: false, center: true, resizable: false,
      backgroundColor: '#0a0a0f',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    loginWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Outfit',sans-serif;background:#0a0a0f;color:#f1f5f9;
    display:flex;align-items:center;justify-content:center;height:100vh;
    -webkit-app-region:drag}
  .card{background:#111118;border:1px solid rgba(255,255,255,0.07);
    border-radius:20px;padding:36px 32px;width:340px;-webkit-app-region:no-drag}
  .logo{text-align:center;margin-bottom:28px}
  .logo-icon{width:56px;height:56px;border-radius:16px;
    background:linear-gradient(135deg,#7c3aed,#06b6d4);
    display:inline-flex;align-items:center;justify-content:center;
    font-size:26px;margin-bottom:12px}
  h1{font-size:20px;font-weight:800;margin-bottom:4px}
  p{font-size:12px;color:#64748b}
  .field{margin-bottom:14px}
  .field label{display:block;font-size:11px;font-weight:600;color:#64748b;
    text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
  .field input{width:100%;background:#18181f;border:1px solid rgba(255,255,255,0.07);
    border-radius:10px;padding:11px 14px;color:#f1f5f9;font-family:'Outfit',sans-serif;
    font-size:14px;transition:border-color .2s;outline:none}
  .field input:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,0.15)}
  .field input::placeholder{color:#334155}
  .btn{width:100%;padding:13px;border-radius:10px;border:none;
    background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;
    font-family:'Outfit',sans-serif;font-size:15px;font-weight:700;
    cursor:pointer;transition:opacity .2s;margin-top:6px}
  .btn:hover{opacity:.9}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .forgot{display:block;text-align:center;margin-top:14px;
    font-size:12px;color:#475569;cursor:pointer;text-decoration:none;
    transition:color .2s}
  .forgot:hover{color:#7c3aed}
  .error{color:#ef4444;font-size:12px;text-align:center;margin-top:10px;min-height:16px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">&#127918;</div>
    <h1>TikTok Games</h1>
    <p>Ingresa con tu correo de creador</p>
  </div>
  <div class="field">
    <label>Correo electrónico</label>
    <input type="email" id="email" placeholder="creador@email.com">
  </div>
  <div class="field">
    <label>Contraseña</label>
    <input type="password" id="password" placeholder="••••••••">
  </div>
  <button class="btn" id="login-btn">Iniciar Sesión</button>
  <a class="forgot" id="forgot-link">¿Olvidaste tu contraseña?</a>
  <div class="error" id="error-msg"></div>
</div>

<script>
  const { ipcRenderer } = require('electron');
  
  const loginBtn = document.getElementById('login-btn');
  const errorMsg = document.getElementById('error-msg');
  const emailInput = document.getElementById('email');
  const passInput = document.getElementById('password');
  const forgotLink = document.getElementById('forgot-link');

  loginBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passInput.value;
    if (!email || !password) {
      errorMsg.textContent = 'Ingresa todos los campos';
      return;
    }
    
    loginBtn.disabled = true;
    errorMsg.textContent = 'Verificando...';
    ipcRenderer.send('login-attempt', { email, password });
  });

  // Soporte para Enter en ambos campos
  [emailInput, passInput].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loginBtn.click();
    });
  });

  forgotLink.addEventListener('click', () => {
    ipcRenderer.send('open-forgot-password');
  });

  ipcRenderer.on('login-response', (event, response) => {
    loginBtn.disabled = false;
    if (response.success) {
      errorMsg.style.color = '#10b981';
      errorMsg.textContent = '¡Ingreso correcto!';
    } else {
      errorMsg.style.color = '#ef4444';
      errorMsg.textContent = response.message || 'Error de credenciales';
    }
  });
</script>
</body>
</html>
    `)}`);

    const loginAttemptHandler = async (event, credentials) => {
      try {
        const res = await postJSON(`${CENTRAL_API_URL}/api/auth/login`, credentials);
        if (res.apiKey) {
          event.reply('login-response', { success: true });
          loginWin.close();
          resolve(res);
        } else {
          event.reply('login-response', { success: false, message: 'API Key no devuelta' });
        }
      } catch (err) {
        event.reply('login-response', { success: false, message: err.error || err.message });
      }
    };

    const forgotPasswordHandler = () => {
      shell.openExternal(`${CENTRAL_API_URL}/forgot-password.html`);
    };

    ipcMain.on('login-attempt', loginAttemptHandler);
    ipcMain.on('open-forgot-password', forgotPasswordHandler);

    loginWin.on('closed', () => {
      ipcMain.removeListener('login-attempt', loginAttemptHandler);
      ipcMain.removeListener('open-forgot-password', forgotPasswordHandler);
    });
  });
}

// ─── Sync Games ──────────────────────────────────────────────────────────────
async function syncGames() {
  return new Promise((resolve) => {
    const url = new URL('/api/games/manifest', CENTRAL_API_URL);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(url, { headers: { 'x-api-key': SESSION_API_KEY } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        try {
          const manifest = JSON.parse(data);
          await downloadNewFiles(manifest);
          resolve(manifest);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function downloadNewFiles(manifest) {
  if (!manifest?.games) return;
  const localManifestPath = path.join(GAMES_DIR, 'manifest.json');
  let localManifest = { games: [] };
  if (fs.existsSync(localManifestPath)) {
    try { localManifest = JSON.parse(fs.readFileSync(localManifestPath, 'utf-8')); } catch {}
  }

  const localVersions = {};
  for (const game of (localManifest.games || [])) {
    localVersions[game.id] = {};
    for (const f of (game.files || [])) {
      localVersions[game.id][f.path] = f.hash;
    }
  }

  for (const game of manifest.games) {
    const gameDir = path.join(GAMES_DIR, game.id);
    if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });

    for (const file of (game.files || [])) {
      const localHash = localVersions[game.id]?.[file.path];
      if (localHash === file.hash) continue;

      console.log(`⬇️ Descargando: ${game.id}/${file.path}`);
      await downloadFile(
        `${CENTRAL_API_URL}/api/games/${game.id}/files/${file.path}`,
        path.join(gameDir, file.path),
        SESSION_API_KEY
      );
    }
  }

  fs.writeFileSync(localManifestPath, JSON.stringify(manifest, null, 2));
}

function downloadFile(url, destPath, apiKey) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const file = fs.createWriteStream(destPath);

    const req = lib.get(url, { headers: { 'x-api-key': apiKey } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath, apiKey).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });

    req.on('error', (err) => {
      fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

// ─── Show Splash ─────────────────────────────────────────────────────────────
function showSplash(message, isError = false) {
  const win = new BrowserWindow({
    width: 420, height: 240, frame: false, center: true,
    backgroundColor: '#0a0a0f', resizable: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: false }
  });

  const color = isError ? '#ef4444' : '#7c3aed';
  const icon  = isError ? '❌' : '⏳';

  win.loadURL(`data:text/html,
    <html style="margin:0;background:#0a0a0f;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
    <div style="text-align:center;color:#f1f5f9">
      <div style="font-size:40px;margin-bottom:14px">${icon}</div>
      <div style="font-size:15px;font-weight:600;color:${color}">${isError ? 'Error de Licencia' : 'Iniciando...'}</div>
      <div style="font-size:12px;color:#64748b;margin-top:8px;max-width:320px;line-height:1.5">${message}</div>
    </div></html>
  `);

  return win;
}

// ─── Create Main Window ───────────────────────────────────────────────────────
function createWindow(licenseInfo) {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    title: 'TikTok Games Launcher',
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    show: false
  });

  const query = `?displayName=${encodeURIComponent(licenseInfo.displayName || '')}&email=${encodeURIComponent(licenseInfo.email || '')}`;
  mainWindow.loadURL(`http://localhost:${SERVER_PORT}/index.html${query}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── Hot Sync License Key on Re-login ─────────────────────────────────────────
async function handleHotLogin(loginResult) {
  SESSION_API_KEY = loginResult.apiKey;
  try {
    await postJSON(`http://localhost:${SERVER_PORT}/api/local/login-sync`, { apiKey: loginResult.apiKey });
  } catch (err) {
    console.error('Error al sincronizar nueva API Key localmente:', err.message);
  }
  createWindow(loginResult);
}

// ─── Handle Logout Flow ────────────────────────────────────────────────────────
function handleLogout() {
  if (mainWindow) {
    mainWindow.destroy();
    mainWindow = null;
  }
  SESSION_API_KEY = '';
  showLoginWindow().then(handleHotLogin);
}

// ─── Process exit tree cleanup ───────────────────────────────────────────────
function killLocalServer() {
  if (serverProcess) {
    console.log('🧹 Terminando proceso del servidor local...');
    try {
      if (serverProcess.pid && process.platform === 'win32') {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${serverProcess.pid} /T /F`);
      } else {
        serverProcess.kill();
      }
    } catch (e) {
      try { serverProcess.kill(); } catch {}
    }
    serverProcess = null;
  }
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // 0. Buscar actualizaciones
  await checkForLauncherUpdates();

  const splash = showSplash('Iniciando TikTok Games...');
  await new Promise(r => setTimeout(r, 400));
  splash.close();

  // 1. Mostrar ventana de login
  const loginResult = await showLoginWindow();
  SESSION_API_KEY = loginResult.apiKey;

  // 2. Descargar juegos actualizados
  const syncSplash = showSplash('Descargando últimas actualizaciones de juegos...');
  await syncGames();
  syncSplash.close();

  // 3. Levantar Express localmente
  const serverSplash = showSplash('Levantando servidor de juegos local...');
  
  const isDev = !app.isPackaged;
  const serverPath = isDev 
    ? path.join(__dirname, '..', 'server.ts') 
    : path.join(__dirname, '..', 'server.js');

  if (isDev) {
    serverProcess = spawn('npx', ['tsx', serverPath], {
      cwd: path.join(__dirname, '..'),
      shell: true,
      env: { ...process.env, CENTRAL_API_KEY: SESSION_API_KEY, CENTRAL_API_URL }
    });

    serverProcess.stdout.on('data', (data) => {
      const log = data.toString();
      console.log(`[Local Server] ${log.trim()}`);
      if (log.includes('[Logout]')) {
        handleLogout();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`[Local Server Error] ${data.toString().trim()}`);
    });
  } else {
    const { utilityProcess } = require('electron');
    serverProcess = utilityProcess.fork(serverPath, [], {
      env: { ...process.env, CENTRAL_API_KEY: SESSION_API_KEY, CENTRAL_API_URL }
    });

    serverProcess.on('message', (msg) => {
      if (msg && msg.type === 'logout') {
        handleLogout();
      }
    });
  }

  // Dar 1.5s al servidor para levantar
  await new Promise(r => setTimeout(r, 1500));
  serverSplash.close();

  // 4. Crear ventana principal
  createWindow(loginResult);
});

app.on('will-quit', async (event) => {
  if (serverProcess) {
    event.preventDefault();
    console.log('🧹 Iniciando apagado limpio del servidor local...');
    try {
      await postJSON(`http://localhost:${SERVER_PORT}/api/local/shutdown`, {});
    } catch (e) {}
    killLocalServer();
    app.exit(0);
  } else {
    killLocalServer();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});