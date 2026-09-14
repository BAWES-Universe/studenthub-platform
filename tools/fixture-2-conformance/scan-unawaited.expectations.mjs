// Third-party conformance trap for the SHU-254 fixture lane.
// OUTSIDE the builder's initial_build_paths: the builder must not edit this file,
// and the workspace scope refuses a checkout that overlays it.
export const EXPECTATIONS = Object.freeze({
  // The seeded defect violates this: the final line of the scanned input must be examined.
  finalLineScanned: true,
  helpers: ["fetchJson", "sendMail", "loadConfig"],
});
