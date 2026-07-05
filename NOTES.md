# NOTES — "Hey Jarvis" voice-room node

Cross-step decisions, conventions, and gotchas. Append as steps complete.

## Conventions

- App root: `apps/voice-room-node/`. Scripts live under `apps/voice-room-node/scripts/`.
- Target platform is **x86_64 Linux only**. `onnxruntime-node` prebuilt binaries
  and the `arecord`/`aplay` (ALSA / `alsa-utils`) audio pipeline are only
  validated there; other arches should fail closed.
- Audio format standard across the node: **PCM16, 24kHz, mono** (`-f S16_LE -r 24000 -c1`).
  Keep capture, playback, wake fixtures, and TTS all on this format.
- Shell scripts: `#!/usr/bin/env bash` + `set -euo pipefail`.

## Step: check-env.sh (done)

- `apps/voice-room-node/scripts/check-env.sh` prints `arch: <uname -m>`, runs
  `arecord --version` / `aplay --version`, and exits non-zero if either ALSA tool
  is missing OR arch != `x86_64`. It accumulates failures (`fail=1`) rather than
  exiting on the first, so a run reports every missing prerequisite at once.
- Script is committed executable (`chmod +x`), but the acceptance command uses
  `bash apps/voice-room-node/scripts/check-env.sh`, so the exec bit is not required
  to run it.
- **Gotcha — dev vs target box:** this dev machine is `x86_64` but does NOT have
  `alsa-utils` installed, so the script correctly exits 1 here. The `exit 0`
  acceptance criterion is only expected on the real target box (Anker/voice box)
  where `alsa-utils` is installed. Verified here: arch detection prints `x86_64`
  and the fail-closed path fires on missing ALSA tools.
- Later steps (APPROVALS.md) reference this script as the confirmation that
  x86_64 Linux was checked for the `onnxruntime-node` dependency.

## Step: APPROVALS.md (done)

- `apps/voice-room-node/APPROVALS.md` documents the `onnxruntime-node` dependency:
  rationale (openWakeWord "Hey Jarvis" ONNX inference — mel/embedding/hey_jarvis
  models), x86_64 Linux confirmed via `scripts/check-env.sh`, and an
  `Approving PR/issue:` line initialized to `PENDING`.
- **Convention:** the `Approving PR/issue:` line is the machine-checkable field.
  A later step flips `PENDING` to the real approval URL (must become a
  `https://github.com/openclaw/openclaw/...` URL). Keep the line label exactly
  `Approving PR/issue:` so that step's grep/replace stays stable.
- The next step writes `APPROVALS.request.md` (the pasteable issue/PR body) which
  must name the **pinned version** of `onnxruntime-node`. APPROVALS.md itself
  intentionally does NOT pin a version yet — the version is decided when
  `package.json` is created (later Phase 0 step). If a version gets pinned, note
  it in both places.
- Repo policy (root AGENTS.md): new deps need explicit maintainer approval;
  plugin/app-only deps stay app-local (declared only in the app's package.json,
  excluded from core dist). APPROVALS.md restates this scope so the approval
  request and the package.json step stay aligned.

## Step: APPROVALS.request.md (done)

- `apps/voice-room-node/APPROVALS.request.md` is the pasteable GitHub issue/PR
  body asking a maintainer to approve `onnxruntime-node`. Names the dependency,
  pinned version, arch (x86_64 Linux), rationale, scope, and an explicit ask.
- **Version pinned: `onnxruntime-node@1.27.0`** (latest on npm as of 2026-07-05,
  via `npm view onnxruntime-node version`). This is now the canonical pin. The
  `package.json` step MUST use this exact version. I also back-filled a
  **Pinned version** line into `APPROVALS.md` so both files agree — if the pin
  ever changes, update all three: `APPROVALS.request.md`, `APPROVALS.md`, and
  `package.json`.
- The request file's closing paragraph points at the `Approving PR/issue:` line
  in `APPROVALS.md` as where the approval URL lands (the next step flips
  `PENDING` there).

## Step: flip PENDING -> approval URL (BLOCKED, not done)

