const express = require("express");
const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");
const Joi = require("joi");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI;
const mongoDbName = process.env.MONGO_DB_NAME || "job_management";
const claudeApiKey = process.env.CLAUDE_API_KEY;
const claudeModel = process.env.CLAUDE_MODEL || "claude-3-5-sonnet-latest";
const allowedCollections = [
  "jobs",
  "clients",
  "projects",
  "screeningquestionmaincategories",
  "atsscreeningquestiontemplatenames",
  "atssendscreeningtestcandidatelists",
  "atssendscreeningtestemails",
  "candidateswipes",
  "client_poc",
  "clientdetails",
  "clientpeoples",
  "clientsjobs",
  "dashboardjobs",
  "feedbacks",
  "jobsettings",
  "lead_logs",
  "mendatory_delegations",
  "newdashboardjobs",
  "offlinecandidateswipes",
  "open_delegations",
  "project_counters",
  "projectscreeninganswers",
  "projectscreeningquestions",
  "public_job_searches"
];

app.use(cors());
app.use(bodyParser.json({ limit: "200kb" }));
app.use(express.static("public"));

const chatSchema = Joi.object({
  message: Joi.string().trim().min(1).max(1000).required(),
  history: Joi.array().items(Joi.object({
    role: Joi.string().valid("user", "bot"),
    text: Joi.string()
  })).optional()
});

let db;
let client;

async function initDB() {
  if (!mongoUri) {
    throw new Error("MONGO_URI is missing in .env");
  }

  client = new MongoClient(mongoUri);
  await client.connect();
  db = client.db(mongoDbName);
  console.log("MongoDB connected");
}

function extractJsonObject(text) {
  const trimmed = (text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}

function sanitizeObject(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeObject);
  }

  if (value && typeof value === "object") {
    const result = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      // Block mongo operators like $where, $expr etc.
      if (key.startsWith("$")) {
        continue;
      }
      result[key] = sanitizeObject(nestedValue);
    }
    return result;
  }

  return value;
}

