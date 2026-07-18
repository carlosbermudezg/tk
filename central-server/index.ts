import express from "express";
import cors from "cors";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import pg from "pg";
import nodemailer from "nodemailer";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Load .env ───────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...rest] = trimmed.split("=");
      if (key) process.env[key.trim()] = rest.join("=").trim();
    }
  }
}

const { Pool } = pg;

// ─── PostgreSQL Pool ─────────────────────────────────────────────────────────
const pool = new Pool({
  user: process.env.PGUSER || "postgres",
  host: process.env.PGHOST || "localhost",
  database: process.env.PGDATABASE || "tiktok",
  password: process.env.PGPASSWORD || "",
  port: parseInt(process.env.PGPORT || "5432"),
});

// ─── Init DB ─────────────────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES
        ('diamond_rate_usd', '0.005'),
        ('royalty_pct', '10')
      ON CONFLICT (key) DO NOTHING;
      UPDATE config SET value = '0.005' WHERE key = 'diamond_rate_usd';

      CREATE TABLE IF NOT EXISTS creators (
        id            SERIAL PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        display_name  TEXT,
        api_key       TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL DEFAULT '',
        license_date  DATE NOT NULL DEFAULT CURRENT_DATE,
        active        BOOLEAN DEFAULT TRUE,
        notes         TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE creators ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE creators ADD COLUMN IF NOT EXISTS email TEXT;

      -- Hacer que username sea nullable para instalaciones existentes sin romper nada
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='creators' AND column_name='username') THEN
          ALTER TABLE creators ALTER COLUMN username DROP NOT NULL;
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         SERIAL PRIMARY KEY,
        creator_id INT REFERENCES creators(id) ON DELETE CASCADE,
        token      TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id             SERIAL PRIMARY KEY,
        creator_id     INT REFERENCES creators(id) ON DELETE CASCADE,
        start_time     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        end_time       TIMESTAMPTZ,
        diamonds       INT DEFAULT 0,
        likes          INT DEFAULT 0,
        new_followers  INT DEFAULT 0,
        shares         INT DEFAULT 0,
        estimated_usd  NUMERIC(10,4) DEFAULT 0,
        royalty_usd    NUMERIC(10,4) DEFAULT 0,
        paid           BOOLEAN DEFAULT FALSE,
        paid_date      DATE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_creator_id ON sessions(creator_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_paid ON sessions(paid);
      CREATE INDEX IF NOT EXISTS idx_creators_api_key ON creators(api_key);
      CREATE INDEX IF NOT EXISTS idx_creators_email ON creators(email);
    `);
    console.log("✅ Base de datos inicializada");
  } finally {
    client.release();
  }
}

// ─── Password helpers (scrypt, sin dependencias extra) ──────────────────────
function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(`${salt}:${derived.toString("hex")}`);
    });
  });
}

function verifyPassword(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(":");
    if (!salt || !key) return resolve(false);
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(derived.toString("hex") === key);
    });
  });
}

// ─── Helper: get config values ───────────────────────────────────────────────
async function getConfig(): Promise<{ diamond_rate_usd: number; royalty_pct: number }> {
  const res = await pool.query("SELECT key, value FROM config");
  const cfg: Record<string, string> = {};
  res.rows.forEach((r) => (cfg[r.key] = r.value));
  return {
    diamond_rate_usd: parseFloat(cfg.diamond_rate_usd || "0.005"),
    royalty_pct: parseFloat(cfg.royalty_pct || "10"),
  };
}

// ─── Helper: validate API key ────────────────────────────────────────────────
async function validateApiKey(apiKey: string | undefined) {
  if (!apiKey) return null;
  const res = await pool.query(
    "SELECT * FROM creators WHERE api_key = $1 AND active = TRUE",
    [apiKey]
  );
  return res.rows[0] || null;
}

// ─── Express App ────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.get("/admin.html", (req, res) => {
  res.redirect("/admin");
});
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.use(express.static(path.join(__dirname, "public")));

// ─── Nodemailer (Gmail) ────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER || "",
    pass: (process.env.SMTP_PASS || "").replace(/\s+/g, ""),  // Contraseña de aplicación de Google (16 caracteres, sin espacios)
  },
});

async function sendResetEmail(email: string, displayName: string, token: string) {
  const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
  const resetLink = `${BASE_URL}/reset-password.html?token=${token}`;

  await mailer.sendMail({
    from: `"TikTok Games" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Recupera tu contraseña — TikTok Games",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#111;color:#f1f5f9;border-radius:12px;padding:32px">
        <h2 style="color:#7c3aed">&#127918; TikTok Games</h2>
        <p>Hola <strong>${displayName}</strong>,</p>
        <p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el botón de abajo:</p>
        <a href="${resetLink}" style="display:inline-block;margin:20px 0;padding:14px 28px;
          background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;border-radius:10px;
          text-decoration:none;font-weight:700;font-size:15px">
          Restablecer contraseña
        </a>
        <p style="color:#64748b;font-size:12px">Este enlace expira en <strong>1 hora</strong>. Si no solicitaste este cambio, ignora este correo.</p>
        <hr style="border-color:#1e293b;margin-top:24px">
        <p style="color:#334155;font-size:11px">TikTok Games Launcher &bull; Acceso solo para creadores licenciados</p>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUTH ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/login  — Login con email + contraseña
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, message: "Email y contraseña requeridos" });
  }

  const result = await pool.query(
    "SELECT * FROM creators WHERE email = $1 AND active = TRUE",
    [email.toLowerCase().trim()]
  );
  const creator = result.rows[0];

  if (!creator || !creator.password_hash) {
    return res.status(401).json({ ok: false, message: "Credenciales incorrectas" });
  }

  const valid = await verifyPassword(password, creator.password_hash);
  if (!valid) {
    return res.status(401).json({ ok: false, message: "Credenciales incorrectas" });
  }

  console.log(`🔑 Login exitoso: ${creator.email}`);
  res.json({
    ok: true,
    apiKey: creator.api_key,
    displayName: creator.display_name || creator.email,
    email: creator.email,
  });
});

