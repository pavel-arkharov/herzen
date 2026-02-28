import { describe, expect, it } from "vitest";
import { createGatewayEnvelope, resolveDefaultLaneKey } from "../src/control/gateway.js";

describe("gateway envelope", () => {
	it("creates envelope with default lane key and trace id", () => {
		const envelope = createGatewayEnvelope({
			sessionId: "session-1",
			source: "stdin",
			payload: { text: "hello" },
			traceIdFactory: () => "trace-1",
		});

		expect(envelope).toEqual({
			sessionId: "session-1",
			traceId: "trace-1",
			source: "stdin",
			laneKey: "session:session-1:trigger",
			payload: { text: "hello" },
		});
	});

	it("maps default lane keys by source", () => {
		expect(resolveDefaultLaneKey("abc", "stdin")).toBe("session:abc:trigger");
		expect(resolveDefaultLaneKey("abc", "wakeword")).toBe("session:abc:trigger");
		expect(resolveDefaultLaneKey("abc", "followup")).toBe("session:abc:followup");
		expect(resolveDefaultLaneKey("abc", "automation")).toBe("session:abc:automation");
		expect(resolveDefaultLaneKey("abc", "tui")).toBe("session:abc:trigger");
	});
});
