import { describe, expect, it } from "vitest";
import { BREVITY_PREAMBLE, prependBrevity } from "./brevity.ts";

describe("prependBrevity", () => {
  it("prefixes the preamble before the transcript", () => {
    const out = prependBrevity("what's the date");
    expect(out.startsWith(BREVITY_PREAMBLE)).toBe(true);
  });

  it("asks for a short plain-text spoken answer", () => {
    expect(BREVITY_PREAMBLE).toMatch(/1-2 short sentences/);
    expect(BREVITY_PREAMBLE.toLowerCase()).toContain("spoken");
  });

  it("preserves the original transcript verbatim", () => {
    const transcript = "Tell me about the OpenClaw gateway.\nSecond line — keep it?";
    const out = prependBrevity(transcript);
    expect(out.endsWith(transcript)).toBe(true);
    // The transcript substring appears unchanged (no trimming/rewriting).
    expect(out).toContain(transcript);
  });
});
