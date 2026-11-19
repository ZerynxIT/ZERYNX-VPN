-- ============================================
-- ZERYNX VPN
-- DATABASE SCHEMA
-- Version: 1.0.1
-- Cloudflare D1 / SQLite
-- ============================================

PRAGMA foreign_keys = ON;

-- ============================================
-- 1. SCHEMA VERSION
-- ============================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 2. ADMIN USERS
-- ============================================

CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin'
        CHECK (role IN ('owner', 'admin', 'operator')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_users_status
ON admin_users(status);

-- ============================================
-- 3. VPN USERS
-- ============================================

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled', 'expired', 'limited')),
    quota_bytes INTEGER NOT NULL DEFAULT 0
        CHECK (quota_bytes >= 0),
    used_bytes INTEGER NOT NULL DEFAULT 0
        CHECK (used_bytes >= 0),
    expires_at TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_status
ON users(status);

CREATE INDEX IF NOT EXISTS idx_users_expiration
ON users(expires_at);

CREATE INDEX IF NOT EXISTS idx_users_created
ON users(created_at);

-- ============================================
-- 4. VPN NODES
-- ============================================

CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    country TEXT,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'offline'
        CHECK (status IN ('online', 'offline', 'maintenance')),
    protocol TEXT,
    last_check_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nodes_status
ON nodes(status);

-- ============================================
-- 5. INBOUNDS
-- ============================================

CREATE TABLE IF NOT EXISTS inbounds (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    port INTEGER NOT NULL
        CHECK (port BETWEEN 1 AND 65535),
    status TEXT NOT NULL DEFAULT 'disabled'
        CHECK (status IN ('enabled', 'disabled')),
    settings_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (node_id)
        REFERENCES nodes(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inbounds_node
ON inbounds(node_id);

CREATE INDEX IF NOT EXISTS idx_inbounds_status
ON inbounds(status);

-- ============================================
-- 6. USER SUBSCRIPTIONS
-- ============================================

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled', 'expired')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
ON subscriptions(status);

CREATE INDEX IF NOT EXISTS idx_subscriptions_expiration
ON subscriptions(expires_at);

-- ============================================
-- 7. USER CONFIGURATIONS
-- ============================================

CREATE TABLE IF NOT EXISTS user_configs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    inbound_id TEXT,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    external_reference TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    FOREIGN KEY (inbound_id)
        REFERENCES inbounds(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_configs_user
ON user_configs(user_id);

CREATE INDEX IF NOT EXISTS idx_user_configs_inbound
ON user_configs(inbound_id);

-- ============================================
-- 8. TRAFFIC USAGE
-- ============================================

CREATE TABLE IF NOT EXISTS traffic_usage (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    node_id TEXT,
    upload_bytes INTEGER NOT NULL DEFAULT 0
        CHECK (upload_bytes >= 0),
    download_bytes INTEGER NOT NULL DEFAULT 0
        CHECK (download_bytes >= 0),
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT NOT NULL DEFAULT 'external',

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    FOREIGN KEY (node_id)
        REFERENCES nodes(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_traffic_user_date
ON traffic_usage(user_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_traffic_node_date
ON traffic_usage(node_id, recorded_at);

-- ============================================
-- 9. ADMIN SESSIONS
-- ============================================

CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    session_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (admin_id)
        REFERENCES admin_users(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin
ON admin_sessions(admin_id);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiration
ON admin_sessions(expires_at);

-- ============================================
-- 10. SYSTEM SETTINGS
-- ============================================

CREATE TABLE IF NOT EXISTS system_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 11. ACTIVITY LOGS
-- ============================================

CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL
        CHECK (actor_type IN ('admin', 'system')),
    actor_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_date
ON activity_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_activity_logs_actor
ON activity_logs(actor_type, actor_id);

CREATE INDEX IF NOT EXISTS idx_activity_logs_action
ON activity_logs(action);

-- ============================================
-- 12. INITIAL SYSTEM SETTINGS
-- ============================================

INSERT OR IGNORE INTO system_settings
(setting_key, setting_value)
VALUES
('panel_name', 'ZERYNX VPN'),
('panel_version', '1.0.1'),
('default_language', 'fa'),
('default_theme', 'dark'),
('max_users', '5'),
('maintenance_mode', 'false'),
('installation_status', 'pending');

-- ============================================
-- 13. REGISTER SCHEMA VERSION
-- ============================================

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('1.0.1');

-- ============================================
-- END OF ZERYNX VPN SCHEMA
-- ============================================
