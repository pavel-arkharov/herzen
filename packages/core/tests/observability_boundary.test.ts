import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));

function extractImportSpecifiers(sourceCode: string): string[] {
	const specs: string[] = [];
	const pattern = /^\s*import\s+(?:.+?\s+from\s+)?["']([^"']+)["'];?\s*$/gm;
	let match = pattern.exec(sourceCode);
	while (match) {
		specs.push(match[1] ?? "");
		match = pattern.exec(sourceCode);
	}
	return specs;
}

async function assertNodeOnlyImports(filePath: string): Promise<void> {
	const sourceCode = await readFile(filePath, "utf8");
	const importSpecifiers = extractImportSpecifiers(sourceCode);
	const invalid = importSpecifiers.filter((specifier) => !specifier.startsWith("node:"));

	expect(
		invalid,
		`Expected Node-only imports in ${filePath}, found: ${invalid.join(", ")}`,
	).toEqual([]);
}

describe("observability extraction guardrail", () => {
	it("keeps dialog journal and tail modules dependency-light", async () => {
		await assertNodeOnlyImports(resolve(testDir, "../src/dialog_journal.ts"));
		await assertNodeOnlyImports(resolve(testDir, "../src/dialog_tail.ts"));
	});
});
