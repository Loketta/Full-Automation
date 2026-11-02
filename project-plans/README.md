# Repository project plans

Codex may add reusable ChatGPT-authored project plans to this directory as individual `.json` files. Keep filenames simple and stable, for example `neon-harbour-v1.json`. Files are version controlled and must use the application's existing version 1 project-import structure.

Each plan must contain only `version`, `name`, `theme`, and `tracks`; each track must contain `title`, `direction`, and `prompt`. Plans support 1–100 tracks and must remain at or below 128 KB. Use `public/examples/project-import-v1.json` and `public/examples/project-import-v1.schema.json` as references, and run `npm test` after adding a plan.

Do not place API keys, generated audio, private output data, or large media here. Adding a file only makes it available in the browser. The user must explicitly choose **Import into Projects**; discovery never generates music or makes a paid request.
