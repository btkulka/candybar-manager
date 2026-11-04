// What Ben tells Ask Claude about himself the first time it opens, and the
// prompt that tunes Claude's answers to it. Plain data, no Node: the window
// renders the questions from here and the Ask job turns the answers into text.
// Claude's memory still loads as usual; this is added on top of it.

import type { ClaudeProfile } from '../../types';

type Question<K extends keyof Omit<ClaudeProfile, 'answeredAt'>> = {
  key: K;
  question: string;
  options: Array<{ value: NonNullable<ClaudeProfile[K]>; label: string; hint: string; prompt: string }>;
};

export const PROFILE_QUESTIONS: [Question<'techSavvy'>, Question<'rekordbox'>, Question<'gear'>] = [
  {
    key: 'techSavvy',
    question: 'How tech-savvy are you?',
    options: [
      { value: 'simple', label: 'Keep it simple', hint: 'Plain words and clicks, please',
        prompt: 'Not technical: use plain words, point to buttons and screens in Track Lab, and leave out file paths, formats and jargon unless asked.' },
      { value: 'comfortable', label: 'Comfortable', hint: 'Fine with folders and file types',
        prompt: 'Comfortable with computers: file names, folders and formats are fine; skip terminal commands unless asked.' },
      { value: 'technical', label: 'Very', hint: 'Show me paths, logs and details',
        prompt: 'Technical: be precise and brief, and include paths, formats, sample rates, logs and commands where they help.' },
    ],
  },
  {
    key: 'rekordbox',
    question: 'How familiar are you with Rekordbox?',
    options: [
      { value: 'new', label: 'New to it', hint: 'Still learning the basics',
        prompt: 'New to Rekordbox: name the menu and button for anything you suggest there, and explain terms like collection, hot cue, beatgrid and export.' },
      { value: 'regular', label: 'I use it for gigs', hint: 'Playlists, cues, USB exports',
        prompt: 'Uses Rekordbox regularly: knows playlists, cues and USB exports; explain only the less common corners.' },
      { value: 'expert', label: 'Inside out', hint: 'Library, XML, the lot',
        prompt: 'Knows Rekordbox inside out, including the collection database and XML: talk to them as a peer.' },
    ],
  },
  {
    key: 'gear',
    question: 'What do you play on?',
    options: [
      { value: 'usb', label: 'CDJs or an XDJ, from USB', hint: 'Club gear, exported sticks',
        prompt: 'Plays from USB on Pioneer CDJs or an XDJ: file formats, USB exports and what the players will read matter in every answer.' },
      { value: 'controller', label: 'A controller and laptop', hint: 'Rekordbox plays the files',
        prompt: 'Plays on a controller with Rekordbox on the laptop: USB exports and player compatibility matter less than the library itself.' },
      { value: 'both', label: 'Both', hint: 'Laptop at home, USB at gigs',
        prompt: 'Plays both on a controller and from USB on CDJs/XDJs: keep USB and player compatibility in mind.' },
      { value: 'none', label: 'Not playing out yet', hint: 'Building the library',
        prompt: 'Not playing out yet, building their library: favour collecting and organising over gig-specific advice.' },
    ],
  },
];

/** The answers as instructions for Claude, or '' when there are none. */
export function profilePrompt(profile: ClaudeProfile | null | undefined): string {
  if (!profile) return '';
  const lines = PROFILE_QUESTIONS.flatMap((q) => {
    const answer = (q.options as Array<{ value: string; prompt: string }>).find((o) => o.value === profile[q.key]);
    return answer ? [`- ${answer.prompt}`] : [];
  });
  if (!lines.length) return '';
  return [
    'About the person you are talking with (they told Track Lab this when they first opened Ask Claude).',
    'Fit how you explain things to it, without mentioning it:',
    ...lines,
  ].join('\n');
}
