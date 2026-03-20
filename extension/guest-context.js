/**
 * guest-context.js — Cross-meeting guest profile storage
 * Loaded before sidepanel.js in sidepanel.html
 *
 * Storage schema (chrome.storage.local key: "guests"):
 * {
 *   [guestId]: {
 *     id: string,          // slugified name
 *     name: string,
 *     company: string,
 *     role: string,
 *     meetings: [
 *       {
 *         date: string,       // ISO date "2026-03-19"
 *         theme: string,      // theme id
 *         duration: string,   // "HH:MM:SS"
 *         goalAchieved: bool,
 *         summary: string,    // first 300 chars of report
 *         actionItems: [],    // strings
 *         checklistScore: string // "4/6"
 *       }
 *     ]
 *   }
 * }
 */

const GuestContext = (() => {

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function slugify(name) {
    return name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  }

  function _loadAll() {
    return new Promise(resolve => {
      chrome.storage.local.get('guests', data => {
        resolve(data.guests || {});
      });
    });
  }

  function _saveAll(guests) {
    return new Promise(resolve => {
      chrome.storage.local.set({ guests }, resolve);
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Search guests by partial name match.
   * Returns up to 5 matching guest objects, sorted by most recent meeting.
   */
  async function search(query) {
    if (!query || query.trim().length < 2) return [];
    const guests = await _loadAll();
    const q = query.trim().toLowerCase();
    return Object.values(guests)
      .filter(g => g.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aDate = a.meetings[a.meetings.length - 1]?.date || '';
        const bDate = b.meetings[b.meetings.length - 1]?.date || '';
        return bDate.localeCompare(aDate);
      })
      .slice(0, 5);
  }

  /**
   * Load a single guest by id.
   */
  async function getGuest(guestId) {
    const guests = await _loadAll();
    return guests[guestId] || null;
  }

  /**
   * Get or create a guest by name. Returns the guest object.
   */
  async function getOrCreate(name, company = '', role = '') {
    const guests = await _loadAll();
    const id = slugify(name);
    if (!guests[id]) {
      guests[id] = { id, name: name.trim(), company, role, meetings: [] };
      await _saveAll(guests);
    }
    return guests[id];
  }

  /**
   * Update guest metadata (name, company, role).
   */
  async function updateGuest(guestId, fields) {
    const guests = await _loadAll();
    if (!guests[guestId]) return;
    Object.assign(guests[guestId], fields);
    await _saveAll(guests);
  }

  /**
   * Append a meeting record to a guest's history.
   * meetingData: { theme, duration, goalAchieved, summary, actionItems[], checklistScore }
   */
  async function addMeeting(guestId, meetingData) {
    const guests = await _loadAll();
    if (!guests[guestId]) return;
    const record = {
      date: new Date().toISOString().slice(0, 10),
      theme: meetingData.theme || '',
      duration: meetingData.duration || '',
      goalAchieved: !!meetingData.goalAchieved,
      summary: (meetingData.summary || '').slice(0, 400),
      actionItems: meetingData.actionItems || [],
      checklistScore: meetingData.checklistScore || '',
    };
    guests[guestId].meetings.push(record);
    // Keep last 20 meetings per guest
    if (guests[guestId].meetings.length > 20) {
      guests[guestId].meetings = guests[guestId].meetings.slice(-20);
    }
    await _saveAll(guests);
    return record;
  }

  /**
   * Delete a guest and all their history.
   */
  async function deleteGuest(guestId) {
    const guests = await _loadAll();
    delete guests[guestId];
    await _saveAll(guests);
  }

  /**
   * Return all guests sorted by most recently seen.
   */
  async function listAll() {
    const guests = await _loadAll();
    return Object.values(guests).sort((a, b) => {
      const aDate = a.meetings[a.meetings.length - 1]?.date || '';
      const bDate = b.meetings[b.meetings.length - 1]?.date || '';
      return bDate.localeCompare(aDate);
    });
  }

  return { search, getGuest, getOrCreate, updateGuest, addMeeting, deleteGuest, listAll, slugify };
})();
