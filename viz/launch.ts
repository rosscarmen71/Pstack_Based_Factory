/**
 * `bun run viz` from the repo root: installs the visualizer's dependencies on first use, rebuilds the UI when its
 * source is newer than the build, starts the server on 127.0.0.1:4600 and opens the browser.
 * It never starts the factory loop; that stays `bun run loop`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const PORT = Number(process.env.PORT ?? 4600);
const URL_ = `http://127.0.0.1:${PORT}`;
const BUN = process.execPath;

async function run(cmd: string[], label: string): Promise<void> {
  console.log(`[viz] ${label}…`);
  const code = await Bun.spawn(cmd, { cwd: DIR, stdout: "inherit", stderr: "inherit" }).exited;
  if (code !== 0) {
    console.error(`[viz] ${label} failed (exit ${code})`);
    process.exit(code);
  }
}

/** Newest modification time under the paths the UI build reads. */
function newestSource(paths: string[]): number {
  let newest = 0;
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
    else newest = Math.max(newest, st.mtimeMs);
  };
  for (const p of paths) walk(join(DIR, p));
  return newest;
}

async function alreadyServing(): Promise<boolean> {
  try {
    return (await fetch(`${URL_}/api/health`)).ok;
  } catch {
    return false;
  }
}

const openBrowser = () => Bun.spawn(["open", URL_], { stdout: "ignore", stderr: "ignore" });

if (await alreadyServing()) {
  console.log(`[viz] already running at ${URL_}; opening it`);
  openBrowser();
  process.exit(0);
}

if (!existsSync(join(DIR, "node_modules"))) await run([BUN, "install"], "installing the visualizer's dependencies (first run only)");

const built = join(DIR, "dist", "index.html");
const builtAt = existsSync(built) ? statSync(built).mtimeMs : 0;
if (newestSource(["src", "shared", "public", "index.html", "vite.config.ts", "package.json"]) > builtAt) {
  await run([BUN, "x", "vite", "build", "--logLevel", "warn"], "building the UI");
}

const server = Bun.spawn([BUN, "run", join(DIR, "server", "index.ts")], {
  cwd: DIR,
  env: { ...process.env, PORT: String(PORT) },
  stdout: "inherit",
  stderr: "inherit",
});

for (let i = 0; i < 50 && !(await alreadyServing()); i++) await Bun.sleep(100);
if (await alreadyServing()) {
  console.log(`[viz] open ${URL_}  (Ctrl+C to stop; the factory loop is not affected)`);
  openBrowser();
} else {
  console.error(`[viz] the server did not come up on ${URL_}`);
}

const stop = () => {
  server.kill("SIGINT");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.exit(await server.exited);
