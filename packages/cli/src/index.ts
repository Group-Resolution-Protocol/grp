// GRP CLI banner. The canonical command is `grp`.

export const CLI_VERSION = "0.1.3-staging.35";

export function banner(): string {
  return `grp ${CLI_VERSION} — Group Resolution Protocol CLI`;
}
