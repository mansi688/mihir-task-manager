# Meeting assistant (`ENABLE_MEETING_AI`)

**Meetings** page → title + participants → **Start meeting recording** (notice shown: "This meeting is being
recorded for generating meeting notes and action items.") → Stop → recording processed in the background →
summary, decisions, risks, full transcript (original language) and **action items** to review → Create / Ignore each.
Discussion, decisions without an implied action and questions without a clear owner are not turned into tasks.

Access: organiser, chosen participants, Admin. Participants are notified when the summary is ready. Recording
playback: organiser/Admin only (5-minute signed link). Retention: recording deleted after
`MEETING_RECORDING_RETENTION_DAYS` (30) by the nightly STORAGE_RETENTION job; transcript, summary and tasks are kept.
Without Supabase Storage the meeting is processed immediately and the recording is not kept at all.
Google Meet's transcript API needs Google Workspace (not available on personal Gmail) — the in-app recorder also covers
site meetings that are not online. Failed processing can be retried from the meeting page.
