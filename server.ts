import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import { TikTokLiveClient, EventType } from "piratetok-live-js";

interface QueueUser {
  username: string;
  name: string;
  photo: string;
}

let queue: QueueUser[] = [];
let activeConnection: TikTokLiveClient | null = null;
let currentUsername: string | null = null;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// Helpers para la cola de pelea
function isUserInQueue(username: string): boolean {
  return queue.some(user => user.username === username);
}

function addToQueue(user: { username: string; nickname?: string; name?: string; profilePictureUrl?: string; photo?: string }): boolean {
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

function removeFromQueue(username: string): boolean {
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

function clearQueue(): void {
  queue = [];
  io.emit("queue-update", queue);
  io.emit("system-event", {
    type: "queue-clear",
    message: "La cola de pelea fue limpiada"
  });
}

// Utilidad para extraer detalles del usuario compatibles con PirateTok
function getUserDetails(data: any) {
  const uniqueId = data.user?.displayId || data.uniqueId || "usuario";
  const nickname = data.user?.nickname || data.nickname || uniqueId;
  const profilePictureUrl = data.user?.avatarThumb?.urlList?.[0] ||
    data.profilePictureUrl ||
    "https://www.tiktok.com/favicon.ico";
  return { uniqueId, nickname, profilePictureUrl };
}

// Normalizadores de eventos para enviar al frontend
function normalizeChat(data: any) {
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

function normalizeGift(data: any) {
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

function normalizeLike(data: any) {
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

function normalizeJoin(data: any) {
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

function normalizeFollow(data: any) {
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

function normalizeShare(data: any) {
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
function setupTikTokListeners(conn: TikTokLiveClient): void {
  conn.on(EventType.connected, (data: any) => {
    console.log(`✅ Conectado exitosamente al live de ${currentUsername} (Room ID: ${data.roomId})`);
    io.emit("status-update", { connected: true, username: currentUsername });
  });

  conn.on(EventType.chat, (data: any) => {
    const normalized = normalizeChat(data);
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

  conn.on(EventType.gift, (data: any) => {
    io.emit("live-event", normalizeGift(data));
  });

  conn.on(EventType.like, (data: any) => {
    io.emit("live-event", normalizeLike(data));
  });

  conn.on(EventType.join, (data: any) => {
    io.emit("live-event", normalizeJoin(data));
  });

  conn.on(EventType.follow, (data: any) => {
    io.emit("live-event", normalizeFollow(data));
  });

  conn.on(EventType.share, (data: any) => {
    io.emit("live-event", normalizeShare(data));
  });

  conn.on(EventType.disconnected, () => {
    console.log(`🔌 Desconectado de ${currentUsername}`);
    activeConnection = null;
    currentUsername = null;
    io.emit("status-update", { connected: false, username: null });
  });

  conn.on("error", (err: any) => {
    console.error("❌ Error en conexión TikTok:", err);
    io.emit("error-message", { message: err.message || "Error de conexión" });
  });
}

// Socket.io handlers
io.on("connection", (socket: Socket) => {
  console.log(`👤 Cliente conectado: ${socket.id}`);

  // Enviar estado actual y cola al conectar
  socket.emit("status-update", {
    connected: !!activeConnection,
    username: currentUsername
  });
  socket.emit("queue-update", queue);

  // Intentar conectar a un live
  socket.on("connect-tiktok", async ({ username }: { username: string }) => {
    if (!username) {
      return socket.emit("error-message", { message: "Se requiere un nombre de usuario" });
    }

    try {
      // Si ya hay conexión activa, cerrarla
      if (activeConnection) {
        console.log(`🔄 Desconectando conexión anterior con ${currentUsername}`);
        try {
          activeConnection.disconnect();
        } catch (e) { }
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
      }).catch((err: any) => {
        console.error(`❌ Error en conexión asíncrona a ${username}:`, err);
        activeConnection = null;
        currentUsername = null;
        io.emit("status-update", { connected: false, username: null });
        socket.emit("error-message", { message: `No se pudo conectar: ${err.message || err}` });
      });

      console.log(`⏳ Conectando al live de ${username} en segundo plano...`);

    } catch (err: any) {
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
      } catch (e) { }
      activeConnection = null;
      currentUsername = null;
      io.emit("status-update", { connected: false, username: null });
    }
  });

  // Operaciones de cola manuales desde el dashboard
  socket.on("queue-join-manual", (user: any) => {
    addToQueue(user);
  });

  socket.on("queue-remove-manual", (username: string) => {
    removeFromQueue(username);
  });

  socket.on("queue-clear-manual", () => {
    clearQueue();
  });


  // Forward Live Leaderboard from Battle Window
  socket.on("update-leaderboard", (data: any) => {
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