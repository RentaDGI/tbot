-- =============================================
-- EJECUTAR ESTE SQL EN SUPABASE > SQL EDITOR
-- =============================================

-- Tabla de cuentas
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL UNIQUE,
    server_url TEXT NOT NULL,
    cookies JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cola de tareas de construcción
CREATE TABLE IF NOT EXISTS build_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    village_id TEXT DEFAULT 'main',
    building_slot INTEGER NOT NULL,
    building_name TEXT,
    target_level INTEGER,
    priority INTEGER DEFAULT 5,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
    error_message TEXT,
    scheduled_for TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Logs de acciones
CREATE TABLE IF NOT EXISTS bot_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES accounts(id),
    action TEXT NOT NULL,
    details JSONB,
    severity TEXT DEFAULT 'info',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para mejor rendimiento
CREATE INDEX IF NOT EXISTS idx_build_queue_pending 
    ON build_queue(account_id, status, priority DESC, created_at ASC) 
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_logs_recent 
    ON bot_logs(created_at DESC);

-- Insertar cuenta de prueba (CAMBIAR DATOS)
INSERT INTO accounts (username, server_url) 
VALUES ('TU_USUARIO', 'https://ts1.x1.europe.travian.com')
ON CONFLICT (username) DO NOTHING;