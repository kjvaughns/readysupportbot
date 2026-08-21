/**
 * General troubleshooting guidance.
 *
 * This is deliberately *not* Readymode documentation. Nobody has crawled the
 * Help Center yet, so these are general softphone and browser checks that hold
 * for any web-based dialer. Every answer says so out loud, because an agent
 * following steps that name the wrong menu wastes more time than no answer.
 *
 * Once `knowledge:sync` has ingested the official Help Center, retrieval takes
 * precedence and these become the fallback for questions the documentation does
 * not cover. Nothing here invents a Readymode menu path, button name or setting.
 */

export type TroubleshootTopic =
  | 'audio'
  | 'login'
  | 'dialer'
  | 'leads'
  | 'license'
  | 'recording'
  | 'other';

export interface TroubleshootingGuide {
  topic: TroubleshootTopic;
  title: string;
  /** Ordered checks, cheapest and most common first. */
  steps: string[];
  /** When to stop self-diagnosing and involve someone. */
  escalate: string;
}

export const GUIDES: Record<TroubleshootTopic, TroubleshootingGuide> = {
  audio: {
    topic: 'audio',
    title: 'No audio, one-way audio, or the caller cannot hear you',
    steps: [
      'Check the headset is fully plugged in, and that any inline mute switch on the cable or earcup is off.',
      'Confirm the browser is allowed to use the microphone — most browsers show a microphone icon in the address bar when a site has asked for it.',
      'Check the operating system picked the headset, not the laptop speakers or webcam microphone, as both input and output.',
      'If the headset is USB, unplug it and plug it back in, then reload the dialer tab.',
      'Try a call after a full browser restart. Audio devices grabbed by another app (a meeting tab, a music app) are a common cause.',
      'If only the caller cannot hear you, the problem is the microphone side; if only you cannot hear them, it is the output side. That split usually points straight at the wrong device being selected.',
      'On a wireless headset, check it is charged and paired to the right machine.',
    ],
    escalate:
      'If audio fails on a second headset, or for several agents at once, it is probably not the hardware — raise it with whoever administers your Readymode account.',
  },
  login: {
    topic: 'login',
    title: 'Cannot sign in',
    steps: [
      'Check the username is exactly as issued — logins are usually case sensitive and often are not the email address.',
      'Confirm the account has not been deactivated. An administrator can see this.',
      'If a message mentions another session, the account may already be signed in somewhere else, which can block a second sign-in.',
      'Try a private or incognito window to rule out a stale saved password or an expired session cookie.',
      'Check the network: a corporate VPN or firewall can block the connection the dialer needs even when ordinary web pages load.',
    ],
    escalate:
      'If the password itself is the problem, an administrator can reset it — ask in this channel and ReadySupport can prepare that change for approval.',
  },
  dialer: {
    topic: 'dialer',
    title: 'Ready but not receiving calls',
    steps: [
      'Confirm your status is the one that receives calls, rather than a break or paused state.',
      'Check you are actually assigned to something that has work in it. Being Ready with no assignment means no calls will arrive.',
      'Check whether the assignment you are on has leads available right now — an empty pool looks identical to a broken dialer from the agent side.',
      'Confirm your phone or softphone is connected. Ready status and phone connection are separate things.',
      'If calls connect but drop instantly, that usually points at the phone connection rather than the assignment.',
    ],
    escalate:
      'Ask ReadySupport to check your assignments and status — "am I assigned to anything?" is a question it can answer directly.',
  },
  leads: {
    topic: 'leads',
    title: 'No leads, or the wrong leads',
    steps: [
      'Check which assignments you are on. Receiving the wrong leads is usually an assignment question, not a dialer fault.',
      'If you should only be getting certain states, check your state configuration — ReadySupport can read that back for you.',
      'Check whether the lead source you expect is active. A paused or exhausted source produces silence, not an error.',
    ],
    escalate:
      'Ask ReadySupport to show your current assignments and states; if those look right and there are still no leads, it is a question for whoever manages the lead files.',
  },
  license: {
    topic: 'license',
    title: 'No seat available, or a seat is stuck',
    steps: [
      'A seat can stay held when a session ends badly — a closed laptop lid, a browser crash, or a lost connection rather than a proper sign-out.',
      'Sign out properly rather than just closing the tab, then sign back in.',
      'If a colleague has finished for the day but their seat is still held, that seat can be released.',
    ],
    escalate:
      'Ask ReadySupport to log out inactive users, or to sign out a specific person if you know who is holding the seat. Both need approval before they run.',
  },
  recording: {
    topic: 'recording',
    title: 'Cannot play or download a call recording',
    steps: [
      'Playback and download are usually separate permissions — having one does not mean you have the other.',
      'Check the call is old enough to have finished processing; a recording is not always available the instant a call ends.',
      'Try a different browser tab or window if the player does not load.',
    ],
    escalate:
      'If you should have access and do not, an administrator can check the permission on your account.',
  },
  other: {
    topic: 'other',
    title: 'Something else is not working',
    steps: [
      'Reload the tab, then sign out and back in — this clears a surprising share of transient faults.',
      'Check whether it affects only you or everyone. One person means an account or device problem; everyone means a system problem.',
      'Note exactly what you were doing, what you expected, and what happened instead. That makes it far quicker for someone to help.',
    ],
    escalate: 'Describe the problem in this channel and an administrator can take a look.',
  },
};

/** Picks a topic from free text. Falls back to `other` rather than guessing. */
export function detectTopic(question: string): TroubleshootTopic {
  const text = question.toLowerCase();

  if (/audio|sound|hear|mic|microphone|headset|speaker|muted|static|echo/.test(text)) return 'audio';
  if (/log ?in|login|sign ?in|password|locked out|can'?t get in|access denied/.test(text)) return 'login';
  if (/licen[cs]e|seat|logged in somewhere|stuck session/.test(text)) return 'license';
  if (/recording|playback|listen to (?:the )?call|download (?:the )?call/.test(text)) return 'recording';
  if (/no leads?|wrong leads?|lead pool|not getting leads?|states?/.test(text)) return 'leads';
  if (/dial|calls?|ready|not receiving|no calls?|queue|playlist|assignment/.test(text)) return 'dialer';

  return 'other';
}

export interface TroubleshootingAnswer {
  topic: TroubleshootTopic;
  title: string;
  body: string;
  /** True when the answer came from official documentation rather than here. */
  fromOfficialDocumentation: boolean;
}

const GENERAL_NOTE =
  'These are general checks for any browser-based dialer, not steps from the official Readymode documentation. ' +
  'Once an Owner runs the Help Center sync, ReadySupport will answer from the official articles and cite them.';

export function answerTroubleshooting(
  topic: TroubleshootTopic,
  question: string,
): TroubleshootingAnswer {
  const guide = GUIDES[topic] ?? GUIDES.other;
  const reported = question.trim().slice(0, 160);

  const body = [
    reported ? `You reported: ${reported}` : '',
    guide.title,
    '',
    ...guide.steps.map((stepText, index) => `${index + 1}. ${stepText}`),
    '',
    `If that does not help: ${guide.escalate}`,
    '',
    GENERAL_NOTE,
  ]
    .filter((line, index) => line !== '' || index > 0)
    .join('\n');

  return {
    topic: guide.topic,
    title: guide.title,
    body,
    fromOfficialDocumentation: false,
  };
}

export { answerTroubleshooting as troubleshoot, GENERAL_NOTE };
