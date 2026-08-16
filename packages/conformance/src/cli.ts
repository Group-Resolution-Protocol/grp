import { readFile, stat, writeFile } from "node:fs/promises";
import { renderJsonReport } from "./reporters/json.js";
import { renderMarkdownReport } from "./reporters/markdown.js";
import { runConformance } from "./runner.js";
import {
  decodeBase64Key,
  publicKeyFromJwks,
  signConformanceReport,
  verifySignedConformanceReport,
} from "./signing.js";
import type { ConformanceProfile, ConformanceReport, SignedConformanceReport } from "./types.js";

interface RunOptions {
  command: "run";
  profile: ConformanceProfile;
  target?: string;
  allowWrites: boolean;
  mandateFile?: string;
  report?: string;
  format: "json" | "markdown";
}

interface SignOptions {
  command: "sign";
  report: string;
  out?: string;
  keyBase64?: string;
  keyEnv?: string;
  kid: string;
}

interface VerifyOptions {
  command: "verify";
  signedReport: string;
  publicKeyBase64?: string;
  jwks?: string;
  out?: string;
}

type CliOptions = RunOptions | SignOptions | VerifyOptions;

export async function runCli(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.command === "sign") {
    await runSign(opts);
    return;
  }
  if (opts.command === "verify") {
    await runVerify(opts);
    return;
  }

  const mandate = opts.mandateFile ? await readMandateFile(opts.mandateFile) : undefined;
  const report = await runConformance({
    profile: opts.profile,
    ...(opts.target ? { target: opts.target } : {}),
    allowWrites: opts.allowWrites,
    ...(mandate ? { mandate } : {}),
  });
  const body = opts.format === "markdown" ? renderMarkdownReport(report) : renderJsonReport(report);

  if (opts.report) {
    await writeFile(opts.report, body, "utf8");
  } else {
    process.stdout.write(body);
  }

  if (report.summary.fail > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  const [command, rest] =
    args[0] === "run" || args[0] === "sign" || args[0] === "verify"
      ? [args[0], args.slice(1)]
      : ["run", args];
  if (command === "sign") return parseSignArgs(rest);
  if (command === "verify") return parseVerifyArgs(rest);

  const opts: RunOptions = {
    command: "run",
    profile: "core",
    format: "json",
    allowWrites: false,
  };

  for (const arg of rest) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--allow-write") {
      opts.allowWrites = true;
      continue;
    }
    const [key, value] = splitArg(arg);
    switch (key) {
      case "--profile":
        if (!isProfile(value)) throw new Error(`invalid --profile '${value}'`);
        opts.profile = value;
        break;
      case "--target":
        opts.target = value;
        break;
      case "--mandate-file":
        opts.mandateFile = value;
        break;
      case "--report":
        opts.report = value;
        break;
      case "--format":
        if (value !== "json" && value !== "markdown") {
          throw new Error(`invalid --format '${value}'`);
        }
        opts.format = value;
        break;
      default:
        throw new Error(`unknown argument '${key}'`);
    }
  }

  if (opts.mandateFile && opts.profile !== "operator") {
    throw new Error("--mandate-file is accepted only with --profile=operator");
  }

  return opts;
}

export async function readMandateFile(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("--mandate-file must name a regular file");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("--mandate-file must not be readable or writable by group or other users");
  }
  const mandate = (await readFile(path, "utf8")).trim();
  if (!mandate) throw new Error("--mandate-file is empty");
  if (/\s/.test(mandate)) throw new Error("--mandate-file must contain one compact JWS value");
  return mandate;
}

function parseSignArgs(args: string[]): SignOptions {
  const opts: SignOptions = { command: "sign", report: "", kid: "" };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const [key, value] = splitArg(arg);
    switch (key) {
      case "--report":
        opts.report = value;
        break;
      case "--out":
        opts.out = value;
        break;
      case "--key-base64":
        opts.keyBase64 = value;
        break;
      case "--key-env":
        opts.keyEnv = value;
        break;
      case "--kid":
        opts.kid = value;
        break;
      default:
        throw new Error(`unknown argument '${key}'`);
    }
  }
  if (!opts.report) throw new Error("sign requires --report=<path>");
  if (!opts.kid) throw new Error("sign requires --kid=<key-id>");
  if (!opts.keyBase64 && !opts.keyEnv) {
    throw new Error("sign requires --key-env=<env-var> or --key-base64=<base64-seed>");
  }
  return opts;
}

