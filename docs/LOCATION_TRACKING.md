# Employee Location & Movement Tracking

Opt-in, work-session based location tracking built into the MIHIR Task Manager: live map, route
history and replay, places (geofences) with arrival/departure detection, task/project integration,
alerts, reports, indoor positioning (BLE beacons / UWB), and privacy controls.

**Everything is OFF until `ENABLE_LOCATION_TRACKING=true` is set.** With the flag off, every
`/api/location/*` endpoint answers 404 (except `/api/location/me`, which only says `enabled:false`)
and nothing appears in the app. The database migration (007) only adds new tables, so deploying
this code changes nothing for anyone until the flag is switched on.

Related docs: [LOCATION_MOBILE.md](LOCATION_MOBILE.md) (Android/iOS apps, permissions, device test
plan) · [LOCATION_INDOOR.md](LOCATION_INDOOR.md) (beacons, UWB, floor plans).

---

## 1. How it works (for employees)

1. **My Location** (sidebar → You) shows a notice explaining what is recorded, why, who can see
   it and for how long. Nothing can start until the employee ticks "I have read this" and accepts.
   The acceptance (with notice version, time, IP, device) is stored; if Admin changes the notice,
   everyone must accept the new version before their next session.
2. **▶ Start work session** — location is recorded only from now until **Stop**. In the Android app
   a permanent notification ("Sharing location — work session on", with a Stop button) is shown the
   whole time; on iPhone the blue location indicator is shown; in a browser a green "📍 Tracking on"
   pill sits in the top bar.
3. Sessions also stop automatically after the maximum length (default 14 h) or outside the allowed
   hours (default 06:00–22:00 IST), and the employee is notified.
4. On the same page the employee sees their own day (route, places, distance), **who looked at
   their location** (every view by someone else is logged), can **download all their location
   data** (JSON), and can **withdraw consent** (stops tracking immediately).

There is no way for a manager to start someone's tracking, and no data exists outside sessions.

## 2. Who can see what

Enforced on the server (`backend/location/routes.js → scopeOf / canSee`), not just hidden in the UI.

| Viewer | Can see |
|---|---|
| Every employee | Their own status, route, visits, export, and the log of who viewed them |
| Admin | Everyone |
| Director | Own department + departments Admin granted them (if "Directors can see" is on) |
| Team lead | Own department (if "Team leads can see" is on) |
| Anyone else | Nobody else (403) |
| People on a task | Place + times of visits **linked to that task** (proof of site visit/delivery) — never the route |

Every view of another person's data (live map, history, visits, reports, task visits, export) is
written to `location_access_log`. Live-map polling is logged at most once per 15 min per
viewer/person. Admin sees the full log under Locations → Privacy & policy.

## 3. Features (Locations page)

| Tab | What it does |
|---|---|
| Live map | Everyone currently in a session (within your scope): position, accuracy circle, status (at a place / moving / stopped / no recent fix / signal lost / waiting for GPS), current place, indoor floor/zone, speed, battery, distance today. Refreshes every 15 s (cheap version check). |
| History & replay | Pick a person and a day: route on the map (simplified for display), start/end markers, a replay slider with play/pause, sessions, place visits with durations, indoor zone timeline, stats (distance, time moving, places). |
| Places | Add/edit/delete offices, sites, warehouses, suppliers, clients by clicking the map; radius 20 m – 2 km (polygons are supported by the API); link to a project; minimum stay before it counts as a visit (drive-bys are ignored); "restricted" flag. Admin and Directors manage places. |
| Reports | Date range → per person (sessions, tracked time, distance, visits, time at places, which places) and per place (visits, people, total time). CSV download. |
| Alerts | Rules: arrives at a place, leaves a place, enters a restricted place/zone, signal lost for N min, speeding over N km/h (two consecutive fast fixes), session longer than N h. Scope by department/person; recipients (default: all Admins); optional "also tell the employee". Alerts arrive as in-app + push notifications; recent alerts can be acknowledged. |
| Indoor | Floors with floor-plan images, zones (rooms/desks/restricted) drawn on the plan, beacons placed on the plan, live indoor positions, UWB badge assignment and integration keys. See LOCATION_INDOOR.md. |
| Map search (every map) | Search box above each map: saved places first (instant), then addresses/landmarks from the search provider; also reads typed coordinates (`18.5590, 73.7868`, `18°33'32"N 73°47'12"E`) and pasted Google Maps links. Picking a result centres the map and drops an orange pin; on Places it can become a new place ("Add as a place") or move the place being edited. |
| Privacy & policy (Admin) | Notice text (versioned), allowed hours, max session length, departments that use tracking, Director/team-lead visibility, indoor on/off, GPS/battery/upload intervals, accuracy threshold, signal-lost minutes, retention periods; export or delete a person's data; access log. |

