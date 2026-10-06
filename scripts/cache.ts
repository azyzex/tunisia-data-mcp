// Tiny on-disk cache for the build scripts, so an interrupted run (INS goes
// down mid-way surprisingly often) resumes instead of starting over. Entries
// expire after 7 days so a later build really refreshes the data.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export function readCache(file: string, ignoreAge = false): string | undefined {
	if (!existsSync(file)) return undefined;
	if (!ignoreAge && Date.now() - statSync(file).mtimeMs > MAX_AGE_MS) return undefined;
	return readFileSync(file, "utf8");
}

export function writeCache(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}
