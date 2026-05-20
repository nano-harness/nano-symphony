import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

const repoRoot = path.resolve(import.meta.dir, "../..");
const tempDirs: string[] = [];
const installedVersion = "1.2.3";
const metadataVersion = `v${installedVersion}`;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-install-"));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, "utf-8");
  await fs.chmod(filePath, 0o755);
}

function run(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  return Bun.spawnSync(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("install.sh update command", () => {
  test("skips reinstall when metadata version has v prefix and installed package does not", async () => {
    const tmp = await makeTempDir();
    const fakeBin = path.join(tmp, "bin-tools");
    const payload = path.join(tmp, "payload");
    const archive = path.join(tmp, "nano-symphony.tar.gz");
    const installDir = path.join(tmp, "install");
    const binDir = path.join(tmp, "bin");
    const curlLog = path.join(tmp, "curl.log");
    const metaFile = path.join(tmp, "meta.json");
    await fs.mkdir(path.join(payload, "templates"), { recursive: true });
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(path.join(payload, "package.json"), JSON.stringify({ version: installedVersion }), "utf-8");
    await fs.writeFile(path.join(payload, ".env.example"), "", "utf-8");
    await fs.writeFile(path.join(payload, "templates", "WORKFLOW.example.md"), "", "utf-8");
    await fs.writeFile(metaFile, JSON.stringify({ version: metadataVersion, install_script_url: "https://example.test/install.sh" }), "utf-8");

    let result = run(["tar", "-czf", archive, "-C", payload, "."]);
    expect(result.exitCode).toBe(0);
    result = run(["sh", "-c", `sha256sum "${archive}" | awk '{print $1 "  nano-symphony.tar.gz"}' > "${archive}.sha256"`]);
    expect(result.exitCode).toBe(0);

    await writeExecutable(
      path.join(fakeBin, "bun"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "1.3.14"
elif [ "\${1:-}" = "install" ]; then
  exit 0
elif [ "\${1:-}" = "-e" ]; then
  script="\${2:-}"
  if [[ "\${script}" == *"Bun.file"* ]]; then
    key="version"
    if [[ "\${script}" == *"install_script_url"* ]]; then
      key="install_script_url"
    fi
    node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(process.env.META_FILE, "utf8"))[process.argv[1]] ?? "");' "\${key}"
  else
    node -e "\${script}"
  fi
else
  echo "unexpected bun command: $*" >&2
  exit 1
fi
`
    );
    await writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
echo "\${url}" >> "${curlLog}"
case "\${url}" in
  */meta.json) cp "${metaFile}" "\${out}" ;;
  */nano-symphony.tar.gz) cp "${archive}" "\${out}" ;;
  */nano-symphony.tar.gz.sha256) cp "${archive}.sha256" "\${out}" ;;
  */install.sh) echo "installer should not be downloaded for no-op update" >&2; exit 42 ;;
  *) echo "unexpected url: \${url}" >&2; exit 1 ;;
esac
`
    );

    const env = {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      INSTALL_DIR: installDir,
      BIN_DIR: binDir,
      OSS_BASE_URL: "https://example.test/symphony",
    };
    result = run(["bash", path.join(repoRoot, "install.sh")], { env });
    expect(result.exitCode).toBe(0);

    await fs.writeFile(curlLog, "", "utf-8");
    result = run([path.join(binDir, "symphony"), "update"], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(`already up to date (${installedVersion})`);
    expect(await fs.readFile(curlLog, "utf-8")).not.toContain("install.sh");
  });
});
