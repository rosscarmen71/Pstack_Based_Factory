// Which /customize_order request already has a Terminal window, so the loop opens one per request and the
// visualizer can bring that same window forward. Runtime state, gitignored. Re-reads before every operation and
// writes atomically, like tasks.store.ts.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const CUSTOMIZE_WINDOWS_PATH = new URL("./customize-windows.json", import.meta.url).pathname;

export interface CustomizeWindow {
  pr: number;
  /** createdAt of the /customize_order comment this window answers. */
  commentAt: string;
  /** Terminal's window id, or null when the window could not be opened (for example, not on macOS). */
  windowId: number | null;
  openedAt: string;
}

export interface CustomizeWindowsStore {
  get(pr: number): CustomizeWindow | undefined;
  record(window: CustomizeWindow): void;
}

export function customizeWindowsStore(path: string = CUSTOMIZE_WINDOWS_PATH): CustomizeWindowsStore {
  const read = (): Record<string, CustomizeWindow> =>
    existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, CustomizeWindow>) : {};
  return {
    get: (pr) => read()[String(pr)],
    record(window) {
      const all = read();
      all[String(window.pr)] = window;
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
      renameSync(tmp, path);
    },
  };
}
