import {
  buildPaidGenerationConfirmation,
  configurePlannedTrackMessage,
  generationSnapshot,
  hasUnsavedPlannedTrackChanges,
  plannedTrackDraft,
  showPlannedTrackMessage,
} from "./planned-track-state.js";
import { buildBatchConfirmation, buildBatchSnapshot, describeBatch } from "./batch-state.js";
import { buildRegenerationConfirmation, formatProjectProgress, hasSubstantivePromptRevision } from "./regeneration-state.js";
import { buildVideoConfirmation } from "./video-state.js";
import { buildMixConfirmation, buildMixTrackViewModels, formatMixDuration, removeMixTrackId } from "./mix-state.js";

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
const generateBatchButton = document.querySelector("#generate-batch");
const stopBatchButton = document.querySelector("#stop-batch");
const batchStatus = document.querySelector("#batch-status");
const batchCompleted = document.querySelector("#batch-completed");
const projectProgress = document.querySelector("#project-progress");
const availablePlanList = document.querySelector("#available-plan-list");
const availablePlanStatus = document.querySelector("#available-plan-status");
const mixSelect = document.querySelector("#mix-select");
const mixTitle = document.querySelector("#mix-title");
const mixCrossfade = document.querySelector("#mix-crossfade");
const mixTrackSelect = document.querySelector("#mix-track-select");
const mixTrackList = document.querySelector("#mix-track-list");
const mixStatus = document.querySelector("#mix-status");
const mixPlanDetails = document.querySelector("#mix-plan-details");
let projects = [];
let libraryTracks = [];
let mixes = [];
let mixTrackIds = [];
let currentMixId = "";
let approvedMixPlan;
let activeBatchId;
let batchPollTimer;

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
loadProjectPlans();
loadMixes();

async function loadLibrary() {
  libraryStatus.textContent = "Loading tracks…";
  try {
    const response = await fetch("/api/tracks");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load the track library.");
    libraryTracks = data.tracks;
    renderTracks(data.tracks);
    renderMixTrackOptions();
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
      await Promise.all([loadLibrary(), loadProjects(projectSelect.value)]);
      if (data.warning) libraryStatus.textContent = data.warning;
      return;
    }
    showCardMessage(card, data.error || "Could not delete track.");
  });
  const createVideo = document.createElement("button");
  createVideo.type = "button";
  createVideo.className = "secondary compact";
  createVideo.textContent = "Create video";
  createVideo.addEventListener("click", () => showVideoCreator(card, track, createVideo));
  actions.append(downloadTrack, createVideo, deleteTrack);

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  titleRow.append(title, saveTitle);
  card.append(titleRow, statusLabel, created, promptLabel, originalPrompt, audio, actions);
  return card;
}

