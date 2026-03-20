/**
 * themes.js — Counsellor Assistant theme configuration
 * Single theme: counselling (Leap Scholar)
 */

const COUNSELLING_THEME = {
  id: 'counselling',
  name: 'Counsellor Assistant',
  icon: '🎓',

  goal: {
    statement: 'Help the student gain clarity on their study abroad path and commit to clear next steps',
  },

  persona: {
    role: 'You are an empathetic study abroad advisor sitting alongside the counsellor during a live call',
    tone: 'Warm, factual, never pushy. Use data to reassure. Speak from the student\'s perspective.',
    outputStyle: '2-3 sentences max. Lead with the key fact or insight, then the actionable implication.',
    constraints: [
      'Never fabricate university stats, eligibility data, or visa rules',
      'Always cite the KB source document when giving factual claims',
      'If unsure, say "I don\'t have data on this — worth verifying"',
      'Do not push enrollment. Let the student decide.',
    ],
  },

  // Script moments — the Leap counselling cheat sheet
  // 14 moments in 4 sections, no linear enforcement
  scriptMoments: [
    // Section 1: Rapport
    {
      id: 'intro_self',
      section: 'Rapport',
      label: 'Introduce yourself',
      cue: 'Counsellor introduces their name and role at Leap',
      autoDetectPatterns: ["i'm", 'my name is', 'leap', 'counsellor'],
    },
    {
      id: 'intro_purpose',
      section: 'Rapport',
      label: 'State call purpose',
      cue: 'Explain the purpose of this call — profiling, not selling',
      autoDetectPatterns: ['purpose of this call', 'today we will', 'understand your', 'figure out'],
    },
    {
      id: 'intro_state',
      section: 'Rapport',
      label: 'Ask how student is',
      cue: "Check in briefly on the student's current state before diving in",
      autoDetectPatterns: ['how are you', 'how have you been', 'hope you are', 'everything okay'],
    },

    // Section 2: Profiling
    {
      id: 'profile_career',
      section: 'Profiling',
      label: 'Understand career goal',
      cue: "Ask what the student wants to do after their degree — career goal, not just course name",
      autoDetectPatterns: ['career', 'after graduation', 'want to work', 'goal', 'five years', 'dream job'],
    },
    {
      id: 'profile_validate',
      section: 'Profiling',
      label: 'Validate conviction',
      cue: "Probe whether studying abroad is decided or still exploratory — don't assume conviction",
      autoDetectPatterns: ['decided', 'sure about', 'definitely', 'considering', 'thinking about', 'not sure yet'],
    },
    {
      id: 'profile_params',
      section: 'Profiling',
      label: 'Capture core parameters',
      cue: 'Country, budget, intake, degree type, course — collect all before suggesting anything',
      autoDetectPatterns: ['budget', 'intake', 'masters', 'bachelor', 'when do you', 'how much'],
    },

    // Section 3: Reaffirmation
    {
      id: 'reaffirm_conviction',
      section: 'Reaffirmation',
      label: 'Reaffirm the decision',
      cue: "Reflect back why studying abroad makes sense for this student's specific goals",
      autoDetectPatterns: ['based on what you told', 'given your goals', 'makes sense for you', 'right fit'],
    },
    {
      id: 'reaffirm_colleges',
      section: 'Reaffirmation',
      label: 'Share college options',
      cue: 'Present 2–3 shortlist options relevant to profile — not generic list',
      autoDetectPatterns: ['university', 'college', 'shortlist', 'options', 'you could consider', 'programs'],
    },
    {
      id: 'reaffirm_similar',
      section: 'Reaffirmation',
      label: 'Share similar student outcome',
      cue: 'Use an anonymised outcome story from the KB that matches this student\'s profile',
      autoDetectPatterns: ['student like you', 'similar background', 'one of our students', 'someone who'],
    },
    {
      id: 'reaffirm_questions',
      section: 'Reaffirmation',
      label: 'Address open questions',
      cue: "Let the student ask questions — don't rush to close",
      autoDetectPatterns: ['any questions', 'what else', 'anything unclear', 'want to know more', 'doubts'],
    },

    // Section 4: Close
    {
      id: 'close_leap',
      section: 'Close',
      label: 'Introduce Leap\'s value',
      cue: 'Explain what Leap does end-to-end — counselling, SOP, visa, loan assistance',
      autoDetectPatterns: ['leap does', 'we help with', 'our services', 'end to end', 'sop', 'visa support'],
    },
    {
      id: 'close_app',
      section: 'Close',
      label: 'Discuss next step / application',
      cue: 'Ask if the student is ready to move forward — enrollment or next call',
      autoDetectPatterns: ['move forward', 'next step', 'start the process', 'enroll', 'proceed', 'application'],
    },
    {
      id: 'close_schedule',
      section: 'Close',
      label: 'Book follow-up',
      cue: 'Set a specific date and time for the next interaction',
      autoDetectPatterns: ['schedule', 'book', 'next call', 'follow up', 'speak again', 'when can we'],
    },
    {
      id: 'close_contact',
      section: 'Close',
      label: 'Share contact / WhatsApp',
      cue: 'Share counsellor WhatsApp or direct contact for quick questions',
      autoDetectPatterns: ['whatsapp', 'contact', 'reach me', 'my number', 'drop a message'],
    },
  ],

  nudgeRules: {
    enabledTypes: ['profile_clarification', 'intent_divergence', 'emotional_signal', 'kb_answer', 'script_gap', 'field_gap'],
    closingCueAtPercent: 80,
    fieldGapAfterPercent: 60,
  },
};

// Helper used by sidepanel.js
function getCounsellingTheme() {
  return COUNSELLING_THEME;
}
