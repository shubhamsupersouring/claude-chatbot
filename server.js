const express = require("express");
const { MongoClient } = require("mongodb");
const { Pool } = require("pg");
const dotenv = require("dotenv");
const cors = require("cors");
const bodyParser = require("body-parser");
const Joi = require("joi");
const Anthropic = require("@anthropic-ai/sdk");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// MongoDB Config
const mongoUri = process.env.MONGO_URI;
const mongoDbName = process.env.MONGO_DB_NAME || "job_management";

// PostgreSQL Config
const pgPool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || "5432"),
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});
const claudeApiKey = (process.env.CLAUDE_API_KEY || "").trim();
const claudeModel = process.env.CLAUDE_MODEL || "claude-3-5-haiku-20241022";

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

  // MongoDB Connection
  client = new MongoClient(mongoUri);
  await client.connect();
  db = client.db(mongoDbName);
  console.log("MongoDB connected");

  // PostgreSQL Connection Test
  try {
    const pgClient = await pgPool.connect();
    console.log("PostgreSQL connected (job_interaction_prod)");
    pgClient.release();
  } catch (err) {
    console.error("PostgreSQL connection error:", err.message);
  }
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
      const allowedOperators = ["$regex", "$options", "$gte", "$lte", "$ne", "$in", "$nin"];
      if (key.startsWith("$") && !allowedOperators.includes(key)) {
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
You are the "Supersourcing AI Recruitment Brain". Your task is to convert recruitment queries (Hinglish/English) into precise MongoDB JSON plans or PostgreSQL SQL queries.

### LIVE SCHEMA GROUNDING (ALL 4 TABLES):
[MONGO: projects]
Sample: {"_id":"6357ac666dd825bee896ffc6","client_name":"somnoware","role":[{"role":"Backend Engineer"}],"primary_skills":[{"skill":".NET"}],"location":"Bangalore, Karnataka, India","project_id":"SOM0001"}
Use for: Active jobs, skills, roles, client pricing, project status.

[MONGO: clients]
Sample: {"client_name":"paytm","location":"Noida, Uttar Pradesh, India","industry":[{"data":"Finance"}]}
Use for: Company details, location-based company search.

[POSTGRES: job_interactions]
Sample: {"engineer_name":"divyang dave","project_role":"Backend Engineer","status":"rejected","quoted_price":"70000","job_primary_skills":[{"skill":"Python"}],"created_at":"2023-09-21"}
Use for: CANDIDATE STATUS, Hiring history (hired, rejected, shortlisted), candidate status logs.

[POSTGRES: job_actions]
Sample: {"action_by_name":"TOQEER IRSHAD","action_type":"interested","created_at":"2023-08-27"}
Use for: Audit logs, tracking performed actions on candidates.

### CRITICAL ROUTING RULES:
1. "Current Jobs", "Openings", "Active Roles" -> DB: "mongo", Collection: "projects".
2. "Locations", "Client Names", "Company Details" -> DB: "mongo", Collection: "clients".
3. "Who is hired", "Shortlisted count", "Candidate Status", "Historian Data" -> DB: "postgres", Table: "job_interactions".
4. "Audit logs", "Performed actions", "Logs" -> DB: "postgres", Table: "job_actions".
5. To find JOBS/DEMAND in a specific LOCATION (e.g., 'React in Noida') -> Use 'action': 'aggregate', 'db': 'mongo', 'collection': 'projects', and set 'joinClients': true.

### TRAINING GALLERY (FEW-SHOT):
1. User: "Bangalore location me React developers ki demand dikhao"
   JSON: {"action": "aggregate", "db": "mongo", "collection": "projects", "filter": {"primary_skills.skill": {"$regex": "react", "$options": "i"}}, "joinClients": true, "limit": 10}

2. User: "Kaunse candidates hired hue hain?"
   JSON: {"action": "query", "db": "postgres", "sql": "SELECT engineer_name, project_role, client_name, status FROM job_interactions WHERE status = 'hired' LIMIT 10"}

3. User: "Hi"
   JSON: {"action": "reply", "reply": "Namaste! Main Supersourcing assistant hoon. Aap mujhse jobs, hiring status, ya client details ke baare me kuch bhi puch sakte hain."}

JSON format:
{
  "action": "query" | "aggregate" | "count" | "reply",
  "db": "mongo" | "postgres",
  "sql": "SQL string (only for postgres)",
  "collection": "projects" | "clients",
  "filter": {}, 
  "projection": {},
  "limit": 5,
  "joinClients": true | false,
  "reply": "Used for action: 'reply'"
}

User Request: "${userMessage}"
Previous Context:
${historyText}
Current Date: ${currentDate}
`;

  try {
    const raw = await callClaude(prompt);
    console.log("Claude RAW Plan:", raw);
    const parsedText = extractJsonObject(raw);
    return JSON.parse(parsedText);
  } catch (error) {
    console.error("GeneratePlan Error:", error.message);
    throw error;
  }
}

// AI-First Architecture: Deterministic logic and hardcoded fallbacks removed.

// Legacy functions generateDeterministicPlan and generateFallbackReply have been removed.

async function runSafeQuery(plan) {
  const collection = plan.collection;
  const limit = Math.min(Math.max(Number(plan.limit) || 5, 1), 50);

  if (!allowedCollections.includes(collection)) {
    throw new Error("Invalid collection requested");
  }

  const safeFilter = sanitizeObject(plan.filter || {});
  const safeProjection = sanitizeObject(plan.projection || {});
  const safeSort = sanitizeObject(plan.sort || {});

  console.log("MongoDB Query:", JSON.stringify({ collection, safeFilter, safeProjection, safeSort, limit }, null, 2));

  return db
    .collection(collection)
    .find(safeFilter)
    .project(safeProjection)
    .sort(safeSort)
    .limit(limit)
    .toArray();
}

async function runCount(plan) {
  const collection = plan.collection;
  if (!allowedCollections.includes(collection)) {
    throw new Error("Invalid collection requested");
  }
  const safeFilter = sanitizeObject(plan.filter || {});
  console.log("MongoDB Count Query:", JSON.stringify({ collection, safeFilter }, null, 2));
  return db.collection(collection).countDocuments(safeFilter);
}

async function runAggregation(plan) {
  const limit = Math.min(Math.max(Number(plan.limit) || 5, 1), 50);
  const pipeline = [];

  // 1. Initial Filtering on Projects (Skills, IDs, etc.)
  if (plan.filter && Object.keys(plan.filter).length > 0) {
    pipeline.push({ $match: sanitizeObject(plan.filter) });
  }

  // 2. Join with Clients (Mandatory for location/industry filters on projects)
  if (plan.joinClients) {
    pipeline.push({
      $lookup: {
        from: "clients",
        localField: "client_id",
        foreignField: "_id",
        as: "client_details"
      }
    });
    pipeline.push({ $unwind: "$client_details" });

    // Handle nested filters if AI provided them (e.g., client location)
    // Note: If the AI puts location in top level filter, we might need to handle it or instruct it to use client_details prefix.
  }

  // 3. Define the aggregation type
  if (plan.type === "topClientsByJobs" || plan.action === "aggregate") {
    pipeline.push({
      $group: {
        _id: "$client_id",
        totalJobs: { $sum: 1 },
        clientName: { $first: plan.joinClients ? "$client_details.client_name" : "$client_name" },
        location: { $first: plan.joinClients ? "$client_details.location" : null }
      }
    });
    pipeline.push({ $sort: { totalJobs: -1 } });
    pipeline.push({ $limit: limit });
    pipeline.push({
      $project: {
        _id: 0,
        clientId: "$_id",
        totalJobs: 1,
        clientName: { $ifNull: ["$clientName", "Unknown Client"] },
        location: 1
      }
    });

    console.log("MongoDB Aggregation Pipeline:", JSON.stringify({ collection: "projects", pipeline }, null, 2));
    return db.collection("projects").aggregate(pipeline).toArray();
  }

  throw new Error(`Unsupported aggregation plan.`);
}

async function runPostgresQuery(plan) {
  const sql = plan.sql;
  if (!sql) throw new Error("SQL query is missing in plan");

  // Basic SQL Injection check (Claude should lead, but we sanitize)
  const forbidden = ["DROP", "DELETE", "UPDATE", "INSERT", "TRUNCATE", "ALTER"];
  const upperSql = sql.toUpperCase();
  if (forbidden.some(word => upperSql.includes(word))) {
    throw new Error("Only SELECT queries are allowed for safety");
  }

  console.log("PostgreSQL Query:", sql);
  const result = await pgPool.query(sql);
  return result.rows;
}

function formatDataResponse(collection, rows) {
  if (!rows.length) {
    return "Data nahi mila.";
  }

  if (collection === "PostgreSQL Interactions") {
    return rows.map((item, index) => {
      const name = item.engineer_name || "Engineer";
      const status = item.status || "N/A";
      const role = item.project_role || "N/A";
      const price = item.final_price || item.quoted_price || "N/A";
      return `${index + 1}. **${name}** - Status: ${status} (Role: ${role}, Price: ${price})`;
    }).join("\n");
  }

  if (collection === "projects" || collection === "jobs") {
    return `**Collection: projects**\n` + rows
      .map((item, index) => {
        const role = item.role && item.role[0] ? item.role[0].role : (item.title || "Untitled Role");
        const client = item.client_name || "Unknown Client";
        const id = item.project_id || "N/A";
        const amount = item.ss_price ? ` - ₹${item.ss_price.toLocaleString()}` : "";
        return `${index + 1}. **${role}** at _${client}_ (ID: ${id})${amount}`;
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
    return "Mausam toh accha hai, par is criteria ke liye koi matching records nahi mile.";
  }

  return `### Aggregation Results\n` + rows
    .map((item, index) => {
      const name = item.clientName || "Unknown Client";
      const total = item.totalJobs || 0;
      const loc = item.location ? ` (${item.location})` : "";
      return `${index + 1}. **${name}**${loc} -> ${total} matching assignments found.`;
    })
    .join("\n");
}

