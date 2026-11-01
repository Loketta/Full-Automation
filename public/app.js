import {
  buildPaidGenerationConfirmation,
  configurePlannedTrackMessage,
  generationSnapshot,
  hasUnsavedPlannedTrackChanges,
  plannedTrackDraft,
  showPlannedTrackMessage,
} from "./planned-track-state.js";

const form = document.querySelector("#generate-form");
const prompt = document.querySelector("#prompt");
const button = document.querySelector("#generate-button");
const status = document.querySelector("#status");
const result = document.querySelector("#result");
const player = document.querySelector("#player");
const volume = document.querySelector("#volume");
const volumeValue = document.querySelector("#volume-value");
const download = document.querySelector("#download");
const trackList = document.querySelector("#track-list");
const libraryStatus = document.querySelector("#library-status");
const refreshLibrary = document.querySelector("#refresh-library");
const createProjectForm = document.querySelector("#create-project-form");
const importProjectForm = document.querySelector("#import-project-form");
const projectFile = document.querySelector("#project-file");
const projectStatus = document.querySelector("#project-status");
const projectSelect = document.querySelector("#project-select");
const projectEditor = document.querySelector("#project-editor");
const projectName = document.querySelector("#project-name");
const projectTheme = document.querySelector("#project-theme");
const projectCreated = document.querySelector("#project-created");
const plannedTrackList = document.querySelector("#planned-track-list");
const addPlannedTrackForm = document.querySelector("#add-planned-track-form");
let projects = [];

player.volume = Number(volume.value);
volume.addEventListener("input", () => {
  player.volume = Number(volume.value);
  volumeValue.value = `${Math.round(player.volume * 100)}%`;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (button.disabled) return;

  const approved = window.confirm("This makes one paid Lyria 3.5 request. Generate now?");
  if (!approved) {
    status.textContent = "Generation cancelled. No API request was made.";
    return;
  }

  button.disabled = true;
  prompt.disabled = true;
  result.hidden = true;
  status.textContent = "Generating one track… this may take a few minutes. Please keep this page open.";

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Generation failed.");

    player.src = data.audioUrl;
    download.href = data.audioUrl;
    download.download = data.filename;
    result.hidden = false;
    status.textContent = data.warning || "Track saved locally. Preview it below or download the MP3.";
    await loadLibrary();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    prompt.disabled = false;
  }
});

refreshLibrary.addEventListener("click", loadLibrary);
loadLibrary();
loadProjects();

async function loadLibrary() {
  libraryStatus.textContent = "Loading tracks…";
  try {
    const response = await fetch("/api/tracks");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load the track library.");
    renderTracks(data.tracks);
    libraryStatus.textContent = data.tracks.length
      ? `${data.tracks.length} track${data.tracks.length === 1 ? "" : "s"} saved locally.`
      : "No tracks yet. Generate one above or add MP3 files to the output folder and restart the app.";
  } catch (error) {
    libraryStatus.textContent = error.message;
  }
}

function renderTracks(tracks) {
  trackList.replaceChildren();
  for (const track of tracks) trackList.append(createTrackCard(track));
}

