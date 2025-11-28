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
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: defaultHeaders,
      body: "",
    };
  }

  // Only POST allowed
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

  // Parse JSON body
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

  // Identify user for rate limiting (userId > IP > anonymous)
  const userIdentifier =
    (typeof payload.userId === "string" && payload.userId.trim()) ||
    getClientIp(event) ||
    "anonymous";

  const hashedUser = crypto
    .createHash("sha256")
    .update(userIdentifier)
    .digest("hex");

  // Rate limit – aber fail-safe: wenn Blobs nicht gehen, kein harter Fehler
  try {
    await enforceRateLimit(hashedUser);
  } catch (rateErr) {
    // Hier nur echte Rate-Limit-Fehler (429), nicht Blob-Konfig-Fehler
    if (rateErr.statusCode) {
      return {
        statusCode: rateErr.statusCode,
        headers: defaultHeaders,
        body: JSON.stringify({ error: rateErr.message }),
      };
    }

    // Falls irgendwas anderes schiefgeht: Rate Limit deaktivieren, aber nicht crashen
    console.warn("Rate limiting disabled due to error:", rateErr);
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
    
      // Versuche, die echte OpenAI-Fehlermeldung rauszuziehen
      const openAiMessage =
        (errorBody && errorBody.error && errorBody.error.message) ||
        (typeof errorBody === "string" ? errorBody : null) ||
        response.statusText;
    
      return {
        statusCode: response.status,
        headers: defaultHeaders,
        body: JSON.stringify({
          // dem User was Sinnvolles anzeigen
          error: openAiMessage || "Upstream OpenAI API error",
          // optional: für Debugging
          raw: errorBody,
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

/**
 * Rate Limiting mit Netlify Blobs, aber:
 * - Wenn Blobs nicht verfügbar/konfiguriert sind → wirf KEINEN 500er,
 *   sondern logge nur und lass die Anfrage durch.
 */
async function enforceRateLimit(hashedUser) {
  let store;
  try {
    // WICHTIG: getStore("name") – nicht getStore({ name })
    store = getStore(RATE_LIMIT_STORE);
  } catch (err) {
    // Genau hier kam vorher deine Fehlermeldung her
    console.warn(
      "Netlify Blobs not configured; skipping rate limiting (store init failed):",
      err && err.message ? err.message : err
    );
    return; // kein Rate Limit, aber auch kein Crash
  }

  const key = `user-${hashedUser}`;
  const now = Date.now();

  let record = null;
  try {
    record =
      (await store.get(key, { type: "json" }).catch(() => null)) || null;
  } catch (err) {
    console.warn(
      "Failed to read from Netlify Blobs; skipping rate limiting:",
      err && err.message ? err.message : err
    );
    return;
  }

  // Noch gültiges Fenster
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

    // Counter erhöhen
    try {
      await store.set(
        key,
        JSON.stringify({
          count: record.count + 1,
          resetAt: record.resetAt,
        })
      );
    } catch (err) {
      console.warn(
        "Failed to update Netlify Blobs; skipping further rate limiting:",
        err && err.message ? err.message : err
      );
    }
    return;
  }

  // Neues Zeitfenster anlegen
  try {
    await store.set(
      key,
      JSON.stringify({
        count: 1,
        resetAt: now + RATE_LIMIT_WINDOW_MS,
      })
    );
  } catch (err) {
    console.warn(
      "Failed to initialize Netlify Blobs record; skipping rate limiting:",
      err && err.message ? err.message : err
    );
  }
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