async function generateFinalResponse(userQuery, rows, collection) {
  if (!rows || !rows.length) return "Data nahi mila.";

  const prompt = `
You are the "Supersourcing AI Recruitment Assistant". 
User asked: "${userQuery}"
I found these results in the "${collection}" collection:
${JSON.stringify(rows, null, 2)}

Please summarize these results using a PREMIUM HTML FORMAT (No Emojis in headers). Use standard HTML <table>, <tr>, <td> tags.

Format Structure:
1. <h1>[Company/Collection] Results</h1>
2. <p>(Friendly professional greeting in Hinglish)</p>
3. <hr>
4. <h2>Primary Results</h2>
   (Generate a clean HTML <table> with headers: Role, Company, Status/ID, Price, etc.)
5. <hr>
6. <h3>Key Highlights</h3>
   (Use <ul> and <li> for requirements and pro-tips)
7. <h3>Next Steps</h3>
   (Numbered list for actions)

### ANALYTICS & CHARTS (NEW):
If the data contains distributions, counts, or multiple categories (e.g., jobs per skill, status counts), include a chart using this pattern:
<div class="chart-container">
  <canvas class="chat-chart" data-type="bar" data-labels='["Cat1", "Cat2"]' data-values="[10, 20]" data-label="Job Distribution"></canvas>
</div>

### DATA HANDLING RULE:
- If processing "Aggregated Data", the records will contain 'clientName', 'totalJobs', and potentially 'location'.
- ALWAYS create a clean table showing these fields.
- For "projects" or "jobs", show Role, Client, and Price.
- Always provide a brief summary in professional Hinglish.
`;

  try {
    return await callClaude(prompt);
  } catch (error) {
    console.error("Final Response Error:", error.message);
    return formatDataResponse(collection, rows);
  }
}

