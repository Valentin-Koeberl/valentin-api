const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL =
  process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const RATE_LIMIT = 20;
const RATE_LIMIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // one week
const RATE_LIMIT_STORE = "chat-rate-limit";

const defaultHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: defaultHeaders,
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: defaultHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  if (!OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers: defaultHeaders,
      body: JSON.stringify({ error: "OPENAI_API_KEY is not configured" }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: defaultHeaders,
      body: JSON.stringify({ error: "Request body must be valid JSON" }),
    };
  }

  const userMessage = typeof payload.message === "string" ? payload.message : "";
  if (!userMessage.trim()) {
    return {
      statusCode: 400,
      headers: defaultHeaders,
      body: JSON.stringify({ error: "message (non-empty string) is required" }),
    };
  }

  const userIdentifier =
    (typeof payload.userId === "string" && payload.userId.trim()) ||
    getClientIp(event) ||
    "anonymous";
  const hashedUser = crypto
    .createHash("sha256")
    .update(userIdentifier)
    .digest("hex");

  try {
    await enforceRateLimit(hashedUser);
  } catch (rateErr) {
    return {
      statusCode: rateErr.statusCode || 429,
      headers: defaultHeaders,
      body: JSON.stringify({ error: rateErr.message }),
    };
  }

  const openAiRequest = buildOpenAiRequest(payload, userMessage);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(openAiRequest),
    });

    if (!response.ok) {
      const errorBody = await maybeJson(response);
      console.error("OpenAI API error:", errorBody || response.statusText);
      return {
        statusCode: response.status,
        headers: defaultHeaders,
        body: JSON.stringify({
          error: "Upstream OpenAI API error",
          details: errorBody,
        }),
      };
    }

    const data = await response.json();
    return {
      statusCode: 200,
      headers: defaultHeaders,
      body: JSON.stringify({
        reply: data.choices?.[0]?.message?.content?.trim() || "",
        usage: data.usage,
        model: data.model,
      }),
    };
  } catch (err) {
    console.error("Unexpected error:", err);
    return {
      statusCode: 502,
      headers: defaultHeaders,
      body: JSON.stringify({
        error: "Failed to reach OpenAI. Please try again later.",
      }),
    };
  }
};

function getClientIp(event) {
  const forwardedFor = event.headers["x-forwarded-for"];
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  return event.headers["client-ip"] || event.headers["x-real-ip"] || null;
}

async function enforceRateLimit(hashedUser) {
  const store = getStore({ name: RATE_LIMIT_STORE });
  const key = `user-${hashedUser}`;

  const record =
    (await store.get(key, { type: "json" }).catch(() => null)) || null;
  const now = Date.now();

  if (record && record.resetAt && Number(record.resetAt) > now) {
    if (record.count >= RATE_LIMIT) {
      const msLeft = record.resetAt - now;
      const days = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
      const error = new Error(
        `Rate limit exceeded. You can try again in ${days} day(s).`
      );
      error.statusCode = 429;
      throw error;
    }

    await store.set(
      key,
      JSON.stringify({
        count: record.count + 1,
        resetAt: record.resetAt,
      })
    );
    return;
  }

  await store.set(
    key,
    JSON.stringify({
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    })
  );
}

function buildOpenAiRequest(payload, userMessage) {
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    return {
      model: payload.model || OPENAI_MODEL,
      messages: payload.messages,
      temperature:
        typeof payload.temperature === "number" ? payload.temperature : 0.7,
    };
  }

  return {
    model: payload.model || OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content:
          payload.systemPrompt ||
          "You are a helpful assistant that responds briefly and professionally.",
      },
      { role: "user", content: userMessage },
    ],
    temperature:
      typeof payload.temperature === "number" ? payload.temperature : 0.7,
  };
}

async function maybeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

