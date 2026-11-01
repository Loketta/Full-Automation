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
    if (response.ok) return loadLibrary();
    const data = await response.json();
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
