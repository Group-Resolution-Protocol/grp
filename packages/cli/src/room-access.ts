import { randomBytes } from "node:crypto";

export type RoomVisibility = "public" | "unlisted" | "private";

export interface CliCreateAccess {
  visibility: RoomVisibility;
  password?: string;
  passwordGenerated: boolean;
  label: string;
}

const GENERATED_PASSWORD_BYTES = 24;

/**
 * Resolve the official CLI's room-access posture.
 *
 * The host's wire default remains Unlisted for protocol compatibility. The
 * CLI is deliberately more conservative: omission creates a password-enabled
 * Private room with 192 bits of random entropy. Explicit access flags always
 * win, and explicit Private without a password means invite-only.
 */
export function resolveCliCreateAccess(flags: Record<string, string>): CliCreateAccess {
  const aliases = [
    flags.public === "true" ? "public" : undefined,
    flags.unlisted === "true" ? "unlisted" : undefined,
    flags.private === "true" ? "private" : undefined,
  ].filter((value): value is RoomVisibility => !!value);
  const explicit = flags.visibility;
  if (explicit && explicit !== "public" && explicit !== "unlisted" && explicit !== "private") {
    throw new Error("--visibility must be one of: public, unlisted, private");
  }
  if (aliases.length > 1 || (aliases.length === 1 && explicit && aliases[0] !== explicit)) {
    throw new Error("choose one visibility: --public, --unlisted, --private, or --visibility=...");
  }
  if (flags.password !== undefined && flags.passcode !== undefined) {
    throw new Error("use --password only; --passcode is a deprecated alias");
  }

  const requestedVisibility = (explicit ?? aliases[0]) as RoomVisibility | undefined;
  const suppliedPassword = flags.password ?? flags.passcode;
  if (suppliedPassword === "true" || suppliedPassword === "") {
    throw new Error("--password requires a value");
  }
  if (suppliedPassword !== undefined) {
    if (requestedVisibility && requestedVisibility !== "private") {
      throw new Error("--password can only be used with --visibility=private");
    }
    return {
      visibility: "private",
      password: suppliedPassword,
      passwordGenerated: false,
      label: "Private — valid invite or room password required",
    };
  }

  if (!requestedVisibility) {
    return {
      visibility: "private",
      password: randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url"),
      passwordGenerated: true,
      label: "Private — valid invite or room password required",
    };
  }
  if (requestedVisibility === "public") {
    return {
      visibility: "public",
      passwordGenerated: false,
      label: "Public — anyone can read or join",
    };
  }
  if (requestedVisibility === "unlisted") {
    return {
      visibility: "unlisted",
      passwordGenerated: false,
      label: "Unlisted — anyone with the link can join, then read and participate",
    };
  }
  return {
    visibility: "private",
    passwordGenerated: false,
    label: "Private — valid invite required",
  };
}
