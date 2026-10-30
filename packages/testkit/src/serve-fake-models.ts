/**
 * Runs the fake OpenAI-compatible + Clef server standalone (for driving real agents such as
 * OpenCode in tests and CI):  node --conditions=@orrery/source --import tsx \
 *   packages/testkit/src/serve-fake-models.ts [port]
 * HOST=0.0.0.0 listens on all interfaces (containers).
 */
import { startFakeModelServer } from "./fake-models.js";

const port = Number(process.argv[2] ?? process.env.PORT ?? 0);
const s = await startFakeModelServer({ dims: 64, port, host: process.env.HOST ?? "127.0.0.1" });
process.stdout.write(`${s.url}\n`);
process.on("SIGTERM", () => void s.close().then(() => process.exit(0)));
