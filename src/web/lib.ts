import "server-only";
import { openLibrary, type Library } from "@/src/core";

const g = globalThis as unknown as { __componentLibrary?: Library };

/** One open database per server process (survives dev hot reloads). */
export function getLib(): Library {
  if (!g.__componentLibrary) g.__componentLibrary = openLibrary();
  return g.__componentLibrary;
}
