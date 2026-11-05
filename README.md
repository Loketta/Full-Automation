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

### Full-length compilation videos

The **Compilation Video Assembly** section combines an existing completed WAV from `output/mixes/` with an MP4 loop from `output/visual-assets/`. Choose both files, enter a title, and select **Review assembly plan**. The plan reports both source durations, the expected output duration, fixed 1920 × 1080 H.264/yuv420p video, AAC 320 kbps 48 kHz stereo audio, and the collision-safe destination filename. Rendering starts only after a separate explicit confirmation.

The visual is looped continuously and aspect-ratio fitted inside 1920 × 1080 without stretching. FFmpeg rebuilds a continuous video timeline from decoded frame counts and a continuous audio timeline from sample counts, then uses the probed WAV duration as the explicit output duration. This avoids cumulative MP4 loop-boundary timestamp drift and does not rely on `-shortest` to decide when a long render ends. Before publication, FFprobe verifies the codecs, resolution, pixel format, audio format, and the audio-stream, video-stream, and container durations against the WAV master. A mismatch reports every actual duration and its difference from the WAV. Approved-plan snapshots detect changed source files; private temporary outputs are removed after failures or interrupted restarts; overlapping renders and silent overwrites are rejected. Completed files are atomically published under ignored `output/compilation-videos/` and shown as download links. WAV masters and visual assets are never modified. This workflow is entirely local and does not call Lyria, generate imagery, or upload to YouTube.

## YouTube connection setup

Milestone 7A identifies and binds the exact YouTube channel authorized through Google. Uploads use that stored, reverified channel identity and are always **Private**.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen. For an External app in Testing, add the Google account you will use as a test user.
3. Create an OAuth client with application type **Desktop app**. Google's [installed-app authorization guide](https://developers.google.com/youtube/data/guides/auth/installed-apps) supports loopback IP redirects for Windows, macOS, and Linux desktop clients; do not create a Web, Android, iOS, or Chrome client for this local flow.
4. Copy the Desktop client ID and client secret into the ignored `.env` file:

```dotenv
YOUTUBE_OAUTH_CLIENT_ID=your_client_id.apps.googleusercontent.com
YOUTUBE_OAUTH_CLIENT_SECRET=your_client_secret
```

The default redirect is `http://127.0.0.1:3000/api/youtube/oauth/callback`. A Desktop client accepts this loopback callback. If `PORT` changes, the application automatically uses that port; alternatively set `YOUTUBE_OAUTH_REDIRECT_URI` to the exact loopback callback and ensure the application is opened on the matching origin. Restart after changing `.env`.

