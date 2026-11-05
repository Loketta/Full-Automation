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
  return classifyGenres(project, genreProfiles, track).primary.map((item) => item.profile);
}

export function classifyGenres(project, genreProfiles = [], track) {
  const compilation = !track; const projectSources = [{ source: "project name", text: project?.name, weight: 2 }, { source: "project theme", text: project?.theme, weight: 4 }];
  const selectedTracks = track ? [track] : (project?.tracks ?? []); const trackCount = Math.max(1, selectedTracks.length);
  const trackSources = selectedTracks.flatMap((item) => [{ source: track ? "track title" : `track “${item.title}” direction`, text: track ? item.title : item.direction, weight: track ? 3 : 1.5 / trackCount, trackId: item.id }, { source: track ? "track direction" : `track “${item.title}” prompt`, text: track ? item.direction : item.prompt, weight: track ? 4 : 0.75 / trackCount, trackId: item.id }, ...(track ? [{ source: "track prompt", text: item.prompt, weight: 2, trackId: item.id }] : [])]);
  const sources = [...projectSources, ...trackSources].filter((item) => String(item.text ?? "").trim());
  const ranked = genreProfiles.map((profile, index) => {
    const genre = String(profile.genre).toLowerCase(); const terms = uniqueTerms([genre, ...(profile.keywords ?? []), ...(profile.tags ?? [])]); const evidence = []; const matchedTracks = new Set(); let score = 0; let projectScore = 0;
    for (const source of sources) for (const term of terms) {
      if (!supportedTerm(source.text, term)) continue; const specificity = term === genre ? 3 : term.split(/\s+/).length > 1 ? 1.5 : 1; const points = source.weight * specificity; score += points; if (source.trackId) matchedTracks.add(source.trackId); else projectScore += points; evidence.push({ source: source.source, term, excerpt: evidenceExcerpt(source.text, term), weight: Number(points.toFixed(2)) });
    }
    const prevalence = compilation ? matchedTracks.size / trackCount : matchedTracks.size; const hasGenreEvidence = evidence.some((item) => establishesGenre(item.term, genre)); const sufficientlySupported = hasGenreEvidence && (projectScore >= 3 || (!compilation && score >= 3) || (matchedTracks.size >= 2 && prevalence >= 0.5) || (projectScore > 0 && matchedTracks.size > 0));
    return { profile, genre: profile.genre, score: Number(score.toFixed(2)), projectScore: Number(projectScore.toFixed(2)), prevalence, evidence: dedupeEvidence(evidence), index, sufficientlySupported };
  }).filter((item) => item.sufficientlySupported).sort((a, b) => b.score - a.score || b.projectScore - a.projectScore || a.index - b.index);
  return { primary: ranked.slice(0, 2), influences: ranked.slice(2, 4), omitted: ranked.slice(4), mode: compilation ? "compilation" : "individual" };
}

export function genreLabel(selected, context = {}) { const profiles = selected.map((item) => item.profile ?? item); if (!profiles.length) return "Instrumental"; return profiles.map((item) => publicGenreName(item.genre, context)).join(profiles.length === 2 ? " & " : ""); }

