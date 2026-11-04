export const COMPILATION_TEMPLATE_VARIABLES = ["project", "duration", "genre"];
export const TRACK_TEMPLATE_VARIABLES = ["track", "genre", "mood_or_scene"];
export const DESCRIPTION_TEMPLATE_VARIABLES = ["project", "track", "genre", "mood_or_scene"];

export function validateTemplate(template, allowed, field) {
  const value = String(template ?? "").trim();
  for (const variable of variables(value)) if (!allowed.includes(variable)) throw validation(`${field} contains unsupported template variable {${variable}}. Supported variables: ${allowed.map((item) => `{${item}}`).join(", ")}.`);
  return value;
}

export function renderTemplate(template, values, allowed, field) {
  validateTemplate(template, allowed, field);
  const missing = []; const rendered = String(template).replace(/\{([^{}]+)\}/g, (_match, key) => { const value = allowed.includes(key) ? String(values[key] ?? "").trim() : ""; if (!value) missing.push(key); return value; }).replace(/\s+/g, " ").replace(/\s+([,.)])/g, "$1").trim();
  if (missing.length) throw validation(`${field} requires ${[...new Set(missing)].map((item) => `{${item}}`).join(", ")}, but the selected project does not provide grounded information for it.`);
  if (/\{[^{}]+\}/.test(rendered)) throw validation(`${field} contains an unresolved template variable.`);
  return rendered;
}

export function selectGenreProfiles(project, genreProfiles = [], track) {
  const trackMetadata = track ? [track.title, track.direction, track.prompt] : (project?.tracks ?? []).flatMap((item) => [item.title, item.direction, item.prompt]);
  const corpus = [project?.theme, project?.name, ...trackMetadata].filter(Boolean).join(" ").toLowerCase();
  return genreProfiles.map((profile, index) => {
    const terms = [profile.genre, ...(profile.keywords ?? []), ...(profile.tags ?? [])].map((item) => String(item).toLowerCase()).filter((item) => item.length >= 3);
    const score = terms.reduce((total, term) => total + (corpus.includes(term) ? (term === String(profile.genre).toLowerCase() ? 4 : 1) : 0), 0);
    const position = corpus.indexOf(String(profile.genre).toLowerCase()); return { profile, score, index, position: position < 0 ? Number.MAX_SAFE_INTEGER : position };
  }).filter((item) => item.score > 0).sort((a, b) => a.position - b.position || b.score - a.score || a.index - b.index).slice(0, 3).map((item) => item.profile);
}

export function genreLabel(selected) { return selected.length ? selected.map((item) => item.genre).join(" / ") : "Instrumental"; }
export function groundedScene(project, track) {
  const values = [track?.direction, project?.theme].map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  for (const raw of values) {
    const explicit = /\b(?:music|soundtrack|ambience|score)\s+for\s+([^.!?;]{3,80})/i.exec(raw) ?? /\b(?:set\s+in|during|inside|within)\s+([^.!?;]{3,80})/i.exec(raw);
    if (explicit) return naturalPhrase(explicit[1]);
    const sentence = raw.split(/[.!?;]/)[0].trim();
    if (sentence.length >= 3 && sentence.length <= 70 && !technical(sentence)) return naturalPhrase(sentence);
  }
  return "";
}
export function renderOptionalTemplate(template, values, allowed, field) { validateTemplate(template, allowed, field); const required = variables(template); const missing = required.filter((key) => !String(values[key] ?? "").trim()); if (missing.length) return { text: "", warning: `${field} was omitted because ${[...new Set(missing)].map((key) => `{${key}}`).join(", ")} could not be grounded in the saved metadata.` }; return { text: renderTemplate(template, values, allowed, field), warning: "" }; }
export function relevantUses(project, track) { const corpus = [project?.theme, track?.direction, track?.prompt].filter(Boolean).join(" ").toLowerCase(); const uses = []; if (/tabletop|ttrpg|roleplay|shadowrun/.test(corpus)) uses.push("tabletop sessions"); if (/writ|story|dystopian/.test(corpus)) uses.push("science-fiction writing"); if (/focus|study|coding|background/.test(corpus)) uses.push("focused background listening"); if (/gaming|gameplay|combat/.test(corpus)) uses.push("gaming"); return uses; }
export function profileKeywords(selected) { return [...new Set(selected.flatMap((item) => [...(item.keywords ?? []), ...(item.tags ?? [])]))]; }
export function profileHashtags(selected) { return [...new Set(selected.flatMap((item) => item.hashtags ?? []))]; }

function variables(template) { return [...String(template).matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]); }
function technical(value) { return /\b(?:bpm|tempo|key|minor|major|synth|bass|percussion|drums?|guitar|arpeggi|sidechain|distort|instrumental|vocals?|master|mix|loop|production|codec|hz|kilohertz)\b/i.test(value) || (value.match(/,/g) ?? []).length > 1; }
function naturalPhrase(value) { const cleaned = String(value).replace(/\b(?:no vocals?|instrumental only)\b.*$/i, "").replace(/^[\s,:-]+|[\s,:-]+$/g, "").trim(); return cleaned ? cleaned[0].toLowerCase() + cleaned.slice(1) : ""; }
function validation(message) { const error = new Error(message); error.name = "MetadataTemplateError"; error.statusCode = 400; return error; }
