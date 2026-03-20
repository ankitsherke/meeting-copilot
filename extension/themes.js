/**
 * themes.js — Built-in meeting theme configurations
 * Loaded before sidepanel.js in sidepanel.html
 */

const BUILT_IN_THEMES = [
  {
    id: 'counselling',
    name: 'Counselling',
    icon: '🎓',

    goal: {
      statement: 'Help the student gain clarity on their study abroad path and commit to clear next steps',
      successSignals: [
        'Student confirms target country/program',
        'Concerns addressed with data',
        'Next meeting or action booked',
        'Budget/timeline discussed'
      ]
    },

    persona: {
      role: 'You are an empathetic study abroad advisor sitting alongside the counsellor',
      tone: 'Warm, factual, never pushy. Use data to reassure, not to sell',
      outputStyle: '2-3 sentences max. Lead with the fact, then the implication',
      constraints: [
        'Never fabricate university stats or eligibility data',
        'Always cite the KB source document when giving factual claims',
        "If unsure, say \"I don't have data on this — worth verifying\""
      ]
    },

    checklist: [
      {
        id: 'cl_01', label: 'Student profile confirmed',
        description: 'GPA, test scores, target intake, budget range',
        autoDetectPatterns: ['gpa', 'ielts', 'toefl', 'gre', 'budget', 'intake'],
        priority: 'critical', nudgeIfMissedAfter: 0.5
      },
      {
        id: 'cl_02', label: 'Target country/program discussed',
        description: 'At least one country and program type explored',
        autoDetectPatterns: ['germany', 'usa', 'uk', 'canada', 'masters', 'mba', 'ms'],
        priority: 'critical', nudgeIfMissedAfter: 0.3
      },
      {
        id: 'cl_03', label: 'Concerns & objections addressed',
        description: "Student's fears or doubts surfaced and responded to",
        autoDetectPatterns: ['worried', 'concern', 'not sure', 'expensive', 'risk', 'safe'],
        priority: 'high', nudgeIfMissedAfter: 0.6
      },
      {
        id: 'cl_04', label: 'Eligibility / shortlist shared',
        description: 'Specific universities or eligibility data provided',
        autoDetectPatterns: ['eligible', 'shortlist', 'university', 'chances', 'admit'],
        priority: 'high', nudgeIfMissedAfter: 0.7
      },
      {
        id: 'cl_05', label: 'Financial clarity provided',
        description: 'Cost breakdown, loan options, or scholarship info shared',
        autoDetectPatterns: ['cost', 'fee', 'loan', 'scholarship', 'afford', 'emi', 'lakh'],
        priority: 'medium', nudgeIfMissedAfter: 0.75
      },
      {
        id: 'cl_06', label: 'Next step agreed',
        description: 'Follow-up meeting booked OR action item assigned',
        autoDetectPatterns: ['next step', 'follow up', 'book', 'schedule', 'call you', 'action'],
        priority: 'critical', nudgeIfMissedAfter: 0.85
      }
    ],

    nudgeRules: {
      enabledTypes: ['kb_answer', 'checklist_reminder', 'objection_handler', 'silence_prompt', 'goal_drift_alert', 'closing_cue', 'context_recall', 'sentiment_shift'],
      customTriggers: [
        {
          pattern: 'I need to think|let me discuss with|not ready',
          nudgeType: 'objection_handler',
          response: "Acknowledge their need for time. Offer: \"Absolutely, take your time. Would it help if I sent you a comparison sheet to review with your family? We can reconnect in 2-3 days.\""
        },
        {
          pattern: "too expensive|can't afford|out of budget",
          nudgeType: 'objection_handler',
          response: "Don't counter — empathize first. Then reframe: \"Many of our students felt the same way initially. Let me show you the cost breakdown for Germany — it's significantly more affordable than you'd expect, especially with part-time work options.\""
        },
        {
          pattern: 'is it worth it|ROI|salary after|will I get a job',
          nudgeType: 'kb_answer',
          response: 'Search KB for salary/placement data for the specific country/program being discussed. Lead with median salary + employment rate.'
        }
      ],
      silenceThresholdSec: 8,
      goalDriftTopics: ['visa process details', 'accommodation hunting', 'part-time job specifics'],
      closingCueAtPercent: 80
    }
  },

  {
    id: 'sales_close',
    name: 'Sales / Close',
    icon: '💼',

    goal: {
      statement: 'Secure a commitment — either a signed deal, a next meeting with decision-maker, or a clear timeline to close',
      successSignals: [
        'Prospect verbally commits or signs',
        'Next meeting with decision-maker booked',
        'Pricing agreed or negotiation started',
        'Clear timeline to decision stated'
      ]
    },

    persona: {
      role: "You are a sharp sales strategist whispering in the rep's ear during a live deal",
      tone: 'Confident, concise, action-oriented. No fluff. Every nudge should move the deal forward',
      outputStyle: '1-2 sentences. Lead with the action, then the reason. Format: DO [action] — BECAUSE [reason]',
      constraints: [
        'Never suggest lying or misrepresenting product capabilities',
        "Don't push a close if the prospect has explicitly said no — pivot to understanding why",
        'Always ground claims in KB data, not made-up stats'
      ]
    },

    checklist: [
      {
        id: 'cl_01', label: 'Pain point identified',
        description: "Prospect's core problem is articulated and acknowledged",
        autoDetectPatterns: ['struggling with', 'problem is', 'challenge', 'pain point', 'issue we face'],
        priority: 'critical', nudgeIfMissedAfter: 0.3
      },
      {
        id: 'cl_02', label: 'Solution mapped to pain',
        description: 'Product/service positioned as the answer to their specific problem',
        autoDetectPatterns: ['our solution', 'how we help', 'what we do', 'feature', 'capability'],
        priority: 'critical', nudgeIfMissedAfter: 0.4
      },
      {
        id: 'cl_03', label: 'Pricing / investment discussed',
        description: 'Cost, pricing model, or ROI mentioned',
        autoDetectPatterns: ['price', 'cost', 'investment', 'package', 'plan', 'roi', 'budget'],
        priority: 'high', nudgeIfMissedAfter: 0.6
      },
      {
        id: 'cl_04', label: 'Objection surfaced & handled',
        description: 'At least one concern raised and addressed',
        autoDetectPatterns: ['but', 'however', 'concern', 'not sure', 'competitor', 'alternative'],
        priority: 'high', nudgeIfMissedAfter: 0.65
      },
      {
        id: 'cl_05', label: 'Decision-maker confirmed',
        description: 'Know who makes the final call and their involvement',
        autoDetectPatterns: ['decision maker', 'who decides', 'boss', 'manager', 'team lead', 'approval'],
        priority: 'medium', nudgeIfMissedAfter: 0.5
      },
      {
        id: 'cl_06', label: 'Close attempted / next step locked',
        description: 'Asked for the business or locked a concrete next step',
        autoDetectPatterns: ['move forward', 'get started', 'sign', 'next step', 'schedule', 'timeline'],
        priority: 'critical', nudgeIfMissedAfter: 0.85
      }
    ],

    nudgeRules: {
      enabledTypes: ['kb_answer', 'checklist_reminder', 'objection_handler', 'silence_prompt', 'closing_cue', 'context_recall'],
      customTriggers: [
        {
          pattern: 'competitor|alternative|also looking at|compared to',
          nudgeType: 'objection_handler',
          response: "Don't bash the competitor. Ask: \"What specifically are you comparing?\" Then position your unique differentiator from KB."
        },
        {
          pattern: 'need to check with|run it by my|discuss internally',
          nudgeType: 'objection_handler',
          response: "Lock the next step NOW: \"Absolutely — when is that conversation happening? Let's schedule a follow-up for right after so I can answer any questions that come up.\""
        },
        {
          pattern: 'sounds good|interesting|makes sense',
          nudgeType: 'closing_cue',
          response: "Buying signal detected. Transition to close: \"Great — shall we talk about how to get this set up?\" or \"What would the ideal start date look like for you?\""
        }
      ],
      silenceThresholdSec: 6,
      goalDriftTopics: ['company history deep-dive', 'unrelated product features', 'personal small talk beyond 2 min'],
      closingCueAtPercent: 75
    }
  },

  {
    id: 'negotiation',
    name: 'Negotiation',
    icon: '🤝',

    goal: {
      statement: 'Reach a mutually acceptable agreement while protecting your key interests',
      successSignals: [
        "Both parties' core interests stated",
        'Multiple options explored',
        'Concessions traded (not given away)',
        'Agreement or clear next round scheduled'
      ]
    },

    persona: {
      role: "You are a negotiation coach in the user's earpiece. Think Chris Voss meets Roger Fisher",
      tone: 'Calm, strategic, precise. Never emotional. Frame everything as mutual gain',
      outputStyle: 'Short tactical directives. Format: TACTIC: [name] — [what to say/do]. Max 2 sentences',
      constraints: [
        'Never suggest deception or bad-faith tactics',
        'Always frame as win-win where possible',
        "Don't reveal the user's BATNA or reservation price"
      ]
    },

    checklist: [
      {
        id: 'cl_01', label: 'Their interests understood',
        description: 'You know WHAT they want and WHY (not just their position)',
        autoDetectPatterns: ['important to us', 'we need', 'our priority', 'what matters', 'why we'],
        priority: 'critical', nudgeIfMissedAfter: 0.3
      },
      {
        id: 'cl_02', label: 'Your interests stated',
        description: "You've clearly communicated what you need and why",
        autoDetectPatterns: ['for us', 'we need', 'our requirement', 'important to us', "can't compromise"],
        priority: 'critical', nudgeIfMissedAfter: 0.35
      },
      {
        id: 'cl_03', label: 'Options explored',
        description: 'Multiple possible solutions discussed, not just binary yes/no',
        autoDetectPatterns: ['what if', 'another option', 'alternatively', 'how about', 'suppose we'],
        priority: 'high', nudgeIfMissedAfter: 0.5
      },
      {
        id: 'cl_04', label: 'Concessions tracked',
        description: "Any give/take is logged — you know what you've offered and received",
        autoDetectPatterns: ['we can offer', 'in exchange', 'if you', "we'll agree to", 'concession'],
        priority: 'high', nudgeIfMissedAfter: 0.6
      },
      {
        id: 'cl_05', label: 'ZOPA identified',
        description: 'Zone of Possible Agreement is clear — or confirmed that no ZOPA exists',
        autoDetectPatterns: ['range', 'between', 'acceptable', 'deal zone', 'agree on'],
        priority: 'medium', nudgeIfMissedAfter: 0.7
      },
      {
        id: 'cl_06', label: 'Agreement or next round set',
        description: 'Either handshake deal or clear agenda for next negotiation round',
        autoDetectPatterns: ['agree', 'deal', 'next round', 'follow up', 'reconvene', 'terms'],
        priority: 'critical', nudgeIfMissedAfter: 0.85
      }
    ],

    nudgeRules: {
      enabledTypes: ['checklist_reminder', 'objection_handler', 'silence_prompt', 'goal_drift_alert', 'closing_cue', 'context_recall'],
      customTriggers: [
        {
          pattern: 'take it or leave it|final offer|non-negotiable',
          nudgeType: 'objection_handler',
          response: "TACTIC: Labeling — \"It sounds like this is really important to you.\" Don't counter-anchor yet. Ask what's driving the firmness."
        },
        {
          pattern: "we can't do that|impossible|no way",
          nudgeType: 'objection_handler',
          response: "TACTIC: Calibrated Question — Ask \"How am I supposed to make that work?\" Puts the problem-solving burden on them without saying no."
        },
        {
          pattern: 'let me think|need to discuss|get back to you',
          nudgeType: 'closing_cue',
          response: "TACTIC: Anchor Next Steps — \"Of course. What specific information would help your decision? Let's schedule a call for [specific day] so we don't lose momentum.\""
        }
      ],
      silenceThresholdSec: 10,
      goalDriftTopics: ['relationship building beyond 5 min', 'unrelated business topics', 'technical deep-dives not relevant to terms'],
      closingCueAtPercent: 80
    }
  },

  {
    id: 'internal_sync',
    name: 'Internal Sync',
    icon: '🧑‍💻',

    goal: {
      statement: 'Make clear decisions, assign owners, and end with everyone aligned on next steps',
      successSignals: [
        'Every agenda item addressed',
        'Decisions made (not deferred)',
        'Every action item has an owner and deadline',
        'Blockers surfaced with resolution plans'
      ]
    },

    persona: {
      role: 'You are an efficient meeting facilitator keeping the team on track',
      tone: "Direct, structured, no-nonsense. Respect everyone's time",
      outputStyle: 'Bullet-point format. Format: ACTION NEEDED: [what] — OWNER: [suggest] — BY: [suggest date]',
      constraints: [
        "Don't generate opinions — only surface decisions that need to be made",
        'Flag when a topic is taking more than its fair share of time',
        'Never assume org hierarchy or decision authority'
      ]
    },

    checklist: [
      {
        id: 'cl_01', label: 'Agenda items covered',
        description: 'All planned topics have been addressed',
        autoDetectPatterns: ['next topic', 'moving on', 'agenda', 'item number', "let's discuss"],
        priority: 'critical', nudgeIfMissedAfter: 0.8
      },
      {
        id: 'cl_02', label: 'Decisions documented',
        description: 'Key decisions are explicitly stated, not implied',
        autoDetectPatterns: ['decided', 'agreed', 'going with', 'decision is', "we'll do"],
        priority: 'critical', nudgeIfMissedAfter: 0.6
      },
      {
        id: 'cl_03', label: 'Owners assigned',
        description: 'Every action item has a named person responsible',
        autoDetectPatterns: ["you'll handle", "i'll take", 'owner', 'responsible', 'assigned to'],
        priority: 'high', nudgeIfMissedAfter: 0.7
      },
      {
        id: 'cl_04', label: 'Deadlines set',
        description: "Action items have dates, not just 'soon' or 'later'",
        autoDetectPatterns: ['by friday', 'by end of', 'deadline', 'due date', 'next week', 'by tomorrow'],
        priority: 'high', nudgeIfMissedAfter: 0.75
      },
      {
        id: 'cl_05', label: 'Blockers surfaced',
        description: 'Any blockers or dependencies identified and discussed',
        autoDetectPatterns: ['blocked', 'waiting on', 'dependency', "can't proceed", 'stuck', 'bottleneck'],
        priority: 'medium', nudgeIfMissedAfter: 0.5
      },
      {
        id: 'cl_06', label: 'Summary & alignment check',
        description: 'Recap of decisions + action items before ending',
        autoDetectPatterns: ['to summarize', 'recap', 'so we agreed', 'action items are', 'let me repeat'],
        priority: 'critical', nudgeIfMissedAfter: 0.9
      }
    ],

    nudgeRules: {
      enabledTypes: ['checklist_reminder', 'silence_prompt', 'goal_drift_alert', 'closing_cue'],
      customTriggers: [
        {
          pattern: "let's table this|park this|come back to",
          nudgeType: 'checklist_reminder',
          response: 'Parked item detected. Add to parking lot. Make sure to revisit before meeting ends or assign a follow-up owner.'
        },
        {
          pattern: 'I think|maybe|probably|not sure',
          nudgeType: 'goal_drift_alert',
          response: "Ambiguity detected. Push for a decision: \"Can we make a call on this now, or do we need more data? If more data — who gets it, by when?\""
        }
      ],
      silenceThresholdSec: 5,
      goalDriftTopics: ['social chat beyond 3 min', 'deep technical debugging', 'topics not on agenda'],
      closingCueAtPercent: 85
    }
  }
];

function getThemeById(id) {
  return BUILT_IN_THEMES.find(t => t.id === id) || BUILT_IN_THEMES[0];
}
