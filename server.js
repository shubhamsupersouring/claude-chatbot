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

### TRAINING GALLERY (FEW-SHOT EXAMPLES)
1. User: "Node.js developers ki jobs dikhao"
   JSON: {"action": "query", "db": "mongo", "collection": "projects", "filter": {"primary_skills.skill": {"$regex": "node", "$options": "i"}}, "projection": {"client_name":1, "role":1, "project_id":1, "ss_price":1}, "limit": 5}

2. User: "Top 10 clients nikaalo"
   JSON: {"action": "query", "db": "mongo", "collection": "clients", "filter": {}, "projection": {"client_name":1, "location":1}, "limit": 10}

3. User: "Kaunse candidate hired hue?"
   JSON: {"action": "query", "db": "postgres", "sql": "SELECT * FROM job_interactions WHERE status = 'hired' LIMIT 5"}

4. User: "Project ID PAY0003 ke saare actions dikhao"
   JSON: {"action": "query", "db": "postgres", "sql": "SELECT * FROM job_actions WHERE project_id = 'PAY0003' ORDER BY created_at DESC"}

### DEEP SCHEMA GROUNDING
**[DB: mongo]**
- [COLLECTION: projects] -> Use for finding "active jobs", "skill-based search", "budget info". Fields: project_id, client_name, role, primary_skills, ss_price, is_client_deleted, createdAt.
- [COLLECTION: clients] -> Use for "client details", "location search". Fields: client_name, location, industry, isDelete.

**[DB: postgres]**
- [TABLE: job_interactions] -> MANDATORY for "hiring status", "interaction history", "candidate status", "shortlisted candidates".
  Columns: id, engineer_name, project_id, project_role, client_name, status, quoted_price, final_price, created_at.
- [TABLE: job_actions] -> Use for "audit logs", "action history".
  Columns: id, interaction_id, action_type, performer_name, project_id.

### ROUTING RULE
- If query is about "job openings" or "finding roles" -> db: "mongo".
- If query is about "who is hired", "shortlisting status", "hiring interactions", or "candidate history" -> db: "postgres".

### HTML FORMATTING RULE
Always generate the final response using clean HTML tables for data. DO NOT use emojis in headers.

### LIMIT RULE
- DEFAULT limit is 5.
- If the user explicitly asks for a specific count (e.g., "50 clients", "Top 10 jobs"), ALWAYS respect that count in the "limit" field or SQL LIMIT clause.

JSON format:
{
  "action": "query" | "aggregate" | "count" | "reply",
  "db": "mongo" | "postgres",
  "sql": "SQL query string (only if db is postgres)",
  "collection": "projects" | "clients",
  "filter": {},
  "projection": {},
  "sort": {"createdAt": -1},
  "limit": 5,
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
        projection: { client_name: 1, role: 1, project_id: 1, createdAt: 1, ss_price: 1 }, 
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
  if (plan.type === "topClientsByJobs" || plan.type === "clientsByProjectCount") {
    const limit = Math.min(Math.max(Number(plan.limit) || 5, 1), 50);
    const minProjects = Number(plan.minProjects) || 0;

    const pipeline = [
      {
        $group: {
          _id: "$client_id",
          totalJobs: { $sum: 1 },
          clientName: { $first: "$client_name" }
        }
      }
    ];

    // Add filter for minimum projects if requested
    if (minProjects > 0) {
      pipeline.push({ $match: { totalJobs: { $gt: minProjects } } });
    }

    pipeline.push({ $sort: { totalJobs: -1 } });
    pipeline.push({ $limit: limit });
    pipeline.push({
      $project: {
        clientId: "$_id",
        totalJobs: 1,
        clientName: { $ifNull: ["$clientName", "Unknown Client"] }
      }
    });

    console.log("MongoDB Aggregation Pipeline:", JSON.stringify({ collection: "projects", pipeline }, null, 2));
    return db.collection("projects").aggregate(pipeline).toArray();
  }

  throw new Error(`Unsupported aggregation plan type: ${plan.type}`);
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
    return "Mausam toh accha hai, par is criteria ke liye koi clients nahi mile.";
  }

  if (plan.type === "topClientsByJobs" || plan.type === "clientsByProjectCount") {
    const minStr = plan.minProjects ? ` (more than ${plan.minProjects} projects)` : "";
    return `**Found ${rows.length} Clients${minStr}:**\n` + rows
      .map((item, index) => `${index + 1}. **${item.clientName}** -> ${item.totalJobs} jobs`)
      .join("\n");
  }

  return rows.map((item) => JSON.stringify(item)).join("\n");
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

### MANDATORY STYLE RULES:
1. ONLY return the HTML fragment (no <html>, <head>, <body>, or <!DOCTYPE> tags).
2. DO NOT wrap the response in markdown code blocks.
3. DO NOT include <style> or <script> tags.
4. NO EMOJIS in any header text.
5. Use professional clean HTML tables for primary data.
6. Language: Professional Hinglish.
7. If no data results found, provide a polite explanation in HTML.
8. Do NOT use markdown tables; use ONLY HTML tagged tables.
9. ALWAYS ensure the labels and values in the chart match the summarized data.
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
    let plan = generateDeterministicPlan(userMessage);

    if (!plan) {
      plan = await generatePlan(userMessage, history);
    }

    if (!plan) {
      return res.json({ reply: generateFallbackReply(userMessage) });
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
