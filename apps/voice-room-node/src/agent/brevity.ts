// Brevity preamble for the Layer 2 turn (folds in the old server-side Layer 3).
//
// The voice-room reply is spoken aloud, so a long answer is a bad experience.
// We prepend a short instruction asking OpenClaw for a 1-2 sentence, plain-text
// spoken answer, then include the user's transcript verbatim. Doing this
// client-side keeps the gateway/agent generic; a later hardening step could
// move it to a server-side session persona (see STEPS.md Layer 3).
export const BREVITY_PREAMBLE =
  "You are answering out loud through a voice speaker. Reply in 1-2 short " +
  "sentences of plain spoken text: no markdown, lists, code blocks, or emoji. " +
  "Here is what the user said:";

// Returns the preamble followed by the user's transcript, preserved verbatim.
export function prependBrevity(transcript: string): string {
  return `${BREVITY_PREAMBLE}\n\n${transcript}`;
}
