// Versioned, idempotent schema migrations.
//
// Rules for every migration (see docs/MIGRATIONS.md):
//   - additive and backwards-compatible: new tables / nullable columns / indexes; never DROP or
//     rewrite existing data in the same release that stops using it
//   - idempotent: written with IF NOT EXISTS / guarded UPDATEs, so re-running is harmless
//   - runs inside ONE transaction (all-or-nothing) and is recorded in schema_migrations
//   - a cluster-wide advisory lock stops two app instances (old + new during a Render deploy)
//     from migrating at the same time
//   - never edit a migration that has shipped; add a new one
//
// The legacy startup schema code in db.js (CREATE TABLE IF NOT EXISTS / ensureColumn) still runs
// first and stays as-is; everything new goes here.

const MIGRATIONS = [
  {
    version: '001',
    name: 'foundation: activity, notification deliveries, jobs, integrations, AI usage, files, task source',
    // New tables use TIMESTAMPTZ (absolute instants) and JSONB. Older tables keep their existing
    // TEXT ISO-8601 timestamps for compatibility; converting them is a separate, planned migration.
    sql: `
      CREATE TABLE IF NOT EXISTS task_activity_events (
        id BIGSERIAL PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_username TEXT,
        actor_name TEXT,
        actor_team TEXT,
        details TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_type TEXT NOT NULL DEFAULT 'web',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_tae_task_time ON task_activity_events (task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tae_type ON task_activity_events (event_type);
      CREATE INDEX IF NOT EXISTS idx_tae_actor ON task_activity_events (actor_username, created_at);

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id BIGSERIAL PRIMARY KEY,
        notification_id INTEGER,
        task_id TEXT,
        recipient_username TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('in_app','web_push','email','whatsapp','android_poll')),
        notification_type TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','retrying','cancelled')),
        scheduled_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        provider_message_id TEXT,
        failure_reason TEXT,
        idempotency_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_nd_idempotency ON notification_deliveries (idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_nd_status ON notification_deliveries (status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_nd_recipient ON notification_deliveries (recipient_username, created_at);

      CREATE TABLE IF NOT EXISTS automation_jobs (
        id BIGSERIAL PRIMARY KEY,
        job_type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','retrying','dead_letter','cancelled')),
        priority INTEGER NOT NULL DEFAULT 100,
        scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        last_error TEXT,
        locked_by TEXT,
        locked_until TIMESTAMPTZ,
        idempotency_key TEXT,
        related_task_id TEXT,
        related_username TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_aj_idempotency ON automation_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_aj_claim ON automation_jobs (status, scheduled_at, priority);

      CREATE TABLE IF NOT EXISTS automation_job_runs (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        worker_id TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        duration_ms INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ajr_job ON automation_job_runs (job_id, attempt);

      CREATE TABLE IF NOT EXISTS integration_events (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        event_type TEXT NOT NULL,
        external_id TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'received',
        error TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ie_external ON integration_events (provider, external_id) WHERE external_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS ai_usage_events (
        id BIGSERIAL PRIMARY KEY,
        feature TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
        username TEXT,
        task_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_usage_time ON ai_usage_events (created_at);

      CREATE TABLE IF NOT EXISTS file_objects (
        id TEXT PRIMARY KEY,
        storage_provider TEXT NOT NULL,
        bucket TEXT,
        object_key TEXT,
        mime_type TEXT,
        file_size BIGINT,
        checksum_sha256 TEXT,
        original_name TEXT,
        uploaded_by TEXT,
        owner_type TEXT,
        owner_id TEXT,
        retention_policy TEXT NOT NULL DEFAULT 'keep',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_file_owner ON file_objects (owner_type, owner_id);

      -- Where a task came from: web | import | api | gmail | whatsapp | meeting | document | audio | video | ai
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'web';
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_ref TEXT;
      UPDATE tasks SET source_type = 'import' WHERE import_key IS NOT NULL AND source_type = 'web';
      CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks (source_type);
    `,
  },
  {
    version: '002',
    name: 'task history: old/new values, append-only guard, backfill of past events',
    sql: `
      ALTER TABLE task_activity_events ADD COLUMN IF NOT EXISTS old_value TEXT;
      ALTER TABLE task_activity_events ADD COLUMN IF NOT EXISTS new_value TEXT;
      CREATE INDEX IF NOT EXISTS idx_tae_task_id_desc ON task_activity_events (task_id, id DESC);

      -- Append-only: history rows can never be edited, and only deleted when the app explicitly
      -- marks a system operation (SET LOCAL mihir.allow_history_delete = 'on'). No route does that today.
      CREATE OR REPLACE FUNCTION mihir_history_append_only() RETURNS trigger AS $fn$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'task history is append-only (update refused)';
        END IF;
        IF COALESCE(current_setting('mihir.allow_history_delete', true), '') <> 'on' THEN
          RAISE EXCEPTION 'task history is append-only (delete refused)';
        END IF;
        RETURN OLD;
      END $fn$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_history_append_only ON task_activity_events;
      CREATE TRIGGER trg_history_append_only BEFORE UPDATE OR DELETE ON task_activity_events
        FOR EACH ROW EXECUTE FUNCTION mihir_history_append_only();

      -- Old timestamps are TEXT; a malformed one must not stop the server starting.
      CREATE OR REPLACE FUNCTION mihir_try_ts(t TEXT) RETURNS TIMESTAMPTZ AS $fn$
      BEGIN
        IF t IS NULL OR t = '' THEN RETURN NULL; END IF;
        RETURN t::timestamptz;
      EXCEPTION WHEN others THEN RETURN NULL;
      END $fn$ LANGUAGE plpgsql IMMUTABLE;

      -- Backfill: reconstruct the events past data still shows, marked backfilled. Only for tasks
      -- with no history rows yet, so re-running adds nothing.
      CREATE TEMP TABLE _tasks_without_history ON COMMIT DROP AS
        SELECT t.id FROM tasks t WHERE NOT EXISTS (SELECT 1 FROM task_activity_events e WHERE e.task_id = t.id);

      INSERT INTO task_activity_events (task_id, event_type, actor_username, actor_name, details, metadata, source_type, created_at)
      SELECT t.id, CASE WHEN t.import_key IS NOT NULL THEN 'TASK_IMPORTED' ELSE 'CREATED' END, t.created_by_username, t.created_by,
             'Task created: ' || t.title, '{"backfilled":true}'::jsonb, COALESCE(t.source_type, 'web'), mihir_try_ts(t.created_at)
      FROM tasks t JOIN _tasks_without_history w ON w.id = t.id WHERE mihir_try_ts(t.created_at) IS NOT NULL;

      INSERT INTO task_activity_events (task_id, event_type, details, metadata, source_type, created_at)
      SELECT a.task_id, 'ASSIGNED', 'Tagged ' || COALESCE(u.name, a.username) || ' (Level ' || COALESCE(a.stage, 1) || ')',
             jsonb_build_object('backfilled', true, 'username', a.username), 'web',
             COALESCE(mihir_try_ts(a.escalation_baseline_at), mihir_try_ts(t.created_at))
      FROM task_assignees a JOIN tasks t ON t.id = a.task_id JOIN _tasks_without_history w ON w.id = a.task_id
      LEFT JOIN users u ON u.username = a.username
      WHERE COALESCE(mihir_try_ts(a.escalation_baseline_at), mihir_try_ts(t.created_at)) IS NOT NULL;

      INSERT INTO task_activity_events (task_id, event_type, actor_username, actor_name, actor_team, details, metadata, source_type, created_at)
      SELECT a.task_id, 'SUBMITTED', a.username, u.name, u.team, 'Submitted their part' || COALESCE(': ' || NULLIF(a.submission_note, ''), ''),
             '{"backfilled":true}'::jsonb, 'web', mihir_try_ts(a.submitted_at)
      FROM task_assignees a JOIN _tasks_without_history w ON w.id = a.task_id LEFT JOIN users u ON u.username = a.username
      WHERE mihir_try_ts(a.submitted_at) IS NOT NULL;

      INSERT INTO task_activity_events (task_id, event_type, actor_name, details, metadata, source_type, created_at)
      SELECT a.task_id, CASE WHEN a.decision = 'approve' THEN 'APPROVED' ELSE 'REJECTED' END, a.completed_by,
             CASE WHEN a.decision = 'approve' THEN 'Approved the part of ' ELSE 'Rejected the part of ' END || COALESCE(u.name, a.username),
             jsonb_build_object('backfilled', true, 'username', a.username), 'web', mihir_try_ts(a.completed_at)
      FROM task_assignees a JOIN _tasks_without_history w ON w.id = a.task_id LEFT JOIN users u ON u.username = a.username
      WHERE mihir_try_ts(a.completed_at) IS NOT NULL AND a.decision IN ('approve', 'reject');

      INSERT INTO task_activity_events (task_id, event_type, actor_username, actor_name, actor_team, details, metadata, source_type, created_at)
      SELECT r.task_id, CASE WHEN r.attachment_name IS NOT NULL THEN 'ATTACHMENT_ADDED' ELSE 'COMMENTED' END, r.by_username, r.by_name, u.team,
             LEFT(COALESCE(r.message, ''), 500), jsonb_build_object('backfilled', true, 'attachment_name', r.attachment_name, 'reply_id', r.id), 'web', mihir_try_ts(r.created_at)
      FROM task_replies r JOIN _tasks_without_history w ON w.id = r.task_id LEFT JOIN users u ON u.username = r.by_username
      WHERE mihir_try_ts(r.created_at) IS NOT NULL;

      INSERT INTO task_activity_events (task_id, event_type, actor_name, details, metadata, source_type, created_at)
      SELECT t.id, 'COMPLETED', t.closed_by, 'Task closed', '{"backfilled":true}'::jsonb, 'web', mihir_try_ts(t.closed_at)
      FROM tasks t JOIN _tasks_without_history w ON w.id = t.id WHERE t.status = 'closed' AND mihir_try_ts(t.closed_at) IS NOT NULL;

      INSERT INTO task_activity_events (task_id, event_type, actor_name, details, metadata, source_type, created_at)
      SELECT t.id, 'CANCELLED', t.cancelled_by, 'Task cancelled' || COALESCE(': ' || NULLIF(t.cancel_reason, ''), ''), '{"backfilled":true}'::jsonb, 'web', mihir_try_ts(t.cancelled_at)
      FROM tasks t JOIN _tasks_without_history w ON w.id = t.id WHERE t.status = 'cancelled' AND mihir_try_ts(t.cancelled_at) IS NOT NULL;

      INSERT INTO task_activity_events (task_id, event_type, details, metadata, source_type, created_at)
      SELECT t.id, 'ARCHIVED', 'Removed from task lists (history kept)', '{"backfilled":true}'::jsonb, 'web', mihir_try_ts(t.archived_at)
      FROM tasks t JOIN _tasks_without_history w ON w.id = t.id WHERE mihir_try_ts(t.archived_at) IS NOT NULL;
    `,
  },
  {
    version: '003',
    name: 'foreign keys between tasks/approvals and their parts (NOT VALID, then validated safely)',
    // Children are already deleted by the app before their parent; ON DELETE CASCADE is a safety net.
    // History (task_activity_events) and audit_log deliberately have NO foreign key — they must outlive
    // deleted tasks. Constraints are added NOT VALID (no full-table check during deploy) and then
    // validated one by one; if old data ever fails validation, the deploy still succeeds and a NOTICE
    // is logged — new rows are enforced either way.
    sql: `
      DO $fk$
      DECLARE c RECORD;
      BEGIN
        FOR c IN SELECT * FROM (VALUES
          ('task_assignees', 'fk_task_assignees_task', 'task_id', 'tasks', 'id'),
          ('task_replies', 'fk_task_replies_task', 'task_id', 'tasks', 'id'),
          ('task_checklist_items', 'fk_task_checklist_task', 'task_id', 'tasks', 'id'),
          ('task_followups', 'fk_task_followups_task', 'task_id', 'tasks', 'id'),
          ('approval_reviewers', 'fk_approval_reviewers_request', 'request_id', 'approval_requests', 'id'),
          ('approval_history', 'fk_approval_history_request', 'request_id', 'approval_requests', 'id')
        ) AS t(tbl, name, col, ref_tbl, ref_col) LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name) THEN
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE CASCADE NOT VALID', c.tbl, c.name, c.col, c.ref_tbl, c.ref_col);
          END IF;
          BEGIN
            EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.tbl, c.name);
          EXCEPTION WHEN others THEN
            RAISE NOTICE 'Constraint % not validated (existing rows need cleanup): %', c.name, SQLERRM;
          END;
        END LOOP;
      END $fk$;
    `,
  },
  {
    version: '004',
    name: 'ingestion items, AI suggestions, meeting sessions',
    sql: `
      -- Everything that might become a task enters here first (voice, WhatsApp, email, meeting, upload).
      -- (source, source_ref) is unique, so the same WhatsApp message / email can never be processed twice.
      CREATE TABLE IF NOT EXISTS ingestion_items (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('voice','whatsapp','email','meeting','upload','manual','api')),
        source_ref TEXT,
        submitted_by TEXT,
        content_type TEXT NOT NULL DEFAULT 'text',
        original_text TEXT,
        normalized_text TEXT,
        language TEXT,
        file_id TEXT,
        status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','needs_review','done','failed','ignored')),
        error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ingestion_source_ref ON ingestion_items (source, source_ref) WHERE source_ref IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_ingestion_submitter ON ingestion_items (submitted_by, created_at DESC);

      -- What AI proposed. Nothing becomes a task until a person accepts it.
      CREATE TABLE IF NOT EXISTS ai_suggestions (
        id BIGSERIAL PRIMARY KEY,
        ingestion_id BIGINT REFERENCES ingestion_items(id) ON DELETE CASCADE,
        meeting_id BIGINT,
        title TEXT NOT NULL,
        description TEXT,
        assignees JSONB NOT NULL DEFAULT '[]'::jsonb,
        unresolved_names JSONB NOT NULL DEFAULT '[]'::jsonb,
        deadline TEXT,
        priority TEXT,
        project TEXT,
        confidence NUMERIC(4,3),
        kind TEXT NOT NULL DEFAULT 'action',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','ignored')),
        task_id TEXT,
        decided_by TEXT,
        decided_at TIMESTAMPTZ,
        provider TEXT,
        model TEXT,
        owner_username TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_suggestions_owner ON ai_suggestions (owner_username, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_suggestions_meeting ON ai_suggestions (meeting_id);

      CREATE TABLE IF NOT EXISTS meeting_sessions (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        created_by TEXT NOT NULL,
        participants JSONB NOT NULL DEFAULT '[]'::jsonb,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        duration_sec INTEGER,
        file_id TEXT,
        transcript TEXT,
        summary TEXT,
        decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
        risks JSONB NOT NULL DEFAULT '[]'::jsonb,
        language TEXT,
        status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','processing','ready','failed')),
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_meetings_creator ON meeting_sessions (created_by, created_at DESC);
      ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS source TEXT;
      ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS cost_inr NUMERIC(12,4) NOT NULL DEFAULT 0;
    `,
  },
  {
    version: '005',
    name: 'company chat: messages (company-wide + one room per department) and read markers',
    sql: `
      -- room = 'general' (whole company) or 'dept:<department name>'. Everyone can read and post in
      -- every room. Messages are soft-deleted (deleted_at) so the conversation stays consistent.
      CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGSERIAL PRIMARY KEY,
        room TEXT NOT NULL,
        by_username TEXT NOT NULL,
        by_name TEXT,
        by_team TEXT,
        message TEXT NOT NULL,
        mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
        mention_teams JSONB NOT NULL DEFAULT '[]'::jsonb,
        task_id TEXT,
        deleted_at TIMESTAMPTZ,
        deleted_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_chat_room_id ON chat_messages (room, id DESC);
      CREATE TABLE IF NOT EXISTS chat_reads (
        username TEXT NOT NULL,
        room TEXT NOT NULL,
        last_read_id BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (username, room)
      );
      -- A chat @tag notification opens its room when tapped.
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS chat_room TEXT;
    `,
  },
  {
    version: '006',
    name: 'private chats: conversations only their members can see',
    sql: `
      -- A private chat's room key is 'p:<id>'. Only the people in chat_private_members can list,
      -- read, post or download files in it — no department or role (not even Admin) sees it.
      CREATE TABLE IF NOT EXISTS chat_private (
        id SERIAL PRIMARY KEY,
        name TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_private_members (
        chat_id INTEGER NOT NULL REFERENCES chat_private(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        added_by TEXT,
        added_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, username)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_private_members_user ON chat_private_members (username);
    `,
  },
  {
    version: '007',
    name: 'employee location tracking: sessions, points, places, visits, alerts, indoor positioning, privacy',
    sql: `
      -- Everything here is NEW tables only (additive). Nothing is collected until ENABLE_LOCATION_TRACKING
      -- is on AND an employee accepts the notice AND starts a work session themselves.
      -- Coordinates are plain WGS84 doubles (lat/lng). PostGIS can be added later with a generated
      -- geography column without moving data (see docs/LOCATION_TRACKING.md).

      -- Admin-editable policy (single row, id = 1).
      CREATE TABLE IF NOT EXISTS location_settings (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO location_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

      -- The employee's acceptance of the tracking notice (versioned; withdrawable).
      CREATE TABLE IF NOT EXISTS location_consents (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        withdrawn_at TIMESTAMPTZ,
        ip_address TEXT,
        device TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_location_consents_user ON location_consents (username, accepted_at DESC);

      -- A work session = the only time location is collected. Started and stopped by the employee
      -- (or auto-stopped by policy / Admin). Latest fix is denormalised here for a cheap live map.
      CREATE TABLE IF NOT EXISTS location_sessions (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ended_at TIMESTAMPTZ,
        end_reason TEXT,
        ended_by TEXT,
        platform TEXT,
        device_id TEXT,
        device_label TEXT,
        app_version TEXT,
        last_point_at TIMESTAMPTZ,
        last_received_at TIMESTAMPTZ,
        last_lat DOUBLE PRECISION,
        last_lng DOUBLE PRECISION,
        last_accuracy_m REAL,
        last_speed_mps REAL,
        last_battery REAL,
        last_is_moving BOOLEAN,
        current_geofence_id BIGINT,
        points_count INTEGER NOT NULL DEFAULT 0,
        distance_m DOUBLE PRECISION NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_location_sessions_user ON location_sessions (username, started_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_location_sessions_one_active ON location_sessions (username) WHERE ended_at IS NULL;

      -- Raw GPS/network fixes. client_point_id makes offline re-uploads idempotent.
      CREATE TABLE IF NOT EXISTS location_points (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES location_sessions(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        accuracy_m REAL,
        altitude_m REAL,
        speed_mps REAL,
        heading REAL,
        battery REAL,
        is_moving BOOLEAN,
        source TEXT,
        client_point_id TEXT NOT NULL,
        UNIQUE (session_id, client_point_id)
      );
      CREATE INDEX IF NOT EXISTS idx_location_points_user_time ON location_points (username, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_location_points_session_time ON location_points (session_id, recorded_at);
      CREATE INDEX IF NOT EXISTS brin_location_points_recorded ON location_points USING BRIN (recorded_at);

      -- Places: office, construction site, warehouse, supplier… Circle or polygon.
      CREATE TABLE IF NOT EXISTS geofences (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'site',
        shape TEXT NOT NULL DEFAULT 'circle',
        center_lat DOUBLE PRECISION NOT NULL,
        center_lng DOUBLE PRECISION NOT NULL,
        radius_m REAL NOT NULL DEFAULT 150,
        polygon JSONB,
        project TEXT,
        address TEXT,
        notes TEXT,
        min_dwell_seconds INTEGER NOT NULL DEFAULT 120,
        restricted BOOLEAN NOT NULL DEFAULT false,
        active BOOLEAN NOT NULL DEFAULT true,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Arrivals/departures (one row per stay). departed_at NULL = still there.
      CREATE TABLE IF NOT EXISTS geofence_visits (
        id BIGSERIAL PRIMARY KEY,
        geofence_id BIGINT NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        session_id BIGINT REFERENCES location_sessions(id) ON DELETE SET NULL,
        arrived_at TIMESTAMPTZ NOT NULL,
        departed_at TIMESTAMPTZ,
        last_inside_at TIMESTAMPTZ NOT NULL,
        -- Set once the person has stayed min_dwell_seconds (drive-bys are discarded, never alerted).
        confirmed_at TIMESTAMPTZ,
        duration_s INTEGER,
        outside_streak INTEGER NOT NULL DEFAULT 0,
        end_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_geofence_visits_user ON geofence_visits (username, arrived_at DESC);
      CREATE INDEX IF NOT EXISTS idx_geofence_visits_place ON geofence_visits (geofence_id, arrived_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_geofence_visits_open ON geofence_visits (username, geofence_id) WHERE departed_at IS NULL;

      -- Task integration: a task can be tied to places (deliver to site, collect from supplier…);
      -- visits are linked to tasks automatically (assignee visited a linked place / the task's
      -- project site) or by hand ("check in to this task").
      CREATE TABLE IF NOT EXISTS task_places (
        task_id TEXT NOT NULL,
        geofence_id BIGINT NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
        purpose TEXT,
        added_by TEXT,
        added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (task_id, geofence_id)
      );
      CREATE TABLE IF NOT EXISTS visit_task_links (
        visit_id BIGINT NOT NULL REFERENCES geofence_visits(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        how TEXT NOT NULL DEFAULT 'auto',
        linked_by TEXT,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (visit_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_visit_task_links_task ON visit_task_links (task_id);

      -- Alerts.
      CREATE TABLE IF NOT EXISTS location_alert_rules (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        geofence_id BIGINT REFERENCES geofences(id) ON DELETE CASCADE,
        departments JSONB NOT NULL DEFAULT '[]'::jsonb,
        usernames JSONB NOT NULL DEFAULT '[]'::jsonb,
        threshold REAL,
        recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
        notify_employee BOOLEAN NOT NULL DEFAULT false,
        active BOOLEAN NOT NULL DEFAULT true,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS location_alert_events (
        id BIGSERIAL PRIMARY KEY,
        rule_id BIGINT REFERENCES location_alert_rules(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        username TEXT NOT NULL,
        session_id BIGINT,
        geofence_id BIGINT,
        message TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        acknowledged_by TEXT,
        acknowledged_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_location_alert_events_time ON location_alert_events (created_at DESC);

      -- Every time someone looks at ANOTHER person's location data. Employees can see their own rows.
      CREATE TABLE IF NOT EXISTS location_access_log (
        id BIGSERIAL PRIMARY KEY,
        viewer_username TEXT NOT NULL,
        viewer_role TEXT,
        subject_username TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        ip_address TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_location_access_subject ON location_access_log (subject_username, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_location_access_time ON location_access_log (created_at DESC);

      -- Indoor positioning. GPS cannot place people on a floor or at a desk: this needs BLE beacons
      -- (room/zone level) or a UWB system (desk level). Coordinates are floor-plan pixels.
      CREATE TABLE IF NOT EXISTS indoor_floors (
        id BIGSERIAL PRIMARY KEY,
        geofence_id BIGINT REFERENCES geofences(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        plan_image TEXT,
        width_px INTEGER,
        height_px INTEGER,
        meters_per_px REAL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS indoor_zones (
        id BIGSERIAL PRIMARY KEY,
        floor_id BIGINT NOT NULL REFERENCES indoor_floors(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'room',
        polygon JSONB NOT NULL,
        restricted BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS indoor_anchors (
        id BIGSERIAL PRIMARY KEY,
        floor_id BIGINT NOT NULL REFERENCES indoor_floors(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'ble',
        identifier TEXT NOT NULL UNIQUE,
        label TEXT,
        x REAL NOT NULL,
        y REAL NOT NULL,
        tx_power REAL,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- UWB / RTLS badges handed to employees (vendor tag id -> person).
      CREATE TABLE IF NOT EXISTS indoor_tags (
        tag_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        assigned_by TEXT,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS indoor_positions (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        session_id BIGINT REFERENCES location_sessions(id) ON DELETE CASCADE,
        floor_id BIGINT NOT NULL REFERENCES indoor_floors(id) ON DELETE CASCADE,
        zone_id BIGINT REFERENCES indoor_zones(id) ON DELETE SET NULL,
        x REAL,
        y REAL,
        accuracy_m REAL,
        method TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_indoor_positions_user_time ON indoor_positions (username, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_indoor_positions_floor_time ON indoor_positions (floor_id, recorded_at DESC);

      -- Machine-to-machine keys for RTLS vendors pushing indoor positions (only a hash is stored).
      CREATE TABLE IF NOT EXISTS location_integration_keys (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
    `,
  },
];

async function runMigrations(pool, log = console.log) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('mihir_task_manager_migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      const started = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations(version, name) VALUES($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
        log(`Migration ${m.version} applied (${m.name}) in ${Date.now() - started}ms`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.version} failed and was rolled back — nothing from it was applied: ${e.message}`);
      }
    }
    return MIGRATIONS[MIGRATIONS.length - 1].version;
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('mihir_task_manager_migrations'))"); } catch (e) { /* connection gone; lock released with it */ }
    client.release();
  }
}

module.exports = { runMigrations, MIGRATIONS };
