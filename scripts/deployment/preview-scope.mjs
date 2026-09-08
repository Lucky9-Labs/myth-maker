import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const controllerOwned = [
  /^\.github\/workflows\/(?:deployment-preview|deploy|provider-(?:executor|cloudflare|railway|modal)|terraform-foundation)\.yml$/,
  /^scripts\/deployment\//,
];

const providerPatterns = {
  terraform: [/^infra\/terraform\//],
  cloudflare: [/^src\/(?:worker|encounter-package-assembler)\.js$/, /^wrangler\.jsonc$/],
  railway: [/^railway\.json$/, /^src\/(?:railway-[^/]+|postgres-receipt-store|encounter-dispatcher)\.js$/, /^package(?:-lock)?\.json$/],
  modal: [/^modal\//, /^package(?:-lock)?\.json$/],
};

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path));
}

export function classifyPreviewPaths(paths) {
  const normalizedPaths = paths.filter(Boolean);
  const controllerChanged = normalizedPaths.some((path) => matchesAny(path, controllerOwned));

  return Object.fromEntries(Object.entries(providerPatterns).map(([provider, patterns]) => [
    provider,
    controllerChanged || normalizedPaths.some((path) => matchesAny(path, patterns)),
  ]));
}

function requiredArgument(argumentsByName, name) {
  const value = argumentsByName.get(name);
  if (!value) {
    throw new Error(`Missing required ${name} argument.`);
  }
  return value;
}

function parseArguments(argv) {
  const argumentsByName = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || argumentsByName.has(name)) {
      throw new Error("Usage: preview-scope.mjs --base <sha> --head <sha>");
    }
    argumentsByName.set(name, value);
  }
  return argumentsByName;
}

function changedPaths(base, head) {
  return execFileSync("git", ["diff", "--name-only", "--no-renames", base, head], {
    encoding: "utf8",
  }).split("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argumentsByName = parseArguments(process.argv.slice(2));
  const scope = classifyPreviewPaths(changedPaths(
    requiredArgument(argumentsByName, "--base"),
    requiredArgument(argumentsByName, "--head"),
  ));
  for (const [provider, changed] of Object.entries(scope)) {
    console.log(`${provider}=${changed}`);
  }
}
