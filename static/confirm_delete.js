// Opens the shared delete confirmation (templates/_confirm_delete.html) for any
// button with data-confirm-delete="<POST url>" and data-name="<item name>".
// Optional: data-detail (consequence text), data-blocked (reason deletion isn't allowed).
(function () {
  const dialog = document.getElementById("confirm-delete");
  if (!dialog) return;
  const title = document.getElementById("confirm-delete-title");
  const detail = document.getElementById("confirm-delete-detail");
  const form = document.getElementById("confirm-delete-form");
  const cancel = dialog.querySelector("[data-cancel]");
  const submit = dialog.querySelector("[data-submit]");

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-confirm-delete]");
    if (!btn) return;
    e.preventDefault();
    const blocked = btn.dataset.blocked;
    title.textContent = blocked
      ? `Can’t delete “${btn.dataset.name}”`
      : `Delete “${btn.dataset.name}”?`;
    detail.textContent = blocked || btn.dataset.detail || "This can’t be undone.";
    submit.hidden = Boolean(blocked);
    cancel.textContent = blocked ? "OK" : "Cancel";
    form.action = btn.dataset.confirmDelete;
    dialog.showModal();
  });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // tap on backdrop
  });
})();
