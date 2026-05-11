-- Admin audit log for tracking sensitive admin operations.
-- Records who did what to whom, providing an immutable trail for security review.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   INTEGER NOT NULL,
  admin_user_id TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_user_id TEXT,
  details     TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_timestamp ON admin_audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin ON admin_audit_log(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target ON admin_audit_log(target_user_id);
