const Anthropic = require("@anthropic-ai/sdk");
const dotenv = require("dotenv");
dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY.trim(),
});

async function testModels() {
  const models = ["claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229"];
  for (const model of models) {
    console.log(`--- Testing Model: ${model} ---`);
    try {
      const res = await callClaudeWithModel(model, "Reply with 'JSON_OK' if you can read this.");
      console.log(`[${model}] SUCCESS:`, res);
      return; // Found one!
    } catch (err) {
      console.error(`[${model}] ERROR ${err.status}:`, err.message);
    }
  }
}

async function callClaudeWithModel(model, prompt) {
  const msg = await anthropic.messages.create({
    model: model,
    max_tokens: 10,
    messages: [{ role: "user", content: prompt }],
  });
  return msg.content[0].text;
}

testModels();
