import { main } from "./index.js";
import { processIo } from "./io.js";

const [major] = process.versions.node.split(".").map(Number);
if ((major ?? 0) < 20) {
  process.stderr.write(`orrery needs Node.js 20 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}
process.exitCode = await main(process.argv.slice(2), processIo());
// Streams may keep the event loop alive after the command finished.
setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