Choose **Connect to YouTube** and complete Google's browser authorization. Following Google's [YouTube scope guidance](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps#identify-access-scopes), the requested scopes are only `youtube.readonly` for verified channel identity and `youtube.upload` for a later upload milestone. The broader account-management and deletion-capable scopes are not requested. If the account has several personal or Brand Account channels, select the intended identity in Google's own account/channel chooser. The application does not pretend that an arbitrary channel ID can switch authorization. Use **Reconnect or change channel** to repeat Google's chooser and replace the binding only after the new channel is verified.

The interface displays the authorized channel name, ID, handle, thumbnail, and connection status. Refresh authorization is stored in encrypted form at `output/youtube-credentials.enc`; the encryption key is derived from the client secret in `.env`. Access tokens, refresh tokens, and the client secret are never returned to browser JavaScript or written to logs. Disconnect requires confirmation, attempts Google revocation, and removes the local encrypted credential even if Google already revoked it. Expired or revoked access is shown as requiring reconnection.

Limitation: Google states that refresh tokens for External OAuth consent screens left in **Testing** normally expire after seven days because these YouTube scopes are not basic identity scopes. The application detects that failure and asks you to reconnect. Moving an OAuth app to production can require Google's scope-verification process; keep it in Testing with an allowed test user while developing.

### Private YouTube uploads

The **YouTube Uploads** section lists completed compilation MP4s from the ignored `output/compilation-videos/` directory. Select a file, enter its title, optional description and comma-separated tags, and choose **Review private upload**. The review binds the exact file fingerprint and duration, metadata, and currently verified channel ID. A separate confirmation names the destination channel, source, size, duration, title, and **PRIVATE** visibility before the application creates any YouTube upload session.

Uploads use Google's supported resumable protocol and bounded 8 MiB chunks, so the complete video is not loaded into memory. Progress and the authoritative uploaded-byte offset are persisted atomically in encrypted `output/youtube-upload-records.enc`; OAuth tokens are never stored in an upload record. The server hard-codes `privacyStatus: private`. The browser cannot request Public, Unlisted, scheduled, or automatic publication, and changing the source or authorized channel invalidates approval.

After a restart, an upload with a saved session is marked **Interrupted** and is never resumed automatically. **Resume saved session** explicitly checks the unchanged source, reverified channel, and YouTube's authoritative session offset before sending more bytes; it does not create a replacement session. Expired sessions, completion responses without a video ID, and outcomes that cannot be reconciled stop safely. An uncertain outcome blocks new uploads until it has been investigated manually in YouTube Studio. A completed record shows the YouTube video ID and a user-clicked link; the application never opens or publishes it automatically.

The first upload of a newly configured YouTube API project may remain private because Google applies additional restrictions to unverified API projects. Upload records deliberately prevent uploading the same source fingerprint to the same channel again; this milestone does not provide a duplicate-upload override. It also does not implement editing, replacing, deleting, scheduling, or making videos public.

### Beyond the Blackwall metadata

The **YouTube Metadata** section is restricted to the verified Beyond the Blackwall channel ID `UCXO7g--zW3kReNXhcZNu_vg`. **Import Channel Style** and **Refresh Channel Style** read the authorized channel's uploads playlist, follow every playlist page, and retrieve video snippets and ISO 8601 durations in batches. This follows Google's documented [uploads-playlist workflow](https://developers.google.com/youtube/data/sample_requests#uploaded-videos-and-system-generated-playlists), [pagination model](https://developers.google.com/youtube/data/guides/implementation/pagination), and [video resource fields](https://developers.google.com/youtube/data/reference/rest/v3/videos). Import is read-only and never calls a video update, insert, or delete method.

The initial style analysis is deterministic. It records recurring title suffixes, repeated first/last description sections, tags, hashtags, links, genre terms, thumbnail-host references, and the exact existing video IDs that informed the result. A convention must recur before it is treated as channel style; one video is explicitly reported as insufficient evidence. Edit and save the title templates, reusable sections, links, vocabulary, tags, hashtags, and thumbnail reference locally. The ignored `output/youtube-channel-style.json` file stores imports, the editable profile, reviewed proposals and approved metadata atomically; it never contains OAuth credentials.

For richer analysis, choose **Export metadata for review**. This downloads a versioned JSON file containing only the imported video IDs, titles, descriptions, tags, durations and publication dates, plus a dataset fingerprint. It does not contain OAuth credentials, tokens, API keys, projects, audio, upload records or other application data. No AI API is called.

After reviewing the export, the user may explicitly copy it to `channel-analysis/beyond-the-blackwall.json`, review the Git diff, and commit/push it for ChatGPT/Codex analysis. The application never writes to the repository and never commits or pushes. See [`channel-analysis/README.md`](channel-analysis/README.md) for the handoff workflow.

The repository includes the reviewed Beyond the Blackwall result at `channel-analysis/beyond-the-blackwall-analysis.json`. At startup the server discovers and schema-validates it. Once the matching channel dataset is present, the server verifies its channel ID, exact dataset fingerprint and every cited source video ID, then stages it automatically for browser preview. Existing profile data remains unchanged until **Accept proposed profile changes** is explicitly confirmed. That approval is persisted by dataset fingerprint, so the same bundled profile is not proposed again after restart; unrelated manual fields are preserved.

Use **Import reviewed analysis** for future updates. Manual imports use the same strict validation and preview/approval flow and remain available even when a bundled analysis exists.

### Deterministic metadata generation

Metadata generation uses the accepted channel profile locally; it does not call an AI service. Compilation title templates support `{project}`, `{duration}` and `{genre}`. Individual-track title templates support `{track}`, `{genre}` and `{mood_or_scene}`. Introduction templates support `{project}`, `{track}`, `{genre}` and `{mood_or_scene}`. Unsupported variables are rejected when saving, and a legacy saved template with an unknown or ungrounded variable produces a clear generation error without altering the saved profile.

The generator scores the current project theme, planned-track titles, musical directions and prompts against the six reviewed genre profiles (industrial, synthwave, lo-fi, metal, jazz and space). Compilation analysis considers the complete project; individual-track analysis considers only the selected track plus project-level context, preventing unrelated tracks from leaking genres. It can select up to three profiles in project-text order, uses only their reviewed keywords/tags/hashtags, and falls back to neutral instrumental wording when none match. It never infers vocals, instruments, BPM or a mood absent from saved project data. Scene-setting introductions use only short natural phrases or explicit “music for…” context; technical generation language is not copied into the opening, and an ungrounded optional introduction is omitted with a preview warning.

Compilation descriptions contain a grounded opening, concise style summary, supported listening uses, verified crossfade-aware chapters, optional saved branding/links and a short relevant hashtag footer. Individual-track metadata has a separate workflow based on the exact planned track and linked library recording and never includes compilation chapters. Both workflows produce selected-profile and warning previews, remain editable, and require explicit approval bound to the current project, source, provenance and profile snapshot. Only compilation metadata can be copied into the existing Private Upload workflow.

### Legacy compilation provenance

Compilation planning now reports whether the selected WAV provenance is verified, missing, incomplete or ambiguous before FFmpeg starts. An incomplete plan can still be explicitly rendered, but the confirmation states that automatic YouTube chapters may be unavailable; the resulting MP4 records that diagnostic instead of implying verified chapters.

Use **Recover legacy chapter provenance** to reconstruct an older WAV timeline only when the chosen mix's exact Track Library identities and order, saved crossfades, measured source durations and measured WAV duration agree. The proposed timeline and evidence are previewed and require explicit approval. Recovery is rejected for missing recordings, non-accepted recordings, duration disagreement or duplicate/ambiguous export records. Accepted recovery is appended to the mix export's audit history and never changes the WAV.

An existing MP4 can be associated with a recovered WAV only when a retained MP4 provenance record already names that WAV, its stored fingerprint matches the unchanged file, its duration matches the retained render record, and the WAV now has verified mix provenance. Filename or duration alone is never treated as proof. Association requires a second explicit approval, retains a recovery history and never modifies the MP4.

When no reliable chapter provenance exists, metadata generation still produces a title, description, tags and hashtags for a valid selected MP4 and compatible project/mix selection. Chapters are omitted, no timestamps are guessed, and the preview shows a prominent reason. Known fingerprint, mix, timeline or project conflicts remain hard errors. If provenance is later recovered, the prior no-chapters approval becomes stale and metadata must be regenerated and approved again.

Legacy mixes may also contain recording IDs that older project files never linked. Metadata generation reports each missing ID and available recording title, distinguishes unverified legacy linkage from evidence pointing to another project, and permits a chapterless draft only when MP4 provenance is incomplete and no conflict is known. The optional repair review is offered only when the recording already stores both the selected project ID and an exact planned-track ID; names and durations are never treated as ownership evidence. Applying a reviewed repair changes project metadata only and does not alter recordings, WAVs, MP4s, or prior metadata approvals.

Review-state checks follow the same boundary: verified chapters require every recording to be marked **Keep**. A chapterless draft may proceed with clearly identified missing or **Unreviewed** library state, but never treats that state as accepted; an explicit **Reject** blocks generation until the user deliberately changes the mix or review decision. Recording IDs, available titles, and review evidence are included in the metadata snapshot, so a later review change makes an earlier approval stale.

### Deterministic metadata writing

The metadata writer ranks the six approved genre profiles from saved project or track evidence. Project names and themes carry the most weight for compilations; an isolated term in one track prompt cannot redefine a whole collection. Negated phrases such as `no metal`, `avoid EDM`, and `not orchestral` are excluded. Titles use at most two primary genres, while separately supported influences may appear in the description. The preview lists the evidence term and source behind every selected genre, along with fields omitted because the saved metadata was insufficient.

Listener-facing copy is assembled from a curated set of stable sentence structures. It can translate supported mood, setting, instrumental status, listening purpose, and a small set of musical characteristics, but it does not reproduce full generation prompts. BPM, key, model instructions, negative prompts, production constraints, and unsupported claims are omitted. Output is deterministic for the same saved inputs; it is intentionally conservative and remains editable before approval.

Representative improvements produced by the deterministic writer:

- Industrial: `Industrial Afterhours || industrial / synthwave / metal Mix (1 Hour)` becomes `Industrial Afterhours || Dark Industrial & Cyberpunk Synthwave Mix (1 Hour)`, opening with “The city keeps moving after midnight, carried by mechanical rhythms and dark synthesizer textures.”
- Cyberpunk lo-fi: a generic `lo-fi / synthwave` label becomes `Neon Shallows || Cyberpunk Lo-Fi Mix (1 Hour)`, with a concise neon-city introduction supported by the project theme.
- Sci-fi metal: a slash-separated `metal / space / synthwave` label becomes `Hyperspace Traveller || Metal & Sci-Fi Space Mix (1 Hour)`, while unsupported extra genres are omitted.

Limitations: the writer cannot infer facts absent from project and track metadata, assess audio content, predict SEO performance, or determine audience response. Manually approved branding, links, calls to action, templates, and universal tags remain authoritative and are preserved.

To create metadata, select a Music Project, an Audio Mix, and a completed compilation MP4. New compilation renders atomically record a provenance chain from the MP4 fingerprint to its WAV master, originating mix export snapshot, and retained crossfade timeline. Metadata generation requires that exact chain and rejects an independently selected or modified MP4. Track names come from the project's real accepted planned tracks. The generator validates that the timeline begins at zero, remains within the completed video's duration, matches its recorded render duration, and leaves at least ten seconds for the final chapter. YouTube requires a first timestamp at 00:00, at least three timestamps in ascending order, and chapters of at least ten seconds; the application enforces those [official chapter requirements](https://support.google.com/youtube/answer/9884579).

Generated fields remain editable. **Approve metadata** persists the reviewed title, description and tags against a snapshot of the exact project, mix, style profile, source fingerprint, and chapter timeline. Any relevant change requires regeneration and approval. **Use in Private Upload** only copies the fields into Milestone 7B's form; its independent source/channel snapshot, Private-only policy, duplicate protection, resumable transfer and explicit upload confirmation still apply. Importing, generating, saving, approving, or copying metadata never starts an upload.

Limitations: legacy mix or compilation-video exports do not contain enough durable evidence to prove their relationship. They remain available for playback, download, manual metadata and manual Private upload, but automated chapters fail clearly. Safely re-render the WAV and compilation video with the current application to create authoritative provenance; existing media is never overwritten or deleted. Repository-assisted analysis does not inspect thumbnail pixels, modify the channel, generate final metadata without project data, or start an upload.

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

Compilation-video tests cover source discovery, safe paths, probing, plan snapshots, continuous timestamp construction, explicit WAV-duration termination, fixed output specifications, duration diagnostics, concurrency, collisions, validation, cleanup, downloads, and explicit confirmation. A real offline integration test synthesizes a short WAV and an animation short enough to cross at least 40 loop boundaries, renders through the production pipeline with a test-only source-duration override, and verifies the complete 1080p H.264/AAC output using FFprobe. It skips clearly when FFmpeg or FFprobe is unavailable; CI requires both tools. No test calls a paid API.

YouTube connection tests use mocked OAuth clients and YouTube API responses. They cover authorization scopes and state, refresh credentials, revoked access, encrypted local storage, channel identity and replacement, missing configuration, disconnect/revocation, server credential isolation, and the browser connection workflow. They require no Google account and make no YouTube API call.

YouTube upload tests use a mocked resumable transport and synthetic local files. They cover private-only metadata, channel and source snapshots, bounded chunk streaming, progress, lost responses, server restart and explicit resume, expired and uncertain sessions, duplicate and concurrent upload prevention, encrypted atomic state, failure-state persistence, and the browser confirmation workflow. They create no Google upload session and perform no network request.

YouTube metadata tests use mocked read-only channel, playlist and video responses. They cover channel binding, pagination, deterministic style extraction, insufficient history, atomic profile persistence, crossfade-aware chapter timing and validation, title/description/tag limits, approval invalidation, upload-form handoff, and isolation from upload and Lyria clients.

Channel-analysis tests use saved imported fixtures. They cover credential-free exports, exact dataset matching, strict structured-profile validation, source evidence, malformed responses, proposal isolation, explicit profile acceptance and preservation of manual fields. No automated test contacts an AI provider.

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

This application intentionally has no cloud deployment, scheduled generation, GitHub Actions music-generation job, automatic visual generation, or recurring automation. YouTube uploads are manual, explicitly confirmed, resumable, and hard-coded Private; there is no public/unlisted publishing, scheduling, background start, editing, replacement, or deletion workflow. Local audio mix assembly only combines recordings that already exist in the Track Library. GitHub Actions is used only for the offline test suite.