## 4. Task, project, procurement & delivery integration

- A **place can belong to a project** (e.g. site "Mihir Amara — Tower B" → project "Mihir Amara").
  When an assignee's visit there is confirmed, the visit is linked to their **open tasks in that
  project** (`how = project`).
- A **task can be tied to places** ("Collect 200 cement bags" → supplier "UltraTech depot",
  purpose "Pick up 200 bags"). Visits by the task's assignees to those places are linked
  (`how = place`) **and written to the task's history** ("Arrived at UltraTech depot (12:22)",
  "Left UltraTech depot after 15 min"). This is how procurement pickups and deliveries are proven.
- The employee gets a notification on arrival: "📍 You're at Tower B — 2 open tasks here: …".
- Task details show a **📍 Places & site visits** block (tie/untie places for the creator,
  Directors, Admin; visits list for everyone who can see the task).
- A person can manually link one of their visits to a task (`POST /api/location/visits/:id/tasks`).

The app has no separate procurement/delivery module; procurement and delivery work is represented
as tasks, so tying tasks to supplier/site places covers it.

## 5. Architecture

```
Phone app (Android foreground service / iOS CoreLocation)          Browser (only while page open)
  └ fixes → SQLite/JSON offline queue → POST /api/location/points   └ watchPosition → localStorage queue → same API
       (Authorization: Location <upload token>)                          (Authorization: Bearer <login token>)
BLE beacons → phone scan → POST /api/location/indoor/sightings
UWB/RTLS vendor engine → POST /api/location/indoor/rtls (X-Location-Key)
                                   │
                    backend/location/routes.js  (auth, scope, access log, validation)
                    backend/location/service.js (sessions, ingest, places engine, alerts, retention)
                    backend/location/indoor.js  (BLE positioning, RTLS, integration keys)
                    backend/location/geo.js     (pure geometry — unit tested)
                                   │
                         PostgreSQL (Supabase) — migration 007 tables
                                   │
            Web UI: frontend/location.js (Leaflet map, served from /vendor/leaflet)
```

- **Ingestion** (`POST /api/location/points`): up to 500 fixes per request, one bulk `INSERT … SELECT
  unnest(…) ON CONFLICT DO NOTHING`. `client_point_id` makes offline re-uploads idempotent.
  Rejected: missing id, bad coordinates (incl. 0,0), accuracy > 1000 m, time outside the session
  (±2 min clock skew). Fixes worse than `maxAccuracyM` (default 100 m) are stored for the record but
  never decide arrivals/departures and are not drawn.
- **Places engine**: for each fresh fix, inside/outside per place with GPS-uncertainty hysteresis —
  "inside" only if the fix is inside; "outside" only if beyond the edge by more than accuracy + 25 m;
  in between changes nothing. Arrival is *confirmed* after `min_dwell_seconds`; unconfirmed stays are
  deleted (drive-bys). Departure after 2 consecutive clearly-outside fixes; departure time = last
  inside fix. Late offline batches older than the last processed fix fill in the route but do not
  rewrite past arrivals (documented limitation).
- **Upload token**: when a session starts, the server issues a JWT with `scope: 'loc'` bound to
  that session (expires max-session-hours + 2 h, revoked by a password change). It can only add
  points/sightings to that session or stop it. Scoped tokens are refused as logins everywhere.
- **Real time**: the live map polls `/api/location/live?v=<version>`; the server answers
  `{unchanged:true}` without any database work when nothing changed. (In-memory version counter —
  correct for the current single Render instance; see MULTI_INSTANCE_READINESS.md if scaling out.)
- **Jobs** (existing job engine): `LOCATION_MONITOR` every 2 min (auto-stop, signal-lost and
  overtime alerts), `LOCATION_RETENTION` daily 02:45 IST.

### Storage & PostGIS decision

Supabase offers PostGIS (3.3.7 available, not installed). It is **not used yet**, deliberately:

- Volume: ~80 users × ~9 h × a fix every 15–120 s (adaptive) ≈ 100–250k rows/day; with 90-day
  retention ≈ 10–20 M rows. B-tree indexes on `(username, recorded_at)` and `(session_id,
  recorded_at)` plus a BRIN index on `recorded_at` (cheap retention deletes) handle this easily.
- Geofence tests run in memory against a cached list of places (tens, not millions), so a spatial
  index would not speed anything up today.
- Coordinates are plain WGS84 `lat`/`lng` doubles, so PostGIS can be added later **without moving
  data**: `CREATE EXTENSION postgis; ALTER TABLE location_points ADD COLUMN geog geography(Point,4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED;` + a GiST index —
  worth doing if you later need "who was within 200 m of X last month" across millions of rows, or
  thousands of polygon places. At > ~50 M rows also consider monthly partitioning of `location_points`.

### Tables (migration 007)

