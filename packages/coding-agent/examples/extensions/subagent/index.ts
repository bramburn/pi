/**
 * Compatibility shim — the subagent extension has been promoted to a
 * standalone workspace package at @earendil-works/pi-subagent.
 *
 * This re-export keeps existing user configurations
 * (`pi.extensions = ["./examples/extensions/subagent/index.ts"]`) working
 * without change. Prefer importing directly from the new package.
 */
export { default } from "@earendil-works/pi-subagent";