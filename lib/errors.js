"use strict";

// A mistake in how the command was called or configured: exit 2, distinct from
// exit 1, which means "the records or the code failed the check".
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

module.exports = { UsageError };