`location_settings` (policy JSON, 1 row) · `location_consents` · `location_sessions` (latest fix
denormalised for the live map; one active session per person enforced by a partial unique index) ·
`location_points` · `geofences` · `geofence_visits` · `task_places` · `visit_task_links` ·
`location_alert_rules` · `location_alert_events` (dedupe key) · `location_access_log` ·
`indoor_floors` · `indoor_zones` · `indoor_anchors` · `indoor_tags` · `indoor_positions` ·
`location_integration_keys` (SHA-256 hash only).

## 6. API (all under `/api/location`, JSON)

Employee: `GET /me` · `POST /consent {policyVersion}` · `POST /consent/withdraw` ·
`POST /sessions/start {platform, deviceLabel, appVersion}` → `{session, uploadToken, config}` ·
`POST /sessions/stop` · `POST /points` (Location token or Bearer + `sessionId`) ·
`POST /indoor/sightings` · `POST /sessions/stop-upload` (Location token; phone notification) ·
`GET /me/history?day=YYYY-MM-DD` · `GET /me/access-log` · `GET /me/export`.

Managers (scope-limited): `GET /live?v=` · `GET /history?username=&day=` (or `from`/`to`, max 7 days) ·
`GET /sessions` · `POST /sessions/:id/stop` (owner/Admin) · `GET /visits?from&to&placeId&username` ·
`GET /reports/summary?from&to[&format=csv]` · `GET /alerts` · `POST /alerts/:id/ack` ·
`GET /indoor/live?floorId=`.

Search: `GET /geocode?q=&lat=&lng=` → `{results:[{name,address,lat,lng,type,source}], provider, cached?, note?}`
(any logged-in user while tracking is on; 40 searches per person per 5 minutes; answers cached 24 h).
Places: `GET /places` · `POST/PUT/DELETE /places[/:id]` (Admin/Director).
Tasks: `GET /tasks/:taskId` · `POST /tasks/:taskId/places {placeId, purpose}` ·
`DELETE /tasks/:taskId/places/:placeId` · `POST /visits/:id/tasks {taskId}`.
Admin: `GET/POST/PUT/DELETE /alert-rules` · `GET/PUT /settings` · `GET /access-log` ·
`GET /export?username=` · `DELETE /data/:username[?before=ISO]` · indoor floors/zones/anchors/tags ·
`GET/POST/DELETE /integration-keys`.
Machine: `POST /indoor/rtls` with header `X-Location-Key`.

Point format: `{ points: [{ id, t (ms or ISO), lat, lng, acc, alt, spd (m/s), hdg, bat (0–1), moving, src }] }`.
The common background-geolocation SDK format (`{ location: { uuid, timestamp, coords: {…}, battery: {level}, is_moving } }`
or an array) is also accepted, so a commercial SDK can post directly.

## 7. Privacy, legal and retention

- **Consent + notice**, versioned; **purpose** stated; **minimisation** (only during sessions,
  accuracy-filtered, no background permission "Allow all the time" on Android/iOS);
  **transparency** (persistent visible status; access log visible to the employee; employee alerts
  option); **access** (self-export) and **erasure** (Admin delete, full or before a date);
  **retention** (nightly purge: route points 90 days, visits/sessions 365, indoor 30, alert events
  365, access log 730 — all configurable).
- Every policy change, place change, alert-rule change, session start/stop (incl. by Admin), consent,
  export and deletion is in the main **Audit Log**.
- India: the Digital Personal Data Protection Act, 2023 applies to employee location data. The notice
  + consent + purpose + retention + access/erasure design above is meant to support compliance, but
  **this is not legal advice** — have the notice text and policy reviewed by your counsel (and your
  HR policy / employment contracts updated) before rollout. Avoid tracking outside working time.
- Database administrators (Supabase project owners) can technically read all stored data, as with
  every other table. Limit who has Supabase access.

## 8. Configuration

