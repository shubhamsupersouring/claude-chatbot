const express = require("express");
const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
const cors = require("cors");
const bodyParser = require("body-parser");
const Joi = require("joi");
const Anthropic = require("@anthropic-ai/sdk");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI;
const mongoDbName = process.env.MONGO_DB_NAME || "job_management";
const claudeApiKey = (process.env.CLAUDE_API_KEY || "").trim();
const claudeModel = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

const anthropic = new Anthropic({
  apiKey: claudeApiKey,
});
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
  if (!claudeApiKey) {
    throw new Error("CLAUDE_API_KEY is missing in .env");
  }

  try {
    const msg = await anthropic.messages.create({
      model: claudeModel,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    return msg.content[0].text || "";
  } catch (error) {
    console.error("Anthropic SDK Error:", error.message);
    if (error.status === 404) {
      console.warn("Model not found. Please verify model name and account permissions.");
    }
    throw error;
  }
}

async function generatePlan(userMessage, history = []) {
  const historyText = history.map(h => `${h.role}: ${h.text}`).join('\n');
  const currentDate = new Date().toISOString();

  const prompt = `
You are the "Supersourcing AI Recruitment Brain". Your task is to convert recruitment queries (Hinglish/English) into precise MongoDB JSON plans.

### TRAINING GALLERY (FEW-SHOT EXAMPLES)
1. User: "Node.js roles dikhao"
   JSON: {"action": "query", "collection": "projects", "filter": {"primary_skills.skill": {"$regex": "node", "$options": "i"}}, "projection": {"client_name":1, "role":1, "project_id":1}, "limit": 10}

2. User: "Top 5 clients nikaalo"
   JSON: {"action": "query", "collection": "clients", "filter": {}, "projection": {"client_name":1, "location":1}, "limit": 5}

3. User: "Aaj kitne projects add hue?"
   JSON: {"action": "count", "collection": "projects", "filter": {"createdAt": {"$gte": "${currentDate.split('T')[0]}T00:00:00Z"}}}

4. User: "Jo deleted na ho?" (Contextual)
   JSON: {"action": "query", "filter": {"is_client_deleted": false}, "limit": 10}

### DEEP SCHEMA GROUNDING
[COLLECTION: projects] -> Use for "jobs", "roles", "projects", "openings".
- Fields: project_id (ID), client_name (Company), role (Array: {role: "Title"}), primary_skills (Array: {skill: "Name"}), is_client_deleted (Bool: Deletion flag), createdAt (Date).

[COLLECTION: clients] -> Use for "clients", "companies", "customers".
- Fields: client_name (Name), location (City/State), industry (Array: {data: "Sector"}), isDelete (Bool: Deletion flag).

### LANGUAGE MAPPING (HINGLISH)
- "dikhao", "nikaalo", "list", "show" -> action: "query"
- "kitne", "count", "number", "total" -> action: "count"
- "aaj" (today) -> createdAt >= ${currentDate.split('T')[0]}
- "deleted na ho", "active", "non-deleted" -> projects.is_client_deleted: false OR clients.isDelete: false

JSON format:
{
  "action": "query" | "aggregate" | "count" | "reply",
  "type": "topClientsByJobs" | null,
  "collection": "projects" | "clients",
  "filter": {},
  "projection": {},
  "sort": {"createdAt": -1},
  "limit": 10,
  "reply": "Used only if action is 'reply'"
}

Previous Conversation:
${historyText}

Current Date Context: ${currentDate}
User Request: "${userMessage}"
`;

  try {
    const raw = await callClaude(prompt);
    console.log("Claude RAW Response:", raw);
    const parsedText = extractJsonObject(raw);
    console.log("Extracted JSON:", parsedText);
    return JSON.parse(parsedText);
  } catch (error) {
    console.error("GeneratePlan Error:", error.message);
    
    // --- Smart Fallback for Recruitment Queries (Claude Alternative) ---
    const text = normalizeText(userMessage);
    const asksJobs = hasAny(text, ["job", "jobs", "role", "role", "project", "projects", "opening"]);
    const asksClients = hasAny(text, ["client", "clients", "company", "companies"]);
    const asksCount = hasAny(text, ["kitne", "count", "total", "number"]);
    
    if (asksJobs || asksClients) {
      const plan = {
        action: asksCount ? "count" : "query",
        collection: asksJobs ? "projects" : "clients",
        filter: {},
        projection: asksJobs ? { client_name: 1, role: 1, project_id: 1 } : { client_name: 1, name: 1, location: 1 },
        limit: 10
      };

      // Handle Skill filters
      if (text.includes("node")) plan.filter = { "primary_skills.skill": { "$regex": "node", "$options": "i" } };
      if (text.includes("react")) plan.filter = { "primary_skills.skill": { "$regex": "react", "$options": "i" } };
      
      // Handle Deletion filters
      if (text.includes("deleted na ہو") || text.includes("non deleted") || text.includes("not deleted") || text.includes("undeleted")) {
        if (asksJobs) plan.filter.is_client_deleted = false;
        if (asksClients) plan.filter.isDelete = false;
      }

      console.log("Using Smart Fallback Plan:", JSON.stringify(plan));
      return plan;
    }
    
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
    return `**Collection: projects**\n` + rows
      .map((item, index) => {
        const role = item.role && item.role[0] ? item.role[0].role : (item.title || "Untitled Role");
        const client = item.client_name || "Unknown Client";
        const id = item.project_id || "N/A";
        return `${index + 1}. **${role}** at _${client}_ (ID: ${id})`;
      })
      .join("\n");
  }

  if (collection === "clients") {
    return `**Collection: clients**\n` + rows
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
