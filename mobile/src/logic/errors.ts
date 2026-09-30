// Errors the logic layer throws; the UI shows their messages. (Flask returned these as
// HTTP 404 / 409 / 400 responses.)
export { ValidationError } from "./text";

/** The thing asked for doesn't exist (e.g. it was deleted elsewhere). */
export class NotFoundError extends Error {
  constructor(message = "That item no longer exists.") {
    super(message);
  }
}

/** The request conflicts with the current state (e.g. the day changed; reload and retry). */
export class ConflictError extends Error {}
