import express from "express";
import http from "http";
import { Server } from "socket.io";
import { TikTokLiveClient, EventType } from "piratetok-live-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ─── Configuración de Licencia (prioridad: env > config.local.json > config.json) ───
let CENTRAL_API_URL = process.env.CENTRAL_API_URL || "http://localhost:4000";
let API_KEY = process.env.CENTRAL_API_KEY || "";
let SESSION_DISPLAY_NAME = "";
let SESSION_EMAIL = "";
if (!API_KEY) {
    const configPath = path.join(__dirname, "config.json");
    const localConfigPath = path.join(__dirname, "config.local.json");
    let cfg = {};
    if (fs.existsSync(configPath)) {
        try {
            cfg = { ...cfg, ...JSON.parse(fs.readFileSync(configPath, "utf-8")) };
        }
        catch { }
    }
    if (fs.existsSync(localConfigPath)) {
        try {
            cfg = { ...cfg, ...JSON.parse(fs.readFileSync(localConfigPath, "utf-8")) };
        }
        catch { }
    }
    CENTRAL_API_URL = cfg.centralApiUrl || CENTRAL_API_URL;
    API_KEY = cfg.apiKey || "";
}
let queue = [];
let activeConnection = null;
let currentUsername = null;
// --- Control de Sesión y Métricas ---
let currentSessionId = null;
let sessionInterval = null;
let sessionDiamonds = 0;
let sessionLikes = 0;
let sessionFollowers = 0;
let sessionShares = 0;
function triggerLogout(reason = "Sesión cerrada") {
    console.log(`⏹️ [Logout] ${reason}`);
    if (process.send) {
        process.send({ type: "logout", reason });
    }
}
async function checkLicenseActive() {
    if (!API_KEY)
        return false;
    try {
        const res = await fetch(`${CENTRAL_API_URL}/api/license/validate`, {
            headers: { "x-api-key": API_KEY }
        });
        if (res.status === 401) {
            triggerLogout("Licencia revocada o inactiva");
            if (activeConnection) {
                try {
                    activeConnection.disconnect();
                }
                catch { }
                activeConnection = null;
                currentUsername = null;
                io.emit("status-update", { connected: false, username: null });
            }
            return false;
        }
        return res.ok;
    }
    catch (err) {
        console.warn("⚠️ No se pudo verificar la licencia con el servidor central:", err);
        return true;
    }
}
async function syncMetricsToCentral(sessId) {
    if (!API_KEY)
        return;
    const diamonds = sessionDiamonds;
    const likes = sessionLikes;
    const followers = sessionFollowers;
    const shares = sessionShares;
    if (diamonds === 0 && likes === 0 && followers === 0 && shares === 0)
        return;
    sessionDiamonds -= diamonds;
    sessionLikes -= likes;
    sessionFollowers -= followers;
    sessionShares -= shares;
    try {
        const res = await fetch(`${CENTRAL_API_URL}/api/sessions/${sessId}/metrics`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": API_KEY
            },
            body: JSON.stringify({
                diamonds,
                likes,
                newFollowers: followers,
                shares
            })
        });
        if (res.status === 401) {
            triggerLogout("Licencia revocada");
            if (activeConnection) {
                try {
                    activeConnection.disconnect();
                }
                catch { }
                activeConnection = null;
                currentUsername = null;
                io.emit("status-update", { connected: false, username: null });
            }
            return;
        }
        if (!res.ok) {
            console.error(`❌ Falló la sincronización de métricas para sesión ${sessId}:`, res.statusText);
            sessionDiamonds += diamonds;
            sessionLikes += likes;
            sessionFollowers += followers;
            sessionShares += shares;
        }
    }
    catch (err) {
        console.error(`❌ Error de red al sincronizar métricas para sesión ${sessId}:`, err);
        sessionDiamonds += diamonds;
        sessionLikes += likes;
        sessionFollowers += followers;
        sessionShares += shares;
    }
}
function startMetricsSyncInterval() {
    if (sessionInterval)
        clearInterval(sessionInterval);
    sessionInterval = setInterval(() => {
        if (currentSessionId) {
            syncMetricsToCentral(currentSessionId);
        }
    }, 10000);
}
async function startCentralSession() {
    if (!API_KEY)
        return;
    try {
        const res = await fetch(`${CENTRAL_API_URL}/api/sessions/start`, {
            method: "POST",
            headers: { "x-api-key": API_KEY }
        });
        if (res.status === 401) {
            triggerLogout("Licencia revocada");
            if (activeConnection) {
                try {
                    activeConnection.disconnect();
                }
                catch { }
                activeConnection = null;
                currentUsername = null;
                io.emit("status-update", { connected: false, username: null });
            }
            return;
        }
        if (res.ok) {
            const data = (await res.json());
            currentSessionId = data.sessionId;
            console.log(`▶️ Sesión registrada en servidor central. ID: ${currentSessionId}`);
            sessionDiamonds = 0;
            sessionLikes = 0;
            sessionFollowers = 0;
            sessionShares = 0;
            startMetricsSyncInterval();
        }
        else {
            console.error("❌ No se pudo iniciar sesión en servidor central:", res.statusText);
        }
    }
    catch (err) {
        console.error("❌ Error al conectar con servidor central para iniciar sesión:", err);
    }
}
async function endCentralSession() {
    if (!currentSessionId || !API_KEY)
        return;
    const sessId = currentSessionId;
    currentSessionId = null;
    if (sessionInterval) {
        clearInterval(sessionInterval);
        sessionInterval = null;
    }
    await syncMetricsToCentral(sessId);
    try {
        const res = await fetch(`${CENTRAL_API_URL}/api/sessions/${sessId}/end`, {
            method: "POST",
            headers: { "x-api-key": API_KEY }
        });
        if (res.status === 401) {
            triggerLogout("Licencia revocada");
            if (activeConnection) {
                try {
                    activeConnection.disconnect();
                }
                catch { }
                activeConnection = null;
                currentUsername = null;
                io.emit("status-update", { connected: false, username: null });
            }
            return;
        }
        if (res.ok) {
            console.log(`⏹️ Sesión ${sessId} finalizada en servidor central.`);
        }
        else {
            console.error(`❌ No se pudo finalizar sesión ${sessId} en servidor central:`, res.statusText);
        }
    }
    catch (err) {
        console.error(`❌ Error al conectar con servidor central para finalizar sesión ${sessId}:`, err);
    }
}
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// Sincronizar API Key cuando el usuario inicia sesión
app.post("/api/local/login-sync", (req, res) => {
    const { apiKey, displayName, email } = req.body;
    API_KEY = apiKey || "";
    SESSION_DISPLAY_NAME = displayName || "";
    SESSION_EMAIL = email || "";
    console.log("🔑 [LoginSync] Sincronizada API Key localmente para:", SESSION_EMAIL);
    res.json({ ok: true });
});
// Cerrar sesión
app.post("/api/local/logout", async (req, res) => {
    triggerLogout("Sesión cerrada por el creador");
    if (activeConnection) {
        try {
            activeConnection.disconnect();
        }
        catch (e) { }
        activeConnection = null;
    }
    await endCentralSession();
    API_KEY = "";
    res.json({ ok: true });
});
// Apagado limpio desde Electron
app.post("/api/local/shutdown", async (req, res) => {
    console.log("🔌 [Shutdown] Recibida orden de apagado limpio. Finalizando conexiones...");
    if (activeConnection) {
        try {
            activeConnection.disconnect();
        }
        catch (e) { }
        activeConnection = null;
    }
    await endCentralSession();
    res.json({ ok: true });
    setTimeout(() => {
        process.exit(0);
    }, 500);
});
// Proxy a central-server para obtener estadísticas del creador
app.get("/api/local/creator/stats", async (req, res) => {
    if (!API_KEY) {
        return res.status(401).json({ error: "No hay licencia o API Key activa" });
    }
    try {
        const response = await fetch(`${CENTRAL_API_URL}/api/creator/stats`, {
            headers: { "x-api-key": API_KEY }
        });
        if (response.status === 401) {
            triggerLogout("Licencia revocada");
            if (activeConnection) {
                try {
                    activeConnection.disconnect();
                }
                catch { }
                activeConnection = null;
                currentUsername = null;
                io.emit("status-update", { connected: false, username: null });
            }
            return res.status(401).json({ error: "Licencia revocada o inactiva" });
        }
        if (!response.ok) {
            return res.status(response.status).json({ error: "Error del servidor central" });
        }
        const data = await response.json();
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Proxy a central-server para actualizar perfil del creador
app.put("/api/local/creator/profile", async (req, res) => {
    if (!API_KEY) {
        return res.status(401).json({ error: "No hay licencia o API Key activa" });
    }
    try {
        const response = await fetch(`${CENTRAL_API_URL}/api/creator/profile`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": API_KEY
            },
            body: JSON.stringify(req.body)
        });
        if (response.status === 401) {
            triggerLogout("Licencia revocada");
            if (activeConnection) {
                try {
                    activeConnection.disconnect();
                }
                catch { }
                activeConnection = null;
                currentUsername = null;
                io.emit("status-update", { connected: false, username: null });
            }
            return res.status(401).json({ error: "Licencia revocada o inactiva" });
        }
        if (!response.ok) {
            const rawText = await response.clone().text();
            console.error("[Proxy Profile Error]", response.status, rawText);
            let errorText = "Error del servidor central";
            try {
                const errJson = JSON.parse(rawText);
                errorText = errJson.error || errorText;
            }
            catch { }
            return res.status(response.status).json({ error: errorText });
        }
        const data = await response.json();
        res.json(data);
    }
    catch (err) {
        console.error("[Proxy Profile Connection Error]", err);
        res.status(500).json({ error: err.message });
    }
});
// Helpers para la cola de pelea
function isUserInQueue(username) {
    return queue.some(user => user.username === username);
}
function addToQueue(user) {
    if (!isUserInQueue(user.username)) {
        queue.push({
            username: user.username,
            name: user.nickname || user.name || user.username,
            photo: user.profilePictureUrl || user.photo || "https://www.tiktok.com/favicon.ico"
        });
        io.emit("queue-update", queue);
        io.emit("system-event", {
            type: "queue",
            message: `${user.nickname || user.name || user.username} se unió a la cola de pelea 🥊`
        });
        return true;
    }
    return false;
}
function removeFromQueue(username) {
    const index = queue.findIndex(user => user.username === username);
    if (index !== -1) {
        const user = queue[index];
        queue.splice(index, 1);
        io.emit("queue-update", queue);
        io.emit("system-event", {
            type: "queue-leave",
            message: `${user.name} salió de la cola`
        });
        return true;
    }
    return false;
}
function clearQueue() {
    queue = [];
    io.emit("queue-update", queue);
    io.emit("system-event", {
        type: "queue-clear",
        message: "La cola de pelea fue limpiada"
    });
}
// Utilidad para extraer detalles del usuario compatibles con PirateTok
function getUserDetails(data) {
    const uniqueId = data.user?.displayId || data.uniqueId || "usuario";
    const nickname = data.user?.nickname || data.nickname || uniqueId;
    const profilePictureUrl = data.user?.avatarThumb?.urlList?.[0] ||
        data.profilePictureUrl ||
        "https://www.tiktok.com/favicon.ico";
    return { uniqueId, nickname, profilePictureUrl };
}
// Normalizadores de eventos para enviar al frontend
function normalizeChat(data) {
    const user = getUserDetails(data);
    return {
        type: "chat",
        id: data.msgId || Math.random().toString(36).substring(2, 11),
        timestamp: parseInt(data.createTime) || Date.now(),
        uniqueId: user.uniqueId,
        nickname: user.nickname,
        profilePictureUrl: user.profilePictureUrl,
        comment: data.content || data.comment || ""
    };
}
function normalizeGift(data) {
    const user = getUserDetails(data);
    const imgUrl = data.gift?.image?.urlList?.[0] ||
        data.giftPictureUrl ||
        (data.giftImage && data.giftImage.url && data.giftImage.url[0]) ||
        (data.icon && data.icon.url && data.icon.url[0]) ||
        "https://www.tiktok.com/favicon.ico";
    const giftName = data.gift?.name || data.giftName || "Regalo";
    const giftId = data.giftId || data.gift?.id || "unknown";
    const repeatCount = data.repeatCount || data.groupCount || 1;
    const describe = data.describe || `Envió ${giftName}`;
    const diamondCount = data.gift?.diamondCount || data.diamondCount || 0;
    return {
        type: "gift",
        id: data.msgId || Math.random().toString(36).substring(2, 11),
        timestamp: parseInt(data.createTime) || Date.now(),
        uniqueId: user.uniqueId,
        nickname: user.nickname,
        profilePictureUrl: user.profilePictureUrl,
        giftId: giftId,
        giftName: giftName,
        giftPictureUrl: imgUrl,
        repeatCount: repeatCount,
        describe: describe,
        diamondCount: diamondCount,
        repeatEnd: data.repeatEnd !== undefined ? data.repeatEnd : (data.gift?.repeat_end !== undefined ? data.gift.repeat_end : true)
    };
}
function normalizeLike(data) {
    const user = getUserDetails(data);
    const likeCount = data.count || data.likeCount || 1;
    const totalLikeCount = data.total || data.totalLikes || data.totalLikeCount || likeCount || 1;
    return {
        type: "like",
        id: data.msgId || Math.random().toString(36).substring(2, 11),
        timestamp: parseInt(data.createTime) || Date.now(),
        uniqueId: user.uniqueId,
        nickname: user.nickname,
        profilePictureUrl: user.profilePictureUrl,
        likeCount: likeCount,
        totalLikeCount: totalLikeCount
    };
}
function normalizeJoin(data) {
    const user = getUserDetails(data);
    return {
        type: "join",
        id: data.msgId || Math.random().toString(36).substring(2, 11),
        timestamp: parseInt(data.createTime) || Date.now(),
        uniqueId: user.uniqueId,
        nickname: user.nickname,
        profilePictureUrl: user.profilePictureUrl
    };
}
function normalizeFollow(data) {
    const user = getUserDetails(data);
    return {
        type: "follow",
        id: data.msgId || Math.random().toString(36).substring(2, 11),
        timestamp: parseInt(data.createTime) || Date.now(),
        uniqueId: user.uniqueId,
        nickname: user.nickname,
        profilePictureUrl: user.profilePictureUrl
    };
}
function normalizeShare(data) {
    const user = getUserDetails(data);
    return {
        type: "share",
        id: data.msgId || Math.random().toString(36).substring(2, 11),
        timestamp: parseInt(data.createTime) || Date.now(),
        uniqueId: user.uniqueId,
        nickname: user.nickname,
        profilePictureUrl: user.profilePictureUrl
    };
}
// Configuración de listeners para TikTok Live
function setupTikTokListeners(conn) {
    conn.on(EventType.connected, (data) => {
        console.log(`✅ Conectado exitosamente al live de ${currentUsername} (Room ID: ${data.roomId})`);
        io.emit("status-update", { connected: true, username: currentUsername });
        startCentralSession();
    });
    conn.on(EventType.reconnecting, (data) => {
        console.warn(`🔄 Re-conectando con ${currentUsername} (Intento ${data.attempt}/${data.maxRetries}, retraso: ${data.delayMs}ms, bloqueado: ${data.deviceBlocked})`);
        io.emit("status-update", { connected: false, username: currentUsername, connecting: true });
    });
    conn.on(EventType.chat, (data) => {
        const normalized = normalizeChat(data);
        console.log(`💬 [Chat] @${normalized.uniqueId}: ${normalized.comment}`);
        io.emit("live-event", normalized);
        // Si escribe "pelea", se agrega a la cola
        if (normalized.comment.trim().toLowerCase() === "pelea") {
            addToQueue({
                username: normalized.uniqueId,
                nickname: normalized.nickname,
                profilePictureUrl: normalized.profilePictureUrl
            });
        }
    });
    conn.on(EventType.gift, (data) => {
        const normalized = normalizeGift(data);
        console.log(`🎁 [Gift] @${normalized.uniqueId} envió ${normalized.giftName} x${normalized.repeatCount} (${normalized.diamondCount} diamantes)`);
        io.emit("live-event", normalized);
        if (normalized.repeatEnd) {
            sessionDiamonds += (normalized.diamondCount * normalized.repeatCount);
        }
    });
    conn.on(EventType.like, (data) => {
        const normalized = normalizeLike(data);
        console.log(`❤️ [Like] @${normalized.uniqueId} dio ${normalized.likeCount} likes`);
        io.emit("live-event", normalized);
        sessionLikes += (normalized.likeCount || 1);
    });
    conn.on(EventType.join, (data) => {
        io.emit("live-event", normalizeJoin(data));
    });
    conn.on(EventType.follow, (data) => {
        io.emit("live-event", normalizeFollow(data));
        sessionFollowers += 1;
    });
    conn.on(EventType.share, (data) => {
        io.emit("live-event", normalizeShare(data));
        sessionShares += 1;
    });
    conn.on(EventType.disconnected, () => {
        console.log(`🔌 Desconectado de ${currentUsername}`);
        activeConnection = null;
        currentUsername = null;
        io.emit("status-update", { connected: false, username: null });
        endCentralSession();
    });
    conn.on("error", (err) => {
        console.error("❌ Error en conexión TikTok:", err);
        io.emit("error-message", { message: err.message || "Error de conexión" });
    });
}
// Socket.io handlers
io.on("connection", (socket) => {
    console.log(`👤 Cliente conectado: ${socket.id}`);
    // Enviar estado actual y cola al conectar
    socket.emit("status-update", {
        connected: !!activeConnection,
        username: currentUsername
    });
    socket.emit("queue-update", queue);
    // Intentar conectar a un live
    socket.on("connect-tiktok", async ({ username }) => {
        if (!username) {
            return socket.emit("error-message", { message: "Se requiere un nombre de usuario" });
        }
        // Validar licencia activa antes de proceder con el live
        const licenseValid = await checkLicenseActive();
        if (!licenseValid) {
            return socket.emit("error-message", { message: "Tu licencia ha sido revocada o está inactiva." });
        }
        try {
            // Si ya hay conexión activa, cerrarla
            if (activeConnection) {
                console.log(`🔄 Desconectando conexión anterior con ${currentUsername}`);
                try {
                    activeConnection.disconnect();
                }
                catch (e) { }
                activeConnection = null;
                currentUsername = null;
            }
            console.log(`⏳ Intentando conectar con ${username}...`);
            io.emit("status-update", { connected: false, username: username, connecting: true });
            const conn = new TikTokLiveClient(username);
            // Guardar el estado antes de iniciar para los listeners
            activeConnection = conn;
            currentUsername = username;
            // Registrar los listeners antes de llamar a connect
            setupTikTokListeners(conn);
            // Iniciar la conexión en segundo plano sin bloquear el flujo principal
            conn.connect().then(() => {
                console.log(`ℹ️ Conexión finalizada de fondo para ${username}`);
            }).catch((err) => {
                console.error(`❌ Error en conexión asíncrona a ${username}:`, err);
                activeConnection = null;
                currentUsername = null;
                io.emit("status-update", { connected: false, username: null });
                socket.emit("error-message", { message: `No se pudo conectar: ${err.message || err}` });
            });
            console.log(`⏳ Conectando al live de ${username} en segundo plano...`);
        }
        catch (err) {
            console.error(`❌ Error al conectar a ${username}:`, err);
            io.emit("status-update", { connected: false, username: null });
            socket.emit("error-message", { message: `No se pudo conectar: ${err.message || err}` });
        }
    });
    // Desconectar del live
    socket.on("disconnect-tiktok", () => {
        if (activeConnection) {
            console.log(`🔌 Desconectando manualmente de ${currentUsername}`);
            try {
                activeConnection.disconnect();
            }
            catch (e) { }
            activeConnection = null;
            currentUsername = null;
            io.emit("status-update", { connected: false, username: null });
        }
    });
    // Operaciones de cola manuales desde el dashboard
    socket.on("queue-join-manual", (user) => {
        addToQueue(user);
    });
    socket.on("queue-remove-manual", (username) => {
        removeFromQueue(username);
    });
    socket.on("queue-clear-manual", () => {
        clearQueue();
    });
    // Forward Live Leaderboard from Battle Window
    socket.on("update-leaderboard", (data) => {
        io.emit("live-leaderboard", data);
    });
    socket.on("disconnect", () => {
        console.log(`🔌 Cliente desconectado del socket: ${socket.id}`);
    });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
