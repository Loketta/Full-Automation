import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createLyriaClient } from "./lyria.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

try {
  const client = createLyriaClient(process.env.GEMINI_API_KEY);
  const app = createApp({
    client,
    apiKey: process.env.GEMINI_API_KEY,
    outputDirectory: path.join(projectRoot, "output"),
    publicDirectory: path.join(projectRoot, "public"),
  });

  app.listen(port, "127.0.0.1", () => {
    console.log(`Lyria Local Studio is ready at http://127.0.0.1:${port}`);
    console.log("No paid request is made until you click Generate and confirm.");
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
