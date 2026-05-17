import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawnAgent } from "../../src/spawner/index.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-spawner-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("spawnAgent", () => {
  test("writes streamable MCP config without persisting token and sends prompt on stdin", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > args.txt",
        "cat > stdin.txt",
        "printf '%s' \"$SYMPHONY_TOKEN\" > token-env.txt",
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    const result = await spawnAgent({
      issueId: "issue-1",
      attempt: 2,
      workspace,
      prompt: "prompt from stdin",
      token: "secret-token",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.killedByTimeout).toBe(false);
    expect(await fs.readFile(path.join(workspace, "args.txt"), "utf-8")).toBe("binary\nexec\n--sandbox=on\n");
    expect(await fs.readFile(path.join(workspace, "stdin.txt"), "utf-8")).toBe("prompt from stdin");
    expect(await fs.readFile(path.join(workspace, "token-env.txt"), "utf-8")).toBe("secret-token");

    const nanoYaml = await fs.readFile(path.join(workspace, ".nano.yaml"), "utf-8");
    expect(nanoYaml).toContain("transport: streamable");
    expect(nanoYaml).toContain('X-Symphony-Token: "${env:SYMPHONY_TOKEN}"');
    expect(nanoYaml).toContain("sandbox:");
    expect(nanoYaml).toContain("enabled: true");
    expect(nanoYaml).toContain("backend: native");
    expect(nanoYaml).toContain("network_access: true");
    expect(nanoYaml).not.toContain("secret-token");
    expect(nanoYaml).not.toContain("transport: http");
  });
});
