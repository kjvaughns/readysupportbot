import { ModelOutput } from './schema';
import { normalizeStateList } from '../readymode/states';

/**
 * Deterministic parser used when OpenAI is not configured, and as a safety net
 * when the model is unavailable. It only recognizes unambiguous phrasings and
 * otherwise returns UNSUPPORTED — it never guesses a target.
 */

const SELF_WORDS = /\b(me|my|mine|i|i'm|im)\b/i;

function extractDiscordMention(text: string): string | null {
  const match = text.match(/<@!?(\d{5,25})>/);
  return match ? match[1] : null;
}

function extractStates(text: string): string[] {
  // Look at the segment after the state verb so unrelated words are not scanned.
  const { states } = normalizeStateList(splitCandidates(text));
  return states;
}

function splitCandidates(text: string): string[] {
  const cleaned = text.replace(/<@!?\d+>/g, ' ');
  const tokens: string[] = [];

  // Two-letter uppercase tokens are treated as postal abbreviations.
  for (const match of cleaned.matchAll(/\b[A-Z]{2}\b/g)) tokens.push(match[0]);

  // Multi-word state names, longest first so "West Virginia" wins over "Virginia".
  const names = [
    'washington, dc', 'district of columbia', 'washington dc', 'new hampshire', 'new jersey',
    'new mexico', 'new york', 'north carolina', 'north dakota', 'rhode island', 'south carolina',
    'south dakota', 'west virginia', 'alabama', 'alaska', 'arizona', 'arkansas', 'california',
    'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois',
    'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts',
    'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'ohio',
    'oklahoma', 'oregon', 'pennsylvania', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
    'washington', 'wisconsin', 'wyoming',
  ];

  const lower = cleaned.toLowerCase();
  let remaining = lower;
  for (const name of names) {
    if (remaining.includes(name)) {
      tokens.push(name);
      remaining = remaining.split(name).join(' ');
    }
  }

  return tokens;
}

function emptyOutput(action: ModelOutput['action']): ModelOutput {
  return {
    action,
    target: null,
    source: null,
    states: null,
    campaigns: null,
    queues: null,
    accounts: null,
    limit: null,
    clarification: null,
    reason: null,
  };
}

function targetFrom(text: string): ModelOutput['target'] {
  const mention = extractDiscordMention(text);
  if (mention) return { kind: 'discord_user', discordUserId: mention };
  if (SELF_WORDS.test(text)) return { kind: 'self' };
  return null;
}

export function fallbackParse(message: string): ModelOutput {
  const text = message.trim();
  const lower = text.toLowerCase();

  if (/^\s*help\b/.test(lower) || /\bwhat can you do\b/.test(lower)) {
    return emptyOutput('HELP');
  }

  if (/\bconnection status\b|\bare you connected\b|\breadymode status\b/.test(lower)) {
    return emptyOutput('CONNECTION_STATUS');
  }

  if (/\brecent (actions|activity)\b|\bactivity log\b|\bwhat have you done\b/.test(lower)) {
    return emptyOutput('RECENT_ACTIONS');
  }

  if (/\blicense usage\b|\bwho('s| is) using (a )?licen[cs]e/.test(lower)) {
    return emptyOutput('LICENSE_USAGE');
  }

  if (/\bdefault states\b|\bdefault for new agents\b/.test(lower)) {
    const output = emptyOutput('SET_DEFAULT_STATES');
    const states = extractStates(text);
    output.states = states.length > 0 ? states : null;
    if (states.length === 0) output.clarification = 'Which states should new agents receive by default?';
    return output;
  }

  if (/\bcopy\b[\s\S]*\bstates?\b|\bstate (setup|configuration)\b[\s\S]*\bto\b/.test(lower)) {
    const output = emptyOutput('COPY_STATE_CONFIGURATION');
    output.clarification = 'Name the agent to copy from and the agent to copy to.';
    return output;
  }

  const stateVerb = lower.match(
    /\b(add|remove|drop|stop|set|only receiv|make .* receive|change|replace|update)\b/,
  );
  const mentionsStates = /\bstates?\b/.test(lower) || extractStates(text).length > 0;

  if (mentionsStates && stateVerb) {
    const verb = stateVerb[1];
    let action: ModelOutput['action'] = 'SET_STATES';
    if (verb === 'add') action = 'ADD_STATES';
    else if (['remove', 'drop', 'stop'].includes(verb)) action = 'REMOVE_STATES';

    const output = emptyOutput(action);
    const states = extractStates(text);
    output.states = states.length > 0 ? states : null;
    output.target = targetFrom(text);
    if (states.length === 0) output.clarification = 'Which states should be used?';
    else if (!output.target) output.clarification = 'Which agent should this apply to?';
    return output;
  }

  if (/\bwhat states\b|\bwhich states\b|\bview states\b|\bstates? (does|do|is|are)\b/.test(lower)) {
    const output = emptyOutput('VIEW_STATES');
    output.target = targetFrom(text);
    if (!output.target) output.clarification = 'Which agent should I look up?';
    return output;
  }

  if (/\b(logged in|online|agent status|is .* logged)\b/.test(lower)) {
    const output = emptyOutput('AGENT_STATUS');
    output.target = targetFrom(text);
    if (!output.target) output.clarification = 'Which agent should I check?';
    return output;
  }

  if (/\bclear\b[\s\S]*\blicen[cs]e\b/.test(lower)) {
    const output = emptyOutput('CLEAR_LICENSE');
    output.target = targetFrom(text);
    if (!output.target) output.clarification = 'Whose license should I clear?';
    return output;
  }

  if (/\breset\b[\s\S]*\bpassword\b/.test(lower)) {
    const output = emptyOutput('RESET_PASSWORD');
    output.target = targetFrom(text);
    if (!output.target) output.clarification = 'Whose password should I reset?';
    return output;
  }

  if (/\b(deactivate|disable|turn off)\b[\s\S]*\b(account|agent|user)\b/.test(lower)) {
    const output = emptyOutput('DEACTIVATE_ACCOUNT');
    output.target = targetFrom(text);
    if (!output.target) output.clarification = 'Which account should be deactivated?';
    return output;
  }

  if (/\b(create|make|add)\b[\s\S]*\b(account|agent)s\b/.test(lower)) {
    const output = emptyOutput('CREATE_ACCOUNTS');
    output.clarification = 'List the full name for each account to create.';
    return output;
  }

  if (/\b(create|make|add)\b[\s\S]*\b(account|agent)\b/.test(lower)) {
    const output = emptyOutput('CREATE_ACCOUNT');
    output.clarification = 'What is the full name for the new account?';
    return output;
  }

  if (/\bcampaign/.test(lower)) {
    const output = emptyOutput('ASSIGN_CAMPAIGNS');
    output.target = targetFrom(text);
    output.clarification = 'Which campaigns should be assigned, and to which agent?';
    return output;
  }

  if (/\bqueue/.test(lower)) {
    const output = emptyOutput('ASSIGN_QUEUES');
    output.target = targetFrom(text);
    output.clarification = 'Which queues should be assigned, and to which agent?';
    return output;
  }

  const output = emptyOutput('UNSUPPORTED');
  output.reason =
    'That is not one of the supported ReadySupport actions. Send "help" to see what is available.';
  return output;
}
