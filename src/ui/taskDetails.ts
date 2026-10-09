// The task's details panel (description, process, environment) and a step's output shown in place of the terminal.
import { getState, setState, type DetailsTab } from "./api.ts";

/** Opens the details panel on a tab: the one it showed last when none is given. */
export function openDetails(tab?: DetailsTab): void {
  const next = tab ?? getState().detailsTab;
  setState({ details: next, detailsTab: next });
}

/** Opens the panel on the tab, or closes it when it already shows that tab. */
export function toggleDetails(tab?: DetailsTab): void {
  const { details } = getState();
  if (details && (!tab || details === tab)) closeDetails();
  else openDetails(tab);
}

export function closeDetails(): void {
  setState({ details: null });
}

/** Shows a step's output where the task's terminal is, with a bar to go back. */
export function showOutput(taskId: string, title: string, text: string): void {
  setState({ output: { taskId, title, text } });
}

export function hideOutput(): void {
  if (getState().output) setState({ output: null });
}

/**
 * Esc outside the terminal and the fields: first takes a shown output away, then closes the panel.
 * True when it did something, so the key goes no further.
 */
export function escapeDetails(): boolean {
  const { output, details } = getState();
  if (output) {
    hideOutput();
    return true;
  }
  if (details) {
    closeDetails();
    return true;
  }
  return false;
}
