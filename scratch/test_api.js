
const Anthropic = require("@anthropic-ai/sdk");
const dotenv = require("dotenv");
dotenv.config();

const claudeApiKey = (process.env.CLAUDE_API_KEY || "").trim();
const claudeModel = process.env.CLAUDE_MODEL || "claude-haiku-4-5";

const anthropic = new Anthropic({
  apiKey: claudeApiKey,
});

async function test() {
  console.log("Testing Claude API...");
  console.log("Model:", claudeModel);
  try {
    const msg = await anthropic.messages.create({
      model: claudeModel,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });
    console.log("Success!");
    console.log("Response:", msg.content[0].text);
  } catch (error) {
    console.error("Error Name:", error.constructor.name);
    console.error("Error Status:", error.status);
    console.error("Error Message:", error.message);
    if (error.error) {
      console.error("Raw Error Data:", JSON.stringify(error.error, null, 2));
    }
  }
}

test();
