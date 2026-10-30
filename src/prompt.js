const MIN_PROMPT_LENGTH = 10;
const MAX_PROMPT_LENGTH = 2000;

export function validatePrompt(value) {
  if (typeof value !== "string") {
    throw new ValidationError("Enter an instrumental style prompt.");
  }

  const prompt = value.trim();
  if (prompt.length < MIN_PROMPT_LENGTH) {
    throw new ValidationError(`Prompt must be at least ${MIN_PROMPT_LENGTH} characters.`);
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new ValidationError(`Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`);
  }

  return prompt;
}

export function buildInstrumentalPrompt(prompt) {
  return `${prompt}\n\nInstrumental only. No vocals, spoken words, or lyrics.`;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}
