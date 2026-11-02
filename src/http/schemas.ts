import { z } from "zod";

/**
 * Optional user-supplied string that tolerates null, empty string, and undefined.
 * All are normalized to undefined for downstream consumers (Postel's principle: be liberal in what you accept).
 *
 * @param opts.max - Optional maximum string length
 * @returns A zod schema that accepts string | "" | null | undefined and transforms to string | undefined
 */
export function nullishString(opts: { max?: number } = {}) {
  const base = opts.max !== undefined ? z.string().max(opts.max) : z.string();
  return z
    .union([base, z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === null || v === "" ? undefined : v));
}
