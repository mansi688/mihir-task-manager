/* Who sees which department page — one list, used by both the server (require) and the page (script tag).
   Admin sees everything. "Senior management" = the Director role or a department named Senior management /
   Management / Director. A department matches by its name (e.g. "Store Department" → store).
   The server adds a few people on top in its own modules: project heads for Estimation approvals, people given
   "Can manage deliveries", named Estimation viewers (EST_VIEW_USERS). */
(function (root) {
  const DEPTS = {
    senior: /senior|management|director|\bmd\b|\bceo\b|owner/i,
    accounts: /account/i,
    estimation: /estimat|billing/i,
    compliance: /complian/i,
    store: /store/i,
    purchase: /purchase/i,
    hr: /(^|\b)hr\b|human resource/i,
  };
  const PAGE_ACCESS = {
    updates: [],                                      // Admin only
    activity: ['senior'],                             // User Activity: Admin + senior management
    accountsdept: ['accounts', 'senior'],
    estimation: ['senior', 'estimation', 'compliance'],
    dpr: ['store', 'purchase'],
    payroll: ['hr'],
    deliveries: ['store', 'purchase'],
    meetings: ['senior', 'purchase', 'compliance'],
  };
  function inDept(dept, role, team) {
    if (dept === 'senior' && role === 'director') return true;
    const rx = DEPTS[dept];
    return !!rx && rx.test(String(team || ''));
  }
  function pageAllowedFor(page, role, team) {
    if (role === 'admin') return true;
    const list = PAGE_ACCESS[page];
    if (!list) return true;
    return list.some(d => inDept(d, role, team));
  }
  const api = { DEPTS, PAGE_ACCESS, inDept, pageAllowedFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MihirAccess = api;
})(typeof window !== 'undefined' ? window : globalThis);
