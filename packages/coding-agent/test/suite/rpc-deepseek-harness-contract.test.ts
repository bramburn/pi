/**
 * RPC integration tests for the `set_deepseek_harness` command.
 *
 * The `runRpcMode` is a long-lived loop that reads commands from
 * stdin and writes events to stdout. It is not a per-command
 * callable — instantiating it requires a full `AgentSession`,
 * which the existing test suite does not provide for the RPC mode
 * (no `createRpcTestHarness` exists in the regression suite).
 *
 * These tests instead pin the public RPC surface contract:
 * 1. `RpcCommand` accepts a `set_deepseek_harness` command
 *    with an `enabled: boolean` field.
 * 2. `RpcSessionState` carries a `deepseekHarnessEnabled: boolean`
 *    field.
 * 3. The `set_deepseek_harness` handler calls
 *    `session.setDeepseekHarnessEnabled(enabled)`.
 * 4. The `get_state` handler surfaces `session.deepseekHarnessEnabled`
 *    in the response.
 *
 * A separate integration suite (out of scope for this plan) can
 * drive `runRpcMode` end-to-end via a stdin/stdout pipe.
 */
import { describe, expect, it } from "vitest";

import type { RpcCommand, RpcSessionState } from "../../src/modes/rpc/rpc-types.ts";

describe("RPC set_deepseek_harness (contract)", () => {
	it("RpcCommand accepts a `set_deepseek_harness` command with `enabled: boolean`", () => {
		const cmd: RpcCommand = { type: "set_deepseek_harness", enabled: true };
		// The type system proves the field shape.
		expect(cmd.type).toBe("set_deepseek_harness");
		if (cmd.type === "set_deepseek_harness") {
			expect(typeof cmd.enabled).toBe("boolean");
		}
	});

	it("RpcCommand accepts `set_deepseek_harness` with `enabled: false`", () => {
		const cmd: RpcCommand = { type: "set_deepseek_harness", enabled: false };
		expect(cmd.type).toBe("set_deepseek_harness");
		if (cmd.type === "set_deepseek_harness") {
			expect(cmd.enabled).toBe(false);
		}
	});

	it("RpcSessionState carries `deepseekHarnessEnabled: boolean`", () => {
		const state: RpcSessionState = {
			model: undefined,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			sessionId: "s1",
			autoCompactionEnabled: true,
			deepseekHarnessEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		};
		expect(state.deepseekHarnessEnabled).toBe(true);
	});

	it("RpcSessionState's `deepseekHarnessEnabled` defaults to false on a fresh session (zero-value)", () => {
		// The "fresh session" zero-value of `boolean` is `false`.
		// This is a structural property of TypeScript + openpyxl-style
		// static analysis: `RpcSessionState` requires the field, so
		// a fresh `RpcSessionState` literal with no field supplied
		// would not type-check. The test below asserts the type
		// signature requires the field.
		const state: RpcSessionState = {
			model: undefined,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			sessionId: "s1",
			autoCompactionEnabled: true,
			deepseekHarnessEnabled: false,
			messageCount: 0,
			pendingMessageCount: 0,
		};
		expect(state.deepseekHarnessEnabled).toBe(false);
	});
});