export function buildMetadataCopy({ project, track, classification, durationLabel }) {
  const text = [project?.name, project?.theme, track?.title, track?.direction, track?.prompt].filter(Boolean).join(" "); const clean = listenerSignals(text); const genre = genreLabel(classification.primary, clean);
  const influences = classification.influences.map((item) => publicGenreName(item.genre, clean)); const instrumental = clean.instrumental && genre !== "Instrumental" ? "instrumental " : ""; const duration = !track && /^1 Hour$/i.test(durationLabel ?? "") ? "hour-long " : "";
  const intro = atmosphericIntroduction(clean, stableIndex(`${project?.id ?? project?.name}:${track?.id ?? "compilation"}`, 4));
  const subject = track?.title ?? project?.name; const format = track ? "track" : "compilation"; const identityParts = [`${subject} is ${article(`${duration}${instrumental}${genre}`)} ${duration}${instrumental}${genre.toLowerCase()} ${format}`];
  const characteristics = supportedCharacteristics(clean); if (characteristics.length) identityParts.push(`shaped by ${naturalJoin(characteristics.slice(0, 3))}`); if (influences.length) identityParts.push(`with ${naturalJoin(influences.map((item) => `${item.toLowerCase()} influences`))}`);
  return { introduction: normalizeSentence(intro), identity: normalizeSentence(identityParts.join(", ")), genre, primaryGenres: classification.primary.map(publicGenreEvidence), secondaryInfluences: classification.influences.map(publicGenreEvidence), omittedFields: [!intro ? "atmospheric introduction (insufficient supported scene or mood information)" : "", !characteristics.length ? "distinctive musical characteristics (insufficient support)" : ""].filter(Boolean) };
}
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
export function relevantUses(project, track) { const corpus = withoutNegatedPhrases([project?.theme, track?.direction, track?.prompt].filter(Boolean).join(" ").toLowerCase()); const uses = []; if (/\b(?:tabletop|ttrpg|roleplay|shadowrun)\b/.test(corpus)) uses.push("tabletop sessions"); if (/\b(?:writing|writer|storytelling)\b/.test(corpus) || /\bdystopian writing\b/.test(corpus)) uses.push("science-fiction writing"); if (/\b(?:focus|study|coding|background listening)\b/.test(corpus)) uses.push("focused background listening"); if (/\b(?:gaming|gameplay)\b/.test(corpus)) uses.push("gaming"); return uses; }
export function profileKeywords(selected) { return [...new Set(selected.flatMap((item) => { const profile = item.profile ?? item; const evidenceTerms = new Set((item.evidence ?? []).map((entry) => entry.term)); return [profile.genre, ...(profile.tags ?? []).filter((tag) => evidenceTerms.has(String(tag).toLowerCase()))]; }))]; }
export function profileHashtags(selected) { return [...new Set(selected.flatMap((item) => (item.profile ?? item).hashtags?.slice(0, 1) ?? []))]; }

