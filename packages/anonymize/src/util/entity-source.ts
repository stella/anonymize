import type { Entity } from "../types";

/**
 * True when the entity came from a caller-supplied detector — a
 * custom deny-list entry or a custom regex. These spans carry
 * caller-locked boundaries: the pipeline does not sanitise, trim,
 * or boundary-adjust them, since the caller chose the exact text.
 */
export const isCallerOwnedEntity = (entity: Entity): boolean =>
  entity.sourceDetail === "custom-deny-list" ||
  entity.sourceDetail === "custom-regex";
