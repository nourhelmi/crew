import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { options, repository, setup } from "./setup.mjs";

try {
  const args = options();
  const { home, crewBin } = await setup({ home: args.home, crewBin: args.crew });
  NodeChildProcess.execFileSync(crewBin, ["help"], { stdio: "ignore", timeout: 10_000 });
  console.log(`CrewCode · Crew runs your agents\nData directory: ${home}`);
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(repository, "scripts/dev-runner.ts"), "dev", "--home-dir", home],
    {
      cwd: repository,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${NodePath.join(repository, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH || ""}`,
        CREWCODE_HOME: home,
        CREWCODE_CREW_BIN: crewBin,
        T3CODE_NO_BROWSER: "true",
      },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  console.error(
    `CrewCode: ${error.message}\nInstall Crew and sign in to the CLIs in your Crew roster, then retry.`,
  );
  process.exitCode = 1;
}