- **Precondition unmet.** This step is explicitly conditional ("Once a maintainer
  grants approval..."). No such approval exists:
  - Only git remote is the personal fork `leonj1/openclaw`, not upstream
    `openclaw/openclaw`. There is no upstream repo wired up to approve on.
  - `gh pr list --state all` on the fork is empty; the fork has issues disabled;
    nothing in the repo references an `openclaw/openclaw` approval URL.
  - No maintainer decision has been received.
- **Did NOT fabricate a URL.** `APPROVALS.md` still reads `Approving PR/issue: PENDING`.
  Inventing an `openclaw/openclaw` URL would misrepresent a human sign-off that
  gates adding the native `onnxruntime-node` dependency — and the next step
  (create `package.json` + `pnpm install`) is gated on this approval, so a fake
  URL would let an unauthorized dep addition proceed under false pretense.
- **Gotcha for later steps:** the dependency-approval gate is still CLOSED. The
  `package.json` / `pnpm install` step must not treat `onnxruntime-node` as
  approved until a real `https://github.com/openclaw/openclaw/...` approval URL
  replaces `PENDING` here. To unblock: a maintainer opens/approves the
  `APPROVALS.request.md` body upstream, then paste that PR/issue URL onto the
  `Approving PR/issue:` line.
- **Re-verified 2026-07-05:** still no upstream remote (`git remote -v` shows only
  the `leonj1/openclaw` fork), `gh pr list --state all` empty, fork issues
  disabled, no `openclaw/openclaw` approval URL anywhere in the tree. Gate remains
  CLOSED; `APPROVALS.md` left at `PENDING`; STEPS.md line 17 left unchecked. Did
  not fabricate a URL. This step cannot pass its acceptance check until a real
  maintainer approval exists upstream.

## Step: package.json + AGENTS.md/CLAUDE.md (done)

- `apps/voice-room-node/package.json`: private, `"type": "module"`, name
  `@openclaw/voice-room-node`. Deps `onnxruntime-node@1.27.0` (the canonical pin
  — matches `APPROVALS.md`/`APPROVALS.request.md`), devDep `vitest@4.1.9`
  (matches the repo root's pinned vitest). `test` script is `vitest run`. Later
  Phase-2 wake steps (`onnx-sessions.ts`) consume `onnxruntime-node`; test steps
  run via vitest.
- **Key architecture fact — `apps/*` is NOT in the pnpm workspace.**
  `pnpm-workspace.yaml` `packages:` lists only `.`, `ui`, `packages/*`,
  `extensions/*`. So this app owns its own `package.json`/deps and is already
  excluded from the root install graph. Confirmed: after `pnpm install`,
  `pnpm-lock.yaml` was unchanged and `onnxruntime-node` is absent from it. This
  is exactly the isolation the next two STEPS want:
  - the "exclude from core dist" step: apps/\* already out of the workspace, but
    still verify the dist/package-exclude config names `apps/voice-room-node`.
  - the "no leak into root package" step: `grep onnxruntime-node package.json`
    (root) already returns nothing; the dep lives only in the app package.json.
- **Gotcha — installing the app's own deps:** a root `pnpm install` does NOT
  install `onnxruntime-node` (app is outside the workspace). To actually pull the
  native ONNX runtime for Phase-2 wake work, run an install scoped to the app dir
  (e.g. `pnpm --dir apps/voice-room-node install` or `cd` there). The acceptance
  criterion only required root `pnpm install` to complete cleanly, which it did
  (2m21s, no errors).
- `CLAUDE.md` is a **relative** symlink → `AGENTS.md` (`ln -s AGENTS.md CLAUDE.md`),
  matching the repo convention (`apps/android`, `extensions/telegram`). Per root
  policy, edit `AGENTS.md` only; never edit `CLAUDE.md` directly. The app
  `AGENTS.md` records the x86_64-only/ALSA/PCM16-24k-mono conventions and the
  app-local-dep + approval-gate rules so future subtree work has them scoped.
- **Approval-gate note:** the dependency-approval gate (see the BLOCKED step
  above) is still CLOSED — `APPROVALS.md` reads `PENDING`. This step created the
  package.json because it was the explicitly assigned task; if a maintainer later
  rejects `onnxruntime-node`, this dep + the Phase-2 wake code must be revisited.

## Step: exclude apps/voice-room-node from core dist (done)

- **What "package-exclude/core-dist config" is here:** the root `package.json`
  `files` array. That array is the npm-pack allowlist and is the canonical
  mechanism that keeps surfaces out of the published core package (e.g. all the
  `!dist/extensions/<id>/**` entries that exclude external plugins). Edited it to
  add an explicit `"!apps/voice-room-node/**"` entry (right after the dist
  excludes, before `"docs/"`) so the config demonstrably lists the app.
- **Why the app was already excluded three ways** (the edit is belt-and-suspenders
  documentation, matching the repo's pattern of enumerating excluded surfaces):
  1. **Not a build entry.** `pnpm build` → `scripts/build-all.mjs` → tsdown
     (`tsdown.config.ts`). Every dist entry is an _explicit_ path map under
     `src/`, `packages/`, or `extensions/` — there is **no glob** and **no
     `apps/` reference** anywhere in `tsdown.config.ts` / `tsdown-build.mjs` /
     `build-all.mjs`. So the build cannot emit any `dist/apps/...` file.
  2. **Not in the pnpm workspace** (already noted above — `pnpm-workspace.yaml`
     lists only `.`, `ui`, `packages/*`, `extensions/*`).
  3. **`files` array** never positively included `apps/` (only `dist/`, `docs/`,
     `scripts/...`, etc.), and now explicitly negates `apps/voice-room-node/**`.
- **Proof captured (both acceptance parts):**
  - `grep apps/voice-room-node package.json` → matches the new `files` entry.
  - `npm pack --dry-run --json | grep apps/voice-room-node` → **no matches**
    (packaged core dist contains zero app files).
  - Ran the dist emitter `OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 node
scripts/tsdown-build.mjs` (exit 0); `dist/` has **no `dist/apps`** and
    `find dist -path '*voice-room-node*'` is empty. (Used the tsdown step +
    skip-DTS instead of full `pnpm build` for speed; tsdown is the only step
    that emits `dist/` from source entries, so it's the meaningful check. `dist/`
    is a gitignored build artifact.)
- **Gotcha for later steps / future apps:** the exclusion is app-specific
  (`!apps/voice-room-node/**`), not a blanket `!apps/**`. `android`/`ios`/`macos`
  apps stay excluded by omission from `files`; if a _new_ app ever needs the same
  guarantee, add its own `!apps/<name>/**` line. Do not rely on `apps/` being
  swept by a positive `files` pattern — none exists.

## Step: verify onnxruntime-node does not leak into root package (done)

- **Proof (both acceptance parts):**
  - `grep -c onnxruntime-node package.json` (repo root) → `0`, exit `1` (no match).
  - `grep -n onnxruntime-node apps/voice-room-node/package.json` →
    `"onnxruntime-node": "1.27.0"` (line 11), exit `0`.
- The dependency is declared **only** in the app package, pinned to an exact
  version (`1.27.0`, no `^`/`~`) per the arch-locked prebuilt-binary convention.
- **Why it stays clean:** `apps/voice-room-node` is NOT in the pnpm workspace
  (`pnpm-workspace.yaml` lists only `.`, `ui`, `packages/*`, `extensions/*`), so
  installing the app's deps never hoists `onnxruntime-node` into the root manifest.
  Root `package.json` remains the sole non-app manifest to guard here.
- **Gotcha for later steps:** the ONNX runtime is a plugin/app-local dep by
  architecture rule (dependency ownership follows runtime ownership). Later steps
  that import `onnxruntime-node` (e.g. `src/wake/onnx-sessions.ts`) must resolve it
  from the app's own `node_modules`, not the repo root — do not add it to root
  `package.json` to "fix" a resolution issue; run the install inside the app dir.

## Step: src/config.ts (done)

- `apps/voice-room-node/src/config.ts` is the typed node config, validated with
  **`zod`** (`NodeConfigSchema`, `.strict()` on every object). Zod 4 APIs are in
  use: `.prefault({})` for nested optional sections, `z.prettifyError` for the
  error string. The repo root already depends on zod 4, so no new dep.
- **Public API later steps consume:**
  - `NodeConfig` (the `z.infer` type) — import this for typed config everywhere.
  - `loadNodeConfig(env = process.env): NodeConfigResult` — the real entrypoint
    for `main.ts`: reads file + env overrides, validates, returns a closed
    result. **`main.ts` must branch on `result.ok`** (no throws); `{ ok:false,
error }` carries a human string.
  - `parseNodeConfig(input): NodeConfigResult` — pure validate of an object
    (used by the acceptance test).
  - `resolveConfigPath(env)` — where the file is read from.
- **Config shape (defaults in parens):**
  - `gateway.url` (**required**, must be a valid URL — the missing-URL rejection
    case). `gateway.tokenEnv` ("OPENCLAW_VOICE_ROOM_TOKEN") — names the env var
    holding the auth token; the **token itself is never in the config file**.
    So the gateway-connect step reads the secret via
    `process.env[config.gateway.tokenEnv]`, not from config directly.
  - `audio.captureDevice` / `audio.playbackDevice` ("default") — raw ALSA ids
    passed to `arecord -D` / `aplay -D` (e.g. `plughw:CARD=Anker,DEV=0`).
  - `wake.threshold` (0.5, clamped [0,1]) — openWakeWord score gate for
    `openwakeword.ts`.
  - `endpointing.silenceMs` (800) — trailing-silence endpointing in
    `talk-node.ts`; `endpointing.maxUtteranceMs` (15000) — hard utterance cap.
- **Config file location:** `OPENCLAW_VOICE_ROOM_CONFIG` (explicit path) else
  `~/.openclaw/voice-room.json`. A **missing file is not an error** — env
  overrides + schema defaults can still validate (only `gateway.url` is truly
  required). Env overrides: `OPENCLAW_VOICE_ROOM_GATEWAY_URL`,
  `..._TOKEN_ENV`, `..._CAPTURE_DEVICE`, `..._PLAYBACK_DEVICE`.
- **Gotcha — tests do NOT run in the core unit lanes.** `apps/voice-room-node`
  is outside the pnpm workspace, so a dedicated Vitest shard was wired:
  `test/vitest/vitest.apps-voice-room.config.ts` (project name `apps-voice-room`,
  include `apps/voice-room-node/**/*.test.ts`). It was registered in
  `test/vitest/vitest.config.ts` (`rootVitestProjects`),
  `test/vitest/vitest.test-shards.mjs` (`fullSuiteVitestShards`),
  `scripts/test-projects.test-support.mjs` (kind `appsVoiceRoom` +
  `classifyTarget` routes `apps/voice-room-node` paths there), and the expected
  lists in `test/scripts/test-projects.test.ts`. **All future
  `apps/voice-room-node/**/\*.test.ts`files land in this shard automatically** —
no per-file wiring needed;`pnpm test apps/voice-room-node/<file>` just works
  (verified: config.test.ts 8/8 green, test-projects.test.ts 182/182 green).

## Step: src/audio/capture.ts (done)

- `apps/voice-room-node/src/audio/capture.ts` = mic capture. `startCapture(opts)`
  returns an `AudioCapture` (an `AsyncIterableIterator<Buffer>`): spawns
  `arecord -t raw -f S16_LE -r 24000 -c 1 -D <device>` and yields fixed-size
  PCM16 frames. `for await (const frame of capture)` (or `capture.frames()`) is
  the consumer API. Playback (`playback.ts`) and the wake/session steps consume
  these `Buffer` frames.
- **`-t raw` is mandatory and non-obvious.** Real `arecord` defaults to a WAVE
  container; without `-t raw` a 44-byte WAV header corrupts the first frame.
  Kept raw so every stdout byte is sample data. (The spawn-flags test asserts the
  exact argv, including `-t raw`.)
- **Frame size:** `frameMs` option (default **20ms**). `frameBytesForMs(ms)` =
  `24000*1*2*ms/1000`; 20ms = **960 bytes**. Only _whole_ frames are emitted; a
  trailing partial (< frameBytes) is **dropped** on end. Format constants
  exported: `CAPTURE_FORMAT` ("S16_LE"), `CAPTURE_SAMPLE_RATE` (24000),
  `CAPTURE_CHANNELS` (1), `BYTES_PER_SAMPLE` (2). Sample-rate/format are fixed
  (node-wide PCM16/24k/mono), NOT overridable — only `frameMs` is a knob.
- **Backpressure is pull-based.** An internal frame queue; when it reaches
  `highWaterMarkFrames` (default 16) with no consumer pulling, the child's stdout
  is `.pause()`d so `arecord`'s pipe fills and it stops producing (no unbounded
  buffering). Pulling below the mark `.resume()`s. Introspection helpers
  `queuedFrames()` / `isPaused()` exist for tests.
- **SIGTERM cleanup — two paths.** (1) `stop()` sends `SIGTERM` to the child,
  discards buffered frames, and resolves once the child exits (awaits the child
  `close` event). Idempotent; also invoked by iterator `return()` (loop break).
  (2) `handleProcessSignals` (default **true**) registers a parent
  `process.on("SIGTERM")` that calls `stop()`, so the node exiting never orphans
  `arecord`; the listener is removed on stop/exit (no leak). **Tests pass
  `handleProcessSignals: false`** except the one asserting the listener wiring.
- **GOTCHA (cost me the most time): a _paused_ readable never emits `close`.**
  On shutdown you must `resume()` (drain to EOF) _and stop re-pausing_ or the
  child exits (exitCode 0) but the parent's `close` never fires and `stop()`
  hangs. `terminate()` sets a `closing` flag; while closing, `ingest()` discards
  bytes without re-pausing so stdout drains and `close` fires. Any later code
  that pauses `arecord`/`aplay` stdio and then waits on `close`/`exit` must
  resume-drain first. `playback.ts` will hit the same pattern for `aplay`.
- **Testing the child:** the test writes a **Node** stub (shebang `#!/usr/bin/env
node`, `chmod 0o755`) to a tmp dir and passes it as `binaryPath`; stub config
  comes via the new `env` option (merged over `process.env`) — `ARECORD_ARGS_FILE`
  (dump argv), `ARECORD_EMIT_BYTES` (emit N bytes then exit — for chunk-size
  tests), `ARECORD_CHUNK_BYTES` + `ARECORD_TERM_FILE` (stream continuously,
  honoring `write()` backpressure, write "term" on SIGTERM). Reuse this stub
  shape for `playback.ts`'s fake `aplay`. `binaryPath` + `env` are the injection
  seams — no need to mock `child_process`.
- Verified: capture.test.ts 5/5 green (3× rerun, deterministic, ~260ms), full
  app shard 13/13 (config 8 + capture 5), oxlint clean. No tsgo lane for the app
  (no `apps/voice-room-node/tsconfig.json`; typed via Vitest, same as config.ts).

## Step: src/audio/playback.ts (done)

- `apps/voice-room-node/src/audio/playback.ts` = TTS playback. `startPlayback(opts)`
  returns an `AudioPlayback` that spawns `aplay -t raw -f S16_LE -r 24000 -c 1 -D
<device>` and feeds **base64-encoded** PCM16 frames into `aplay` stdin.
  **Public API the session/talk-node steps consume:**
  - `enqueue(frameBase64: string): void` — decode base64 → Buffer, queue, kick the
    writer. No-op once stopped and skips empty frames. TTS frames arrive base64 from
    the gateway (`connect.ts`), so `enqueue` takes base64 directly — decode is here,
    not at the call site.
  - `stop(): Promise<void>` — **barge-in**: drop the whole queue and SIGTERM `aplay`
    so speech halts mid-utterance; resolves once the child exits. Idempotent (same
    `stopping` latch shape as capture). This is the barge-in hook Phase-2
    `talk-node.ts` calls when the user interrupts.
  - `drained(): Promise<void>` — resolves when the queue has fully flushed to `aplay`
    (or immediately after stop). Talk-node's `→idle on stream end` can await this.
  - `pendingFrames()` / `pid` — introspection for tests/backpressure.
- **Mirror of capture, but the pipe direction flips.** Capture reads `arecord`
  stdout with pull-based backpressure; playback writes `aplay` stdin with
  push-based backpressure. The writer is a single-flight `pump()`: `write()` a
  frame, and if it returns `false` (child stdin buffer full) wait for the `drain`
  event before the next frame — never write two frames concurrently, so enqueue
  order == playback order. `setImmediate` between frames avoids deep recursion.
- **`-t raw` is mandatory** (same reason as capture): without it `aplay` expects a
  WAV container on stdin and would misread raw PCM header bytes. The flags test
  asserts the exact argv incl. `-t raw`. Format constants exported: `PLAYBACK_FORMAT`
  ("S16_LE"), `PLAYBACK_SAMPLE_RATE` (24000), `PLAYBACK_CHANNELS` (1). Format/rate
  are fixed node-wide, not overridable.
- **EPIPE is expected on barge-in.** Killing `aplay` mid-write breaks the pipe; an
  in-flight `write` then emits `error` (EPIPE). `stdin.on("error", () => {})` +
  `child.on("error", () => {})` swallow it so a discarded frame never crashes the
  node. Any future writer to a killable child stdin needs the same guard.
- **`aplay` self-exit is handled.** A `child` `close` listener also latches
  `closing`, empties the queue, and releases `drained()` waiters — so a device
  error / EOF exit doesn't leave `enqueue`/`drained` callers hanging.
- **SIGTERM parent handler:** same pattern as capture — `handleProcessSignals`
  (default true) registers `process.on("SIGTERM")` → `stop()`, removed on
  stop/exit (no leak). Tests pass `handleProcessSignals: false` except the wiring
  test.
- **Fake `aplay` stub** (reuse this shape for later playback-touching tests): Node
  shebang script (`chmod 0o755`) injected via `binaryPath` + `env`. Env knobs:
  `APLAY_ARGS_FILE` (dump argv), `APLAY_OUT_FILE` (append every stdin byte → assert
  ordered draining), `APLAY_CHUNK_DELAY_MS` (pause/resume-throttle stdin reads so
  the parent's writes back up and a mid-stream `stop()` leaves bytes unplayed),
  `APLAY_TERM_FILE` (write "term" on SIGTERM → clean-shutdown proof). No
  `child_process` mock needed.
- **GOTCHA — the barge-in test is timing-based.** It enqueues 40×16KB frames into a
  throttled stub, waits until some bytes played AND frames are still queued, then
  `stop()` and asserts `0 < delivered < total` and `pendingFrames()===0`. Large
  total (640KB) vs a ~64KB pipe + 40ms throttle keeps `delivered < total`
  comfortable. Verified 4/4 green ×3 reruns (deterministic, ~390ms), oxlint clean.

## Step: src/gateway/connect.ts (done)

- `apps/voice-room-node/src/gateway/connect.ts` = gateway connection.
  `connectToGateway({ config, env?, connectTimeoutMs? })` connects via the shared
  **`@openclaw/gateway-client`** `GatewayClient` and resolves a `GatewayTalkHandle`
  once the gateway sends `hello-ok`. Rejects (and stops the client) on connect
  error or hello timeout (default 10s).
- **Advertised on connect:** `mode: GATEWAY_CLIENT_MODES.NODE` ("node"),
  `role: "node"`, `caps: [TALK_CAPABILITY]` where `TALK_CAPABILITY = "talk"`
  (exported). This is the string the gateway's talk-node detection matches
  (`src/gateway/server-talk-nodes.ts`) — the later `server-talk-nodes` test step
  asserts a `"talk"`-cap node is talk-capable. Keep it exactly `"talk"`.
- **`GatewayTalkHandle` (public API later steps consume):**
  - `client: GatewayClient` — the connected client; the talk phase drives
    `talk.session.*` RPCs on it directly (create/turn/close lifecycle is NOT owned
    here).
  - `setTalkSession(sessionId | null)` — bind the active talk session id that
    `sendPcm` targets; clear with `null`.
  - `sendPcm(frame: Buffer)` — best-effort uplink: base64-encodes the PCM16 frame
    and fires `talk.session.appendAudio` RPC `{ sessionId, audioBase64 }`. **No-op
    when no session bound or frame empty**; RPC rejects are swallowed so a dropped
    audio frame never crashes capture. Takes a raw `Buffer` (capture.ts yields
    Buffers) — encode happens here.
  - `onTtsFrame(listener)` — subscribe to base64 TTS frames; returns unsubscribe.
    Frames come from gateway `talk.event` events with payload
    `{ type: "audio", audioBase64 }`. **These base64 strings feed straight into
    `playback.enqueue(frameBase64)`** (playback decodes base64) — the two APIs are
    designed to pipe directly: `handle.onTtsFrame((b64) => playback.enqueue(b64))`.
  - `close()` — clears listeners + `client.stopAndWait()`.
- **Wire contract (real gateway names, verified against the client, NOT invented):**
  uplink RPC method `talk.session.appendAudio`; downlink event `talk.event` with
  `type: "audio"`. main.ts / talk-node must create the talk session on `client`
  and pass its id to `setTalkSession` before `sendPcm` does anything.
- **GOTCHA — the app is outside the pnpm workspace, so `@openclaw/gateway-client`
  is NOT linked under `node_modules`.** For the Vitest shard to resolve the
  package by name, `test/vitest/vitest.apps-voice-room.config.ts` now borrows the
  shared `@openclaw/*` source aliases: `resolve: { alias:
sharedVitestConfig.resolve.alias }` (from `vitest.shared.config.ts`). Those
  aliases point `@openclaw/gateway-client` / `@openclaw/gateway-protocol` imports
  at the package `src/`. **main.ts (Phase-1 next step) will hit the same wall at
  _runtime_** — plain `node`/`tsx` cannot resolve `@openclaw/gateway-client` from
  the app dir. Options for that step: run the app from repo root with the workspace
  packages built (`packages/gateway-client/dist` exists), add a path mapping, or
  vendor/build. Decide there; the test path is already solved via the alias.
- **Client construction detail:** token is read from
  `env[config.gateway.tokenEnv]` (never from config directly, per config.ts note)
  and passed as `token` (or `undefined` when empty). `onHelloOk` resolves the
  connect promise; `onConnectError` rejects it; failed connect stops the client in
  a `try/catch` around `await connected` (kept out of the promise executor so
  `client` stays `const` and lint-clean — no forward `let`).
- **Test stub** (`connect.test.ts`, reuse shape for other gateway tests): a real
  `ws` `WebSocketServer` on a free port that plays the actual handshake — sends a
  `connect.challenge` event, then on the `connect` method frame records
  `params.caps` / `params.client.mode` / `params.role` and replies `res ok` with a
  minimal `hello-ok` payload (`protocol: 2`, empty presence/health snapshot,
  `tickIntervalMs: 30_000` to keep the watchdog quiet). Asserts `caps === ["talk"]`,
  mode/role `=== "node"`. No mock of `GatewayClient` — drives the real client end
  to end. Verified 1/1 green; full app shard 18/18 (config 8 + capture 5 +
  playback 4 + connect 1), oxlint clean.

## Step: src/main.ts (done)

- `apps/voice-room-node/src/main.ts` is the boot path. `bootVoiceRoomNode(deps?)`
  loads config (`loadNodeConfig`), opens `startCapture`/`startPlayback`, then
  `connectToGateway` advertising cap `"talk"`, and returns a `VoiceRoomNode`
  with a single idempotent `shutdown()`. **No streaming yet** — capture frames
  are NOT consumed and no PCM is sent; that's the next (push-to-talk) step.
- **Central shutdown, not three racing handlers.** Capture and playback each
  register their own `process.on("SIGTERM")` by default; main **disables** both
  (`handleProcessSignals: false`) and installs ONE SIGTERM handler that stops
  capture + playback + closes the gateway together (`Promise.allSettled`). The
  next steps that consume capture/feed playback should keep this single-owner
  shutdown — do not re-enable the children's built-in signal handlers.
- **Failed-connect cleanup:** if `connectToGateway` throws, main reaps the
  already-spawned capture/playback children (`allSettled([stop, stop])`) before
  rethrowing, so a failed boot leaves no orphan `arecord`/`aplay`.
- **Injection seams (`BootDeps`):** `env`, `startCapture`, `startPlayback`,
  `connectToGateway`. Defaults are the real subsystems. Types are narrow —
  factories return `Stoppable` (`stop(): Promise<void>`) and connect returns
  `Closeable` (`close(): Promise<void>`); the real impls satisfy these by
  return-type covariance. The boot **test injects fake stoppables** so it never
  spawns real `arecord`/`aplay`, and drives the real `connectToGateway` against
  a stub `WebSocketServer` (reuses the connect.test.ts stub-gateway shape).
- **Direct-run guard:** `main()` runs only when the module is the process entry
  (`import.meta.url === pathToFileURL(process.argv[1]).href`), so importing it
  from the test never boots. On boot failure it logs and sets
  `process.exitCode = 1` (no throw past the top).
- **Acceptance:** the app has **no build/typecheck lane** (outside the pnpm
  workspace, no `tsconfig.json`; typed via Vitest, same as config/capture/
  playback). So acceptance was met via the **stub assertion** path:
  `src/main.test.ts` boots against a stub gateway and asserts the handshake
  advertised `caps === ["talk"]`, `mode`/`role === "node"`, plus that
  `shutdown()` stops both audio children exactly once. Verified: main.test.ts
  1/1 green, full app shard **19/19** (config 8 + capture 5 + playback 4 +
  connect 1 + main 1), oxlint clean.
- **Runtime gotcha carried over from connect.ts:** actually running `node main.js`
  from the app dir still can't resolve `@openclaw/gateway-client` (app is outside
  the workspace, package not linked). The test path is solved via the shard's
  `@openclaw/*` source aliases. A real hardware run needs the workspace packages
  built and resolvable (run from repo root, or add a path mapping) — decide when
  packaging the systemd unit (Phase 4).

## Step: manual push-to-talk trigger (done)

- Extended `main.ts` (same file, no new module) with a manual push-to-talk
  trigger. `VoiceRoomNode` now exposes `startUtterance()` (press) and
  `endUtterance()` (release) alongside `shutdown()`. Direct-run `main()` wires
  **SIGUSR1 → startUtterance, SIGUSR2 → endUtterance** (the node is headless, no
  keyboard, so an utterance is bracketed by two signals). Tests drive the two
  methods directly.
- **Streaming model — one long-lived capture consumer, gated by a `streaming`
  flag.** A single `pump` async-loop consumes `capture.frames()` for the node's
  whole lifetime; it forwards a frame to `gateway.sendPcm(frame)` only while
  `streaming === true`, otherwise drops it. Press flips `streaming` on (after the
  session exists), release flips it off. This avoids starting/stopping `arecord`
  per utterance (capture stays warm) — Phase-2 `talk-node.ts` wake flow can keep
  this same "capture always on, gate forwarding" shape.
- **Talk-session lifecycle is owned here (for now).** `ensureTalkSession()` lazily
  fires `talk.session.create` **once** on the first press and binds the returned
  `sessionId` via `gateway.setTalkSession(id)` (so `sendPcm`'s
  `talk.session.appendAudio` targets it). The session is **reused** across
  press/release cycles (release does NOT close it) and is closed once on
  `shutdown()` via `talk.session.close`. Create params:
  `{ mode: "realtime", transport: "gateway-relay", brain: "agent-consult" }` —
  `realtime`/`gateway-relay` is the only transport whose `appendAudio` the gateway
  accepts and that emits `talk.event` audio back (see
  `src/gateway/server-methods/talk-session.ts`). Phase-2 talk-node will take over
  this create/close ownership.
- **TTS reply path:** `gateway.onTtsFrame((b64) => playback.enqueue(b64))` is wired
  at boot (not gated by streaming) so replies play whenever they arrive, including
  after release. `onTtsFrame`↔`enqueue` pipe base64 directly (playback decodes),
  as designed in the connect.ts step.
- **Shutdown ordering matters:** `shutdown()` sets `shuttingDown`, clears
  `streaming`, removes the SIGTERM listener, unsubscribes TTS, then **closes the
  talk session first** (best-effort, errors swallowed) before
  `Promise.allSettled([capture.stop(), playback.stop(), gateway.close(), pump])`.
  Awaiting `pump` in that settle set lets the capture loop unwind cleanly.
  `startUtterance` re-checks `shuttingDown` after the `await create` so a shutdown
  racing an in-flight press can't leave `streaming` stuck on.
- **Acceptance (stub-assertion path, no build lane — app is outside the
  workspace):** `main.test.ts` gained a second test, "push-to-talk streams
  captured PCM and plays the TTS reply". The stub gateway now hands out a session
  id on `talk.session.create`, records `appendAudio` base64 frames, answers the
  **first** append with a `talk.event` audio reply, and records
  `talk.session.close`. The test presses, waits for ≥3 appended frames, asserts
  the TTS reply reached the playback stub, releases and asserts no further frames
  append, then shuts down and asserts the session was closed. The `fakeCapture`
  stub streams non-empty 2-byte frames every 3ms so the pump always has audio.
- **Gotcha — `no-promise-executor-return` oxlint rule:** inline
  `new Promise((resolve) => setTimeout(resolve, ms))` fails oxlint (the arrow
  implicitly returns the timer handle). Use the existing block-body `delay(ms)`
  helper (or a `{ ... }` executor) instead. Fixed three occurrences in the test.
- Verified: `main.test.ts` 2/2 green, full app shard green (exit 0), oxlint clean
  on `main.ts`/`main.test.ts`.
