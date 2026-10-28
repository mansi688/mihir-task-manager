// Feature flags — every new integration is OFF until explicitly enabled and tested.
// ENABLE_AUTO_TASK_CREATION is deliberately not supported: AI/integrations may PROPOSE tasks, a
// person always confirms (human-in-the-loop).
const on = (v, dflt = false) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
function flags(env = process.env) {
  // With an AI key set, the AI features are on unless switched off (ENABLE_…=false); without a key they stay off.
  const hasAI = !!env.AI_API_KEY || /^mock$/i.test(String(env.AI_PROVIDER || ''));
  return {
    aiTaskExtraction: on(env.ENABLE_AI_TASK_EXTRACTION, hasAI),
    voiceTasks: on(env.ENABLE_VOICE_TASKS, hasAI),
    whatsapp: on(env.ENABLE_WHATSAPP_INTEGRATION),
    emailIngestion: on(env.ENABLE_EMAIL_INGESTION),
    meetingAi: on(env.ENABLE_MEETING_AI, hasAI),
    aiBudgetLimit: on(env.ENABLE_AI_BUDGET_LIMIT, true),
    // Employee location tracking (docs/LOCATION_TRACKING.md). Off until Admin has set the policy and
    // places and decided to roll it out.
    locationTracking: on(env.ENABLE_LOCATION_TRACKING),
    autoTaskCreation: false,
  };
}
module.exports = { flags };
