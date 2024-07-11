import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const coze_api_base = process.env.COZE_API_BASE || "api.coze.com";
const default_bot_id = process.env.BOT_ID || "";
const botConfig = process.env.BOT_CONFIG ? JSON.parse(process.env.BOT_CONFIG) : {};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
      "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization",
  "Access-Control-Max-Age": "86400",
};

app.use((req, res, next) => {
  res.set(corsHeaders);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  console.log("Request Method:", req.method);
  console.log("Request Path:", req.path);
  next();
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>COZE2OPENAI</title>
      </head>
      <body>
        <h1>Coze2OpenAI</h1>
        <p>Congratulations! Your project has been successfully deployed.</p>
      </body>
    </html>
  `);
});

const getAuthToken = (req) => {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader) {
    return null;
  }
  const token = authHeader.split(" ")[1];
  return token || null;
};

const handleRequestError = (res, error, defaultMessage = "An error occurred.") => {
  console.error("Error:", error);
  const errorMessage = error.message || defaultMessage;
  res.status(500).json({ error: errorMessage });
};

const buildChatHistory = (messages) => {
  const chatHistory = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const message = messages[i];
    chatHistory.push({
      role: message.role === "system" ? "assistant" : message.role,
      content: message.content,
      content_type: "text",
    });
  }
  return chatHistory;
};

const extractAnswerContent = (data) => {
  if (data.code !== 0 || data.msg !== "success") {
    throw new Error(data.msg);
  }
  const answerMessage = data.messages.find(
      (message) => message.role === "assistant" && message.type === "answer"
  );
  if (!answerMessage) {
    throw new Error("No answer message found.");
  }
  return answerMessage.content.trim();
};

const sendStreamChunk = (res, chunkData) => {
  res.write("data: " + JSON.stringify(chunkData) + "\n\n");
};

const endStream = (res) => {
  res.write("data: [DONE]\n\n");
  res.end();
};

app.post("/v1/chat/completions", async (req, res) => {
  const token = getAuthToken(req);
  if (!token) {
    return res.status(401).json({ code: 401, errmsg: "Unauthorized." });
  }

  try {
    const { messages, model, user = "apiuser", stream = false } = req.body;
    const chatHistory = buildChatHistory(messages);
    const queryString = messages[messages.length - 1].content;
    const bot_id = model && botConfig[model] ? botConfig[model] : default_bot_id;

    const requestBody = {
      query: queryString,
      stream: stream,
      conversation_id: "",
      user: user,
      bot_id: bot_id,
      chat_history: chatHistory,
    };

    const coze_api_url = `https://${coze_api_base}/open_api/v2/chat`;
    const resp = await fetch(coze_api_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      const stream = resp.body;
      let buffer = "";

      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");

        for (let i = 0; i < lines.length - 1; i++) {
          let line = lines[i].trim();
          if (!line.startsWith("data:")) continue;

          line = line.slice(5).trim();
          let chunkObj;
          try {
            chunkObj = line.startsWith("{") ? JSON.parse(line) : null;
          } catch (error) {
            console.error("Error parsing chunk:", error);
            continue;
          }

          if (!chunkObj) continue;

          if (chunkObj.event === "message") {
            if (
                chunkObj.message.role === "assistant" &&
                chunkObj.message.type === "answer"
            ) {
              const chunkContent = chunkObj.message.content;
              if (chunkContent !== "") {
                const chunkId = `chatcmpl-${Date.now()}`;
                const chunkCreated = Math.floor(Date.now() / 1000);
                sendStreamChunk(res, {
                  id: chunkId,
                  object: "chat.completion.chunk",
                  created: chunkCreated,
                  model: model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: chunkContent },
                      finish_reason: null,
                    },
                  ],
                });
              }
            }
          } else if (chunkObj.event === "done") {
            const chunkId = `chatcmpl-${Date.now()}`;
            const chunkCreated = Math.floor(Date.now() / 1000);
            sendStreamChunk(res, {
              id: chunkId,
              object: "chat.completion.chunk",
              created: chunkCreated,
              model: model,
              choices: [
                { index: 0, delta: {}, finish_reason: "stop" },
              ],
            });
            endStream(res);
          } else if (chunkObj.event === "error") {
            const errorMsg = chunkObj.error_information
                ? chunkObj.error_information.err_msg
                : `${chunkObj.code} ${chunkObj.message}`;
            console.error("Error: ", errorMsg);
            sendStreamChunk(res, {
              error: {
                error: "Unexpected response from Coze API.",
                message: errorMsg,
              },
            });
            endStream(res);
          }
        }

        buffer = lines[lines.length - 1];
      });
    } else {
      try {
        const data = await resp.json();
        const result = extractAnswerContent(data);
        const chunkId = `chatcmpl-${Date.now()}`;
        const chunkCreated = Math.floor(Date.now() / 1000);

        const formattedResponse = {
          id: chunkId,
          object: "chat.completion",
          created: chunkCreated,
          model: model,
          choices: [
            {
              index: 0,
              message: { role: "system", content: result },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
          },
          system_fingerprint: "fp_2f57f81c11",
        };
        res.set("Content-Type", "application/json");
        res.send(JSON.stringify(formattedResponse, null, 2));
      } catch (error) {
        handleRequestError(res, error, "Error processing response.");
      }
    }
  } catch (error) {
    handleRequestError(res, error);
  }
});

export default app;