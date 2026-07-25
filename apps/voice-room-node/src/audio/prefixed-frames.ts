// Frame prefix helper: yields a PCM clip followed by the rest of a source
// async iterator. Used to feed the verification clip as the start of the
// full utterance so the user doesn't have to repeat "Hey Jarvis".

export function prefixedFrames(
  clipPcm: Buffer,
  source: AsyncIterableIterator<Buffer>,
): AsyncIterableIterator<Buffer> {
  let clipYielded = false;

  return {
    [Symbol.asyncIterator]() {
      return this;
    },

    async next(): Promise<IteratorResult<Buffer>> {
      if (!clipYielded) {
        clipYielded = true;
        if (clipPcm.length > 0) {
          return { value: clipPcm, done: false };
        }
      }
      return source.next();
    },
  };
}
