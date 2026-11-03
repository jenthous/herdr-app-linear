// A Linear workflow state as an icon (other mods use these files by path, e.g. a spaces sidebar): dashed circle backlog, empty todo, half in progress, three-quarter review,
// check done, cross canceled. Draw with svg(stateIcon(state)).text_color(state.color).

const ICON = "mods/linear/icons";
const KNOWN = ["backlog", "triage", "unstarted", "started", "completed", "canceled"];

export function stateIcon(state) {
  const type = state?.type;
  if (type === "started" && /review|리뷰/i.test(state?.name ?? "")) return `${ICON}/state-review.svg`;
  return `${ICON}/state-${KNOWN.includes(type) ? type : type === "duplicate" ? "canceled" : "unstarted"}.svg`;
}
