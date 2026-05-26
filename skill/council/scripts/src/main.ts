import { runCli } from "./cli.ts";

runCli(process.argv.slice(2))
  .then((output) => {
    process.stdout.write(output);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
