/**
 * A failure that retrying cannot fix (unrecognised format, malformed file).
 * Queues must NOT retry these; they go straight to the dead-letter path.
 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}
