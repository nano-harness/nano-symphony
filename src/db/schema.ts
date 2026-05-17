import { readFileSync } from "fs";
import { join } from "path";

export const sql = readFileSync(join(import.meta.dir, "schema.sql"), "utf-8");
