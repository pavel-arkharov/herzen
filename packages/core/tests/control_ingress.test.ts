import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createControlIngressReader, controlIngressFilePath } from "../src/control/ingress.js";

function createTempRoot(prefix: string): string {
	const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

describe("control ingress reader", () => {
	it("reads valid chat ingress events incrementally", async () => {
		const root = createTempRoot("control-ingress");
		const controlDir = join(root, "control");
		mkdirSync(controlDir, { recursive: true });
		const ingressFile = controlIngressFilePath(controlDir);
		writeFileSync(
			ingressFile,
			[
				JSON.stringify({
					schemaVersion: "control.ingress.v1",
					ingressId: "ing-1",
					sessionId: "session-1",
					source: "tui",
					command: "chat.send",
					payload: { sessionId: "session-1", text: "hello", source: "tui" },
					ts: "2026-02-27T00:00:00.000Z",
				}),
				JSON.stringify({
					schemaVersion: "control.ingress.v1",
					ingressId: "bad-1",
					sessionId: "session-1",
					source: "tui",
					command: "chat.send",
					payload: { sessionId: "other", text: "bad", source: "tui" },
					ts: "2026-02-27T00:00:01.000Z",
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const reader = createControlIngressReader(controlDir);
		const first = await reader.poll();
		expect(first).toEqual([
			{
				command: "chat.send",
				ingressId: "ing-1",
				sessionId: "session-1",
				text: "hello",
				source: "tui",
				traceId: undefined,
				ts: "2026-02-27T00:00:00.000Z",
			},
		]);

		appendFileSync(
			ingressFile,
			`${JSON.stringify({
				schemaVersion: "control.ingress.v1",
				ingressId: "ing-2",
				sessionId: "session-1",
				source: "tui",
				command: "chat.send",
				payload: { sessionId: "session-1", text: "next", source: "tui" },
				traceId: "trace-2",
				ts: "2026-02-27T00:00:02.000Z",
			})}\n`,
			"utf8",
		);
		appendFileSync(
			ingressFile,
			`${JSON.stringify({
				schemaVersion: "control.ingress.v1",
				ingressId: "ing-3",
				sessionId: "session-1",
				source: "automation",
				command: "chat.send",
				payload: { sessionId: "session-1", text: "auto", source: "automation" },
				ts: "2026-02-27T00:00:03.000Z",
			})}\n`,
			"utf8",
		);

		const second = await reader.poll();
		expect(second).toEqual([
			{
				command: "chat.send",
				ingressId: "ing-2",
				sessionId: "session-1",
				text: "next",
				source: "tui",
				traceId: "trace-2",
				ts: "2026-02-27T00:00:02.000Z",
			},
			{
				command: "chat.send",
				ingressId: "ing-3",
				sessionId: "session-1",
				text: "auto",
				source: "automation",
				traceId: undefined,
				ts: "2026-02-27T00:00:03.000Z",
			},
		]);
	});

	it("parses runtime control commands", async () => {
		const root = createTempRoot("control-ingress-runtime");
		const controlDir = join(root, "control");
		mkdirSync(controlDir, { recursive: true });
		const ingressFile = controlIngressFilePath(controlDir);
		writeFileSync(
			ingressFile,
			[
				JSON.stringify({
					schemaVersion: "control.ingress.v1",
					ingressId: "ing-10",
					sessionId: "session-1",
					source: "tui",
					command: "runtime.set_profile",
					payload: { profile: "text" },
					ts: "2026-02-27T00:00:10.000Z",
				}),
				JSON.stringify({
					schemaVersion: "control.ingress.v1",
					ingressId: "ing-11",
					sessionId: "session-1",
					source: "tui",
					command: "voice.trigger_once",
					payload: {},
					ts: "2026-02-27T00:00:11.000Z",
				}),
				JSON.stringify({
					schemaVersion: "control.ingress.v1",
					ingressId: "ing-12",
					sessionId: "session-1",
					source: "tui",
					command: "wakeword.set_enabled",
					payload: { enabled: false },
					ts: "2026-02-27T00:00:12.000Z",
				}),
				JSON.stringify({
					schemaVersion: "control.ingress.v1",
					ingressId: "ing-13",
					sessionId: "session-1",
					source: "tui",
					command: "runtime.get_status",
					payload: { includeDiagnostics: true },
					ts: "2026-02-27T00:00:13.000Z",
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const reader = createControlIngressReader(controlDir);
		const commands = await reader.poll();
		expect(commands).toEqual([
			{
				command: "runtime.set_profile",
				ingressId: "ing-10",
				sessionId: "session-1",
				source: "tui",
				profile: "text",
				traceId: undefined,
				ts: "2026-02-27T00:00:10.000Z",
			},
			{
				command: "voice.trigger_once",
				ingressId: "ing-11",
				sessionId: "session-1",
				source: "tui",
				traceId: undefined,
				ts: "2026-02-27T00:00:11.000Z",
			},
			{
				command: "wakeword.set_enabled",
				ingressId: "ing-12",
				sessionId: "session-1",
				source: "tui",
				enabled: false,
				traceId: undefined,
				ts: "2026-02-27T00:00:12.000Z",
			},
			{
				command: "runtime.get_status",
				ingressId: "ing-13",
				sessionId: "session-1",
				source: "tui",
				includeDiagnostics: true,
				traceId: undefined,
				ts: "2026-02-27T00:00:13.000Z",
			},
		]);
	});
});