function variables(template) { return [...String(template).matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]); }
function technical(value) { return /\b(?:bpm|tempo|key|minor|major|synth|bass|percussion|drums?|guitar|arpeggi|sidechain|distort|instrumental|vocals?|master|mix|loop|production|codec|hz|kilohertz)\b/i.test(value) || (value.match(/,/g) ?? []).length > 1; }
function naturalPhrase(value) { const cleaned = String(value).replace(/\b(?:no vocals?|instrumental only)\b.*$/i, "").replace(/^[\s,:-]+|[\s,:-]+$/g, "").trim(); return cleaned ? cleaned[0].toLowerCase() + cleaned.slice(1) : ""; }
function uniqueTerms(values) { return [...new Set(values.map((item) => String(item).toLowerCase().trim()).filter((item) => item.length >= 3))].sort((a, b) => b.length - a.length); }
function establishesGenre(term, genre) { if (term === genre || term.includes(genre)) return true; const aliases = { industrial: /\b(?:techno|darkwave|heavy synth)\b/, synthwave: /\b(?:retrowave|outrun|retro futuristic)\b/, "lo-fi": /\b(?:lo-fi|lofi|study ambience)\b/, metal: /\b(?:metal|rock|punk)\b/, jazz: /\b(?:jazz|lounge)\b/, space: /\b(?:space opera|hyperspace|traveller|sci-fi synth|space)\b/ }; return aliases[genre]?.test(term) ?? term.split(/\s+/).length > 1; }
function supportedTerm(value, term) { const text = String(value).toLowerCase(); const termPattern = term.split(/\s+/).map(escapeRegExp).join("\\s+"); const pattern = new RegExp(`(^|[^a-z0-9])${termPattern}([^a-z0-9]|$)`, "g"); let match; while ((match = pattern.exec(text))) { const before = text.slice(Math.max(0, match.index - 35), match.index); if (!/(?:\bno\b|\bnot\b|\bavoid(?:ing)?\b|\bwithout\b|\bexclude(?:s|d|ing)?\b|\bnever\b)[^.!?;,]{0,24}$/.test(before)) return true; } return false; }
function withoutNegatedPhrases(value) { return String(value).replace(/\b(?:no|not|avoid(?:ing)?|without|exclude(?:s|d|ing)?|never)\b[^.!?;,]{0,40}/gi, " "); }
function evidenceExcerpt(value, term) { const text = String(value).replace(/\s+/g, " ").trim(); const index = text.toLowerCase().indexOf(term); const start = Math.max(0, index - 28); const end = Math.min(text.length, index + term.length + 38); return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`; }
function dedupeEvidence(values) { const seen = new Set(); return values.filter((item) => { const key = `${item.source}:${item.term}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 8); }
function publicGenreEvidence(item) { return { genre: item.profile.genre, score: item.score, evidence: item.evidence }; }
function publicGenreName(genre, context = {}) { const value = String(genre).toLowerCase(); const dark = context.dark ? "Dark " : ""; if (value === "industrial") return `${dark}Industrial`; if (value === "synthwave") return `${context.cyberpunk ? "Cyberpunk " : dark}Synthwave`; if (value === "lo-fi") return `${context.cyberpunk ? "Cyberpunk " : ""}Lo-Fi`; if (value === "space") return "Sci-Fi Space"; return value.replace(/(^|[-\s])\w/g, (letter) => letter.toUpperCase()); }
function listenerSignals(value) { const text = withoutNegatedPhrases(String(value).toLowerCase()); return { text, dark: /\b(?:dark|shadowy|nocturnal)\b/.test(text), cyberpunk: /\bcyberpunk\b/.test(text), atmospheric: /\b(?:atmospheric|ambien(?:t|ce)|immersive)\b/.test(text), tense: /\b(?:tension|tense|suspense)\b/.test(text), dreamy: /\b(?:dreamy|dreamlike|ethereal)\b/.test(text), chill: /\b(?:chill|relaxed|relaxing|mellow)\b/.test(text), mechanical: /\b(?:mechanical|machine|machinery|industrial)\b/.test(text), melodic: /\b(?:melodic|melody|hooks?)\b/.test(text), distorted: /\b(?:distorted|distortion)\b/.test(text), city: /\b(?:city|urban|streets?|megacity)\b/.test(text), neon: /\bneon\b/.test(text), night: /\b(?:night|midnight|afterhours|after-hours)\b/.test(text), space: /\b(?:space|hyperspace|cosmic|starship|galactic)\b/.test(text), dystopian: /\b(?:dystopian|dystopia)\b/.test(text), instrumental: /\binstrumental\b|\bno vocals?\b/.test(String(value).toLowerCase()) };
}
function supportedCharacteristics(signal) { const values = []; if (signal.mechanical) values.push("mechanical rhythms"); if (signal.dark && /\bsynth/.test(signal.text)) values.push("dark synthesizer textures"); if (signal.atmospheric || signal.tense) values.push(signal.tense ? "atmospheric tension" : "atmospheric depth"); if (signal.melodic) values.push("melodic hooks"); if (signal.distorted && /\bbass\b/.test(signal.text)) values.push("distorted bass"); if (signal.dreamy) values.push("dreamlike textures"); return [...new Set(values)]; }
function atmosphericIntroduction(signal, variant) { const texture = supportedCharacteristics(signal); if (signal.city && signal.night) return variant % 2 ? `The city keeps moving after midnight, carried by ${naturalJoin(texture.slice(0, 2).length ? texture.slice(0, 2) : ["dark electronic currents"])}` : `After midnight, ${naturalJoin(texture.slice(0, 2).length ? texture.slice(0, 2) : ["dark electronic currents"])} move through the city`; if (signal.neon && signal.cyberpunk) return `Neon light frames a cyberpunk soundscape of ${naturalJoin(texture.slice(0, 2).length ? texture.slice(0, 2) : ["electronic atmosphere"])}`; if (signal.space) return `Beyond the atmosphere, ${naturalJoin(texture.slice(0, 2).length ? texture.slice(0, 2) : ["science-fiction electronics"])} set the course`; if (signal.dystopian) return `A dystopian soundscape unfolds through ${naturalJoin(texture.slice(0, 2).length ? texture.slice(0, 2) : ["electronic tension"])}`; if (signal.atmospheric || signal.dark || signal.dreamy) return `${variant % 2 ? "An immersive" : "A"} ${signal.dark ? "dark " : signal.dreamy ? "dreamlike " : "atmospheric "}soundscape shaped by ${naturalJoin(texture.slice(0, 2).length ? texture.slice(0, 2) : ["electronic textures"])}`; return ""; }
function stableIndex(value, modulo) { let hash = 0; for (const char of String(value)) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0; return hash % modulo; }
function naturalJoin(values) { return values.length < 2 ? values[0] ?? "" : values.length === 2 ? `${values[0]} and ${values[1]}` : `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`; }
function normalizeSentence(value) { const cleaned = String(value ?? "").replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/([.!?])\1+/g, "$1").replace(/\.+$/g, "").trim(); return cleaned ? `${cleaned[0].toUpperCase()}${cleaned.slice(1)}.` : ""; }
function article(value) { return /^(?:[aeiou]|hour\b)/i.test(String(value).trim()) ? "an" : "a"; }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function validation(message) { const error = new Error(message); error.name = "MetadataTemplateError"; error.statusCode = 400; return error; }
