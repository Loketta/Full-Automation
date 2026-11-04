# Channel analysis exchange

This directory is the explicit, reviewable handoff point for ChatGPT-assisted channel-style analysis.

`beyond-the-blackwall-analysis.json` is the reviewed result bundled with the application. Full Automation discovers it automatically, but applies it only after its channel ID and dataset fingerprint match the locally imported metadata and the user explicitly approves the preview. That approval persists locally and is not requested again for the same fingerprint.

1. In Full Automation, import the Beyond the Blackwall channel metadata once, then choose **Export metadata for review**.
2. Open the downloaded `beyond-the-blackwall.json` and review it. It contains only the channel ID/name plus imported video IDs, titles, descriptions, tags, durations and publication dates. It contains no OAuth credentials.
3. If you approve sharing that public metadata, manually copy it to `channel-analysis/beyond-the-blackwall.json`, review the Git diff, commit it and push it. Full Automation never writes, commits or pushes this repository file.
4. Ask ChatGPT/Codex to analyse that file and produce a separate schema-version-1 result containing `channelId`, the unchanged `datasetFingerprint`, `report` and `proposedProfile`.
5. Download that result and use **Import reviewed analysis**. Full Automation validates the schema, dataset fingerprint and every cited source video ID, then shows a preview. The saved profile changes only after **Accept proposed profile changes** is separately confirmed.

The exported channel dataset is intentionally not committed. Sharing future exports remains an explicit user decision, and **Import reviewed analysis** remains available for later reviewed results.

The reviewed result must have this shape (all fields are required and unsupported fields are rejected):

```json
{
  "version": 1,
  "channelId": "UCXO7g--zW3kReNXhcZNu_vg",
  "datasetFingerprint": "copy unchanged from the reviewed export",
  "report": {
    "summary": "Readable summary",
    "observedConventions": [{ "category": "titles", "pattern": "Evidence-backed pattern", "sourceVideoIds": ["id-1", "id-2"], "examples": ["Example title"] }],
    "inconsistencies": [{ "issue": "Observed inconsistency", "sourceVideoIds": ["id-1"] }],
    "recommendations": [{ "recommendation": "Clearly labelled recommendation", "rationale": "Reason", "sourceVideoIds": ["id-1"] }]
  },
  "proposedProfile": {
    "compilationTitleTemplate": "{project} — {duration} Mix",
    "individualTrackTitleTemplate": "{track}",
    "universalBranding": { "introduction": "", "footer": "", "callsToAction": [], "recurringLinks": [] },
    "universalTags": [],
    "universalHashtags": [],
    "genreProfiles": [{ "genre": "industrial", "keywords": [], "tags": [], "hashtags": [], "sourceVideoIds": ["id-1"] }]
  }
}
```
