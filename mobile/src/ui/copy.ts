// Copying a workout or routine (user requirement): the copy opens as a new, unsaved builder
// with every setting the same and the name suffixed " NEW". Routes: #/<kind>/new?copy=<id>.
import { html } from "lit-html";
import { href } from "./app";

const SUFFIX = " NEW";

/** "Push Day" -> "Push Day NEW", kept within the 100-character name limit. */
export const copyName = (name: string) => name.slice(0, 100 - SUFFIX.length) + SUFFIX;

export const copyHref = (kind: "workouts" | "routines", id: number) => href(`/${kind}/new`, { copy: String(id) });

const icon = html`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`;

/** The copy button in a list card's corner, beside the delete ×. */
export const cardCopyButton = (kind: "workouts" | "routines", id: number, name: string) =>
  html`<a class="icon-btn card-copy" href=${copyHref(kind, id)} aria-label="Copy ${name}">${icon}</a>`;
