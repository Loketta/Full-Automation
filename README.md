# Lyria Local Studio

A deliberately small local Node.js app that generates **one instrumental MP3** with Google's official Lyria 3.5 model when—and only when—you click **Generate** and confirm the paid action.

## Before you start

- Windows 10 or 11
- [Node.js 24 LTS](https://nodejs.org/) (select the option to add Node to `PATH`)
- [Visual Studio Code](https://code.visualstudio.com/)
- A Gemini API key with billing and Lyria access

The app uses Google's official `@google/genai` JavaScript SDK and the Interactions API. It does not make an API call during installation, startup, or tests. Generated Lyria audio contains Google's SynthID watermark.

## Setup in VS Code on Windows

1. Download or clone this repository, then open its folder in VS Code (**File → Open Folder**).
2. Open the VS Code terminal (**Terminal → New Terminal**).
3. Check Node: `node --version` (it should begin with `v24`).
4. Install packages: `npm install`.
5. Copy the example settings: `Copy-Item .env.example .env`.
6. Open `.env` and replace `your_api_key_here` with your Gemini API key. Do not add quotes or share this file.

## Run

In the VS Code terminal:

```powershell
npm start
```

Open <http://127.0.0.1:3000>. Starting the server costs nothing. A paid request happens only after you submit a valid prompt and accept the browser confirmation. The button is disabled while generating, and the app never retries a failed generation automatically.

Your MP3 is saved under the ignored `output/` folder. The result panel lets you play it, lower its playback volume, and download it.

## Test offline

```powershell
npm test
```

Tests use mocked Lyria responses, need no API key, make no network requests, and spend no API credit.

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

Implementation checked against Google's official [Lyria 3.5 music generation guide](https://ai.google.dev/gemini-api/docs/music-generation): model `lyria-3.5`, `client.interactions.create(...)`, text `input`, `response_format: { type: "audio" }`, and base64 MP3 data from `interaction.output_audio.data`.

## Scope

This milestone intentionally has no cloud deployment, scheduled generation, GitHub Actions music-generation job, YouTube integration, or recurring automation. GitHub Actions is used only for the offline test suite.