// POST /api/auth/forgot-password
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ ok: false, message: "Email requerido" });

  const result = await pool.query(
    "SELECT * FROM creators WHERE email = $1 AND active = TRUE",
    [email.toLowerCase().trim()]
  );
  const creator = result.rows[0];

  // Siempre respondemos OK para no revelar si el email existe
  if (!creator) {
    return res.json({ ok: true, message: "Si el correo existe, recibirás un enlace" });
  }

  // Invalidar tokens anteriores
  await pool.query("UPDATE password_reset_tokens SET used = TRUE WHERE creator_id = $1", [creator.id]);

  // Crear token con expiry de 1 hora
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO password_reset_tokens (creator_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
    [creator.id, token]
  );

  try {
    await sendResetEmail(creator.email, creator.display_name || creator.email, token);
    console.log(`📧 Email de recuperación enviado a: ${creator.email}`);
  } catch (err: any) {
    console.error("\u274c Error al enviar email:", err.message);
    return res.status(500).json({ ok: false, message: "Error al enviar el correo. Verifica la configuración SMTP." });
  }

  res.json({ ok: true, message: "Si el correo existe, recibirás un enlace" });
});

// POST /api/auth/reset-password
app.post("/api/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ ok: false, message: "Token y contraseña requeridos" });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, message: "La contraseña debe tener al menos 6 caracteres" });
  }

  const tokenRes = await pool.query(
    "SELECT * FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()",
    [token]
  );
  const tokenRow = tokenRes.rows[0];
  if (!tokenRow) {
    return res.status(400).json({ ok: false, message: "El enlace es inválido o ya expiró" });
  }

  const hash = await hashPassword(password);
  await pool.query("UPDATE creators SET password_hash = $1 WHERE id = $2", [hash, tokenRow.creator_id]);
  await pool.query("UPDATE password_reset_tokens SET used = TRUE WHERE id = $1", [tokenRow.id]);

  console.log(`🔑 Contraseña restablecida para creator_id=${tokenRow.creator_id}`);
  res.json({ ok: true, message: "Contraseña actualizada correctamente" });
});

// ─────────────────────────────────────────────────────────────────────────────
//  LAUNCHER ENDPOINTS (autenticados con API Key del creador)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/license/validate
app.get("/api/license/validate", async (req, res) => {
  const apiKey = req.headers["x-api-key"] as string;
  const creator = await validateApiKey(apiKey);
  if (!creator) {
    return res.status(401).json({ valid: false, message: "Licencia inválida o inactiva" });
  }
  res.json({ valid: true, displayName: creator.display_name || creator.email, email: creator.email });
});

