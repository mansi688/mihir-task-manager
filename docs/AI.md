# AI assistant: ingestion, suggestions, voice tasks

## Pipeline (one path for every channel)
input (voice / WhatsApp / email / meeting / pasted text) → `ingestion_items` (unique per source message) →
AI extraction (`backend/services/ai.js`) → app-side validation (people resolved against the real directory with the
same rules as the Excel import, dates checked, non-actions dropped, max 20 per message / 50 per meeting) →
`ai_suggestions` → a person reviews/edits → **Create Task** → the same task-creation code as "+ New Task"
(`createTaskFromSpec` → `insertTaskRecords`) → history event with source, model, confidence and approver.
Nothing is created automatically (`ENABLE_AUTO_TASK_CREATION` does not exist on purpose).

## Provider
`AI_PROVIDER=gemini` (default model `gemini-3.5-flash-lite`, falling back to newer/older models if Google retires one, structured JSON output) or `mock` (rule-based, free —
tests/demos). Application code only calls `ai.extractTasks()` / `ai.processAudio()`; another provider is one new
function in `ai.js`. Data sent: the message/audio, people's names + usernames, project names, today's date.
Use the **paid** Gemini API tier (free-tier inputs may be used to improve Google's products).

## Cost control
Every call logged in `ai_usage_events` (tokens, US$ and ₹, feature, source, user). `MONTHLY_AI_BUDGET_INR`
(default ₹1,000): Admins notified at `AI_COST_ALERT_THRESHOLD` (80 %); at 100 % AI requests are refused with a
clear message — manual task creation is unaffected. Admin → System Health shows today / this month / by source.
Typical cost: text extraction ≈ ₹0.02; a 1-minute voice note ≈ ₹0.05–0.1; a 1-hour meeting ≈ ₹3–6 (estimates
from published prices; real figures appear on System Health).

## Voice tasks (`ENABLE_VOICE_TASKS`)
My Tasks → **🎤 Create Task by Voice** → record (≤ 3 min; Marathi/Hindi/English/mixed) → transcript in the
original language + task cards (English) → edit → Create. Low confidence is flagged on the card. Requires the
microphone (browser prompt; Android app v1.4+ asks once). **📋 Tasks from a message** does the same for pasted text.

## Documents, photos and videos (`ENABLE_AI_TASK_EXTRACTION`)
My Tasks → **📎 Tasks from a document or photo** (and WhatsApp documents/photos/videos): PDF, Word (.docx), Excel
(.xlsx), CSV/TXT, photos (incl. handwriting, scanned pages) and short videos, up to 15 MB (WhatsApp 16 MB).
Word/Excel/CSV are read on the server (only the text goes to the AI); PDF/photo/video go to the model as files.
Old .doc/.xls and other types are refused with a clear message. Files are kept privately for `UPLOAD_RETENTION_DAYS`
(90) when storage is configured. Typical cost: a photo or PDF page ≈ ₹0.01–0.05; a 1-minute video ≈ ₹0.5–1.

## Switching on
1. Get a Gemini API key (Google AI Studio → API key; enable billing for the paid tier).
2. Render → Environment: `AI_API_KEY`, `MONTHLY_AI_BUDGET_INR`, `ENABLE_AI_TASK_EXTRACTION=true`, `ENABLE_VOICE_TASKS=true`.
3. Test with a few real voice notes in Marathi/Hindi/English; check System Health → AI usage.