app.post("/chat", async (req, res) => {
  const { error, value } = chatSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ reply: "Invalid input" });
  }

  const userMessage = value.message;
  const history = value.history || [];

  try {
    const plan = await generatePlan(userMessage, history);

    if (!plan) {
      return res.json({ reply: "Maaf kijiye, main ye query samajh nahi pa raha hoon. Kya aap thoda detail me bata sakte hain?" });
    }

    if (plan.action === "count") {
      const total = await runCount(plan);
      const prefix = plan.filter && Object.keys(plan.filter).length > 0 ? "Result: " : "Total ";
      if (plan.collection === "clients") {
        return res.json({ reply: `${prefix}${total} clients hain.` });
      }
      return res.json({ reply: `${prefix}${total} jobs hain.` });
    }

    if (plan.action === "aggregate") {
      const rows = await runAggregation(plan);
      const aiResponse = await generateFinalResponse(userMessage, rows, "Aggregated Data");
      return res.json({ reply: aiResponse });
    }

    if (plan.action === "reply") {
      return res.json({ reply: plan.reply || "Main help karne ke liye ready hoon." });
    }

    if (plan.action === "query") {
      let rows;
      if (plan.db === "postgres") {
        rows = await runPostgresQuery(plan);
      } else {
        rows = await runSafeQuery(plan);
      }
      
      const aiResponse = await generateFinalResponse(userMessage, rows, plan.db === "postgres" ? "PostgreSQL Interactions" : plan.collection);
      return res.json({ reply: aiResponse });
    }

    return res.json({ reply: "Samajh nahi aaya, please thoda aur clear likho." });
  } catch (err) {
    console.error("Chat Global Error:", err.message);
    
    let friendlyMessage = "Maaf kijiye, abhi system me thoda load hai. Kya aap query ko thoda aur simple karke puch sakte hain? Main koshish karunga ki aapka kaam ho jaye.";
    
    if (err.name === "AnthropicError" || err.status === 429) {
      friendlyMessage = "AI response me thodi deri ho rahi hai. Aap ek minute baad try karein ya simple counts (total jobs) pucho.";
    } else if (err.message.includes("Mongo") || err.message.includes("Postgres")) {
      friendlyMessage = "Database se connect karne me problem aa rahi hai. Hamari team ispe kaam kar rahi hai, please thodi der baad try karein.";
    }
    
    // NEVER RETURN 500 TO USER
    return res.json({ 
      reply: `<h1>System Update</h1><p>${friendlyMessage}</p>` 
    });
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