// GET /api/creator/stats
app.get("/api/creator/stats", async (req, res) => {
  const apiKey = req.headers["x-api-key"] as string;
  const creator = await validateApiKey(apiKey);
  if (!creator) return res.status(401).json({ error: "No autorizado" });

  const sessionsRes = await pool.query(
    "SELECT * FROM sessions WHERE creator_id = $1 ORDER BY start_time DESC LIMIT 30",
    [creator.id]
  );
  
  const statsRes = await pool.query(`
    SELECT 
      COALESCE(SUM(diamonds), 0) as total_diamonds,
      COALESCE(SUM(estimated_usd), 0) as total_usd,
      COALESCE(SUM(CASE WHEN paid = FALSE AND end_time IS NOT NULL THEN royalty_usd ELSE 0 END), 0) as pending_royalty
    FROM sessions 
    WHERE creator_id = $1
  `, [creator.id]);

  res.json({
    email: creator.email,
    displayName: creator.display_name || creator.email,
    sessions: sessionsRes.rows,
    stats: statsRes.rows[0]
  });
});

// PUT /api/creator/profile
app.put("/api/creator/profile", async (req, res) => {
  const apiKey = req.headers["x-api-key"] as string;
  const creator = await validateApiKey(apiKey);
  if (!creator) return res.status(401).json({ error: "No autorizado" });

  const { displayName, password } = req.body;

  if (displayName) {
    await pool.query("UPDATE creators SET display_name = $1 WHERE id = $2", [displayName.trim(), creator.id]);
  }

  if (password) {
    if (password.length < 6) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
    }
    const hash = await hashPassword(password);
    await pool.query("UPDATE creators SET password_hash = $1 WHERE id = $2", [hash, creator.id]);
  }

  res.json({ ok: true, displayName: displayName || creator.display_name });
});

// GET /api/games/manifest
app.get("/api/games/manifest", async (req, res) => {
  const apiKey = req.headers["x-api-key"] as string;
  const creator = await validateApiKey(apiKey);
  if (!creator) return res.status(401).json({ error: "No autorizado" });

  const manifestPath = path.join(__dirname, "games-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return res.json({ manifest_version: "1.0.0", games: [] });
  }
  res.json(JSON.parse(fs.readFileSync(manifestPath, "utf-8")));
});

// GET /api/games/:gameId/files/*
app.get("/api/games/:gameId/files/*", async (req, res) => {
  const apiKey = req.headers["x-api-key"] as string;
  const creator = await validateApiKey(apiKey);
  if (!creator) return res.status(401).json({ error: "No autorizado" });

  const gameId = req.params.gameId;
  const filePath = (req.params as any)[0] as string;
  const fullPath = path.join(__dirname, "games", gameId, filePath);

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: "Archivo no encontrado" });
  }
  res.sendFile(fullPath);
});

// POST /api/sessions/start
app.post("/api/sessions/start", async (req, res) => {
  const apiKey = req.headers["x-api-key"] as string;
  const creator = await validateApiKey(apiKey);
  if (!creator) return res.status(401).json({ error: "No autorizado" });

  const result = await pool.query(
    "INSERT INTO sessions (creator_id) VALUES ($1) RETURNING id, start_time",
    [creator.id]
  );
  const session = result.rows[0];
  console.log(`▶️  Sesión iniciada: creator=${creator.email} session_id=${session.id}`);
  res.json({ sessionId: session.id, startTime: session.start_time });
});

// PATCH /api/sessions/:id/metrics
app.patch("/api/sessions/:id/metrics", async (req, res) => {
  const apiKey = req.headers["x-api-key"] as string;
  const creator = await validateApiKey(apiKey);
  if (!creator) return res.status(401).json({ error: "No autorizado" });

  const { diamonds = 0, likes = 0, newFollowers = 0, shares = 0 } = req.body;
  const sessionId = parseInt(req.params.id);
  const cfg = await getConfig();

  // Verify session belongs to this creator
  const check = await pool.query(
    "SELECT id FROM sessions WHERE id = $1 AND creator_id = $2",
    [sessionId, creator.id]
  );
  if (check.rows.length === 0) return res.status(403).json({ error: "Sesión no encontrada" });

  const updateRes = await pool.query(
    `UPDATE sessions SET
       diamonds      = diamonds + $1,
       likes         = likes + $2,
       new_followers = new_followers + $3,
       shares        = shares + $4
     WHERE id = $5
     RETURNING diamonds`,
    [diamonds, likes, newFollowers, shares, sessionId]
  );

  if (updateRes.rows.length > 0) {
    const totalDiamonds = updateRes.rows[0].diamonds;
    const estimatedUsd = totalDiamonds * cfg.diamond_rate_usd;
    const royaltyUsd = estimatedUsd * (cfg.royalty_pct / 100);

    await pool.query(
      `UPDATE sessions SET
         estimated_usd = $1,
         royalty_usd   = $2
       WHERE id = $3`,
      [estimatedUsd.toFixed(4), royaltyUsd.toFixed(4), sessionId]
    );
  }

  res.json({ ok: true });
});

