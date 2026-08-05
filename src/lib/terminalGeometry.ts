/**
 * Pure geometry estimate (no DOM). Used by estimateTerminalGeometry and tests.
 */
export function estimateTerminalGeometryFromSize(
  width: number,
  height: number,
  fontSize = 14,
): { cols: number; rows: number } {
  const cellW = fontSize * 0.6;
  const cellH = fontSize * 1.2;
  const cols = Math.max(80, Math.min(300, Math.floor(width / cellW) || 80));
  const rows = Math.max(24, Math.min(120, Math.floor(height / cellH) || 24));
  return { cols, rows };
}

/**
 * Estimate terminal cols/rows for session_open before xterm is mounted.
 * Prefer measuring the main terminal host if present; otherwise use window size.
 */
export function estimateTerminalGeometry(): { cols: number; rows: number } {
  const host =
    document.querySelector<HTMLElement>("[data-terminal-host]") ??
    document.querySelector<HTMLElement>("main");

  const fontSize = 14;

  let width = window.innerWidth - 320; // activity + sidebar approx
  let height = window.innerHeight - 120; // title + tabs + status

  if (host) {
    const r = host.getBoundingClientRect();
    if (r.width > 80 && r.height > 80) {
      width = r.width;
      height = r.height;
    }
  }

  return estimateTerminalGeometryFromSize(width, height, fontSize);
}
