// Search + muscle filter for exercise pickers (templates/_exercise_filter.html).
// Options need { name, primary: [...], ancillary: [...] }.
//
//   const filter = ExerciseFilter(rootEl, onChange);
//   filter.matches(option) -> bool;  filter.reset();
//
// Role toggles (user requirement): both start off and are disabled until a muscle is
// picked. Picking a muscle while both are off turns Primary on. With a muscle picked, an
// exercise matches if it has that muscle in a checked role; with both roles off, the
// muscle doesn't filter at all. Going back to "All muscles" turns both off again.
window.ExerciseFilter = function (root, onChange) {
  const search = root.querySelector("[data-filter-search]");
  const muscle = root.querySelector("[data-filter-muscle]");
  const roles = [...root.querySelectorAll("[data-filter-role]")];
  const primary = roles.find((r) => r.dataset.filterRole === "primary");

  search.addEventListener("input", onChange);
  muscle.addEventListener("change", () => {
    for (const r of roles) {
      r.disabled = !muscle.value;
      if (!muscle.value) r.checked = false;
    }
    if (muscle.value && !roles.some((r) => r.checked)) primary.checked = true;
    onChange();
  });
  for (const r of roles) r.addEventListener("change", onChange);

  return {
    matches(option) {
      if (!option.name.toLowerCase().includes(search.value.trim().toLowerCase())) return false;
      const checked = roles.filter((r) => r.checked);
      if (!muscle.value || !checked.length) return true;
      const want = muscle.value.toLowerCase();
      return checked.some((r) => option[r.dataset.filterRole].some((m) => m.toLowerCase() === want));
    },
    reset() {
      search.value = "";
      muscle.value = "";
      for (const r of roles) {
        r.checked = false;
        r.disabled = true;
      }
    },
  };
};
