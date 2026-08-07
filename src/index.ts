import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./cli.js";

const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === entryPath) await main();

export * from "./types.js";
export * from "./config.js";
export * from "./conversations.js";
export * from "./filter.js";
export * from "./commands.js";
export * from "./media.js";
export * from "./reply.js";
export * from "./sessions.js";
