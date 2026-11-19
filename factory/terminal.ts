// Opens and focuses macOS Terminal windows for runs a human answers in, such as /customize_order.
// Shared by the loop (which opens the window) and the visualizer (which brings it forward or reopens it).

export interface OsaResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs one AppleScript. Injectable so tests never drive Terminal. */
export type OsaRunner = (script: string) => Promise<OsaResult>;

export const bunOsa: OsaRunner = async (script) => {
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/** Single-quotes a value for the shell inside the Terminal command. */
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Opens a new Terminal window running `command` and returns its window id. */
export async function openTerminalWindow(command: string, osa: OsaRunner = bunOsa): Promise<number> {
  const script = [
    'tell application "Terminal"',
    "  activate",
    `  set newTab to do script ${JSON.stringify(command)}`,
    "  return id of (first window whose tabs contains newTab)",
    "end tell",
  ].join("\n");
  const { exitCode, stdout, stderr } = await osa(script);
  if (exitCode !== 0) throw new Error(`osascript failed (exit ${exitCode}): ${stderr.trim() || "no output"}`);
  const id = Number(stdout.trim());
  if (!Number.isInteger(id)) throw new Error(`osascript returned no window id: ${JSON.stringify(stdout.trim())}`);
  return id;
}

/**
 * Brings the window with `id` to the front. False when the window is gone or its command has finished: Terminal
 * can keep a window open after its shell exits, and that window has no agent left to answer.
 */
export async function focusTerminalWindow(id: number, osa: OsaRunner = bunOsa): Promise<boolean> {
  const script = [
    'tell application "Terminal"',
    `  if not (exists window id ${id}) then return "missing"`,
    `  if not (busy of selected tab of window id ${id}) then return "finished"`,
    `  set index of window id ${id} to 1`,
    "  activate",
    '  return "ok"',
    "end tell",
  ].join("\n");
  const { exitCode, stdout, stderr } = await osa(script);
  if (exitCode !== 0) throw new Error(`osascript failed (exit ${exitCode}): ${stderr.trim() || "no output"}`);
  return stdout.trim() === "ok";
}
