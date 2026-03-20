/**
 * nudge-engine.js — Priority queue for meeting nudges
 * Loaded before sidepanel.js in sidepanel.html
 *
 * Priority Tiers:
 *   P4 (highest): closing_cue, checklist_reminder (critical items past threshold)
 *   P3:           kb_answer, objection_handler
 *   P2:           context_recall, sentiment_shift, goal_drift_alert
 *   P1 (lowest):  silence_prompt
 *
 * Suppression Rules:
 *   - Max 1 nudge displayed per 45 seconds (global cooldown)
 *   - Same type: suppress for 3 minutes after display
 *   - After dismiss: suppress type for 10 minutes
 *   - 3 consecutive dismissals of same type → disable for session
 *   - Queued candidates decay after 60 seconds if not displayed
 */

class NudgeQueue {
  constructor() {
    this.queue = [];                // { type, text, source?, priority, addedAt }
    this.suppressedUntil = new Map(); // type → timestamp
    this.dismissCounts = new Map();   // type → count this session
    this.disabledTypes = new Set();   // disabled for entire session

    this.lastDisplayTime = 0;

    // Timing constants
    this.GLOBAL_COOLDOWN_MS    = 45 * 1000;       // 45s between any new nudge
    this.TYPE_COOLDOWN_MS      = 3 * 60 * 1000;   // 3 min after same type shown
    this.DISMISS_COOLDOWN_MS   = 10 * 60 * 1000;  // 10 min after dismiss
    this.DECAY_MS              = 60 * 1000;        // candidates expire after 60s in queue
    this.DISABLE_AFTER_N       = 3;                // disable type after N consecutive dismissals
  }

  // ── Priority mapping ────────────────────────────────────────────────────────

  _priorityFor(type) {
    if (['closing_cue', 'checklist_reminder'].includes(type))     return 4;
    if (['kb_answer', 'objection_handler'].includes(type))        return 3;
    if (['context_recall', 'sentiment_shift', 'goal_drift_alert'].includes(type)) return 2;
    return 1; // silence_prompt and anything else
  }

  // ── Add a candidate nudge ───────────────────────────────────────────────────

  add(nudge) {
    // nudge: { type, text, source? }
    if (!nudge.type || !nudge.text) return;
    if (this.disabledTypes.has(nudge.type)) return;

    nudge.priority = this._priorityFor(nudge.type);
    nudge.addedAt  = Date.now();

    this.queue.push(nudge);

    // Keep sorted by priority desc so flush() is O(n) scan
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  // ── Flush: returns the best nudge that can be shown now, or null ────────────

  flush() {
    const now = Date.now();

    // Global cooldown: don't show anything if too recent
    if (now - this.lastDisplayTime < this.GLOBAL_COOLDOWN_MS) return null;

    // Expire decayed candidates
    this.queue = this.queue.filter(n => (now - n.addedAt) < this.DECAY_MS);

    // Find first eligible candidate (highest priority that isn't suppressed)
    for (let i = 0; i < this.queue.length; i++) {
      const candidate = this.queue[i];
      const suppressed = this.suppressedUntil.get(candidate.type) || 0;
      if (now < suppressed) continue;

      // Eligible — remove from queue and return
      this.queue.splice(i, 1);
      this.lastDisplayTime = now;
      this.suppressedUntil.set(candidate.type, now + this.TYPE_COOLDOWN_MS);
      return candidate;
    }

    return null;
  }

  // ── Record a dismiss event ──────────────────────────────────────────────────

  dismiss(type) {
    const now = Date.now();
    this.suppressedUntil.set(type, now + this.DISMISS_COOLDOWN_MS);

    const count = (this.dismissCounts.get(type) || 0) + 1;
    this.dismissCounts.set(type, count);

    if (count >= this.DISABLE_AFTER_N) {
      this.disabledTypes.add(type);
      console.log(`[NudgeQueue] Type "${type}" disabled for session (${count} dismissals)`);
    }
  }

  // ── Reset on meeting end ────────────────────────────────────────────────────

  reset() {
    this.queue = [];
    this.lastDisplayTime = 0;
    // Keep suppressedUntil and dismissCounts — they persist within a session
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  queueLength() {
    return this.queue.length;
  }

  isTypeEnabled(type) {
    return !this.disabledTypes.has(type);
  }
}
