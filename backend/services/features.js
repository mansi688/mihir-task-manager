// Feature flags — every new integration is OFF until explicitly enabled and tested.
// ENABLE_AUTO_TASK_CREATION is deliberately not supported: AI/integrations may PROPOSE tasks, a
// person always confirms (human-in-the-loop).
const on = (v, dflt = false) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
function flags(env = process.env) {
  return {
    aiTaskExtraction: on(env.ENABLE_AI_TASK_EXTRACTION),
    voiceTasks: on(env.ENABLE_VOICE_TASKS),
    whatsapp: on(env.ENABLE_WHATSAPP_INTEGRATION),
    emailIngestion: on(env.ENABLE_EMAIL_INGESTION),
    meetingAi: on(env.ENABLE_MEETING_AI),
    aiBudgetLimit: on(env.ENABLE_AI_BUDGET_LIMIT, true),
    // Employee location tracking (docs/LOCATION_TRACKING.md). Off until Admin has set the policy and
    // places and decided to roll it out.
    locationTracking: on(env.ENABLE_LOCATION_TRACKING),
    autoTaskCreation: false,
  };
}
module.exports = { flags };
