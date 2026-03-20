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
      suggestedQuestion: "Hi! I'm [your name], a counsellor at Leap Scholar. I'll be with you through your entire study abroad journey.",
      autoDetectPatterns: ["i'm", 'my name is', 'leap', 'counsellor'],
    },
    {
      id: 'intro_purpose',
      section: 'Rapport',
      label: 'State call purpose',
      cue: 'Explain the purpose of this call — profiling, not selling',
      suggestedQuestion: "The goal of today's call is just to understand where you are and what you're looking for — no pressure, no decisions today.",
      autoDetectPatterns: ['purpose of this call', 'today we will', 'understand your', 'figure out'],
    },
    {
      id: 'intro_state',
      section: 'Rapport',
      label: 'Ask how student is',
      cue: "Check in briefly on the student's current state before diving in",
      suggestedQuestion: "Before we begin — how are you doing? Is this a good time to talk?",
      autoDetectPatterns: ['how are you', 'how have you been', 'hope you are', 'everything okay'],
    },

    // Section 2: Profiling
    {
      id: 'profile_career',
      section: 'Profiling',
      label: 'Understand career goal',
      cue: "Ask what the student wants to do after their degree — career goal, not just course name",
      suggestedQuestion: "Let's start from the beginning — where do you see yourself career-wise 4-5 years from now? What kind of work do you want to be doing?",
      autoDetectPatterns: ['career', 'after graduation', 'want to work', 'goal', 'five years', 'dream job'],
    },
    {
      id: 'profile_validate',
      section: 'Profiling',
      label: 'Validate conviction',
      cue: "Probe whether studying abroad is decided or still exploratory — don't assume conviction",
      suggestedQuestion: "How decided are you about studying abroad? Is it a definite plan, or are you still weighing your options?",
      autoDetectPatterns: ['decided', 'sure about', 'definitely', 'considering', 'thinking about', 'not sure yet'],
    },
    {
      id: 'profile_params',
      section: 'Profiling',
      label: 'Capture core parameters',
      cue: 'Country, budget, intake, degree type, course — collect all before suggesting anything',
      suggestedQuestion: "Tell me about the basics — which country or countries are you considering, what degree level, roughly when are you targeting, and what's your budget range?",
      autoDetectPatterns: ['budget', 'intake', 'masters', 'bachelor', 'when do you', 'how much'],
    },

    // Section 3: Reaffirmation
    {
      id: 'reaffirm_conviction',
      section: 'Reaffirmation',
      label: 'Reaffirm the decision',
      cue: "Reflect back why studying abroad makes sense for this student's specific goals",
      suggestedQuestion: "Based on everything you've shared, studying abroad genuinely makes sense for your goals — let me tell you why I think so.",
      autoDetectPatterns: ['based on what you told', 'given your goals', 'makes sense for you', 'right fit'],
    },
    {
      id: 'reaffirm_colleges',
      section: 'Reaffirmation',
      label: 'Share college options',
      cue: 'Present 2–3 shortlist options relevant to profile — not generic list',
      suggestedQuestion: "Based on your profile, I have 2-3 universities in mind that I think are a strong fit. Can I walk you through them?",
      autoDetectPatterns: ['university', 'college', 'shortlist', 'options', 'you could consider', 'programs'],
    },
    {
      id: 'reaffirm_similar',
      section: 'Reaffirmation',
      label: 'Share similar student outcome',
      cue: 'Use an anonymised outcome story from the KB that matches this student\'s profile',
      suggestedQuestion: "I want to share a story — I had a student with a background very similar to yours. Here's what happened with them.",
      autoDetectPatterns: ['student like you', 'similar background', 'one of our students', 'someone who'],
    },
    {
      id: 'reaffirm_questions',
      section: 'Reaffirmation',
      label: 'Address open questions',
      cue: "Let the student ask questions — don't rush to close",
      suggestedQuestion: "Before I move on — do you have any questions? Anything that's unclear or that you'd like to understand better?",
      autoDetectPatterns: ['any questions', 'what else', 'anything unclear', 'want to know more', 'doubts'],
    },

    // Section 4: Close
    {
      id: 'close_leap',
      section: 'Close',
      label: "Introduce Leap's value",
      cue: 'Explain what Leap does end-to-end — counselling, SOP, visa, loan assistance',
      suggestedQuestion: "Let me tell you a bit about how Leap supports you — we help end-to-end: counselling, SOP, visa, and loan assistance all under one roof.",
      autoDetectPatterns: ['leap does', 'we help with', 'our services', 'end to end', 'sop', 'visa support'],
    },
    {
      id: 'close_app',
      section: 'Close',
      label: 'Discuss next step / application',
      cue: 'Ask if the student is ready to move forward — enrollment or next call',
      suggestedQuestion: "Based on what we've discussed today, are you ready to take the next step and start the process with us?",
      autoDetectPatterns: ['move forward', 'next step', 'start the process', 'enroll', 'proceed', 'application'],
    },
    {
      id: 'close_schedule',
      section: 'Close',
      label: 'Book follow-up',
      cue: 'Set a specific date and time for the next interaction',
      suggestedQuestion: "Let's lock in our next call — what time works for you this week or next?",
      autoDetectPatterns: ['schedule', 'book', 'next call', 'follow up', 'speak again', 'when can we'],
    },
    {
      id: 'close_contact',
      section: 'Close',
      label: 'Share contact / WhatsApp',
      cue: 'Share counsellor WhatsApp or direct contact for quick questions',
      suggestedQuestion: "I'll share my WhatsApp number with you right now so you can reach me directly between calls.",
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
