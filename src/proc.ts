/** Spawn a command, capture stdout, and throw on non-zero exit with stderr. */
export async function sh(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`\`${cmd.join(" ")}\` exited ${code}: ${err.trim() || out.trim()}`);
  return out;
}
