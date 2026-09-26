/** Existing tests model a previously completed read, not an old config migration.
 * Upgrade their explicit fixture certificates; migration tests use raw config. */
export function observedFixture(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_key, item) => {
    if (
      item &&
      typeof item === "object" &&
      typeof item.observedStateRevision === "string" &&
      !item.observations
    ) {
      return {
        ...item,
        observations: {
          schema: 1,
          generation: "fixture-read",
          conversation: item.observedStateRevision,
          global: item.observedStateRevision,
        },
      };
    }
    return item;
  });
}
