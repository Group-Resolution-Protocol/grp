import {
  clearHostedCredential,
  resolveProviderBaseUrl,
  setHostedCredential,
  updateProviderConfig,
} from "./provider-config.js";
import { parseRoomArgs, renderJson } from "./room-cli.js";

export interface AuthCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  sleep: (ms: number) => Promise<void>;
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenResponse {
  access_token: string;
  public_id?: string;
  token_type: "Bearer";
  scope?: string;
  resource?: string | null;
  mandate: string;
}

export async function runAuthCli(
  command: "login" | "logout",
  argv: string[],
  io: Partial<AuthCliIo> = {},
): Promise<number> {
  const resolvedIo = resolveIo(io);
  const parsed = parseRoomArgs(argv);
  // Spec 114 (WR6-7) — help flags never touch the network (F092-1 class).
  if (parsed.flags.help === "true" || parsed.flags.h === "true") {
    resolvedIo.stdout(
      command === "login"
        ? [
            "Usage: grp login [--host=NAME]",
            "",
            "Sign in to the current host when rooms ask for identity (OAuth device code).",
            "",
            "Example: grp login",
            "",
          ].join("\n")
        : ["Usage: grp logout", "", "Clear the saved host identity.", ""].join("\n"),
    );
    return 0;
  }
  try {
    if (command === "logout") {
      return runLogout(parsed.flags, resolvedIo);
    }
    return runLogin(parsed.flags, resolvedIo);
  } catch (err) {
    resolvedIo.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function runLogin(flags: Record<string, string>, io: AuthCliIo): Promise<number> {
  const baseUrl = resolveAuthBaseUrl(flags, io.env);
  const auth = await requestForm<DeviceAuthorizationResponse>(
    io,
    baseUrl,
    "/oauth/device_authorization",
    {
      client_id: flags["client-id"] ?? "grp-cli",
      agent_slug: flags.agent ?? "grp-cli",
      from: "grp-cli",
      scope: flags.scope ?? "decision:read decision:write",
      ...(flags.resource ? { resource: flags.resource } : {}),
    },
  );

  if (flags.json === "true" || flags["no-wait"] === "true") {
    io.stdout(renderJson({ host: baseUrl, ...auth }));
    return 0;
  }

  io.stdout(
    [
      "GRP login",
      "",
      `Open: ${auth.verification_uri_complete}`,
      `Code: ${auth.user_code}`,
      "",
      "Waiting for browser authorization...",
      "",
    ].join("\n"),
  );

  const token = await pollForToken(io, baseUrl, auth, flags);
  const credential = {
    baseUrl,
    accessToken: token.access_token,
    mandate: token.mandate,
    savedAt: new Date().toISOString(),
    ...(token.public_id !== undefined ? { publicId: token.public_id } : {}),
    ...(token.scope !== undefined ? { scope: token.scope } : {}),
    ...(token.resource !== undefined ? { resource: token.resource } : {}),
  };
  updateProviderConfig((current) => setHostedCredential(current, credential), io.env, {
    scope: "global",
  });

  io.stdout("Logged in. GRP will use this host identity when a room asks for it.\n");
  return 0;
}

function runLogout(flags: Record<string, string>, io: AuthCliIo): number {
  updateProviderConfig((current) => clearHostedCredential(current), io.env, {
    scope: "global",
  });
  if (flags.json === "true") {
    io.stdout(renderJson({ logged_in: false }));
    return 0;
  }
  io.stdout("Logged out of the saved GRP host identity.\n");
  return 0;
}

async function pollForToken(
  io: AuthCliIo,
  baseUrl: string,
  auth: DeviceAuthorizationResponse,
  flags: Record<string, string>,
): Promise<DeviceTokenResponse> {
  const intervalSeconds = Number(flags["poll-interval"] ?? auth.interval ?? 5);
  const intervalMs = Number.isFinite(intervalSeconds) ? Math.max(0, intervalSeconds * 1000) : 5000;
  const deadline = Date.now() + auth.expires_in * 1000;

  while (Date.now() < deadline) {
    if (intervalMs > 0) await io.sleep(intervalMs);
    const response = await io.fetch(new URL("/oauth/token", baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: auth.device_code,
      }).toString(),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.ok) return body as DeviceTokenResponse;
    if (isOAuthPending(body)) {
      if (body.error === "slow_down") await io.sleep(Math.max(1000, intervalMs));
      continue;
    }
    throw new Error(oauthErrorMessage(body, response.status));
  }
  throw new Error("login expired before browser authorization completed");
}

async function requestForm<T>(
  io: AuthCliIo,
  baseUrl: string,
  path: string,
  form: Record<string, string>,
): Promise<T> {
  const response = await io.fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) throw new Error(oauthErrorMessage(body, response.status));
  return body as T;
}

function isOAuthPending(body: unknown): body is { error: "authorization_pending" | "slow_down" } {
  return (
    !!body &&
    typeof body === "object" &&
    "error" in body &&
    (body.error === "authorization_pending" || body.error === "slow_down")
  );
}

function oauthErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error_description" in body) {
    const description = body.error_description;
    if (typeof description === "string") return description;
  }
  if (body && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (typeof error === "string") return error;
  }
  return `OAuth request failed with ${status}`;
}

function resolveAuthBaseUrl(
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
) {
  const base =
    flags.base ??
    (flags.host || flags.provider
      ? resolveProviderBaseUrl(flags.host ?? flags.provider, env)
      : undefined) ??
    env.GRP_BASE_URL ??
    resolveProviderBaseUrl(undefined, env);
  if (!base) {
    throw new Error("No default host configured. Run `grp init grp` or pass --base.");
  }
  return base.replace(/\/$/, "");
}

function resolveIo(io: Partial<AuthCliIo>): AuthCliIo {
  return {
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text)),
    fetch: io.fetch ?? fetch,
    env: io.env ?? process.env,
    sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}