function createTrackCard(track) {
  const card = document.createElement("article");
  card.className = "track-card";

  const title = document.createElement("input");
  title.className = "track-title";
  title.value = track.title;
  title.maxLength = 120;
  title.setAttribute("aria-label", `Title for ${track.title}`);

  const saveTitle = document.createElement("button");
  saveTitle.type = "button";
  saveTitle.className = "secondary compact";
  saveTitle.textContent = "Save title";
  saveTitle.addEventListener("click", async () => {
    await updateTrack(track.id, { title: title.value }, card);
  });

  const statusLabel = document.createElement("label");
  statusLabel.textContent = "Review status";
  const reviewStatus = document.createElement("select");
  for (const value of ["Unreviewed", "Keep", "Reject"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === track.reviewStatus;
    reviewStatus.append(option);
  }
  reviewStatus.addEventListener("change", async () => {
    await updateTrack(track.id, { reviewStatus: reviewStatus.value }, card);
  });
  statusLabel.append(reviewStatus);

  const created = document.createElement("p");
  created.className = "track-meta";
  created.textContent = `Created ${new Date(track.createdAt).toLocaleString()} · ${track.filename}`;

  const promptLabel = document.createElement("p");
  promptLabel.className = "prompt-label";
  promptLabel.textContent = "Original prompt";
  const originalPrompt = document.createElement("p");
  originalPrompt.className = "original-prompt";
  originalPrompt.textContent = track.prompt;

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  audio.volume = 0.5;
  audio.src = `/audio/${encodeURIComponent(track.filename)}`;

  const actions = document.createElement("div");
  actions.className = "track-actions";
  const downloadTrack = document.createElement("a");
  downloadTrack.className = "download compact";
  downloadTrack.href = audio.src;
  downloadTrack.download = track.filename;
  downloadTrack.textContent = "Download";
  const deleteTrack = document.createElement("button");
  deleteTrack.type = "button";
  deleteTrack.className = "danger compact";
  deleteTrack.textContent = "Delete permanently";
  deleteTrack.addEventListener("click", async () => {
    if (!window.confirm(`Permanently delete “${track.title}” and its MP3? This cannot be undone.`)) return;
    const response = await fetch(`/api/tracks/${encodeURIComponent(track.id)}`, { method: "DELETE" });
    const data = await response.json();
    if (response.ok) {
      await loadLibrary();
      if (data.warning) libraryStatus.textContent = data.warning;
      return;
    }
    showCardMessage(card, data.error || "Could not delete track.");
  });
  actions.append(downloadTrack, deleteTrack);

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  titleRow.append(title, saveTitle);
  card.append(titleRow, statusLabel, created, promptLabel, originalPrompt, audio, actions);
  return card;
}

async function updateTrack(id, changes, card) {
  const response = await fetch(`/api/tracks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  const data = await response.json();
  if (!response.ok) return showCardMessage(card, data.error || "Could not update track.");
  showCardMessage(card, "Saved.");
}

function showCardMessage(card, message) {
  let element = card.querySelector(".card-message");
  if (!element) {
    element = document.createElement("p");
    element.className = "card-message";
    card.append(element);
  }
  element.textContent = message;
}

createProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await apiJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.querySelector("#new-project-name").value,
        theme: document.querySelector("#new-project-theme").value,
      }),
    });
    createProjectForm.reset();
    await loadProjects(data.project.id);
    projectStatus.textContent = "Project created locally.";
  } catch (error) {
    projectStatus.textContent = error.message;
  }
});

importProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = projectFile.files[0];
  if (!file) return;
  if (file.size > 128 * 1024) {
    projectStatus.textContent = "Import must be 128 KB or smaller.";
    return;
  }
  try {
    const parsed = JSON.parse(await file.text());
    const data = await apiJson("/api/projects/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    });
    importProjectForm.reset();
    await loadProjects(data.project.id);
    projectStatus.textContent = "Project imported locally. No music was generated.";
  } catch (error) {
    projectStatus.textContent = error instanceof SyntaxError ? `Invalid JSON: ${error.message}` : error.message;
  }
});

projectSelect.addEventListener("change", () => renderSelectedProject(projectSelect.value));

document.querySelector("#save-project").addEventListener("click", async () => {
  if (!projectSelect.value) return;
  try {
    await apiJson(`/api/projects/${encodeURIComponent(projectSelect.value)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName.value, theme: projectTheme.value }),
    });
    await loadProjects(projectSelect.value);
    projectStatus.textContent = "Project details saved.";
  } catch (error) {
    projectStatus.textContent = error.message;
  }
});

