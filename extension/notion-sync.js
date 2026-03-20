/**
 * notion-sync.js — Notion API integration for Counsellor Assistant
 * Loaded before sidepanel.js in sidepanel.html
 *
 * All Notion calls are client-side (integration token in extension storage).
 * Handles: search students, read profile, update profile, append call history, create student.
 */

const NotionSync = (() => {

  const NOTION_API = 'https://api.notion.com/v1';
  const NOTION_VERSION = '2022-06-28';

  // ── Low-level request ──────────────────────────────────────────────────────

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

  // ── Rich-text helper ────────────────────────────────────────────────────────

  function _rt(text) {
    return [{ type: 'text', text: { content: String(text || '') } }];
  }

  // ── Markdown → Notion blocks (minimal) ─────────────────────────────────────

  function _mdToBlocks(md) {
    const lines = md.split('\n');
    const blocks = [];
    for (const line of lines) {
      if (/^## (.+)/.test(line)) {
        blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: _rt(line.replace(/^## /, '')) } });
      } else if (/^### (.+)/.test(line)) {
        blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: _rt(line.replace(/^### /, '')) } });
      } else if (/^[-*] (.+)/.test(line)) {
        blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: _rt(line.replace(/^[-*] /, '')) } });
      } else if (line.trim()) {
        blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: _rt(line) } });
      }
    }
    return blocks.slice(0, 98);
  }

  // ── Test connection ─────────────────────────────────────────────────────────

  async function testConnection(apiKey) {
    const data = await _request('GET', '/users/me', apiKey);
    return data.name || data.id;
  }

  // ── Search students ─────────────────────────────────────────────────────────

  /**
   * Search the students DB by name (case-insensitive filter).
   * Returns array of { pageId, name, source, leadStatus, callCount }
   */
  async function searchStudents(query, apiKey, dbId) {
    if (!query.trim()) return [];

    const data = await _request('POST', `/databases/${dbId}/query`, apiKey, {
      filter: {
        property: 'Name',
        title: { contains: query },
      },
      page_size: 10,
    });

    return (data.results || []).map(page => {
      const props = page.properties || {};
      const name = props['Name']?.title?.[0]?.plain_text || '(unnamed)';
      const source = props['Source Platform']?.select?.name || '';
      const leadStatus = props['Lead Status']?.select?.name || 'New';
      const callCount = props['Call Count']?.number || 0;
      return { pageId: page.id, name, source, leadStatus, callCount };
    });
  }

  // ── Get student profile ─────────────────────────────────────────────────────

  /**
   * Fetch full student profile from a Notion page.
   * Returns a plain object matching the shortlist field schema.
   */
  async function getStudentProfile(pageId, apiKey) {
    const [page, blocks] = await Promise.all([
      _request('GET', `/pages/${pageId}`, apiKey),
      _request('GET', `/blocks/${pageId}/children?page_size=100`, apiKey),
    ]);

    const props = page.properties || {};

    function getText(prop) {
      return prop?.rich_text?.[0]?.plain_text || prop?.title?.[0]?.plain_text || null;
    }
    function getSelect(prop) { return prop?.select?.name || null; }
    function getMultiSelect(prop) { return (prop?.multi_select || []).map(s => s.name); }
    function getNumber(prop) { return prop?.number ?? null; }
    function getPhone(prop) { return prop?.phone_number || null; }
    function getEmail(prop) { return prop?.email || null; }

    const profile = {
      pageId,
      name:                  getText(props['Name']),
      phone:                 getPhone(props['Phone']),
      email:                 getEmail(props['Email']),
      source_platform:       getSelect(props['Source Platform']),
      source_campaign:       getText(props['Source Campaign']),
      initial_interest:      getText(props['Initial Interest']),
      counsellor:            getSelect(props['Counsellor']),
      lead_status:           getSelect(props['Lead Status']) || 'New',
      call_count:            getNumber(props['Call Count']) || 0,
      country:               getMultiSelect(props['Country']),
      intake:                getSelect(props['Intake']),
      budget:                getText(props['Budget']),
      preferred_course:      getText(props['Preferred Course']),
      preferred_degree:      getSelect(props['Preferred Degree']),
      preferred_location:    getText(props['Preferred Location']),
      work_experience_months: getNumber(props['Work Experience (months)']),
      backlogs:              getNumber(props['Backlog']),
      ielts_score:           getText(props['IELTS Score']),
      ug_score:              getText(props['UG Score']),
      ug_specialisation:     getText(props['UG Specialisation']),
      twelfth_score:         getText(props['12th Score']),
      gre_gmat_score:        getText(props['GRE/GMAT Score']),
      college_in_mind:       getText(props['College in Mind']),
      profile_summary:       getText(props['Profile Summary']),
      motivation:            getText(props['Motivation']),
      constraints:           getText(props['Constraints']),
      open_questions:        getText(props['Open Questions']),
      counsellor_commitments: getText(props['Counsellor Commitments']),
      emotional_notes:       getText(props['Emotional Notes']),
      last_call_summary:     getText(props['Last Call Summary']),
    };

    // Extract call history from page blocks (heading_2 that matches "Call N —")
    const callHistory = [];
    const blockResults = blocks.results || [];
    let currentCall = null;
    for (const block of blockResults) {
      const plainText = block[block.type]?.rich_text?.[0]?.plain_text || '';
      if (block.type === 'heading_2' && /^Call \d+/.test(plainText)) {
        currentCall = { heading: plainText, lines: [] };
        callHistory.push(currentCall);
      } else if (currentCall) {
        currentCall.lines.push(plainText);
      }
    }
    profile.callHistory = callHistory;

    return profile;
  }

  // ── Update student profile ──────────────────────────────────────────────────

  /**
   * Write shortlist fields + qualitative data back to the Notion page.
   * updates: object with any subset of shortlist/qualitative field names.
   * incrementCallCount: if true, also increments Call Count.
   */
  async function updateStudentProfile(pageId, updates, apiKey, incrementCallCount = false, newLeadStatus = null) {
    const properties = {};

    function setRT(key, value) {
      if (value != null) properties[key] = { rich_text: _rt(value) };
    }
    function setSelect(key, value) {
      if (value) properties[key] = { select: { name: value } };
    }
    function setMultiSelect(key, values) {
      if (values && values.length) properties[key] = { multi_select: values.map(v => ({ name: String(v) })) };
    }
    function setNumber(key, value) {
      if (value != null && !isNaN(value)) properties[key] = { number: Number(value) };
    }

    if (updates.country)              setMultiSelect('Country', updates.country);
    if (updates.intake)               setSelect('Intake', updates.intake);
    if (updates.budget)               setRT('Budget', updates.budget);
    if (updates.preferred_course)     setRT('Preferred Course', updates.preferred_course);
    if (updates.preferred_degree)     setSelect('Preferred Degree', updates.preferred_degree);
    if (updates.preferred_location)   setRT('Preferred Location', updates.preferred_location);
    if (updates.work_experience_months != null) setNumber('Work Experience (months)', updates.work_experience_months);
    if (updates.backlogs != null)     setNumber('Backlog', updates.backlogs);
    if (updates.ielts_score)          setRT('IELTS Score', updates.ielts_score);
    if (updates.ug_score)             setRT('UG Score', updates.ug_score);
    if (updates.ug_specialisation)    setRT('UG Specialisation', updates.ug_specialisation);
    if (updates.twelfth_score)        setRT('12th Score', updates.twelfth_score);
    if (updates.gre_gmat_score)       setRT('GRE/GMAT Score', updates.gre_gmat_score);
    if (updates.college_in_mind)      setRT('College in Mind', updates.college_in_mind);
    if (updates.profile_summary)      setRT('Profile Summary', updates.profile_summary);
    if (updates.motivation)           setRT('Motivation', updates.motivation);
    if (updates.constraints)          setRT('Constraints', updates.constraints);
    if (updates.open_questions)       setRT('Open Questions', updates.open_questions);
    if (updates.counsellor_commitments) setRT('Counsellor Commitments', updates.counsellor_commitments);
    if (updates.emotional_notes)      setRT('Emotional Notes', updates.emotional_notes);
    if (updates.last_call_summary)    setRT('Last Call Summary', updates.last_call_summary);

    if (newLeadStatus) setSelect('Lead Status', newLeadStatus);

    if (Object.keys(properties).length === 0 && !incrementCallCount) return;

    // Handle call count increment separately — need current value
    if (incrementCallCount) {
      const page = await _request('GET', `/pages/${pageId}`, apiKey);
      const currentCount = page.properties?.['Call Count']?.number || 0;
      properties['Call Count'] = { number: currentCount + 1 };
    }

    await _request('PATCH', `/pages/${pageId}`, apiKey, { properties });
  }

  // ── Append call history ─────────────────────────────────────────────────────

  /**
   * Append a call history section to the student's Notion page body.
   * callNum: integer call number
   * duration: "MM:SS" string
   * reportMarkdown: the post-call report markdown
   * extractedData: { open_questions, counsellor_commitments }
   */
  async function appendCallHistory(pageId, callNum, duration, date, reportMarkdown, extractedData, apiKey) {
    const divider = { object: 'block', type: 'divider', divider: {} };
    const heading = {
      object: 'block', type: 'heading_2',
      heading_2: { rich_text: _rt(`Call ${callNum} — ${date}, ${duration}`) }
    };

    const blocks = [divider, heading, ...(_mdToBlocks(reportMarkdown))];

    if (extractedData?.open_questions?.length) {
      blocks.push({
        object: 'block', type: 'heading_3',
        heading_3: { rich_text: _rt('Open Items') }
      });
      for (const q of extractedData.open_questions) {
        blocks.push({
          object: 'block', type: 'to_do',
          to_do: { rich_text: _rt(q), checked: false }
        });
      }
    }

    if (extractedData?.counsellor_commitments?.length) {
      blocks.push({
        object: 'block', type: 'heading_3',
        heading_3: { rich_text: _rt('Counsellor Commitments') }
      });
      for (const c of extractedData.counsellor_commitments) {
        blocks.push({
          object: 'block', type: 'to_do',
          to_do: { rich_text: _rt(c), checked: false }
        });
      }
    }

    await _request('PATCH', `/blocks/${pageId}/children`, apiKey, {
      children: blocks.slice(0, 100),
    });
  }

  // ── Create new student ──────────────────────────────────────────────────────

  /**
   * Create a new student page in the Notion database.
   * profile: { name, phone?, email?, initial_interest?, source_platform? }
   * Returns the new page ID.
   */
  async function createStudent(profile, apiKey, dbId) {
    const properties = {
      'Name': { title: _rt(profile.name || 'New Student') },
    };

    if (profile.phone)            properties['Phone'] = { phone_number: profile.phone };
    if (profile.email)            properties['Email'] = { email: profile.email };
    if (profile.initial_interest) properties['Initial Interest'] = { rich_text: _rt(profile.initial_interest) };
    if (profile.source_platform)  properties['Source Platform'] = { select: { name: profile.source_platform } };
    properties['Lead Status'] = { select: { name: 'New' } };
    properties['Call Count'] = { number: 0 };

    const page = await _request('POST', '/pages', apiKey, {
      parent: { database_id: dbId },
      properties,
    });
    return page.id;
  }

  return {
    testConnection,
    searchStudents,
    getStudentProfile,
    updateStudentProfile,
    appendCallHistory,
    createStudent,
  };
})();
