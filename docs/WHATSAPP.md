# WhatsApp task assistant (`ENABLE_WHATSAPP_INTEGRATION`)

One company WhatsApp Business number (Meta WhatsApp Cloud API — official; no WhatsApp Web automation).
Employees are recognised by the phone number on their profile (last 10 digits); other numbers are ignored.

## Flow
Message (text or voice note) → webhook (signature verified, each message id once) → background job → AI →
reply: "Task prepared: … Assigned … Due … Reply CONFIRM to create (or CONFIRM 1, CONFIRM 2…), or CANCEL."
→ CONFIRM creates the task(s) through the normal task path (source = whatsapp) and replies with the task ID.
Documents (PDF, Word, Excel), photos and short videos are read the same way ("Task prepared from your document…").
Suggestions without a deadline, with unknown people or below `AI_MIN_CONFIDENCE` cannot be confirmed from WhatsApp
— the reply says to complete them in the app (they appear under **Suggestions**). Voice notes are stored privately
for 30 days (if storage is configured) and transcribed in their original language.

## Setup
1. Meta Business account (company name) → verify the business → WhatsApp → add a dedicated number (not active on the normal WhatsApp app).
2. Meta app → WhatsApp → Configuration → Webhook URL `https://<site>/api/integrations/whatsapp/webhook`,
   verify token = `WHATSAPP_VERIFY_TOKEN`; subscribe to **messages**.
3. Render → Environment: `WHATSAPP_TOKEN` (permanent system-user token), `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_APP_SECRET` (Meta app → Settings → Basic), `WHATSAPP_VERIFY_TOKEN`, `ENABLE_WHATSAPP_INTEGRATION=true`.
4. Add employees' mobile numbers in their profiles.

## Cost (India, from 1 Oct 2026, approx. + GST)
Messages employees send: free. Replies within 24 h: first 1,000/month free, then ≈ ₹0.12–0.15 each. Reminders sent
outside a conversation are "utility templates" (≈ ₹0.12–0.15 each, need Meta-approved templates) — so only important
notification types go to WhatsApp (`WHATSAPP_NOTIFY_TYPES`).
