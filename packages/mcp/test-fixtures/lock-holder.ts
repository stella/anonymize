import { DurableSessionStore } from "../src/durable-sessions";

const sessionDirectory = process.argv.at(2);
const keyFile = process.argv.at(3);
if (sessionDirectory === undefined || keyFile === undefined) {
  throw new Error("Lock holder requires session directory and key paths");
}

const holder = globalThis as typeof globalThis & {
  durableSessionStore?: DurableSessionStore;
};
holder.durableSessionStore = await DurableSessionStore.create({
  keyFile,
  sessionDirectory,
});
process.stdout.write("ready\n");
setInterval(() => undefined, 60_000);
await new Promise(() => undefined);
