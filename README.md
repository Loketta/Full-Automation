# Lyria Local Studio

A deliberately small local Node.js app that generates **one instrumental MP3** with Google's official Lyria 3.5 model when—and only when—you click **Generate** and confirm the paid action.

## Before you start

- Windows 10 or 11
- [Node.js 24 LTS](https://nodejs.org/) (select the option to add Node to `PATH`)
- [Visual Studio Code](https://code.visualstudio.com/)
- A Gemini API key with billing and Lyria access

The app uses Google's official `@google/genai` 2.x JavaScript SDK and the current Interactions API `steps` schema. It does not make an API call during installation, startup, or tests. Generated Lyria audio contains Google's SynthID watermark.

## Setup in VS Code on Windows

1. Download or clone this repository, then open its folder in VS Code (**File → Open Folder**).
2. Open the VS Code terminal (**Terminal → New Terminal**).
3. Check Node: `node --version` (it should begin with `v24`).
4. Install packages: `npm install`.
5. Copy the example settings: `Copy-Item .env.example .env`.
6. Open `.env` and replace `your_api_key_here` with your Gemini API key. Do not add quotes or share this file.

### Updating an existing installation

Stop the server, keep your existing `.env` and `output/` folder in place, pull the latest `main`, and run `npm ci`. Then start the app with `npm start`. Neither `.env` nor `output/` is tracked by Git, and the startup import reads existing MP3s without rewriting them. An optional copy of the `output/` folder is still sensible before any software update.

For a Windows ZIP installation, stop the server and back up `.env` plus the complete `output/` directory. Extract the new ZIP to a separate folder, copy your existing `.env` and `output/` into that folder without replacing them with example or empty files, run `npm ci`, and start the new copy. Keep the backup until the library, projects, and media appear normally.

## Run

In the VS Code terminal:

```powershell
npm start
```

Open <http://127.0.0.1:3000>. Starting the server costs nothing. A paid request happens only after you submit a valid prompt and accept the browser confirmation. The button is disabled while generating, and the app never retries a failed generation automatically.

Your MP3 is saved under the ignored `output/` folder. The result panel lets you play it, lower its playback volume, and download it.

## Local track library

The library loads automatically at startup and keeps its metadata in `output/library.json`. Generated tracks are registered with their prompt, creation date, title, and an **Unreviewed**, **Keep**, or **Reject** status. You can rename, review, play, download, or permanently delete tracks in the browser.

On startup, existing top-level `.mp3` files in `output/` are imported without changing their audio. Imported tracks receive a title based on the filename and an “original prompt unavailable” note. Repeated starts do not create duplicates. Metadata updates use a temporary file and atomic rename to avoid partially written JSON.

Deletion requires browser confirmation and removes the MP3 plus its metadata. During deletion, audio is first moved to a private recovery filename inside `output/`; metadata is then committed before the recovery file is removed. A failed metadata write restores the MP3, while interrupted rollback or cleanup is recovered on the next startup. The server accepts only plain `.mp3` filenames that resolve directly inside `output/`; it will not delete paths outside that folder.

## Themed music projects

Projects organise an overarching musical theme and an ordered list of planned tracks. Each plan stores a title, musical direction, complete Lyria prompt, Pending/Generated status, and a link to its generated Track Library entry. Project metadata is stored locally in the ignored `output/projects.json` file and survives restarts.

You can create projects manually or import a JSON plan prepared by ChatGPT. Import is local parsing only: it makes no AI or Lyria request. Review and edit every pending title and prompt, then save the plan before choosing **Generate this track**. Generation is blocked while any title, direction, or prompt edit is unsaved. The confirmation displays the exact saved title and full prompt, and the server verifies that snapshot again before making the normal one-request/no-retry paid call. Deleting a project or planned-track record never deletes its generated MP3.

### Project import schema, version 1

Imports must be valid UTF-8 JSON no larger than 128 KB, with 1–100 tracks. Project names are 1–100 characters, themes 1–2,000, track titles 1–120, directions 1–1,000, and prompts 10–2,000 characters.

```json
{
  "version": 1,
  "name": "Night City — Total Warfare",
  "theme": "Aggressive instrumental cyberpunk industrial techno.",
  "tracks": [
    {
      "title": "Chrome Requiem",
      "direction": "Relentless mechanical percussion and distorted bass.",
      "prompt": "Instrumental cyberpunk industrial techno with mechanical percussion and distorted bass. No vocals."
    }
  ]
}
```

The browser includes a downloadable complete example at `public/examples/project-import-v1.json` and a formal JSON Schema at `public/examples/project-import-v1.schema.json`.

### Repository project plans

Codex can add reusable version 1 JSON plans directly under the tracked `project-plans/` directory. The server discovers only safe, direct `.json` files in that directory, validates them with the same limits and rules as manual imports, and lists them under **Available Project Plans**. Invalid plans are shown with a safe validation message and do not prevent startup.

Choose **Import as New Project** to create a separate project with the plan's ordered Pending tracks. Choose **Append to Existing Project** to select a destination, review a server-validated summary, and explicitly confirm that the plan's tracks should be added after its current tracks. Appending preserves the destination's ID, name, theme, creation date, existing track IDs and order, prompts, recording links, review statuses, Track Library metadata, and MP3 files. Every appended track starts Pending with no recording.

Discovery, new-project import, and append are local file operations: they do not call Lyria, generate music, execute a batch, modify audio, or incur charges. Append approval binds the exact plan fingerprint and current target-project snapshot; if either changes, the browser must request and confirm a fresh summary.

The filename is the stable plan identifier and a SHA-256 content fingerprint identifies its version. Exact versions cannot be imported twice while their imported project exists, or appended twice to the same target. If the repository file changes, the browser marks a revised version as available without overwriting earlier projects or edits. Revisions are never imported or appended automatically and require a new explicit confirmation. New-project and append history is durably recorded in ignored `output/project-plan-imports.json`; each target project also stores its appended plan-version markers atomically with the new tracks so a history-write failure cannot make a retry duplicate them. If an imported-as-new project is deleted, the same version becomes explicitly reimportable.

## Controlled batch generation

For a selected project, choose between one and five Pending tracks and click **Generate batch**. The confirmation names the project and tracks and states the exact maximum number of paid requests being authorised. The server verifies the saved project snapshot, preserves project order, and generates one track at a time. It durably saves the MP3, Track Library entry, and project link before starting the next paid request.

The batch stops on its first generation or persistence failure and never retries. **Stop batch** prevents another request from starting after the current request finishes. A batch cannot overlap another batch or a single-track generation, and already-generated tracks are rejected. Batch state is stored in the ignored `output/batches.json`; an unfinished batch is marked Interrupted after a restart and is never resumed automatically. Review the Track Library, project status, and terminal diagnostics manually before authorising any further request after a failed or interrupted batch.

If the batch runner itself exits unexpectedly, the server treats the outcome as uncertain, attempts to persist a terminal failure, and blocks all further paid generation for that server session. If even the failure record cannot be written, the in-memory block remains in place and the browser/API warns that saved batch metadata is not authoritative. Inspect the output folder and metadata before safely restarting; no request is retried or resumed automatically.

## Project review and regeneration

Generated recordings can be played and reviewed directly inside their ordered project track cards. **Unreviewed**, **Keep**, and **Reject** are the same Track Library status, so a change in either view is reflected in both. The project summary reports accepted, rejected, awaiting-review, and not-yet-generated counts.

Only a current recording marked **Reject** shows regeneration controls. Its original generation prompt is prefilled and must be substantively revised; whitespace-only edits are rejected in both the browser and server. Confirmation identifies the exact rejected filename, revised prompt, and one paid request before anything is sent to Lyria. Regeneration uses the same application-wide concurrency and fail-closed batch safeguards and never retries automatically.

Replacement is recoverable: the rejected MP3 remains linked while the new audio and prepared library metadata are saved. The project is then durably switched to the new **Unreviewed** recording before the old MP3 is removed. Prepared and cleanup markers let startup either discard an uncommitted replacement or finish a committed cleanup. An old recording referenced by another planned track is retained. The interface intentionally exposes only the current recording, not version history.

## Local video assembly

Video export uses a local FFmpeg installation. It does not generate music, call Google, or upload anything. On Windows, download a trusted Windows build linked from [ffmpeg.org](https://ffmpeg.org/download.html), extract it to a permanent folder, and verify it in a new terminal:

```powershell
ffmpeg -version
```

If `ffmpeg` is not on `PATH`, add its executable location to `.env` and restart the app:

```dotenv
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe
FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe
```

The app never downloads or installs FFmpeg or FFprobe. Both executables are required: FFprobe validates the source streams and private rendered file before an export is published. If either configured executable is missing, the browser displays a setup error while the rest of the application remains available.

Copy the approved 12-second Harbour Docks master into the ignored `output/visual-assets/` directory, for example `output/visual-assets/harbour-docks-master.mp4`. Keep the original 1672 × 942 MP4 there; it is not committed to Git and is never modified. The directory is created automatically on startup.

In the Track Library, choose **Create video**, select the animation, and review the recording, animation, and intended output filename. Confirm explicitly to run FFmpeg. The animation loops until the complete MP3 finishes; output uses H.264, AAC, `yuv420p`, aspect-ratio-preserving even dimensions, and `+faststart`. Before publication, FFprobe confirms both output streams, codecs, expected dimensions, and a duration closely matching the complete source audio. Completed files are stored under `output/videos/` and appear as download links. Existing exports are never overwritten, and invalid or interrupted `.rendering-…` files are removed.

## Local audio mix assembly

The **Audio Mix Assembly** section builds long-form WAV masters entirely on the local machine. Add recordings directly from the filterable Track Library list, or select a Music Project and choose **Add All Accepted** to append only its Keep recordings in planned-track order. Already-included recordings are marked and cannot be added twice. Arrange the mix order, enter a title, and choose a global crossfade from 0–20 seconds (8 seconds by default). Drafts are saved in ignored `output/mixes.json`, can be reopened after a restart, and never alter the source MP3 files.

FFprobe supplies actual durations for the recording list and a live summary showing source time, crossfade overlap, estimated final duration, and the exact shortfall. The calculation is `sum of source durations − sum of adjacent overlaps`; a crossfade must be shorter than both adjacent recordings. **Review mix plan** shows these details even when the mix is too short. Production mixes must be strictly longer than 60 minutes (3,600 seconds) after all overlaps, and only a qualifying review receives the server snapshot that enables rendering. Aim for approximately 62 minutes of source material when practical so transitions do not reduce the finished mix below 60 minutes. Changing the draft or any source file invalidates that authorization and requires a new review.

After explicit confirmation, FFmpeg renders sequentially with equal-power crossfades (`qsin`) or clean concatenation when the duration is zero. The master is 24-bit PCM WAV, 48 kHz, stereo. FFprobe validates its codec, sample rate, channel count, duration, and minimum length before it is atomically published under ignored `output/mixes/`. Incomplete private temporary files are cleaned up, renders cannot overlap, existing exports are never overwritten, and completed masters appear as download links.

Audio mixing uses the same `FFMPEG_PATH` and `FFPROBE_PATH` settings described above. Missing recordings, invalid media, crossfades that are too long, stale plans, failed renders, and failed validation are reported without modifying the original MP3s. No mix action calls Lyria, generates music, or uploads media.

## Test offline

```powershell
npm test
```

Tests use mocked Lyria responses, need no API key, make no network requests, and spend no API credit.

Library tests use temporary folders and cover existing-file imports, idempotent scans, persistence across restart, renaming, review status, deletion, atomic metadata output, and directory traversal protection.

Project tests cover creation, persistence, ordered imports, validation, editing, generated-track linking and recovery, deletion without audio loss, reference reconciliation, and metadata-write failures. All project management and import tests are offline.

Repository-plan tests cover discovery, existing-schema validation, malformed and oversized files, path and symlink safety, ordered imports, duplicate protection, durable history, revised plans, deletion and explicit reimport, and API isolation from paid generation.

Batch tests cover sizes one through five, the server-side limit, saved snapshots and ordering, sequential execution, exact request bounds, stop and failure behaviour, duplicate starts, stale data, persistence failure, and restart interruption. Mock generators are used throughout, so these tests cannot contact Google or incur charges.

Review and regeneration tests cover shared status persistence, progress counts, Reject-only eligibility, client/server prompt comparison, paid confirmation text, exactly-one-call behavior, batch overlap blocking, safe replacement, rollback, shared references, cleanup failure, and restart recovery. All audio generation responses are mocked.

Most video tests use a mocked process runner. A real offline integration test uses FFmpeg to synthesize a shorter animation and longer audio, runs the production assembly pipeline, and uses FFprobe to verify looping, H.264/AAC streams, dimensions, and complete-audio duration. It skips with an explicit reason when either tool is unavailable locally; GitHub Actions installs both tools and requires the test to run. Tests never generate music or make paid requests.

Mix tests cover saved and reopened drafts, ordering, duration calculations, crossfade validation, stale approvals, path and filename safety, collision handling, failures, interrupted temporary-file cleanup, and download behavior. A separate real offline integration test synthesizes short MP3 inputs, exercises the actual FFmpeg mix pipeline with an isolated test-only minimum-duration override, then uses FFprobe to verify 24-bit PCM, 48 kHz stereo output and the expected crossfaded duration. Production code always enforces a finished duration strictly greater than 60 minutes.

## GitHub Actions tests

GitHub automatically runs the full offline test suite for every pull request targeting `main` and every push to `main`. The workflow uses Node.js 24, installs the locked dependencies with `npm ci`, and runs `npm test` on an Ubuntu runner.

The workflow has read-only repository access and is not given a Gemini API key. The test suite injects mocked Lyria clients instead of creating a real Google client, so it cannot request music or incur generation charges.

To view a run, open the repository's **Actions** tab and select **Tests**, or open a pull request and check its **Checks** section.

## Troubleshooting

- **Missing key:** confirm the file is named exactly `.env` and contains `GEMINI_API_KEY=...`.
- **401/403:** verify the key, billing, and that the account can use Lyria 3.5.
- **429:** wait before deliberately clicking Generate again. The app does not retry for you.
- **No audio:** keep the error visible and try again only if you choose to spend another request.

When generation fails, the browser shows a safe, actionable summary. The VS Code terminal shows a more detailed diagnostic containing only selected fields such as HTTP status, Google error code, sanitized message, and request ID. API keys and authentication headers are redacted, and the raw error object is never logged. Share the terminal diagnostic—not your `.env` file—when asking for help.

API keys remain server-side. Error messages shown in the browser are sanitized and never include the key or raw provider response.

## Verified API contract

Implementation checked against Google's official [Lyria 3.5 music generation guide](https://ai.google.dev/gemini-api/docs/music-generation) and [Interactions breaking-changes guide](https://ai.google.dev/gemini-api/docs/interactions-breaking-changes-may-2026): model `lyria-3.5`, `@google/genai` 2.x, `client.interactions.create(...)`, text `input`, `response_format: { type: "audio" }`, and base64 MP3 data in an audio content block under a `model_output` step.

## Scope

This application intentionally has no cloud deployment, scheduled generation, GitHub Actions music-generation job, YouTube OAuth/upload, automatic visual generation, or recurring automation. Local audio mix assembly only combines recordings that already exist in the Track Library. GitHub Actions is used only for the offline test suite.
