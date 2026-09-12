/**
 * TypeBox schemas for the 8 experiment tools.
 *
 * Each schema is intentionally small — descriptions are short and named
 * clearly. The LLM sees these via the tool's `description` and `parameters`,
 * so they double as inline documentation.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const StartParams = Type.Object({
	hypothesis: Type.String({ description: "Falsifiable claim. One sentence. What would disprove it?" }),
	approach_name: Type.String({
		description: "Kebab-case slug for the candidate (e.g. 'bun-ipc-worker').",
		pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$",
	}),
	parent_commit: Type.Optional(Type.String({ description: "Git SHA to fork from. Default: HEAD." })),
});

export const RunParams = Type.Object({
	experiment_id: Type.String({ description: "ID returned by experiment_start." }),
	command: Type.String({ description: "Shell command to run inside the worktree." }),
	timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms. Default: 600000 (10 min)." })),
});

export const TestParams = Type.Object({
	experiment_id: Type.String({ description: "ID returned by experiment_start." }),
	filter: Type.Optional(Type.String({ description: "Test name pattern (passed to the runner)." })),
});

export const DiffParams = Type.Object({
	experiment_id: Type.String({ description: "ID returned by experiment_start." }),
});

export const MergeParams = Type.Object({
	experiment_id: Type.String({ description: "ID returned by experiment_start (the winner)." }),
	strategy: StringEnum(["cherry-pick", "squash", "merge"] as const, {
		description:
			"Transfer strategy. cherry-pick: clean atomic commit. squash: one commit from all WIP. merge: keep experimental history.",
	}),
	squash_message: Type.Optional(
		Type.String({ description: "Required when strategy='squash'. The squash commit message." }),
	),
});

export const DiscardParams = Type.Object({
	experiment_id: Type.String({ description: "ID returned by experiment_start." }),
	keep_branch: Type.Optional(
		Type.Boolean({ description: "Default true. Keep the branch (and WHY_IT_FAILED.md) for archaeology." }),
	),
	reason: Type.String({ description: "One line: why this experiment was discarded." }),
});

export const ListParams = Type.Object({
	status: Type.Optional(
		StringEnum(["scaffolded", "running", "completed", "failed", "merged", "discarded", "cancelled", "all"] as const),
	),
});

export const CompareParams = Type.Object({
	exp_id_1: Type.String({ description: "First experiment ID." }),
	exp_id_2: Type.String({ description: "Second experiment ID." }),
	axes: Type.Optional(
		Type.Array(Type.String(), { description: "Benchmark axes to compare. Default: all numeric fields." }),
	),
});
