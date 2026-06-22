import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

const repoRoot = path.resolve(import.meta.dir, "../..");
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-wrapper-"));
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

async function installWithFakeDeps(tmp: string) {
  const fakeBin = path.join(tmp, "bin-tools");
  const payload = path.join(tmp, "payload");
  const archive = path.join(tmp, "nano-symphony.tar.gz");
  const installDir = path.join(tmp, "install");
  const binDir = path.join(tmp, "bin");
  const metaFile = path.join(tmp, "meta.json");

  await fs.mkdir(path.join(payload, "share", "templates"), { recursive: true });
  await fs.mkdir(path.join(payload, "share", "skills", "nano-symphony"), { recursive: true });
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(payload, "package.json"), JSON.stringify({ version: "2.0.0" }), "utf-8");
  await fs.writeFile(path.join(payload, "share", "VERSION"), "2.0.0", "utf-8");
  await fs.writeFile(path.join(payload, ".env.example"), "# example\n", "utf-8");
  await fs.writeFile(
    path.join(payload, "share", "templates", "WORKFLOW.example.md"),
    "---\ntracker: linear\n---\n{{ issue.title }}\n",
    "utf-8"
  );
  await fs.writeFile(path.join(payload, "share", "skills", "nano-symphony", "SKILL.md"), "", "utf-8");

  let result = run(["tar", "-czf", archive, "-C", payload, "."]);
  expect(result.exitCode).toBe(0);
  result = run(["sh", "-c", `sha256sum "${archive}" | awk '{print $1 "  nano-symphony.tar.gz"}' > "${archive}.sha256"`]);
  expect(result.exitCode).toBe(0);

  await fs.writeFile(metaFile, JSON.stringify({ version: "v2.0.0", install_script_url: "https://example.test/install.sh" }), "utf-8");

  await writeExecutable(
    path.join(fakeBin, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
REAL_BUN="\${REAL_BUN:-bun}"
if [ "\${1:-}" = "--version" ]; then
  echo "1.3.14"
elif [ "\${1:-}" = "install" ]; then
  exit 0
elif [ "\${1:-}" = "-e" ]; then
  script="\${2:-}"
  if [[ "\${script}" == *"Bun.file"* ]]; then
    "\$REAL_BUN" -e "\${script}"
  elif [[ "\${script}" == *"getRandomValues"* ]]; then
    od -An -tx1 -N 32 /dev/urandom | tr -d ' \\n'
  else
    "\$REAL_BUN" -e "\${script}"
  fi
else
  echo "unexpected bun command: \$*" >&2
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
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    -*) shift ;;
    *) url="\$1"; shift ;;
  esac
done
case "\${url}" in
  */meta.json) cp "${metaFile}" "\${out}" ;;
  */nano-symphony.tar.gz) cp "${archive}" "\${out}" ;;
  */nano-symphony.tar.gz.sha256) cp "${archive}.sha256" "\${out}" ;;
  */install.sh) cp "${path.join(repoRoot, "install.sh")}" "\${out}" ;;
  *) echo "unexpected url: \${url}" >&2; exit 1 ;;
esac
`
  );

  const env = {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    INSTALL_DIR: installDir,
    BIN_DIR: binDir,
    OSS_BASE_URL: "https://example.test/symphony",
    META_FILE: metaFile,
    REAL_BUN: Bun.argv[0],
  };

  result = run(["bash", path.join(repoRoot, "install.sh")], { env });
  expect(result.exitCode).toBe(0);

  return { installDir, binDir, env };
}

describe("symphony wrapper CLI", () => {
  test("generated wrapper supports report-event with space-separated --kind", async () => {
    const tmp = await makeTempDir();
    const { binDir } = await installWithFakeDeps(tmp);
    const wrapper = await fs.readFile(path.join(binDir, "symphony"), "utf-8");

    // Must parse both --kind VALUE and --kind=VALUE
    expect(wrapper).toContain('--kind) kind="${2:-}"; shift ;');
    expect(wrapper).toContain('--kind=*) kind="${1#--kind=}" ;');
  }, { timeout: 30000 });

  test("generated wrapper embeds data-json directly when valid JSON", async () => {
    const tmp = await makeTempDir();
    const { binDir } = await installWithFakeDeps(tmp);
    const wrapper = await fs.readFile(path.join(binDir, "symphony"), "utf-8");

    expect(wrapper).toContain('if node -e');
    expect(wrapper).toContain('args="{\\"data\\":${data_json}}"');
    expect(wrapper).toContain('args="{\\"data\\":$(json_string "${data_json}")}"');
  }, { timeout: 30000 });

  test("generated wrapper uses python3 for print_json", async () => {
    const tmp = await makeTempDir();
    const { binDir } = await installWithFakeDeps(tmp);
    const wrapper = await fs.readFile(path.join(binDir, "symphony"), "utf-8");

    expect(wrapper).toContain('python3 -m json.tool');
    expect(wrapper).not.toContain("node -e 'const data=require");
  }, { timeout: 30000 });

  test("generated wrapper passes bash syntax check", async () => {
    const tmp = await makeTempDir();
    const { binDir } = await installWithFakeDeps(tmp);
    const wrapperPath = path.join(binDir, "symphony");
    const result = run(["bash", "-n", wrapperPath]);
    expect(result.exitCode).toBe(0);
  }, { timeout: 30000 });
});
