// A muscle group can be primary OR ancillary, not both: selecting it in one list
// disables it in the other. Custom groups typed in either list are added to both.
(function () {
  const lists = {
    primary: document.querySelector('.chips[data-role="primary"]'),
    ancillary: document.querySelector('.chips[data-role="ancillary"]'),
  };
  const other = { primary: "ancillary", ancillary: "primary" };

  function findChip(role, name) {
    const key = name.toLowerCase();
    return [...lists[role].querySelectorAll("input")].find((i) => i.value.toLowerCase() === key);
  }

  function sync() {
    for (const role of ["primary", "ancillary"]) {
      for (const input of lists[role].querySelectorAll("input")) {
        const twin = findChip(other[role], input.value);
        input.disabled = Boolean(twin && twin.checked);
        input.closest(".chip").title = input.disabled
          ? `Already selected as ${other[role] === "primary" ? "primary" : "ancillary"}`
          : "";
      }
    }
  }

  function makeChip(role, name) {
    const label = document.createElement("label");
    label.className = "chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = role;
    input.value = name;
    const span = document.createElement("span");
    span.textContent = name;
    label.append(input, span);
    lists[role].append(label);
    return input;
  }

  function normalize(raw) {
    const name = raw.replace(/^#+/, "").trim().replace(/\s+/g, " ").slice(0, 50);
    return name === name.toLowerCase() ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : name;
  }

  function addCustom(role) {
    const field = document.querySelector(`[data-add-for="${role}"]`);
    const name = normalize(field.value);
    if (!name) return;
    for (const r of ["primary", "ancillary"]) {
      if (!findChip(r, name)) makeChip(r, name);
    }
    const input = findChip(role, name);
    if (!input.disabled) input.checked = true;
    field.value = "";
    sync();
    field.focus();
  }

  document.addEventListener("change", (e) => {
    if (e.target.matches(".chips[data-role] input")) sync();
  });

  for (const role of ["primary", "ancillary"]) {
    document.querySelector(`[data-add-button="${role}"]`).addEventListener("click", () => addCustom(role));
    document.querySelector(`[data-add-for="${role}"]`).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault(); // don't submit the form
        addCustom(role);
      }
    });
  }

  sync();
})();
