# MIHIR Task Manager — Production Readiness Report

October 2026 · covers Phases 0–8 of the roadmap · 313/313 automated tests passing.

## Status by phase
| Phase | Status | Report |
|---|---|---|
| 0 Audit + foundation | ✅ done | PHASE0_REPORT.md |
| 1 Task history | ✅ done | PHASE1_REPORT.md |
| 2 Notifications + reminder engine + Follow Up | ✅ done | PHASE2_REPORT.md |
| 7A Job engine | ✅ done | AUTOMATION.md |
| 8 Hardening (FKs, storage, backups, security headers/CORS, System Health, docs) | ✅ done in code · ⏳ 3 settings to apply (below) | this report |
| 5 Ingestion + AI layer + cost control | ✅ built, **OFF** until an AI key is added | AI.md |
| Voice tasks | ✅ built, OFF | AI.md |
| Documents / photos / videos → tasks (app + WhatsApp) | ✅ built, OFF | AI.md |
| 4 WhatsApp task creation | ✅ built, OFF until the business number exists | WHATSAPP.md |
| 3 Email → task | ✅ built, OFF · needs the mail host of mihirgroup.com | EMAIL.md |
| 6 Meetings | ✅ built, OFF | MEETINGS.md |
| 7B Workflows | ✅ escalations, meeting follow-up, email/WhatsApp → task · ✗ vendor follow-ups (no vendor module) | AUTOMATION.md |

## Quality gates
| Gate | |
|---|---|
| Existing functionality, users, tasks, history, assignments, approvals, comments intact | ✅ (all prior tests pass; migrations additive; history backfilled) |
| Migrations succeed; rollback/recovery plan | ✅ (transactional, locked, re-run tested; MIGRATIONS.md, DISASTER_RECOVERY.md) |
| Notifications always on; T-3/T-2/T-1/T/overdue; follow-up; exclusions; no duplicates | ✅ (reminder-engine tests) |
| Duplicate jobs prevented; worker failure recovery; retry; dead-letter | ✅ (job-engine tests) |
| History table: search, filters, paging, mobile, authorization | ✅ |
| Rate limiting, health checks, structured logs, monitoring page | ✅ (System Health; uptime monitor: optional, see below) |
| Backup strategy + restore procedure + DR documented; restore tested | ✅ locally · ⏳ add `DATABASE_URL` secret to GitHub so nightly backups run, then one production test-restore |
| No secrets committed; no critical security issues open | ✅ (one historical key rotated) |
| AI/WhatsApp/email/meetings verified against the real services | ⏳ after keys/accounts — tested end-to-end against stand-ins |

## Settings to apply (no code needed)
1. Render → mihir-task-manager → Settings → **Health Check Path** = `/readiness`.
2. Render → Environment → `NODE_ENV=production`, `APP_BASE_URL=https://mihir-task-manager.onrender.com`.
3. GitHub → repo → Settings → Secrets → Actions → `DATABASE_URL` (enables the nightly backup).
Then delete `suraj_kathale` and `tejas.l` once more if still present.

## Paid services (none purchased — for decision)
| Service | Purpose | Why free is insufficient | ≈ Monthly | ≈ Annual | Recommendation |
|---|---|---|---|---|---|
| Render Starter ($7) | Always-on server | Free sleeps → reminders late, webhooks slow, 1-min wake-up | ₹600–650 | ₹7,500 | **Yes, first** |
| Supabase Pro ($25) | Daily backups, PITR add-on, no pausing, more capacity | Free has no point-in-time restore (RPO 24 h) | ₹2,150–2,250 (+PITR add-on) | ₹26,000+ | When the project goes company-wide |
| Gemini API (paid tier) | AI extraction/voice/meetings | Free tier may use inputs for training; rate limits | ₹50–300 at company scale (budget-capped) | ₹600–3,600 | Yes, with `MONTHLY_AI_BUDGET_INR` |
| WhatsApp Cloud API | WhatsApp tasks + important alerts | — (Meta charges per business message) | ₹50–300 | ₹600–3,600 | When the number is ready |
| Uptime monitor | Alert when site is down | Optional — free tiers exist (e.g. UptimeRobot free) | ₹0 | ₹0 | Free tier |

Within the ₹2,000–2,500 target: Render Starter + AI + WhatsApp ≈ ₹700–1,250/month. Adding Supabase Pro brings it to
≈ ₹2,850–3,500/month.

## Known limitations
Free hosting sleeps (until Render Starter); real AI quality must be checked with real Marathi/Hindi recordings after the
key is added; email needs the mailbox host; WhatsApp needs Meta verification; vendor follow-ups need a vendor module;
the APK's background notifications are periodic (instant push via the installed web app).

## Future integration readiness
Gmail add-on, Google Meet artifacts, documents (PDF/Excel) → tasks: each is a new ingestion source feeding the same
pipeline (`ingestion.receive` → `process` → suggestions); no changes to the task engine, history, notifications or jobs.
