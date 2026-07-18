-- ============================================
-- TikTok Games Royalty System — DB Schema
-- Database: tiktok
-- ============================================

-- Configuración global del sistema
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('diamond_rate_usd', '0.005'),
  ('royalty_pct', '10')
ON CONFLICT (key) DO NOTHING;

-- Creadores con licencia activa
CREATE TABLE IF NOT EXISTS creators (
  id           SERIAL PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT,
  api_key      TEXT UNIQUE NOT NULL,
  license_date DATE NOT NULL DEFAULT CURRENT_DATE,
  active       BOOLEAN DEFAULT TRUE,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Sesiones de transmisión (una por live)
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

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_sessions_creator_id ON sessions(creator_id);
CREATE INDEX IF NOT EXISTS idx_sessions_paid ON sessions(paid);
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_creators_api_key ON creators(api_key);
