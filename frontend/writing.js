/* Writing help for every text box in the app.
   1. Spell-check / autocorrect / auto-capitalise are switched on for text boxes (red underlines and right-click
      suggestions on a computer; the keyboard's autocorrect on phones). Usernames, passwords, codes, numbers,
      searches and amounts are left alone.
   2. "✨ Fix" — a small chip that appears in the corner of the text box you are typing in (when the server has the
      AI key): one tap corrects spelling, grammar and punctuation in the same language (English, Hinglish, Hindi,
      Marathi). "↩ Undo" puts your own text back.
   Loaded after app.js. The chip lives outside the app's render area, so re-renders never disturb it. */
(function () {
  const SKIP_TYPES = /^(password|email|number|tel|search|url|date|time|datetime-local|month|week|color|file|range|checkbox|radio|hidden|submit|button)$/i;
  const SKIP_NAMES = /(user|login|pass|otp|code|ref|amount|qty|rate|phone|mobile|email|gst|pan|ifsc|utr|account|search|filter|lat|lng|coord|bill-no|bill_no|invoice-no|pin)/i;
  function isProse(el) {
    if (!el || el.disabled || el.readOnly || el.dataset.noSpell != null) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type !== 'text' || SKIP_TYPES.test(type)) return false;
    const key = `${el.id || ''} ${el.name || ''} ${el.getAttribute('autocomplete') || ''} ${el.className || ''}`;
    if (SKIP_NAMES.test(key) || /\bmono\b/.test(el.className)) return false;
    if (el.getAttribute('spellcheck') === 'false') return false;
    return true;
  }
  // Idempotent: the app's re-render can drop these attributes, so they are put back whenever needed.
  function tune(el) {
    if (!isProse(el)) return;
    if (el.getAttribute('spellcheck') !== 'true') el.setAttribute('spellcheck', 'true');
    if (el.getAttribute('autocorrect') !== 'on') el.setAttribute('autocorrect', 'on');
    if (!el.hasAttribute('autocapitalize')) el.setAttribute('autocapitalize', 'sentences');
  }
  function tuneAll(root) { (root || document).querySelectorAll('textarea, input').forEach(tune); }
  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') { if (m.target.matches && m.target.matches('textarea, input') && m.target.getAttribute('spellcheck') !== 'false') tune(m.target); continue; }
      for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches && n.matches('textarea, input')) tune(n); else if (n.querySelectorAll) tuneAll(n); }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['spellcheck', 'autocorrect'] });
  document.addEventListener('focusin', e => tune(e.target), true);
  document.addEventListener('DOMContentLoaded', () => tuneAll());
  tuneAll();

  // ---- ✨ Fix chip
  const MIN_LEN = 6;
  const chip = document.createElement('button');
  chip.type = 'button'; chip.className = 'w-fix-chip'; chip.hidden = true;
  chip.title = 'Fix spelling, grammar and punctuation (same language)';
  let target = null, undo = null, busy = false, hideT = null;
  const enabled = () => typeof appFeatures !== 'undefined' && appFeatures && appFeatures.aiWriting;
  // Only text boxes where a sentence is written (not one-word fields).
  const wantsChip = (el) => isProse(el) && (el.tagName === 'TEXTAREA' || el.dataset.aiFix != null || /title|subject|desc|note|remark|reason|message|comment/i.test(`${el.id} ${el.name}`));
  function place() {
    if (!target || !document.body.contains(target)) { chip.hidden = true; return; }
    const r = target.getBoundingClientRect();
    if (r.width < 120 || r.bottom < 0 || r.top > window.innerHeight) { chip.hidden = true; return; }
    chip.style.top = `${Math.max(4, r.bottom - 30)}px`;
    chip.style.left = `${Math.max(4, r.right - chip.offsetWidth - 6)}px`;
  }
  function refresh() {
    clearTimeout(hideT);
    const len = target ? String(target.value || '').trim().length : 0;
    const show = target && enabled() && (busy || (undo && undo.el === target) || len >= MIN_LEN);
    if (!show) { chip.hidden = true; return; }
    chip.textContent = busy ? '✨ Fixing…' : undo && undo.el === target ? '↩ Undo fix' : '✨ Fix';
    chip.classList.toggle('undo', !!(undo && undo.el === target) && !busy);
    chip.disabled = busy;
    chip.hidden = false;
    place();
  }
  function setValue(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  chip.addEventListener('mousedown', e => e.preventDefault()); // keep the cursor in the text box
  chip.addEventListener('click', async () => {
    const el = target; if (!el || busy) return;
    if (undo && undo.el === el) { setValue(el, undo.before); undo = null; el.focus(); refresh(); return; }
    const before = String(el.value || '');
    busy = true; refresh();
    try {
      const r = await api('/api/ai/fix-text', { method: 'POST', body: JSON.stringify({ text: before }) });
      busy = false;
      if (String(el.value || '') !== before) { refresh(); return; } // they kept typing — don't overwrite
      if (r.text && r.text !== before) { setValue(el, r.text); undo = { el, before, after: r.text }; }
      else { chip.textContent = '✓ Looks good'; setTimeout(refresh, 1500); el.focus(); return; }
      el.focus();
    } catch (e) {
      busy = false;
      if (typeof setBanner === 'function') { setBanner(e.message || 'Could not fix the text right now.'); if (typeof render === 'function') render(); }
    }
    refresh();
  });
  document.addEventListener('focusin', e => { const el = e.target; if (wantsChip(el)) { target = el; refresh(); } });
  document.addEventListener('focusout', e => { if (e.target === target) hideT = setTimeout(() => { if (document.activeElement !== target) { chip.hidden = true; } }, 200); });
  document.addEventListener('input', e => {
    if (e.target !== target) return;
    if (undo && undo.el === target && target.value !== undo.after) undo = null; // typing again → fresh Fix
    refresh();
  });
  window.addEventListener('scroll', () => { if (!chip.hidden) place(); }, true);
  window.addEventListener('resize', () => { if (!chip.hidden) place(); });
  const mount = () => { if (!chip.isConnected) document.body.appendChild(chip); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
