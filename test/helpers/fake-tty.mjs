/**
 * Run the real CLI as though it were attached to a terminal.
 *
 * The REPL only starts when stdin *and* stdout both look like TTYs, and a test
 * child process can never provide that. This wrapper flips the two flags on the
 * real streams and then calls the CLI's exported `main()`, so a test can pipe a
 * scripted conversation (prompts, permission answers, `/exit`) into a genuine
 * interactive session.
 *
 * Usage: node test/helpers/fake-tty.mjs [cli options...]
 */

const { main } = await import(new URL('../../bin/deepseek-code.js', import.meta.url));

for (const stream of [process.stdin, process.stdout]) {
  try {
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  } catch {
    /* leave the stream alone; the run then falls back to non-interactive */
  }
}

process.exitCode = (await main()) ?? 0;
