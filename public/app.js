const form = document.querySelector("#generate-form");
const prompt = document.querySelector("#prompt");
const button = document.querySelector("#generate-button");
const status = document.querySelector("#status");
const result = document.querySelector("#result");
const player = document.querySelector("#player");
const volume = document.querySelector("#volume");
const volumeValue = document.querySelector("#volume-value");
const download = document.querySelector("#download");

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
    status.textContent = "Track saved locally. Preview it below or download the MP3.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    prompt.disabled = false;
  }
});
