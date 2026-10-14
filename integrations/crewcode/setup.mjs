import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const integration = path.dirname(fileURLToPath(import.meta.url));
const crewRoot = path.resolve(integration, "../..");
const upstream = JSON.parse(await readFile(path.join(integration, "upstream.json"), "utf8"));

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

// sourceRepository also permits verifying the complete reconstruction offline.
export async function prepareCheckout({
  destination = path.join(crewRoot, ".crewcode-app"),
  sourceRepository = upstream.repository,
} = {}) {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 13 || (minor === 13 && patch < 1)) {
    throw new Error("Use Node 24.13.1 or newer within the 24.x release line.");
  }
  git(crewRoot, "--version");
  destination = path.resolve(destination);
  try {
    // Exclusive creation protects existing source, credentials, and app data.
    await mkdir(destination);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Destination already exists: ${destination}. To start a prepared app, run pnpm crewcode there. To prepare another checkout, pass a new directory.`,
        { cause: error },
      );
    }
    throw error;
  }

  console.log(`Preparing CrewCode at ${destination}`);
  git(destination, "init", "--initial-branch=crewcode");
  git(destination, "config", "core.autocrlf", "false");
  git(destination, "remote", "add", "origin", upstream.repository);
  git(destination, "fetch", "--depth=1", sourceRepository, upstream.commit);
  git(destination, "checkout", "-B", "crewcode", "FETCH_HEAD");
  if (git(destination, "rev-parse", "HEAD") !== upstream.commit) {
    throw new Error("The fetched T3 Code commit does not match upstream.json.");
  }

  const patchPath = path.join(integration, "upstream.patch");
  git(destination, "apply", "--check", patchPath);
  git(destination, "apply", patchPath);
  await cp(path.join(integration, "files"), destination, { recursive: true, force: false });
  git(destination, "add", "--all");
  if (git(destination, "write-tree") !== upstream.resultTree) {
    throw new Error("The reconstructed source differs from the verified CrewCode tree.");
  }
  git(
    destination,
    "-c", "user.name=CrewCode Setup",
    "-c", "user.email=crewcode@localhost",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "-m", "feat(crewcode): run Crew advisors through a local ACP provider",
  );

  execFileSync(process.execPath, [
    path.join(destination, "scripts/crewcode/setup.mjs"),
    "--home", path.join(destination, ".crewcode"),
    "--crew", path.join(crewRoot, "bin/crew"),
  ], { cwd: destination, stdio: "inherit" });
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) {
    console.log("Usage: node integrations/crewcode/setup.mjs [new-checkout-directory]");
    process.exitCode = args.length === 1 && args[0] === "--help" ? 0 : 1;
  } else {
    try {
      const destination = await prepareCheckout({ destination: args[0] });
      const quoted = `'${destination.replaceAll("'", "'\\''")}'`;
      console.log(`\nSource verified. Start on this machine:\n  cd ${quoted}\n  pnpm install --frozen-lockfile\n  pnpm crewcode\n\nOpen the complete pairing URL printed by the dev runner.`);
    } catch (error) {
      console.error(`CrewCode setup: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