// POST /api/sessions/:id/end
app.post("/api/sessions/:id/end", async (req, res) => {
  const apiKey = req.headers["x-api-key"] as string;
  const creator = await validateApiKey(apiKey);
  if (!creator) return res.status(401).json({ error: "No autorizado" });

  const sessionId = parseInt(req.params.id);
  const cfg = await getConfig();

  // Get latest metrics
  const sessionRes = await pool.query(
    "SELECT * FROM sessions WHERE id = $1 AND creator_id = $2",
    [sessionId, creator.id]
  );
  if (sessionRes.rows.length === 0) return res.status(403).json({ error: "Sesión no encontrada" });

  const session = sessionRes.rows[0];
  const estimatedUsd = session.diamonds * cfg.diamond_rate_usd;
  const royaltyUsd = estimatedUsd * (cfg.royalty_pct / 100);

  await pool.query(
    `UPDATE sessions SET
       end_time      = NOW(),
       estimated_usd = $1,
       royalty_usd   = $2
     WHERE id = $3`,
    [estimatedUsd.toFixed(4), royaltyUsd.toFixed(4), sessionId]
  );

  console.log(`⏹️  Sesión terminada: creator=${creator.email} diamonds=${session.diamonds} royalty=$${royaltyUsd.toFixed(2)}`);
  res.json({ ok: true, estimatedUsd, royaltyUsd });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_TOKEN = "carlos-admin-secret-token-777";

function requireAdminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers["x-admin-token"];
  if (token === ADMIN_TOKEN) {
    return next();
  }
  res.status(401).json({ error: "No autorizado (admin)" });
}

// POST /api/admin/login
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "Carlos" && password === ".drilo777") {
    return res.json({ ok: true, token: ADMIN_TOKEN });
  }
  res.status(401).json({ error: "Usuario o contraseña de administrador incorrectos" });
});

// GET /api/config
app.get("/api/config", requireAdminAuth, async (_req, res) => {
  const cfg = await getConfig();
  res.json(cfg);
});

// PUT /api/config
app.put("/api/config", requireAdminAuth, async (req, res) => {
  const { diamond_rate_usd, royalty_pct } = req.body;
  if (diamond_rate_usd !== undefined) {
    await pool.query("UPDATE config SET value = $1 WHERE key = 'diamond_rate_usd'", [String(diamond_rate_usd)]);
  }
  if (royalty_pct !== undefined) {
    await pool.query("UPDATE config SET value = $1 WHERE key = 'royalty_pct'", [String(royalty_pct)]);
  }
  res.json({ ok: true });
});

// GET /api/stats
app.get("/api/stats", requireAdminAuth, async (_req, res) => {
  const [creatorsRes, sessionsRes, pendingRes] = await Promise.all([
    pool.query("SELECT COUNT(*) as total, SUM(CASE WHEN active THEN 1 ELSE 0 END) as active FROM creators"),
    pool.query("SELECT SUM(diamonds) as total_diamonds, SUM(estimated_usd) as total_usd, SUM(royalty_usd) as total_royalty FROM sessions"),
    pool.query("SELECT SUM(royalty_usd) as pending FROM sessions WHERE paid = FALSE AND end_time IS NOT NULL"),
  ]);

  res.json({
    totalCreators: parseInt(creatorsRes.rows[0].total),
    activeCreators: parseInt(creatorsRes.rows[0].active),
    totalDiamonds: parseInt(sessionsRes.rows[0].total_diamonds || "0"),
    totalUsd: parseFloat(sessionsRes.rows[0].total_usd || "0"),
    totalRoyalty: parseFloat(sessionsRes.rows[0].total_royalty || "0"),
    pendingRoyalty: parseFloat(pendingRes.rows[0].pending || "0"),
  });
});

