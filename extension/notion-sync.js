/**
 * notion-sync.js — Notion API integration for Meeting Copilot
 * Loaded before sidepanel.js in sidepanel.html
 *
 * Handles:
 *  - Creating meeting report pages in a Notion database
 *  - Auto-creating the database if none is configured
 *  - Retry queue for failed pushes (stored in chrome.storage.local)
 *
 * Notion API is called directly from the extension (requires host_permissions for api.notion.com)
 */

const NotionSync = (() => {

  const NOTION_API = 'https://api.notion.com/v1';
  const NOTION_VERSION = '2022-06-28';
  const RETRY_STORAGE_KEY = 'notionRetryQueue';

  // ── Low-level request ───────────────────────────────────────────────────────

  async function _request(method, path, apiKey, body = null) {
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${NOTION_API}${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Notion API error ${res.status}`);
    return data;
  }

  // ── Markdown → Notion blocks (minimal parser) ───────────────────────────────

  function _mdToBlocks(md) {
    const lines = md.split('\n');
    const blocks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^## (.+)/.test(line)) {
        blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: line.replace(/^## /, '') } }] } });
      } else if (/^### (.+)/.test(line)) {
        blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: line.replace(/^### /, '') } }] } });
      } else if (/^[-*] (.+)/.test(line)) {
        const text = line.replace(/^[-*] /, '').replace(/\*\*(.+?)\*\*/g, '$1');
        blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text } }] } });
      } else if (line.trim() === '') {
        // skip blank lines
      } else {
        const text = line.replace(/\*\*(.+?)\*\*/g, '$1');
        if (text.trim()) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } });
      }
    }

    // Notion API max 100 blocks per request
    return blocks.slice(0, 100);
  }

  // ── Database auto-creation ──────────────────────────────────────────────────

  /**
   * Create a "Meeting Copilot" database as a child of the user's workspace root.
   * parentPageId: the ID of a page the integration has access to.
   * Returns the new database ID.
   */
  async function createDatabase(apiKey, parentPageId) {
    const db = await _request('POST', '/databases', apiKey, {
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: 'Meeting Copilot' } }],
      properties: {
        'Name':           { title: {} },
        'Date':           { date: {} },
        'Theme':          { select: { options: [
          { name: 'Counselling', color: 'blue' },
          { name: 'Sales / Close', color: 'green' },
          { name: 'Negotiation', color: 'orange' },
          { name: 'Internal Sync', color: 'purple' },
          { name: 'General', color: 'gray' },
        ]}},
        'Duration':       { rich_text: {} },
        'Guest':          { rich_text: {} },
        'Goal Achieved':  { checkbox: {} },
        'Checklist Score':{ rich_text: {} },
      },
    });
    return db.id;
  }

  // ── Push a meeting report ───────────────────────────────────────────────────

  /**
   * reportData: {
   *   apiKey, databaseId,
   *   guestName, themeName, themeId, date, duration,
   *   goalAchieved, checklistScore,
   *   reportMarkdown
   * }
   */
  async function pushReport(reportData) {
    const {
      apiKey, databaseId,
      guestName = '', themeName = 'General', date,
      duration = '—', goalAchieved = false,
      checklistScore = '—', reportMarkdown = '',
    } = reportData;

    const today = date || new Date().toISOString().slice(0, 10);
    const titleText = `${guestName ? `Meeting with ${guestName}` : 'Meeting'} — ${today}`;

    // Metadata block prepended to page body (works with any database schema)
    const metaBlock = {
      object: 'block', type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content:
          `📅 ${today}  ·  🎯 ${themeName}  ·  ⏱ ${duration}  ·  ${guestName ? `👤 ${guestName}  ·  ` : ''}${goalAchieved ? '✅ Goal achieved' : '❌ Goal not achieved'}  ·  📋 ${checklistScore}`
        }}],
        icon: { emoji: '📝' },
        color: 'gray_background',
      },
    };

    const page = await _request('POST', '/pages', apiKey, {
      parent: { database_id: databaseId },
      properties: {
        'Name': { title: [{ type: 'text', text: { content: titleText } }] },
      },
      children: [metaBlock, ...(_mdToBlocks(reportMarkdown).slice(0, 99))],
    });

    return page.id;
  }

  // ── Test connection ─────────────────────────────────────────────────────────

  async function testConnection(apiKey) {
    // Just hit /users/me to validate the key
    const data = await _request('GET', '/users/me', apiKey);
    return data.name || data.id;
  }

  // ── Retry queue ─────────────────────────────────────────────────────────────

  function _loadQueue() {
    return new Promise(resolve => {
      chrome.storage.local.get(RETRY_STORAGE_KEY, d => resolve(d[RETRY_STORAGE_KEY] || []));
    });
  }

  function _saveQueue(queue) {
    return new Promise(resolve => chrome.storage.local.set({ [RETRY_STORAGE_KEY]: queue }, resolve));
  }

  /** Add a failed push to the retry queue */
  async function enqueueRetry(reportData) {
    const queue = await _loadQueue();
    queue.push({ ...reportData, failedAt: Date.now(), attempts: 1 });
    await _saveQueue(queue);
  }

  /** Attempt all queued retries. Returns { succeeded, failed } counts. */
  async function flushRetryQueue(apiKey, databaseId) {
    const queue = await _loadQueue();
    if (!queue.length) return { succeeded: 0, failed: 0 };

    let succeeded = 0;
    const stillFailing = [];

    for (const item of queue) {
      try {
        await pushReport({ ...item, apiKey, databaseId });
        succeeded++;
      } catch (_) {
        item.attempts = (item.attempts || 1) + 1;
        if (item.attempts < 5) stillFailing.push(item); // drop after 5 attempts
      }
    }

    await _saveQueue(stillFailing);
    return { succeeded, failed: stillFailing.length };
  }

  async function retryQueueLength() {
    const queue = await _loadQueue();
    return queue.length;
  }

  return {
    pushReport,
    createDatabase,
    testConnection,
    enqueueRetry,
    flushRetryQueue,
    retryQueueLength,
  };
})();