async function showVideoCreator(card, track, trigger) {
  trigger.disabled = true;
  let panel = card.querySelector(".video-creator");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "video-creator";
    card.append(panel);
  }
  panel.replaceChildren();
  const message = document.createElement("p");
  message.className = "card-message";
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  message.textContent = "Loading local visual assets…";
  panel.append(message);
  try {
    const data = await apiJson("/api/video-assets");
    if (!data.status.available) throw new Error(data.status.error);
    if (!data.assets.length) throw new Error("No MP4 visual assets found. Copy the Harbour Docks master into output/visual-assets and try again.");

    const recording = document.createElement("p");
    recording.textContent = `Recording: ${track.title} (${track.filename})`;
    const assetLabel = document.createElement("label");
    assetLabel.textContent = "Looping animation";
    const assetSelect = document.createElement("select");
    assetSelect.append(new Option("Choose an animation", ""));
    for (const asset of data.assets) assetSelect.append(new Option(asset.filename, asset.filename));
    assetLabel.append(assetSelect);
    const preview = document.createElement("div");
    preview.className = "video-plan";
    const render = actionButton("Render MP4", "compact", async () => {
      const plan = render.videoPlan;
      if (!plan) return;
      if (!window.confirm(buildVideoConfirmation(plan))) {
        message.textContent = "Video export cancelled. FFmpeg was not started.";
        return;
      }
      render.disabled = true;
      assetSelect.disabled = true;
      message.textContent = "Rendering locally with FFmpeg… The complete MP3 and animation remain unchanged.";
      try {
        const result = await apiJson("/api/videos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trackId: track.id,
            assetFilename: plan.asset.filename,
            outputFilename: plan.outputFilename,
          }),
        });
        const link = document.createElement("a");
        link.className = "download compact";
        link.href = result.video.downloadUrl;
        link.download = result.video.filename;
        link.textContent = `Download ${result.video.filename}`;
        preview.replaceChildren(link);
        message.textContent = "Video export completed and was saved locally.";
      } catch (error) {
        message.textContent = error.message;
        render.disabled = false;
        assetSelect.disabled = false;
      }
    });
    render.disabled = true;
    assetSelect.addEventListener("change", async () => {
      render.videoPlan = undefined;
      render.disabled = true;
      preview.replaceChildren();
      if (!assetSelect.value) return;
      message.textContent = "Validating inputs and choosing a safe output filename…";
      try {
        const planned = await apiJson("/api/videos/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trackId: track.id, assetFilename: assetSelect.value }),
        });
        render.videoPlan = planned.plan;
        const details = document.createElement("p");
        details.textContent = `Recording: ${planned.plan.track.filename} · Animation: ${planned.plan.asset.filename} · Output: ${planned.plan.outputFilename}`;
        preview.replaceChildren(details);
        render.disabled = false;
        message.textContent = "Review the recording, animation, and output filename, then explicitly start the local render.";
      } catch (error) {
        message.textContent = error.message;
      }
    });
    message.textContent = "Choose a local MP4 animation.";
    panel.prepend(recording, assetLabel, preview, render);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    trigger.disabled = false;
  }
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
  if (Object.hasOwn(changes, "reviewStatus")) await loadProjects(projectSelect.value);
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

generateBatchButton.addEventListener("click", startBatch);
stopBatchButton.addEventListener("click", stopBatch);
mixSelect.addEventListener("change", () => selectMixDraft(mixSelect.value));
document.querySelector("#mix-add-track").addEventListener("click", () => {
  if (!mixTrackSelect.value || mixTrackIds.includes(mixTrackSelect.value)) return;
  mixTrackIds.push(mixTrackSelect.value);
  invalidateMixPlan();
  renderMixDraftTracks();
});
document.querySelector("#mix-save").addEventListener("click", async () => {
  try { await saveMixDraft(); mixStatus.textContent = "Mix draft saved locally."; }
  catch (error) { mixStatus.textContent = error.message; }
});
document.querySelector("#mix-plan").addEventListener("click", reviewMixPlan);
mixTitle.addEventListener("input", invalidateMixPlan);
mixCrossfade.addEventListener("input", invalidateMixPlan);

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
    await Promise.all([loadProjects(), loadProjectPlans()]);
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

async function loadProjectPlans() {
  availablePlanStatus.textContent = "Loading repository plans…";
  try {
    const data = await apiJson("/api/project-plans");
    availablePlanList.replaceChildren(...data.plans.map(createAvailablePlanCard));
    availablePlanStatus.textContent = data.plans.length
      ? `${data.plans.length} repository plan${data.plans.length === 1 ? "" : "s"} discovered.`
      : "No repository project plans are available.";
  } catch (error) { availablePlanStatus.textContent = error.message; }
}

function createAvailablePlanCard(plan) {
  const card = document.createElement("article");
  card.className = `available-plan-card${plan.valid ? "" : " invalid"}`;
  const heading = document.createElement("h4"); heading.textContent = plan.valid ? plan.name : plan.id;
  const details = document.createElement("p");
  details.textContent = plan.valid ? `${plan.theme} · ${plan.trackCount} planned track${plan.trackCount === 1 ? "" : "s"}` : plan.error;
  const state = document.createElement("p"); state.className = "status-badge"; state.textContent = plan.status;
  card.append(heading, details, state);
  if (plan.valid) {
    const action = actionButton("Import into Projects", "compact", () => importRepositoryPlan(plan.id, action));
    action.disabled = !plan.canImport;
    card.append(action);
  }
  return card;
}