// GET /api/creators
app.get("/api/creators", requireAdminAuth, async (_req, res) => {
  const result = await pool.query(`
    SELECT c.*,
      COUNT(s.id) as session_count,
      SUM(s.diamonds) as total_diamonds,
      SUM(s.estimated_usd) as total_usd,
      SUM(CASE WHEN s.paid = FALSE AND s.end_time IS NOT NULL THEN s.royalty_usd ELSE 0 END) as pending_royalty,
      MAX(s.start_time) as last_session
    FROM creators c
    LEFT JOIN sessions s ON s.creator_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `);
  res.json(result.rows);
});

// POST /api/creators
app.post("/api/creators", requireAdminAuth, async (req, res) => {
  const { email, displayName, password, notes } = req.body;
  if (!email) return res.status(400).json({ error: "email requerido" });
  if (!password) return res.status(400).json({ error: "contraseña requerida" });

  const apiKey = "CRE-" + crypto.randomBytes(12).toString("hex");
  const passwordHash = await hashPassword(password);

  try {
    const result = await pool.query(
      "INSERT INTO creators (email, display_name, api_key, password_hash, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [email.toLowerCase().trim(), displayName || email, apiKey, passwordHash, notes || null]
    );
    // No devolver password_hash al cliente
    const { password_hash, ...safe } = result.rows[0];
    res.status(201).json(safe);
  } catch (e: any) {
    if (e.code === "23505") {
      return res.status(409).json({ error: "Este correo ya está registrado" });
    }
    throw e;
  }
});

// PUT /api/creators/:id/password  — cambiar contraseña
app.put("/api/creators/:id/password", requireAdminAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "contraseña requerida" });
  const hash = await hashPassword(password);
  await pool.query("UPDATE creators SET password_hash = $1 WHERE id = $2", [hash, parseInt(req.params.id)]);
  res.json({ ok: true });
});

// PUT /api/creators/:id
app.put("/api/creators/:id", requireAdminAuth, async (req, res) => {
  const { displayName, active, notes } = req.body;
  const id = parseInt(req.params.id);

  await pool.query(
    `UPDATE creators SET
       display_name = COALESCE($1, display_name),
       active       = COALESCE($2, active),
       notes        = COALESCE($3, notes)
     WHERE id = $4`,
    [displayName, active, notes, id]
  );
  res.json({ ok: true });
});

// DELETE /api/creators/:id
app.delete("/api/creators/:id", requireAdminAuth, async (req, res) => {
  await pool.query("DELETE FROM creators WHERE id = $1", [parseInt(req.params.id)]);
  res.json({ ok: true });
});

// GET /api/creators/:id/sessions
app.get("/api/creators/:id/sessions", requireAdminAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM sessions WHERE creator_id = $1 ORDER BY start_time DESC LIMIT 100",
    [parseInt(req.params.id)]
  );
  res.json(result.rows);
});

// PUT /api/sessions/:id/paid
app.put("/api/sessions/:id/paid", requireAdminAuth, async (req, res) => {
  const { paid } = req.body;
  await pool.query(
    "UPDATE sessions SET paid = $1, paid_date = CASE WHEN $1 THEN CURRENT_DATE ELSE NULL END WHERE id = $2",
    [paid !== false, parseInt(req.params.id)]
  );
  res.json({ ok: true });
});

// GET /api/pending-royalties
app.get("/api/pending-royalties", requireAdminAuth, async (_req, res) => {
  const result = await pool.query(`
    SELECT COALESCE(c.email, c.username) as username, c.email, c.display_name, c.api_key,
           s.id as session_id, s.start_time, s.end_time,
           s.diamonds, s.estimated_usd, s.royalty_usd
    FROM sessions s
    JOIN creators c ON c.id = s.creator_id
    WHERE s.paid = FALSE AND s.end_time IS NOT NULL
    ORDER BY COALESCE(c.email, c.username), s.start_time DESC
  `);
  res.json(result.rows);
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "4000");

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor Central corriendo en http://localhost:${PORT}`);
    console.log(`📊 Panel Admin: http://localhost:${PORT}/admin`);
  });
}).catch((err) => {
  console.error("❌ Error al conectar con PostgreSQL:", err.message);
  process.exit(1);
});