function normalizeText(input) {
  return (input || "")
    .toLowerCase()
    .replace(/[?.,!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text, keywords) {
  return keywords.some((word) => text.includes(word));
}

async function callClaude(prompt) {
  const apiKey = (process.env.CLAUDE_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("CLAUDE_API_KEY is missing in .env");
  }

  const activeModel = process.env.CLAUDE_MODEL || "claude-3-5-sonnet-latest";

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: activeModel,
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        timeout: 30000
      }
    );

    return response.data?.content?.[0]?.text || "";
  } catch (error) {
    if (error.response) {
      console.error("Claude API Error Body:", JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

async function generatePlan(userMessage, history = []) {
  const historyText = history.map(h => `${h.role}: ${h.text}`).join('\n');
  const prompt = `
You are a strict JSON planner for a recruiter chatbot.

Key Collections & Schemas:
1) projects (Mapped as "jobs" or "roles"):
   - Fields: _id, project_id, client_name, client_id, project_status (e.g. "draft", "assigned"), status, is_client_deleted (bool), role (array of {role: ""}), primary_skills (array of {skill: "", competency: [{data: ""}]})
2) clients:
   - Fields: _id, client_name, company_website, isDelete (bool), location, status

Query Construction Rules:
- If user asks for "jobs", "roles", or "projects", use "projects" collection.
- For skill filters: {"primary_skills.skill": "Node.js"} or {"primary_skills.skill": {"$regex": "node", "$options": "i"}}.
- For role filters: {"role.role": {"$regex": "engineer", "$options": "i"}}.
- For "deleted": {isDelete: false} for clients, {is_client_deleted: false} for projects.
- IMPORTANT: Use "history" to handle follow-up fragments. If current is "Jo deleted na ho?", apply {isDelete: false} or {is_client_deleted: false} to the previous query's intent.

JSON format:
{
  "action": "query" | "aggregate" | "count" | "reply",
  "type": "topClientsByJobs" | null,
  "collection": string,
  "filter": {},
  "projection": {},
  "sort": {},
  "limit": 10,
  "reply": "..."
}

Conversation History:
${historyText}

User message: "${userMessage}"
`;

  try {
    const raw = await callClaude(prompt);
    console.log("Claude RAW Response:", raw);
    const parsedText = extractJsonObject(raw);
    console.log("Extracted JSON:", parsedText);
    return JSON.parse(parsedText);
  } catch (error) {
    console.error("GeneratePlan Error:", error.message);
    return null;
  }
}

function generateDeterministicPlan(userMessage) {
  const text = normalizeText(userMessage);

  const asksCount = hasAny(text, ["kitne", "count", "total", "how many", "kitna", "number of"]);
  const asksClients = hasAny(text, ["client", "clients", "customer", "customers", "company"]);
  const asksJobs = hasAny(text, ["job", "jobs", "opening", "openings", "vacancy", "vacancies", "project", "projects"]);
  const asksList = hasAny(text, ["list", "dikhao", "dekho", "show", "batao", "nikaalo", "display", "kaunse", "kisne", "kaun"]);
  const asksToday = hasAny(text, ["today", "aaj", "abhee", "now", "recent", "latest"]);
  const asksNonDeleted = hasAny(text, ["non deleted", "active", "not deleted", "undeleted", "saaf", "bin deleted"]);
  const asksTop = hasAny(text, ["top", "sabse", "ranking", "best"]);

  // Build filter
  const filter = {};
  if (asksToday) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    filter.createdAt = { "$gte": today };
  }
  if (asksNonDeleted) {
    // For clients it's isDelete: false, for projects it's project_status !== 'deleted'
    // This is a bit ambiguous in deterministic, so we check collection context later
  }

  // Handle Aggregation: "top 5 clients by jobs"
  if (asksTop && asksClients && (asksJobs || text.includes("job"))) {
    const limitMatch = text.match(/\d+/);
    return {
      action: "aggregate",
      type: "topClientsByJobs",
      limit: limitMatch ? parseInt(limitMatch[0]) : 5
    };
  }

  // Handle Counts
  if (asksCount) {
    const countFilter = { ...filter };
    if (asksClients) {
      if (asksNonDeleted) countFilter.isDelete = false;
      return { action: "count", collection: "clients", filter: countFilter };
    }
    if (asksJobs) {
      if (asksNonDeleted) countFilter.is_client_deleted = false;
      return { action: "count", collection: "projects", filter: countFilter };
    }
  }

  // Handle Lists/Queries
  if (asksList || asksToday || asksNonDeleted) {
    if (asksJobs || (asksClients && asksToday)) { 
      const queryFilter = { ...filter };
      if (asksNonDeleted) queryFilter.is_client_deleted = false;
      return { 
        action: "query", 
        collection: "projects", 
        filter: queryFilter, 
        projection: { client_name: 1, role: 1, project_id: 1, createdAt: 1 }, 
        limit: 10 
      };
    }
    if (asksClients) {
      const queryFilter = { ...filter };
      if (asksNonDeleted) queryFilter.isDelete = false;
      return { 
        action: "query", 
        collection: "clients", 
        filter: queryFilter, 
        projection: { client_name: 1, name: 1, location: 1 }, 
        limit: 10 
      };
    }
  }

  return null;
}

function generateFallbackReply(userMessage) {
  const text = normalizeText(userMessage);

  if (hasAny(text, ["hello", "hi", "hey", "namaste", "salam"])) {
    return "Namaste! Aap Hindi ya English me kuch bhi puch sakte ho - jobs, clients, count, top results, sab handle kar lunga.";
  }

  if (hasAny(text, ["help", "kya kar sakte", "what can you do", "kaise use"])) {
    return "Main Hinglish me queries samajh sakta hoon. Example: 'clients kitne hai', 'latest jobs dikhao', 'top 5 clients by jobs'.";
  }

  if (hasAny(text, ["thanks", "thank you", "shukriya"])) {
    return "Always welcome! Aur koi query ho to pucho.";
  }

  return "Main samajhne ki koshish kar raha hoon. Aap thoda detail me pucho, jaise: 'last 10 jobs dikhao' ya 'top 5 clients by jobs'.";
}

async function runSafeQuery(plan) {
  const collection = plan.collection;
  const limit = Math.min(Math.max(Number(plan.limit) || 10, 1), 20);

  if (!allowedCollections.includes(collection)) {
    throw new Error("Invalid collection requested");
  }

  const safeFilter = sanitizeObject(plan.filter || {});
  const safeProjection = sanitizeObject(plan.projection || {});
  const safeSort = sanitizeObject(plan.sort || {});

  return db
    .collection(collection)
    .find(safeFilter)
    .project(safeProjection)
    .sort(safeSort)
    .limit(limit)
    .toArray();
}

async function runCount(collection) {
  if (!allowedCollections.includes(collection)) {
    throw new Error("Invalid collection requested");
  }
  return db.collection(collection).countDocuments({});
}

async function runAggregation(plan) {
  if (plan.type === "topClientsByJobs") {
    const limit = Math.min(Math.max(Number(plan.limit) || 5, 1), 20);
    return db
      .collection("projects")
      .aggregate([
        {
          $group: {
            _id: "$client_id",
            totalJobs: { $sum: 1 },
            clientName: { $first: "$client_name" }
          }
        },
        { $sort: { totalJobs: -1 } },
        { $limit: limit },
        {
          $project: {
            clientId: "$_id",
            totalJobs: 1,
            clientName: { $ifNull: ["$clientName", "Unknown Client"] }
          }
        }
      ])
      .toArray();
  }

  throw new Error("Unsupported aggregation plan");
}

function formatDataResponse(collection, rows) {
  if (!rows.length) {
    return "Data nahi mila.";
  }

  if (collection === "projects" || collection === "jobs") {
    return rows
      .map((item, index) => {
        const role = item.role && item.role[0] ? item.role[0].role : (item.title || "Untitled Role");
        const client = item.client_name || "Unknown Client";
        const id = item.project_id || "N/A";
        return `${index + 1}. **${role}** at _${client}_ (ID: ${id})`;
      })
      .join("\n");
  }

  if (collection === "clients") {
    return rows
      .map((item, index) => {
        const name = item.client_name || item.name || "Unknown Client";
        const location = item.location || "N/A";
        return `${index + 1}. **${name}** - ${location}`;
      })
      .join("\n");
  }

  return rows.map((item) => JSON.stringify(item)).join("\n");
}

function formatAggregationResponse(plan, rows) {
  if (!rows.length) {
    return "Aggregation data nahi mila.";
  }

  if (plan.type === "topClientsByJobs") {
    return rows
      .map((item, index) => `${index + 1}. ${item.clientName} -> ${item.totalJobs} jobs`)
      .join("\n");
  }

  return rows.map((item) => JSON.stringify(item)).join("\n");
}

app.post("/chat", async (req, res) => {
  const { error, value } = chatSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ reply: "Invalid input" });
  }

  const userMessage = value.message;
  const history = value.history || [];

  try {
    let plan = generateDeterministicPlan(userMessage);

    if (!plan) {
      plan = await generatePlan(userMessage, history);
    }

    if (!plan) {
      return res.json({ reply: generateFallbackReply(userMessage) });
    }

    if (plan.action === "count") {
      const total = await runCount(plan.collection);
      if (plan.collection === "clients") {
        return res.json({ reply: `Humare paas total ${total} clients hain.` });
      }
      return res.json({ reply: `Total ${total} jobs available hain.` });
    }

    if (plan.action === "aggregate") {
      const rows = await runAggregation(plan);
      const response = formatAggregationResponse(plan, rows);
      return res.json({ reply: response });
    }

    if (plan.action === "reply") {
      return res.json({ reply: plan.reply || "Main help karne ke liye ready hoon." });
    }

    if (plan.action !== "query") {
      return res.json({ reply: "Samajh nahi aaya, please thoda aur clear likho." });
    }

    const rows = await runSafeQuery(plan);
    const response = formatDataResponse(plan.collection, rows);
    return res.json({ reply: response });
  } catch (err) {
    console.error("Chat error:", err.message);
    if (axios.isAxiosError(err)) {
      return res.json({
        reply:
          "AI service temporary issue hai. Aap jobs/clients related query pucho, main DB se direct answer de dunga."
      });
    }
    return res.status(500).json({ reply: "Server error" });
  }
});

async function start() {
  try {
    await initDB();
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error("Startup failed:", error.message);
    process.exit(1);
  }
}

start();

process.on("SIGINT", async () => {
  if (client) {
    await client.close();
  }
  process.exit(0);
});