| Env var | Default | Meaning |
|---|---|---|
| `ENABLE_LOCATION_TRACKING` | `false` | Master switch |
| `MAP_TILE_URL` | OpenStreetMap standard tiles | Map tiles. **Set a commercial provider for production** (e.g. MapTiler, Stadia, Mapbox, Google): OSM's public tile servers have a fair-use policy that a company dashboard polling all day may exceed. Example: `https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=YOUR_KEY` |
| `MAP_TILE_ATTRIBUTION` | `© OpenStreetMap contributors` | Attribution shown on the map (required by tile providers) |
| `GEOCODER` | `nominatim` | Map search provider: `nominatim` (OpenStreetMap's free service — max 1 request/second, fair use only; fine for Admins adding places), `maptiler` (commercial, needs `GEOCODER_KEY`; recommended for daily use), `mock` (fixed demo answers, tests) or `off` (only coordinates / Google Maps links work). |
| `GEOCODER_KEY` | — | API key for `maptiler` (the same MapTiler key as the tiles works) |
| `GEOCODER_EMAIL` | — | Contact email sent to Nominatim as their usage policy asks — set it to an IT/admin address |
| `GEOCODER_COUNTRY` | `in` | Limit search to these country codes (comma-separated); empty = worldwide |
| `DB_IDLE_TIMEOUT_MS`, `DB_POOL_WARM` | 10 min, 4 | Connection pool (from the speed fix) |

Everything else is in the Admin policy screen (stored in `location_settings`).

## 9. Rollout plan (safe deployment)

1. **Deploy with the flag OFF** (default). Migration 007 adds tables only; existing features are
   untouched. Check `/ready` shows `schemaVersion: "007"`.
2. **Staging (recommended)**: create a second Render web service from a `staging` branch, pointing at
   a **separate Supabase project** (or a Supabase branch) — never at production data. Set
   `ENABLE_LOCATION_TRACKING=true` there, install the new APK on 2–3 test phones (one Samsung, one
   Xiaomi/Redmi, one iPhone if the iOS app is built) and run the device test plan in LOCATION_MOBILE.md.
   *Not done by the author: creating services and projects needs your Render/Supabase accounts and costs.*
3. **Policy**: Admin edits the notice text (after legal/HR review), allowed hours, retention, who can
   see, and adds places (head office, each site, main suppliers, warehouses).
4. **Pilot**: in production set `ENABLE_LOCATION_TRACKING=true` and limit "Departments that use
   tracking" to one department (e.g. Site). Distribute APK 1.5. Watch for a week.
5. **Company-wide**: clear the department limit.
6. **Rollback**: set `ENABLE_LOCATION_TRACKING=false` (instant, no data lost). The tables can stay.

### Hosting recommendation (no budget restriction)

- Render **Starter or Standard** plan instead of Free: Free sleeps after 15 min idle (phones would
  wait ~1 min to upload after a quiet period) and has 0.15 CPU.
- Put the app server and the database in the **same region, close to India**: e.g. Render
  **Singapore** + Supabase **ap-south-1 (Mumbai)** or **ap-southeast-1 (Singapore)**. Today the
  server is in Oregon and the database in Tokyo (~100 ms per query). Moving needs a new Render service
  and a Supabase project migration — plan it as a separate, scheduled change.
- Supabase **Pro** (daily backups, point-in-time recovery option) — location data grows quickly.

## 10. Monitoring & operations

- `/ready` (DB latency, schema version), Render metrics/logs (`path` contains `/api/location`).
- Admin → System Health shows the job engine (LOCATION_MONITOR, LOCATION_RETENTION runs and failures).
- Useful SQL: active sessions `SELECT username, last_received_at FROM location_sessions WHERE ended_at IS NULL;` ·
  daily volume `SELECT date_trunc('day', received_at), count(*) FROM location_points GROUP BY 1 ORDER BY 1 DESC LIMIT 14;` ·
  table size `SELECT pg_size_pretty(pg_total_relation_size('location_points'));`
- Backups: `npm run backup` includes all location tables; `scripts/restore-database.js` restores them
  in foreign-key order (fixed in this release; a backup→restore round trip was tested).

## 11. Testing

- `test/location-geo.test.js` — geometry: distance, polygons, hysteresis, route simplification,
  glitch filtering, BLE positioning.
- `test/location-tracking.test.js` — end-to-end API: flag off, consent/versioning, sessions, upload
  tokens (cannot be used as a login), validation, idempotent offline re-upload, SDK format, places
  engine (drive-by ignored, dwell, hysteresis, departure duration), project/task linking + task
  history, visibility (Admin / team lead / Director / member) + access log, alerts (arrival, speeding,
  signal lost via the job, overtime), auto-stop, phone "Stop" endpoint, reports + CSV, export,
  retention purge, deletion, audit entries, indoor BLE + UWB + restricted-zone alert + key revocation.
- `android/test.sh` — JVM test of the iBeacon parser.
- Manual device tests: LOCATION_MOBILE.md §5 (cannot be automated here — needs real phones).

## 12. Known limitations

- Browser tracking only works while the page is open and the screen on (a browser restriction).
- The iOS app is **source only** (not compiled — no Mac/Xcode was available). The Android APK was
  built and its manifest/permissions verified, but **not run on a phone** in this environment.
- Background tracking can still be stopped by aggressive OEM battery managers (Xiaomi, Vivo, Oppo,
  Realme) unless the app is allowed to run in the background; the app prompts for this.
- If Android kills and later restarts the service while the app is in the background, Android may
  not deliver locations until the employee opens the app again (the "My Location" page resumes it).
- Indoor positioning needs installed hardware; BLE gives room/zone level, not desk level.
