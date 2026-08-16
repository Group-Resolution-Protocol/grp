import {
  addProvider,
  listProviders,
  providerConfigPath,
  readProviderConfig,
  removeProvider,
  resolveProvider,
  setDefaultProvider,
  updateProviderConfig,
} from "./provider-config.js";
import { parseRoomArgs, renderJson } from "./room-cli.js";

export interface ProviderCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
}

export async function runProviderCli(
  argv: string[],
  io: Partial<ProviderCliIo> = {},
): Promise<number> {
  const resolvedIo = resolveIo(io);
  const parsed = parseRoomArgs(argv);
  const [command, name] = parsed.positionals;

  // Help must be side-effect-free and succeed on every subcommand
  // (`grp host add --help` used to exit 1 with "host name is required").
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    parsed.flags.help === "true" ||
    parsed.positionals.includes("-h")
  ) {
    printProviderHelp(resolvedIo.stdout);
    return 0;
  }

  try {
    switch (command) {
      case "add": {
        if (!name) throw new Error("host name is required");
        const base = parsed.flags.base;
        if (!base) throw new Error("--base is required");
        const config = updateProviderConfig(
          (current) =>
            addProvider(
              current,
              name,
              base,
              parsed.flags.default === "true" || parsed.flags["set-default"] === "true",
            ),
          resolvedIo.env,
          { scope: "global" },
        );
        writeProvider(config, name, parsed.flags, resolvedIo);
        return 0;
      }
      case "use": {
        if (!name) throw new Error("host name is required");
        const config = updateProviderConfig(
          (current) => setDefaultProvider(current, name),
          resolvedIo.env,
          { scope: "global" },
        );
        writeProvider(config, name, parsed.flags, resolvedIo);
        return 0;
      }
      case "remove": {
        if (!name) throw new Error("host name is required");
        updateProviderConfig((current) => removeProvider(current, name), resolvedIo.env, {
          scope: "global",
        });
        if (parsed.flags.json === "true") {
          resolvedIo.stdout(renderJson({ removed: name }));
        } else {
          resolvedIo.stdout(`removed host ${name}\n`);
        }
        return 0;
      }
      case "list": {
        const config = readProviderConfig(resolvedIo.env, { scope: "global" });
        const providers = listProviders(config).map((provider) => ({
          ...provider,
          default: config.defaultProvider === provider.name,
        }));
        if (parsed.flags.json === "true") {
          resolvedIo.stdout(renderJson({ providers, path: providerConfigPath(resolvedIo.env) }));
          return 0;
        }
        if (providers.length === 0) {
          resolvedIo.stdout(
            [
              "no host configured",
              "run `grp host use grp`, `grp host use local`,",
              "or `grp host add NAME --base=URL --default`",
              "",
            ].join("\n"),
          );
          return 0;
        }
        for (const provider of providers) {
          const marker = provider.default ? "*" : " ";
          resolvedIo.stdout(`${marker} ${provider.name}\t${provider.baseUrl}\n`);
        }
        return 0;
      }
      case "path": {
        resolvedIo.stdout(`${providerConfigPath(resolvedIo.env)}\n`);
        return 0;
      }
      default:
        resolvedIo.stderr(`unknown host command: ${command}\n`);
        return 2;
    }
  } catch (err) {
    resolvedIo.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function writeProvider(
  config: ReturnType<typeof readProviderConfig>,
  name: string,
  flags: Record<string, string>,
  io: ProviderCliIo,
): void {
  const provider = resolveProvider(config, name);
  if (!provider) throw new Error(`unknown provider: ${name}`);
  const out = { ...provider, default: config.defaultProvider === provider.name };
  if (flags.json === "true") {
    io.stdout(renderJson(out));
    return;
  }
  const suffix = out.default ? " (default)" : "";
  io.stdout(`${out.name}\t${out.baseUrl}${suffix}\n`);
}

function resolveIo(io: Partial<ProviderCliIo>): ProviderCliIo {
  return {
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text)),
    env: io.env ?? process.env,
  };
}

function printProviderHelp(write: (text: string) => void): void {
  write(
    `${[
      "Usage: grp host <command> [name] [options]",
      "",
      "Commands:",
      "  add NAME --base=URL   add or update a room host",
      "  use NAME              set the default room host",
      "  list                  list configured/default hosts",
      "  remove NAME           remove a configured host",
      "  path                  print the host config path",
      "",
      "Examples:",
      "  grp host add acme --base=https://grp.internal.acme.com --default",
      "  grp host use grp",
      "  grp create --host=acme --ask='Pick dinner'",
    ].join("\n")}\n`,
  );
}
