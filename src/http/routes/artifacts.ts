import { Hono } from "hono";
import fs from "fs/promises";
import path from "path";
import type { Tracker } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";

export function createArtifactsRoutes(
  tracker: Tracker,
  _getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  _triggerTick: () => void,
  _options?: Record<string, unknown>,
): Hono {
  const app = new Hono();

  app.get("/artifacts", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
    const artifacts = tracker.listRecentArtifacts(limit);
    const items = artifacts.map(({ content, storage_path, ...rest }) => rest);
    return c.json(items);
  });

  app.get("/artifacts/:id", (c) => {
    const artifact = tracker.getArtifact(c.req.param("id"));
    if (!artifact) return c.json({ error: "Not found" }, 404);
    // Omit storage_path from response (internal implementation detail)
    const { storage_path, ...rest } = artifact;
    return c.json(rest);
  });

  app.get("/artifacts/:id/raw", async (c) => {
    const artifact = tracker.getArtifact(c.req.param("id"));
    if (!artifact) return c.json({ error: "Not found" }, 404);

    // Sanitize label before embedding in Content-Disposition to prevent header injection.
    // Strip CR/LF, double-quotes, and backslashes: in RFC 2616 quoted-strings a backslash
    // is an escape prefix (quoted-pair), so an unstripped '\\' followed by '"' would break
    // out of the quoted-string boundary and allow header value injection.
    const rawLabel = (artifact.label ?? artifact.id).replace(/[\r\n"\\]/g, "_");
    const disposition = `attachment; filename="${rawLabel}"`;

    if (artifact.storage_path) {
      try {
        const data = await fs.readFile(artifact.storage_path);
        return new Response(data, {
          headers: {
            "Content-Type": artifact.mime_type,
            "Content-Disposition": disposition,
          },
        });
      } catch {
        return c.json({ error: "File not found on disk" }, 404);
      }
    }

    if (artifact.content) {
      return new Response(artifact.content, {
        headers: {
          "Content-Type": artifact.mime_type,
          "Content-Disposition": disposition,
        },
      });
    }

    // Workspace fallback: resolve file from workspace if artifact has a path.
    // Use fs.realpath to resolve all symlinks before containment check to
    // prevent symlink-escape attacks (agent creates link -> /etc/passwd and
    // reports it as an artifact path).
    if (artifact.path) {
      const run = tracker.getRun(artifact.issue_uuid);
      if (run?.workspace_path) {
        const full = path.resolve(run.workspace_path, artifact.path);
        try {
          const [realFull, realWorkspace] = await Promise.all([
            fs.realpath(full),
            fs.realpath(run.workspace_path),
          ]);
          if (realFull !== realWorkspace && !realFull.startsWith(realWorkspace + path.sep)) {
            return c.json({ error: "path escape denied" }, 403);
          }
          const data = await fs.readFile(realFull);
          return new Response(data, {
            headers: {
              "Content-Type": artifact.mime_type,
              "Content-Disposition": disposition,
            },
          });
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") return c.json({ error: "file not found" }, 404);
          if (code === "EACCES") return c.json({ error: "access denied" }, 403);
          /* fall through to 404 */
        }
      }
    }

    return c.json({ error: "No content available" }, 404);
  });

  return app;
}
