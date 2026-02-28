import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCoreStatusWriter, readCoreStatusSnapshot } from "../src/control/core_status.js";

describe("core status heartbeat", () => {
	it("writes and reads status snapshots", async () => {
		const root = await mkdtemp(join(tmpdir(), "herzen-core-status-"));
		try {
			const controlDir = join(root, "control");
			const writer = createCoreStatusWriter({
				controlDir,
				sessionId: "session-1",
				initialProfile: "voice",
			});
			await writer.update({
				coreState: "ready",
				triggerState: "ready",
				wakewordState: "disabled",
			});

			const snapshot = await readCoreStatusSnapshot(controlDir);
			expect(snapshot).toMatchObject({
				schemaVersion: "core.status.v1",
				sessionId: "session-1",
				profile: "voice",
				coreState: "ready",
				triggerState: "ready",
				wakewordState: "disabled",
				sttState: "ready",
				ttsState: "ready",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
