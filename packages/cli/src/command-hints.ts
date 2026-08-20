/** Render a follow-up command inside the active explicit `grp as` persona. */
export function grpCommand(command: string): string {
  const session = process.env.GRP_AS_ACTIVE === "1" ? process.env.GRP_SESSION?.trim() : undefined;
  return session ? `grp as ${session} ${command}` : `grp ${command}`;
}
