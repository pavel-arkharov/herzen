import { describe, expect, it } from "vitest";
import { WakeWordTriggerSource } from "../src/trigger/wakeword.js";

describe("WakeWordTriggerSource", () => {
	it("throws NOT_IMPLEMENTED from nextTrigger", async () => {
		const source = new WakeWordTriggerSource();

		await expect(source.nextTrigger()).rejects.toMatchObject({
			name: "TriggerError",
			code: "NOT_IMPLEMENTED",
		});
	});

	it("keeps start/stop as safe no-ops", () => {
		const source = new WakeWordTriggerSource();

		expect(() => source.start()).not.toThrow();
		expect(() => source.stop()).not.toThrow();
	});
});
