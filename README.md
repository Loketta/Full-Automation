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

## Controlled batch generation

For a selected project, choose between one and five Pending tracks and click **Generate batch**. The confirmation names the project and tracks and states the exact maximum number of paid requests being authorised. The server verifies the saved project snapshot, preserves project order, and generates one track at a time. It durably saves the MP3, Track Library entry, and project link before starting the next paid request.

The batch stops on its first generation or persistence failure and never retries. **Stop batch** prevents another request from starting after the current request finishes. A batch cannot overlap another batch or a single-track generation, and already-generated tracks are rejected. Batch state is stored in the ignored `output/batches.json`; an unfinished batch is marked Interrupted after a restart and is never resumed automatically. Review the Track Library, project status, and terminal diagnostics manually before authorising any further request after a failed or interrupted batch.

If the batch runner itself exits unexpectedly, the server treats the outcome as uncertain, attempts to persist a terminal failure, and blocks all further paid generation for that server session. If even the failure record cannot be written, the in-memory block remains in place and the browser/API warns that saved batch metadata is not authoritative. Inspect the output folder and metadata before safely restarting; no request is retried or resumed automatically.

## Project review and regeneration

Generated recordings can be played and reviewed directly inside their ordered project track cards. **Unreviewed**, **Keep**, and **Reject** are the same Track Library status, so a change in either view is reflected in both. The project summary reports accepted, rejected, awaiting-review, and not-yet-generated counts.

Only a current recording marked **Reject** shows regeneration controls. Its original generation prompt is prefilled and must be substantively revised; whitespace-only edits are rejected in both the browser and server. Confirmation identifies the exact rejected filename, revised prompt, and one paid request before anything is sent to Lyria. Regeneration uses the same application-wide concurrency and fail-closed batch safeguards and never retries automatically.

Replacement is recoverable: the rejected MP3 remains linked while the new audio and prepared library metadata are saved. The project is then durably switched to the new **Unreviewed** recording before the old MP3 is removed. Prepared and cleanup markers let startup either discard an uncommitted replacement or finish a committed cleanup. An old recording referenced by another planned track is retained. The interface intentionally exposes only the current recording, not version history.

## Test offline

```powershell
npm test
```

Tests use mocked Lyria responses, need no API key, make no network requests, and spend no API credit.

Library tests use temporary folders and cover existing-file imports, idempotent scans, persistence across restart, renaming, review status, deletion, atomic metadata output, and directory traversal protection.

Project tests cover creation, persistence, ordered imports, validation, editing, generated-track linking and recovery, deletion without audio loss, reference reconciliation, and metadata-write failures. All project management and import tests are offline.

Batch tests cover sizes one through five, the server-side limit, saved snapshots and ordering, sequential execution, exact request bounds, stop and failure behaviour, duplicate starts, stale data, persistence failure, and restart interruption. Mock generators are used throughout, so these tests cannot contact Google or incur charges.

Review and regeneration tests cover shared status persistence, progress counts, Reject-only eligibility, client/server prompt comparison, paid confirmation text, exactly-one-call behavior, batch overlap blocking, safe replacement, rollback, shared references, cleanup failure, and restart recovery. All audio generation responses are mocked.

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

This milestone intentionally has no cloud deployment, scheduled generation, GitHub Actions music-generation job, YouTube integration, or recurring automation. GitHub Actions is used only for the offline test suite.
