// The fish picker: choose how many of each species live in the tank, like the
// original's Fish settings page (0-100 each; the crab and sea star 0-1).
//
// A "Fish" button in the panel opens a popover listing every species with a
// count, presets, and the schooling switch. Apply re-stocks the tank at once
// and records the choice in the URL (?tank=slug:n,...&school=0), so a link
// reproduces the tank exactly.

import type { FishEntry } from "./fish.ts";

export type Stock = Record<string, number>;

export interface FishPickerOptions {
  panel: HTMLElement;
  fish: FishEntry[];
  /** The install's own settings.xml tank. */
  installed: Stock;
  initial: Stock;
  schooling: boolean;
  onApply(stock: Stock, schooling: boolean): Promise<void>;
}

/** The original's spinner limits (README-settings.md §4). */
function maxFor(entry: FishEntry): number {
  return entry.slug === "anemone-crab" || entry.slug === "sea-star" ? 1 : 100;
}

export function fishPicker(o: FishPickerOptions): void {
  const species = [...o.fish].sort((a, b) => a.name.localeCompare(b.name));
  const counts: Stock = Object.fromEntries(species.map((f) => [f.slug, o.initial[f.slug] ?? 0]));
  let schooling = o.schooling;

  const button = document.createElement("button");
  button.type = "button";
  button.title = "Choose the fish in the tank";
  o.panel.append(button);

  const pop = document.createElement("div");
  pop.id = "fishpicker";
  pop.hidden = true;
  document.body.append(pop);

  const total = () => Object.values(counts).reduce((a, b) => a + b, 0);
  const label = () => (button.textContent = `Fish (${total()})`);
  label();

  // --- contents ---------------------------------------------------------------
  const presets = document.createElement("div");
  presets.className = "fp-presets";
  const preset = (text: string, title: string, make: () => Stock) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", () => {
      const s = make();
      for (const f of species) counts[f.slug] = Math.min(maxFor(f), s[f.slug] ?? 0);
      sync();
    });
    presets.append(b);
  };
  preset("Installed", "The install's settings.xml tank", () => o.installed);
  preset("One of each", "Every species once", () => Object.fromEntries(species.map((f) => [f.slug, 1])));
  preset("None", "Empty tank", () => ({}));

  const list = document.createElement("div");
  list.className = "fp-list";
  const inputs = new Map<string, HTMLInputElement>();
  for (const f of species) {
    const row = document.createElement("label");
    row.className = "fp-row";
    const name = document.createElement("span");
    name.textContent = f.name;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = String(maxFor(f));
    input.step = "1";
    input.addEventListener("input", () => {
      const n = Math.round(Number(input.value));
      counts[f.slug] = Number.isFinite(n) ? Math.max(0, Math.min(maxFor(f), n)) : 0;
      mark();
    });
    input.addEventListener("change", sync);
    const step = (d: number, text: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.tabIndex = -1;
      b.addEventListener("click", (e) => {
        e.preventDefault(); // inside a <label>: don't also focus the input
        counts[f.slug] = Math.max(0, Math.min(maxFor(f), counts[f.slug] + d));
        sync();
      });
      return b;
    };
    row.append(name, step(-1, "−"), input, step(+1, "+"));
    inputs.set(f.slug, input);
    list.append(row);
  }

  const foot = document.createElement("div");
  foot.className = "fp-foot";
  const schoolBox = document.createElement("input");
  schoolBox.type = "checkbox";
  schoolBox.addEventListener("change", () => {
    schooling = schoolBox.checked;
    mark();
  });
  const schoolLabel = document.createElement("label");
  schoolLabel.append(schoolBox, " Schooling");
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "fp-apply";
  apply.addEventListener("click", async () => {
    apply.disabled = true;
    apply.textContent = "Loading…";
    try {
      await o.onApply({ ...counts }, schooling);
      applied = key();
    } finally {
      apply.disabled = false;
      mark();
      label();
    }
  });
  foot.append(schoolLabel, apply);
  pop.append(presets, list, foot);

  // --- state -----------------------------------------------------------------
  const key = () => JSON.stringify([counts, schooling]);
  let applied = key();
  function mark(): void {
    const dirty = key() !== applied;
    apply.textContent = dirty ? `Apply (${total()})` : "Applied";
    apply.classList.toggle("dirty", dirty);
  }
  function sync(): void {
    for (const f of species) inputs.get(f.slug)!.value = String(counts[f.slug]);
    schoolBox.checked = schooling;
    mark();
  }
  sync();

  const setOpen = (open: boolean) => {
    pop.hidden = !open;
    button.classList.toggle("active", open);
    if (open) {
      const r = o.panel.getBoundingClientRect();
      pop.style.top = `${r.bottom + 8}px`;
      pop.style.left = `${r.left}px`;
    }
  };
  button.addEventListener("click", () => setOpen(pop.hidden !== false));
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) setOpen(false);
  });
  // Clicking the scene closes it (but not clicks inside it or on its button).
  addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (!pop.hidden && !pop.contains(t) && t !== button) setOpen(false);
  });
}

/** `?tank=slug:n,...` for a stock, omitting zeros (empty string for an empty tank). */
export function stockParam(stock: Stock): string {
  return Object.entries(stock).filter(([, n]) => n > 0).map(([s, n]) => `${s}:${n}`).join(",");
}
