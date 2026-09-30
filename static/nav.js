// Bottom bar: "Today" plus a Library menu (Routines / Workouts / Exercises) that pops up above it.
(function () {
  const btn = document.getElementById("library-btn");
  const menu = document.getElementById("library-menu");
  if (!btn) return;

  function setOpen(open) {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  }

  btn.addEventListener("click", () => {
    setOpen(menu.hidden);
    if (!menu.hidden) menu.querySelector("a").focus();
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !e.target.closest(".tab-menu")) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      setOpen(false);
      btn.focus();
    }
  });
})();
