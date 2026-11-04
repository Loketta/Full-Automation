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
  const corpus = [project?.theme, project?.name, track?.title, track?.direction, track?.prompt, ...(project?.tracks ?? []).flatMap((item) => [item.title, item.direction, item.prompt])].filter(Boolean).join(" ").toLowerCase();
  return genreProfiles.map((profile, index) => {
    const terms = [profile.genre, ...(profile.keywords ?? []), ...(profile.tags ?? [])].map((item) => String(item).toLowerCase()).filter((item) => item.length >= 3);
    const score = terms.reduce((total, term) => total + (corpus.includes(term) ? (term === String(profile.genre).toLowerCase() ? 4 : 1) : 0), 0);
    const position = corpus.indexOf(String(profile.genre).toLowerCase()); return { profile, score, index, position: position < 0 ? Number.MAX_SAFE_INTEGER : position };
  }).filter((item) => item.score > 0).sort((a, b) => a.position - b.position || b.score - a.score || a.index - b.index).slice(0, 3).map((item) => item.profile);
}

export function genreLabel(selected) { return selected.length ? selected.map((item) => item.genre).join(" / ") : "Instrumental"; }
export function groundedScene(project, track) { const raw = String(track?.direction || project?.theme || "").trim(); if (!raw) return ""; return raw.split(/[.!?]/)[0].replace(/^instrumental\s+/i, "").replace(/\s+music$/i, "").trim(); }
export function relevantUses(project, track) { const corpus = [project?.theme, track?.direction, track?.prompt].filter(Boolean).join(" ").toLowerCase(); const uses = []; if (/tabletop|ttrpg|roleplay|shadowrun/.test(corpus)) uses.push("tabletop sessions"); if (/writ|story|dystopian/.test(corpus)) uses.push("science-fiction writing"); if (/focus|study|coding|background/.test(corpus)) uses.push("focused background listening"); if (/gaming|gameplay|combat/.test(corpus)) uses.push("gaming"); return uses; }
export function profileKeywords(selected) { return [...new Set(selected.flatMap((item) => [...(item.keywords ?? []), ...(item.tags ?? [])]))]; }
export function profileHashtags(selected) { return [...new Set(selected.flatMap((item) => item.hashtags ?? []))]; }

function variables(template) { return [...String(template).matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]); }
function validation(message) { const error = new Error(message); error.name = "MetadataTemplateError"; error.statusCode = 400; return error; }