async function importRepositoryPlan(planId, button) {
  button.disabled = true;
  availablePlanStatus.textContent = "Importing the selected repository plan locally…";
  try {
    const data = await apiJson(`/api/project-plans/${encodeURIComponent(planId)}/import`, { method: "POST" });
    await Promise.all([loadProjects(data.project.id), loadProjectPlans()]);
    availablePlanStatus.textContent = "Project plan imported. No music was generated and no paid request was made.";
  } catch (error) { availablePlanStatus.textContent = error.message; button.disabled = false; }
}

async function loadProjects(selectedId = projectSelect.value) {
  try {
    const data = await apiJson("/api/projects");
    projects = data.projects;
    projectSelect.replaceChildren(new Option("Choose a project", ""));
    for (const project of projects) projectSelect.append(new Option(project.name, project.id));
    const nextId = projects.some((project) => project.id === selectedId) ? selectedId : "";
    projectSelect.value = nextId;
    renderSelectedProject(nextId);
    await loadLatestBatch(nextId);
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
  projectProgress.textContent = formatProjectProgress(project.progress);
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
  title.control.dataset.plannedField = "title";
  direction.control.dataset.plannedField = "direction";
  promptField.control.dataset.plannedField = "prompt";
  const locked = track.status === "Generated";
  for (const control of [title.control, direction.control, promptField.control]) control.disabled = locked;

  if (!locked) {
    const selector = document.createElement("label");
    selector.className = "batch-selector";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "batch-track-selector";
    checkbox.value = track.id;
    checkbox.setAttribute("aria-label", `Include ${track.title} in batch`);
    checkbox.addEventListener("change", () => {
      const count = document.querySelectorAll(".batch-track-selector:checked").length;
      if (count > 5) {
        checkbox.checked = false;
        batchStatus.textContent = "A batch can authorise at most five paid requests.";
      }
    });
    selector.append(checkbox, document.createTextNode("Select for batch"));
    card.append(selector);
  }

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
    const recordingPanel = createProjectRecording(project, track, cardMessage);
    card.append(heading, title.wrapper, direction.wrapper, promptField.wrapper, recordingPanel, actions, cardMessage);
  } else {
    card.append(heading, title.wrapper, direction.wrapper, promptField.wrapper, actions, cardMessage);
  }
  return card;
}

function createProjectRecording(project, track, cardMessage) {
  const panel = document.createElement("section");
  panel.className = "project-recording";
  const recording = track.recording;
  if (!recording) {
    const warning = document.createElement("p");
    warning.textContent = "The linked recording is unavailable. Refresh or restart before taking further action.";
    panel.append(warning);
    return panel;
  }

  const heading = document.createElement("strong");
  heading.textContent = `Current recording: ${recording.title}`;
  const filename = document.createElement("p");
  filename.className = "track-meta";
  filename.textContent = recording.filename;
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  audio.volume = 0.5;
  audio.src = `/audio/${encodeURIComponent(recording.filename)}`;

  const statusLabel = document.createElement("label");
  statusLabel.textContent = "Review status";
  const review = document.createElement("select");
  for (const value of ["Unreviewed", "Keep", "Reject"]) {
    const option = new Option(value, value, false, value === recording.reviewStatus);
    review.append(option);
  }
  review.addEventListener("change", async () => {
    review.disabled = true;
    try {
      await apiJson(`/api/tracks/${encodeURIComponent(recording.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewStatus: review.value }),
      });
      await Promise.all([loadProjects(project.id), loadLibrary()]);
      projectStatus.textContent = "Review status saved in the project and Track Library.";
    } catch (error) {
      showPlannedTrackMessage(cardMessage, error.message);
      review.disabled = false;
    }
  });
  statusLabel.append(review);
  panel.append(heading, filename, audio, statusLabel);

  if (recording.reviewStatus === "Reject") {
    const editor = document.createElement("div");
    editor.className = "regeneration-editor";
    const notice = document.createElement("p");
    notice.className = "warning";
    notice.textContent = `Regeneration will replace the rejected recording ${recording.filename} only after the new recording is safely saved.`;
    const promptLabel = document.createElement("label");
    promptLabel.textContent = "Revised regeneration prompt";
    const revisedPrompt = document.createElement("textarea");
    revisedPrompt.minLength = 10;
    revisedPrompt.maxLength = 2000;
    revisedPrompt.value = recording.prompt;
    promptLabel.append(revisedPrompt);
    const regenerate = actionButton("Regenerate rejected recording", "compact", async () => {
      if (!hasSubstantivePromptRevision(recording.prompt, revisedPrompt.value)) {
        showPlannedTrackMessage(cardMessage, "Revise the prompt before regenerating. Whitespace-only changes do not qualify. No paid request was made.");
        return;
      }
      if (!window.confirm(buildRegenerationConfirmation(recording, revisedPrompt.value))) {
        showPlannedTrackMessage(cardMessage, "Regeneration cancelled. No paid request was made.");
        return;
      }
      regenerate.disabled = true;
      revisedPrompt.disabled = true;
      showPlannedTrackMessage(cardMessage, "Generating one replacement… The rejected recording remains safe until commit completes.");
      try {
        const data = await apiJson(`/api/projects/${encodeURIComponent(project.id)}/tracks/${encodeURIComponent(track.id)}/regenerate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: revisedPrompt.value,
            expected: { libraryTrackId: recording.id, prompt: recording.prompt },
          }),
        });
        player.src = data.audioUrl;
        download.href = data.audioUrl;
        download.download = data.filename;
        result.hidden = false;
        await Promise.all([loadProjects(project.id), loadLibrary()]);
        const message = document.getElementById(`planned-track-message-${track.id}`);
        if (message) showPlannedTrackMessage(message, data.warning || "Rejected recording replaced safely. The new recording is awaiting review.");
      } catch (error) {
        showPlannedTrackMessage(cardMessage, error.message);
        regenerate.disabled = false;
        revisedPrompt.disabled = false;
      }
    });
    editor.append(notice, promptLabel, regenerate);
    panel.append(editor);
  }
  return panel;
}