function parseVerifyArgs(args: string[]): VerifyOptions {
  const opts: VerifyOptions = { command: "verify", signedReport: "" };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const [key, value] = splitArg(arg);
    switch (key) {
      case "--signed-report":
        opts.signedReport = value;
        break;
      case "--public-key-base64":
        opts.publicKeyBase64 = value;
        break;
      case "--jwks":
        opts.jwks = value;
        break;
      case "--out":
        opts.out = value;
        break;
      default:
        throw new Error(`unknown argument '${key}'`);
    }
  }
  if (!opts.signedReport) throw new Error("verify requires --signed-report=<path>");
  if (opts.publicKeyBase64 && opts.jwks) {
    throw new Error("verify accepts only one of --public-key-base64 or --jwks");
  }
  return opts;
}

async function runSign(opts: SignOptions): Promise<void> {
  const report = JSON.parse(await readFile(opts.report, "utf8")) as ConformanceReport;
  const keyValue = opts.keyBase64 ?? process.env[opts.keyEnv ?? ""];
  if (!keyValue) {
    throw new Error(`environment variable ${opts.keyEnv} is not set`);
  }
  const signed = await signConformanceReport({
    report,
    privateKey: decodeBase64Key(keyValue, "conformance signing key"),
    kid: opts.kid,
  });
  const body = `${JSON.stringify(signed, null, 2)}\n`;
  if (opts.out) {
    await writeFile(opts.out, body, "utf8");
  } else {
    process.stdout.write(body);
  }
}

async function runVerify(opts: VerifyOptions): Promise<void> {
  const signedReport = JSON.parse(
    await readFile(opts.signedReport, "utf8"),
  ) as SignedConformanceReport;
  const publicKey = await resolvePublicKey(opts, signedReport);
  const verification = await verifySignedConformanceReport({
    signedReport,
    ...(publicKey ? { publicKey } : {}),
  });
  const body = `${JSON.stringify(verification, null, 2)}\n`;
  if (opts.out) {
    await writeFile(opts.out, body, "utf8");
  } else {
    process.stdout.write(body);
  }
}

async function resolvePublicKey(
  opts: VerifyOptions,
  signedReport: SignedConformanceReport,
): Promise<Uint8Array | undefined> {
  if (opts.publicKeyBase64) {
    return decodeBase64Key(opts.publicKeyBase64, "conformance public key");
  }
  if (opts.jwks) {
    const jwks = JSON.parse(await readFile(opts.jwks, "utf8")) as unknown;
    return publicKeyFromJwks(jwks, signedReport.signature.kid);
  }
  return undefined;
}

function splitArg(arg: string): [string, string] {
  const ix = arg.indexOf("=");
  if (ix < 0) return [arg, "true"];
  return [arg.slice(0, ix), arg.slice(ix + 1)];
}

function isProfile(value: string): value is ConformanceProfile {
  return value === "core" || value === "transport" || value === "operator";
}

function printHelp(): void {
  process.stdout.write(`grp-conformance

Usage:
  grp-conformance run --profile=core
  grp-conformance --profile=core
  grp-conformance --profile=transport --target=https://room.example --allow-write --format=markdown
  grp-conformance --profile=operator --target=https://host.example --allow-write --mandate-file=/secure/path/mandate.jws
  grp-conformance sign --report=report.json --key-env=GRP_CONFORMANCE_SIGNING_KEY_BASE64 --kid=operator-2026-05 --out=signed-report.json
  grp-conformance verify --signed-report=signed-report.json --jwks=operator-jwks.json

Options:
  --profile=core|transport|operator
  --target=<base-url>          Required for transport/operator live probes
  --allow-write                Required acknowledgement: live probes create and delete test rooms
  --mandate-file=<path>        0600 file containing a short-lived trusted mandate for hosted operator probes
  --report=<path>              Write report to file instead of stdout
  --format=json|markdown       Defaults to json

Signing:
  --key-env=<name>             Environment variable containing base64 Ed25519 seed
  --key-base64=<value>         Base64 Ed25519 seed; prefer --key-env for real keys
  --kid=<key-id>               Signing key id
  --out=<path>                 Write signed report or verification result to file

Verification:
  --signed-report=<path>       Signed conformance report JSON
  --public-key-base64=<value>  Expected base64 Ed25519 public key
  --jwks=<path>                Expected JWKS containing the signing kid
`);
}