document.querySelector("#delete-project").addEventListener("click", async () => {
  const project = projects.find((candidate) => candidate.id === projectSelect.value);
  if (!project) return;
  if (!window.confirm(`Delete project “${project.name}”? Generated MP3s will remain in the Track Library.`)) return;
  try {
    const data = await apiJson(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    await loadProjects();
    projectStatus.textContent = data.message;
  } catch (error) {
    projectStatus.textContent = error.message;
  }
});

addPlannedTrackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!projectSelect.value) return;
  try {
    await apiJson(`/api/projects/${encodeURIComponent(projectSelect.value)}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: document.querySelector("#planned-title").value,
        direction: document.querySelector("#planned-direction").value,
        prompt: document.querySelector("#planned-prompt").value,
      }),
    });
    addPlannedTrackForm.reset();
    await loadProjects(projectSelect.value);
    projectStatus.textContent = "Pending track added.";
  } catch (error) {
    projectStatus.textContent = error.message;
  }
});

async function loadProjects(selectedId = projectSelect.value) {
  try {
    const data = await apiJson("/api/projects");
    projects = data.projects;
    projectSelect.replaceChildren(new Option("Choose a project", ""));
    for (const project of projects) projectSelect.append(new Option(project.name, project.id));
    const nextId = projects.some((project) => project.id === selectedId) ? selectedId : "";
    projectSelect.value = nextId;
    renderSelectedProject(nextId);
  } catch (error) {
    projectStatus.textContent = error.message;
  }
}

function renderSelectedProject(id) {
  const project = projects.find((candidate) => candidate.id === id);
  projectEditor.hidden = !project;
  if (!project) return;
  projectName.value = project.name;
  projectTheme.value = project.theme;
  projectCreated.textContent = `Created ${new Date(project.createdAt).toLocaleString()}`;
  plannedTrackList.replaceChildren();
  project.tracks.forEach((track, index) => plannedTrackList.append(createPlannedTrackCard(project, track, index)));
  if (!project.tracks.length) {
    const empty = document.createElement("p");
    empty.textContent = "No planned tracks yet.";
    plannedTrackList.append(empty);
  }
}

function createPlannedTrackCard(project, track, index) {
  const card = document.createElement("article");
  card.className = "planned-card";
  card.dataset.plannedTrackId = track.id;
  const heading = document.createElement("div");
  heading.className = "library-heading-row";
  const number = document.createElement("strong");
  number.textContent = `${index + 1}. ${track.title}`;
  const badge = document.createElement("span");
  badge.className = "status-badge";
  badge.textContent = track.status;
  heading.append(number, badge);

  const title = field("Title", track.title, "input", 120);
  const direction = field("Musical direction", track.direction, "textarea", 1000);
  const promptField = field("Complete Lyria generation prompt", track.prompt, "textarea", 2000);
  const locked = track.status === "Generated";
  for (const control of [title.control, direction.control, promptField.control]) control.disabled = locked;

  const actions = document.createElement("div");
  actions.className = "track-actions";
  const cardMessage = configurePlannedTrackMessage(document.createElement("p"));
  cardMessage.id = `planned-track-message-${track.id}`;
  if (!locked) {
    const save = actionButton("Save plan", "secondary compact", async () => {
      try {
        await apiJson(`/api/projects/${project.id}/tracks/${track.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.control.value, direction: direction.control.value, prompt: promptField.control.value }),
        });
        await loadProjects(project.id);
        projectStatus.textContent = "Planned track saved.";
      } catch (error) { projectStatus.textContent = error.message; }
    });
    const generate = actionButton("Generate this track", "compact", async () => {
      const draft = plannedTrackDraft(title.control.value, direction.control.value, promptField.control.value);
      if (hasUnsavedPlannedTrackChanges(track, draft)) {
        showPlannedTrackMessage(cardMessage, "Unsaved changes detected. Save this planned track before generating. No paid request was made.");
        return;
      }
      if (!window.confirm(buildPaidGenerationConfirmation(track))) {
        showPlannedTrackMessage(cardMessage, "Generation cancelled. No paid request was made.");
        return;
      }
      generate.disabled = true;
      showPlannedTrackMessage(cardMessage, "Generating one planned track… Keep this page open.");
      try {
        const data = await apiJson(`/api/projects/${project.id}/tracks/${track.id}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expected: generationSnapshot(track) }),
        });
        player.src = data.audioUrl;
        download.href = data.audioUrl;
        download.download = data.filename;
        result.hidden = false;
        await Promise.all([loadProjects(project.id), loadLibrary()]);
        const refreshedMessage = document.getElementById(`planned-track-message-${track.id}`);
        if (refreshedMessage) {
          showPlannedTrackMessage(refreshedMessage, data.warning || "Track generated, linked, and saved in the Track Library.");
        }
      } catch (error) { showPlannedTrackMessage(cardMessage, error.message); }
      finally { generate.disabled = false; }
    });
    actions.append(save, generate);
  }
  const remove = actionButton("Remove from project", "danger compact", async () => {
    const audioNote = locked ? " The generated MP3 will remain in the Track Library." : "";
    if (!window.confirm(`Remove “${track.title}” from this project?${audioNote}`)) return;
    try {
      await apiJson(`/api/projects/${project.id}/tracks/${track.id}`, { method: "DELETE" });
      await loadProjects(project.id);
      projectStatus.textContent = `Planned track removed.${audioNote}`;
    } catch (error) { projectStatus.textContent = error.message; }
  });
  actions.append(remove);
  if (locked) {
    const libraryNote = document.createElement("p");
    libraryNote.textContent = "Generated audio is available in the Track Library below.";
    card.append(heading, title.wrapper, direction.wrapper, promptField.wrapper, libraryNote, actions, cardMessage);
  } else {
    card.append(heading, title.wrapper, direction.wrapper, promptField.wrapper, actions, cardMessage);
  }
  return card;
}

function field(labelText, value, kind, maxLength) {
  const wrapper = document.createElement("label");
  wrapper.textContent = labelText;
  const control = document.createElement(kind);
  control.value = value;
  control.maxLength = maxLength;
  wrapper.append(control);
  return { wrapper, control };
}

function actionButton(text, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.addEventListener("click", handler);
  return button;
}

async function apiJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
