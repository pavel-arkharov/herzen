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

function resolveLocalImportPath(fromFilePath: string, specifier: string): string {
	const base = resolve(dirname(fromFilePath), specifier);
	if (base.endsWith(".js")) return `${base.slice(0, -3)}.ts`;
	return `${base}.ts`;
}

async function assertDependencyLightImports(
	filePath: string,
	visited: Set<string> = new Set(),
): Promise<void> {
	if (visited.has(filePath)) return;
	visited.add(filePath);

	const sourceCode = await readFile(filePath, "utf8");
	const importSpecifiers = extractImportSpecifiers(sourceCode);
	const invalid: string[] = [];

	for (const specifier of importSpecifiers) {
		if (specifier.startsWith("node:")) continue;
		if (!specifier.startsWith(".")) {
			invalid.push(specifier);
			continue;
		}
		await assertDependencyLightImports(resolveLocalImportPath(filePath, specifier), visited);
	}

	expect(
		invalid,
		`Expected dependency-light imports in ${filePath}, found: ${invalid.join(", ")}`,
	).toEqual([]);
}

describe("observability extraction guardrail", () => {
	it("keeps dialog journal and tail modules dependency-light", async () => {
		await assertDependencyLightImports(resolve(testDir, "../src/conversation/journal.ts"));
		await assertDependencyLightImports(resolve(testDir, "../src/conversation/stream.ts"));
		await assertDependencyLightImports(resolve(testDir, "../src/observability/perf_journal.ts"));
	});
});