async function startBatch() {
  const project = projects.find((candidate) => candidate.id === projectSelect.value);
  if (!project) return;
  const selectedIds = [...document.querySelectorAll(".batch-track-selector:checked")].map((element) => element.value);
  if (selectedIds.length < 1 || selectedIds.length > 5) {
    batchStatus.textContent = "Select between 1 and 5 pending tracks.";
    return;
  }
  for (const trackId of selectedIds) {
    const track = project.tracks.find((candidate) => candidate.id === trackId);
    const card = plannedTrackList.querySelector(`[data-planned-track-id="${CSS.escape(trackId)}"]`);
    const controls = card?.querySelectorAll("[data-planned-field]");
    if (!track || !controls?.length) continue;
    const values = Object.fromEntries([...controls].map((control) => [control.dataset.plannedField, control.value]));
    if (hasUnsavedPlannedTrackChanges(track, plannedTrackDraft(values.title, values.direction, values.prompt))) {
      const message = card.querySelector(".planned-track-message");
      showPlannedTrackMessage(message, "Unsaved changes detected. Save this planned track before batch generation. No paid request was made.");
      batchStatus.textContent = "Save all selected track changes before approving a paid batch.";
      return;
    }
  }
  const expected = buildBatchSnapshot(project, selectedIds);
  if (!window.confirm(buildBatchConfirmation(project.name, expected.tracks))) {
    batchStatus.textContent = "Batch cancelled. No API request was made.";
    return;
  }
  generateBatchButton.disabled = true;
  batchStatus.textContent = "Authorising the saved batch snapshot…";
  try {
    const data = await apiJson(`/api/projects/${encodeURIComponent(project.id)}/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected }),
    });
    activeBatchId = data.batch.id;
    renderBatch(data.batch);
    scheduleBatchPoll();
  } catch (error) {
    batchStatus.textContent = error.message;
    generateBatchButton.disabled = false;
  }
}

async function stopBatch() {
  if (!activeBatchId) return;
  stopBatchButton.disabled = true;
  try {
    const data = await apiJson(`/api/batches/${encodeURIComponent(activeBatchId)}/stop`, { method: "POST" });
    renderBatch(data.batch);
    scheduleBatchPoll();
  } catch (error) {
    batchStatus.textContent = error.message;
  } finally {
    stopBatchButton.disabled = false;
  }
}

async function loadLatestBatch(projectId) {
  clearTimeout(batchPollTimer);
  activeBatchId = undefined;
  batchCompleted.replaceChildren();
  batchStatus.textContent = "";
  stopBatchButton.hidden = true;
  generateBatchButton.disabled = false;
  if (!projectId) return;
  try {
    const data = await apiJson("/api/batches");
    if (data.safety?.blocked) {
      renderBatchSafety(data.safety);
      return;
    }
    const batch = data.batches.find((candidate) => candidate.projectId === projectId);
    if (!batch) return;
    renderBatch(batch);
    if (["approved", "running", "stopping"].includes(batch.status)) scheduleBatchPoll();
  } catch (error) {
    batchStatus.textContent = error.message;
  }
}

function scheduleBatchPoll() {
  clearTimeout(batchPollTimer);
  batchPollTimer = setTimeout(refreshBatch, 1000);
}

async function refreshBatch() {
  if (!activeBatchId) return;
  try {
    const data = await apiJson(`/api/batches/${encodeURIComponent(activeBatchId)}`);
    renderBatch(data.batch);
    if (data.safety?.blocked) {
      renderBatchSafety(data.safety);
      return;
    }
    await Promise.all([loadProjects(projectSelect.value), loadLibrary()]);
    if (["approved", "running", "stopping"].includes(data.batch.status)) scheduleBatchPoll();
  } catch (error) {
    batchStatus.textContent = `Batch status could not be refreshed: ${error.message} The server will not automatically retry or resume generation.`;
  }
}

function renderBatch(batch) {
  const active = ["approved", "running", "stopping"].includes(batch.status);
  activeBatchId = active ? batch.id : undefined;
  batchStatus.textContent = describeBatch(batch);
  batchCompleted.replaceChildren(...batch.completed.map((track) => {
    const item = document.createElement("li");
    item.textContent = `${track.title} — ${track.filename}`;
    return item;
  }));
  generateBatchButton.disabled = active;
  stopBatchButton.hidden = !active;
  stopBatchButton.disabled = batch.status === "stopping";
}

function renderBatchSafety(safety) {
  activeBatchId = undefined;
  clearTimeout(batchPollTimer);
  generateBatchButton.disabled = true;
  stopBatchButton.hidden = true;
  batchStatus.textContent = safety.message;
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

async function loadMixes(selectedId = currentMixId) {
  try {
    const data = await apiJson("/api/mixes");
    mixes = data.mixes;
    mixSelect.replaceChildren(new Option("New mix", ""));
    for (const mix of mixes) mixSelect.append(new Option(mix.title, mix.id));
    if (selectedId && mixes.some((mix) => mix.id === selectedId)) {
      mixSelect.value = selectedId;
      selectMixDraft(selectedId);
    }
    if (!data.status.available) mixStatus.textContent = data.status.error;
  } catch (error) { mixStatus.textContent = error.message; }
}

function selectMixDraft(id) {
  const mix = mixes.find((candidate) => candidate.id === id);
  currentMixId = mix?.id ?? "";
  mixTitle.value = mix?.title ?? "Untitled Mix";
  mixCrossfade.value = mix?.crossfadeSeconds ?? 8;
  mixTrackIds = mix ? [...mix.trackIds] : [];
  invalidateMixPlan(); renderMixDraftTracks();
}

function renderMixTrackOptions() {
  const selected = mixTrackSelect.value;
  mixTrackSelect.replaceChildren(new Option("Choose a recording", ""));
  for (const track of libraryTracks) mixTrackSelect.append(new Option(`${track.title} — ${track.filename}`, track.id));
  if (libraryTracks.some((track) => track.id === selected)) mixTrackSelect.value = selected;
  renderMixDraftTracks();
}

function renderMixDraftTracks() {
  const viewModels = buildMixTrackViewModels(mixTrackIds, libraryTracks);
  mixTrackList.replaceChildren(...viewModels.map(({ id, track, missing }, index) => {
    const item = document.createElement("li"); item.className = "mix-track-item";
    if (missing) item.classList.add("missing");
    const title = document.createElement("strong"); title.textContent = `${index + 1}. ${missing ? "Missing recording — unavailable" : track.title}`;
    const actions = document.createElement("div"); actions.className = "track-actions";
    const up = actionButton("Move up", "secondary compact", () => moveMixTrack(index, -1));
    const down = actionButton("Move down", "secondary compact", () => moveMixTrack(index, 1));
    const remove = actionButton("Remove", "danger compact", () => { mixTrackIds = removeMixTrackId(mixTrackIds, index); invalidateMixPlan(); renderMixDraftTracks(); });
    up.disabled = index === 0; down.disabled = index === mixTrackIds.length - 1;
    actions.append(up, down, remove); item.append(title);
    if (missing) {
      const warning = document.createElement("p"); warning.textContent = `Recording ID ${id} is missing. Restore it to the Track Library or explicitly remove it before planning.`; item.append(warning);
    } else {
      const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = `/audio/${encodeURIComponent(track.filename)}`; item.append(audio);
    }
    item.append(actions); return item;
  }));
}

function moveMixTrack(index, offset) {
  const destination = index + offset;
  if (destination < 0 || destination >= mixTrackIds.length) return;
  [mixTrackIds[index], mixTrackIds[destination]] = [mixTrackIds[destination], mixTrackIds[index]];
  invalidateMixPlan(); renderMixDraftTracks();
}

function invalidateMixPlan() { approvedMixPlan = undefined; mixPlanDetails.replaceChildren(); }

async function saveMixDraft() {
  const body = JSON.stringify({ title: mixTitle.value, trackIds: mixTrackIds, crossfadeSeconds: Number(mixCrossfade.value) });
  const data = await apiJson(currentMixId ? `/api/mixes/${encodeURIComponent(currentMixId)}` : "/api/mixes", {
    method: currentMixId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body,
  });
  currentMixId = data.mix.id;
  await loadMixes(currentMixId);
  return data.mix;
}

async function reviewMixPlan() {
  try {
    await saveMixDraft();
    mixStatus.textContent = "Probing source durations and validating the mix…";
    const data = await apiJson(`/api/mixes/${encodeURIComponent(currentMixId)}/plan`, { method: "POST" });
    approvedMixPlan = data.plan;
    const heading = document.createElement("h3"); heading.textContent = "Approved mix plan";
    const list = document.createElement("ol");
    for (const track of data.plan.tracks) { const item = document.createElement("li"); item.textContent = `${track.title} — ${formatMixDuration(track.duration)}`; list.append(item); }
    const summary = document.createElement("p");
    const transitionDurations = data.plan.transitions.map((transition) => `${transition.duration}s`).join(", ");
    summary.textContent = `Crossfades by join: ${transitionDurations} · Source total: ${formatMixDuration(data.plan.totalSourceDuration)} · Crossfade overlap: ${formatMixDuration(data.plan.totalCrossfadeOverlap)} · Expected final: ${formatMixDuration(data.plan.expectedDuration)} · Output: ${data.plan.outputFilename}`;
    const render = actionButton("Render WAV master", "compact", renderApprovedMix);
    mixPlanDetails.replaceChildren(heading, list, summary, render);
    mixStatus.textContent = "Review the complete plan, then explicitly confirm the local render.";
  } catch (error) { mixStatus.textContent = error.message; }
}

async function renderApprovedMix(event) {
  const plan = approvedMixPlan;
  if (!plan || !window.confirm(buildMixConfirmation(plan))) { mixStatus.textContent = "Mix render cancelled. FFmpeg was not started."; return; }
  const controls = [...document.querySelectorAll(".mix-section button, .mix-section input, .mix-section select")];
  controls.forEach((control) => { control.disabled = true; });
  mixStatus.textContent = "Rendering the local 24-bit WAV master…";
  try {
    const data = await apiJson(`/api/mixes/${encodeURIComponent(plan.mixId)}/render`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outputFilename: plan.outputFilename, snapshot: plan.snapshot }),
    });
    await loadMixes(plan.mixId);
    const link = document.createElement("a"); link.className = "download"; link.href = data.export.downloadUrl; link.download = data.export.filename; link.textContent = `Download ${data.export.filename}`;
    mixPlanDetails.replaceChildren(link); mixStatus.textContent = "WAV master validated, saved, and ready to download.";
  } catch (error) { mixStatus.textContent = error.message; }
  finally { controls.forEach((control) => { control.disabled = false; }); }
}

async function apiJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
