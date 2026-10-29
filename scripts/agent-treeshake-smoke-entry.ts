import { Agent } from "@bramburn/qi-agent-core";
import { createModels } from "@bramburn/qi-ai";
import { anthropicProvider } from "@bramburn/qi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
