require("dotenv").config();

const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 27121;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ZAI_API_KEY = process.env.ZAI_API_KEY;

// Health
app.get("/health", (_req, res) => {
  res.json({ status: "ok", providers: { openrouter: !!OPENROUTER_API_KEY, zai: !!ZAI_API_KEY } });
});

// Sanitize delta function
function sanitizeDelta(s) {
  if (!s) return "";
  // drop obvious chain-of-thought markers
  return s
    .replace(/^\s*(thinking|analysis)\b.*$/i, "")   // line starts with thinking/analysis
    .replace(/\bassistantfinal\b:?/ig, "")          // remove 'assistantfinal' tokens
    .replace(/\b(system|assistant|user):(?!\/\/)/ig, "") // stray role markers
    .replace(/(?<=\n)- /g, "• "); 
}

// Existing /complete endpoint (you can keep this if needed)
app.post("/complete", async (req, res) => {
  const { prefix, suffix, provider = "openrouter", model = process.env.DEFAULT_MODEL } = req.body;

  logRequest("complete", { provider, prefixLength: prefix?.length, suffixLength: suffix?.length });

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    let stream;
    if (provider === "zai") {
      stream = callZai(model, prefix, suffix);
    } else {
      stream = callOpenRouter(model, prefix, suffix);
    }
    for await (const delta of stream) {
      const clean = sanitizeDelta(delta);
      if (clean.trim()) res.write(JSON.stringify({ type: "delta", data: clean }) + "\n");
    }
    res.write(JSON.stringify({ type: "end", data: { usage: {} } }) + "\n");
    res.end();
  } catch (err) {
    console.error("Error:", err);
    res.write(JSON.stringify({ type: "error", data: { message: err.message } }) + "\n");
    res.end();
  }
});

// NEW /chat endpoint
app.post("/chat", async (req, res) => {
  const { message, lang, filePath, prefix, suffix, provider = "openrouter", model = process.env.DEFAULT_MODEL } = req.body;

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    const messages = buildChatPrompt({ message, lang, filePath, prefix, suffix });

    const stream = (provider === "zai")
      ? callZaiStream(model, messages)
      : callOpenRouterStream(model, messages);

    for await (const delta of stream) {
      const clean = sanitizeDelta(delta);
      if (clean.trim()) res.write(JSON.stringify({ type: "delta", data: clean }) + "\n");
    }
    res.write(JSON.stringify({ type: "end", data: {} }) + "\n");
    res.end();
  } catch (e) {
    res.write(JSON.stringify({ type: "error", data: { message: e.message } }) + "\n");
    res.end();
  }
});

function buildChatPrompt({ message, lang, filePath, prefix, suffix }) {
  return [
    {
      role: "system",
      content:
        "You are AJ’s coding assistant, integrated into VSCodium." +
        "Your role:" +
        "Provide accurate, concise, and directly usable answers in response to code-related queries." +
        "When the user asks for help with code, return the corrected or completed code directly, with minimal explanation unless explicitly requested." +
        "When the user asks a general or conversational question, respond politely but keep it brief." +
        "Strict rules:" +
        "Output ONLY the final answer or code. Do NOT include hidden reasoning, analysis, or “thinking” steps." +
        "Do NOT use meta-phrases like “As an AI assistant” or “I think”." +
        "Do NOT hallucinate APIs or code that won’t run; prefer minimal, correct, and tested patterns." +
        "If you are uncertain, ask a single clarifying question instead of guessing." +
        "If the user asks about math or algorithms, provide correct formulas or code, formatted properly." +
        "Context usage:" +
        "Use the provided `language`, `filePath`, `prefix`, and `suffix` to generate solutions tailored to the open file and cursor position." +
        "Suggest the smallest possible edit that achieves the user’s goal." +
        "Always maintain the style and conventions of the surrounding code." +
        "Tone:" +
        "Professional, direct, and respectful." +
        "Friendly but not verbose." +
        "Your purpose is to be a practical, code-first Copilot replacement." +
        "Remember: The user does not want to see chain-of-thought, “Thinking…”, “analysis”, or role markers like `assistantfinal`. Only deliver the final usable output."
    },
    {
      role: "user",
      content: `
Language: ${lang || "plaintext"}
File: ${filePath || "unknown"}
${(prefix || "").slice(-4000)}
${(suffix || "").slice(0, 4000)}
Task: ${message}
`
    }
  ];
}

// Streaming versions of OpenRouter and Z.ai calls for the /chat endpoint
async function* callOpenRouterStream(model, messages) {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: model || "gpt-4o-mini", messages, stream: true })
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
  let buffer = "";
  for await (const chunk of resp.body) {
    buffer += chunk.toString("utf8");
    const parts = buffer.split("\n\n");
    buffer = parts.pop();
    for (const p of parts) {
      if (!p.startsWith("data: ")) continue;
      const data = p.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {}
    }
  }
}

async function* callZaiStream(model, messages) {
  const resp = await fetch("https://api.z.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.ZAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: model || "default", messages, stream: true })
  });
  if (!resp.ok) throw new Error(`Z.ai ${resp.status}`);
  let buf = "";
  for await (const chunk of resp.body) {
    buf += chunk.toString("utf8");
    let line;
    while ((line = buf.substring(0, buf.indexOf("\n"))) && buf.includes("\n")) {
      buf = buf.slice(line.length + 1);
      line = line.trim();
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.text;
        if (delta) yield delta;
      } catch {}
    }
  }
}

// Existing callOpenRouter function (from your current code)
async function* callOpenRouter(model, prefix, suffix) {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const body = {
    model: model || "openai/gpt-oss-20b:free",
    messages: [
      { role: "system", content: "You are a helpful coding assistant." },
      { role: "user", content: prefix + "" + suffix }
    ],
    stream: true
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`OpenRouter failed: ${resp.status}`);
  let buffer = "";
  for await (const chunk of resp.body) {
    buffer += chunk.toString("utf8");
    let parts = buffer.split("\n\n");
    buffer = parts.pop();
    for (const part of parts) {
      if (part.startsWith("data: ")) {
        const data = part.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch { /* ignore parse errors */ }
      }
    }
  }
}

// Existing callZai function
async function* callZai(model, prefix, suffix) {
  const url = "https://api.z.ai/v1/completions";
  const body = {
    model: model || "glm-4.5-flash",
    prompt: prefix + "" + suffix,
    stream: true
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ZAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Z.ai failed: ${resp.status}`);
  let buffer = "";
  for await (const chunk of resp.body) {
    buffer += chunk.toString("utf8");
    let parts = buffer.split("\n");
    buffer = parts.pop();
    for (const part of parts) {
      if (!part.trim()) continue;
      try {
        const json = JSON.parse(part);
        const delta = json.choices?.[0]?.text || json.delta;
        if (delta) yield delta;
      } catch { /* ignore parse errors */ }
    }
  }
}

// Logging helper
function logRequest(endpoint, meta) {
  const logDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
  const logFile = path.join(logDir, "request.log");
  const entry = `[${new Date().toISOString()}] ${endpoint} - ${JSON.stringify(meta)}\n`;
  fs.appendFileSync(logFile, entry);
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`🚀 Orchestrator live at http://127.0.0.1:${PORT}`);
});
