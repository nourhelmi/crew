import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export const repository = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

export function providerSettings({ home, crewBin }) {
  return {
    defaultModelSelection: { instanceId: "crew", model: "crew-auto" },
    providerInstances: {
      codex: { driver: "codex", enabled: false },
      claudeAgent: { driver: "claudeAgent", enabled: false },
      crew: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Crew",
        environment: [
          { name: "CREWCODE_HOME", value: home, sensitive: false },
          { name: "CREWCODE_CREW_BIN", value: crewBin, sensitive: false },
        ],
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [NodePath.join(repository, "scripts/crewcode/acp.mjs")],
          customModels: ["crew-auto"],
        },
      },
    },
  };
}

export async function setup({
  home = process.env.CREWCODE_HOME || NodePath.join(repository, ".crewcode"),
  crewBin,
} = {}) {
  home = NodePath.resolve(home);
  const directory = NodePath.join(home, "userdata");
  const path = NodePath.join(directory, "settings.json");
  let existing;
  try {
    existing = JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const savedCrew = existing?.providerInstances?.crew;
  crewBin ??=
    process.env.CREWCODE_CREW_BIN ||
    savedCrew?.environment?.find((entry) => entry.name === "CREWCODE_CREW_BIN")?.value ||
    "crew";
  if (crewBin.includes("/")) crewBin = await NodeFSP.realpath(NodePath.resolve(crewBin));
  const settings = providerSettings({ home, crewBin });
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await NodeFSP.writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const saved = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    const actual = saved.providerInstances?.crew;
    const expected = settings.providerInstances.crew;
    if (
      actual?.driver !== expected.driver ||
      actual?.config?.source !== "local" ||
      actual.config.commandPath !== expected.config.commandPath ||
      JSON.stringify(actual.config.commandArgs) !== JSON.stringify(expected.config.commandArgs) ||
      expected.environment.some(
        (entry) =>
          actual.environment?.find((item) => item.name === entry.name)?.value !== entry.value,
      )
    ) {
      throw new Error(
        `Existing settings at ${path} have different Crew configuration. Change Crew in Settings → Providers or choose a new --home directory.`,
        { cause: error },
      );
    }
  }
  return { home, path, crewBin, settings };
}

export function options(argv = process.argv.slice(2)) {
  return NodeUtil.parseArgs({
    args: argv,
    options: { home: { type: "string" }, crew: { type: "string" } },
    strict: true,
  }).values;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    const args = options();
    const configured = await setup({ home: args.home, crewBin: args.crew });
    console.log(`CrewCode configured: ${configured.path}\nStart with: pnpm crewcode`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
