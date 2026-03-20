/**
 * nudge-engine.js — Priority queue for counsellor assist card nudges
 *
 * Priority Tiers (highest → lowest):
 *   P1: profile_clarification, intent_divergence  (red — interrupt anything)
 *   P2: emotional_signal                           (amber — surface quickly)
 *   P3: kb_answer                                  (blue — on question)
 *   P4: script_gap                                 (green — helpful opening)
 *   P5: field_gap                                  (gray — passive reminder)
 *
 * Suppression:
 *   - Max 1 active card at a time (highest priority wins)
 *   - 90s cooldown per type after dismiss (P1 exempt)
 *   - 3 consecutive dismissals → disable type for session
 *   - Queued candidates decay after 90s if not displayed
 */

class NudgeQueue {
  constructor() {
    this.queue = [];                  // { type, text, suggestion, reason?, priority, addedAt }
    this.suppressedUntil = new Map(); // type → timestamp
    this.dismissCounts = new Map();   // type → count this session
    this.disabledTypes = new Set();

    this.lastDisplayTime = 0;

    this.GLOBAL_COOLDOWN_MS  = 30 * 1000;       // 30s between cards
    this.TYPE_COOLDOWN_MS    = 90 * 1000;        // 90s after type shown
    this.DISMISS_COOLDOWN_MS = 90 * 1000;        // 90s after dismiss (P1 exempt)
    this.DECAY_MS            = 90 * 1000;        // candidates expire after 90s
    this.DISABLE_AFTER_N     = 3;
  }

  _priorityFor(type) {
    if (['profile_clarification', 'intent_divergence'].includes(type)) return 5; // P1 → highest number
    if (type === 'emotional_signal')                                   return 4;
    if (type === 'kb_answer')                                          return 3;
    if (type === 'script_gap')                                         return 2;
    return 1; // field_gap and anything else
  }

  add(nudge) {
    if (!nudge.type || !nudge.text) return;
    if (this.disabledTypes.has(nudge.type)) return;

    nudge.priority = this._priorityFor(nudge.type);
    nudge.addedAt  = Date.now();
    this.queue.push(nudge);
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  flush() {
    const now = Date.now();

    // Expire decayed candidates
    this.queue = this.queue.filter(n => (now - n.addedAt) < this.DECAY_MS);

    // Find first eligible (highest priority, not suppressed)
    for (let i = 0; i < this.queue.length; i++) {
      const candidate = this.queue[i];
      const suppressed = this.suppressedUntil.get(candidate.type) || 0;
      if (now < suppressed) continue;

      // Skip global cooldown only for P1 types
      if (candidate.priority < 5 && now - this.lastDisplayTime < this.GLOBAL_COOLDOWN_MS) continue;

      this.queue.splice(i, 1);
      this.lastDisplayTime = now;
      this.suppressedUntil.set(candidate.type, now + this.TYPE_COOLDOWN_MS);
      return candidate;
    }

    return null;
  }

  dismiss(type) {
    const now = Date.now();
    const isP1 = ['profile_clarification', 'intent_divergence'].includes(type);
    if (!isP1) {
      this.suppressedUntil.set(type, now + this.DISMISS_COOLDOWN_MS);
    }

    const count = (this.dismissCounts.get(type) || 0) + 1;
    this.dismissCounts.set(type, count);
    if (count >= this.DISABLE_AFTER_N) {
      this.disabledTypes.add(type);
    }
  }

  reset() {
    this.queue = [];
    this.lastDisplayTime = 0;
  }

  queueLength() { return this.queue.length; }
  isTypeEnabled(type) { return !this.disabledTypes.has(type); }
}
