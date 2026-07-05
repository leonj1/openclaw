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
