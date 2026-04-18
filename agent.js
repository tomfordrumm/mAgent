#!/usr/bin/env node
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const API_URL = "https://api.openai.com/v1/responses";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = process.cwd();
const SPINNER_FRAMES = ["|", "/", "-", "\\"];

const SYSTEM_PROMPT = [
  "You are a simple coding agent working inside a local codebase.",
  `The project root is: ${ROOT_DIR}`,
  "Use tools when you need to inspect or modify the codebase.",
  "Be careful with writes. Only change files that are necessary.",
  "Keep answers concise and practical."
].join("\n");

const tools = [
  {
    type: "function",
    name: "read_directory",
    description: "List files and folders inside a directory relative to the project root.",
    parameters: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "Directory path relative to the project root. Use '.' for the root."
        }
      },
      required: ["dir"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 text file relative to the project root.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "File path relative to the project root."
        }
      },
      required: ["file"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "write_file",
    description: "Write UTF-8 text to a file relative to the project root. This overwrites existing content.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "File path relative to the project root."
        },
        content: {
          type: "string",
          description: "Full file content to write."
        }
      },
      required: ["file", "content"],
      additionalProperties: false
    }
  }
];

function getModel() {
  return process.env.OPENAI_MODEL || "gpt-5.2";
}

function resolvePath(relativePath) {
  const fullPath = path.resolve(ROOT_DIR, relativePath);
  const relative = path.relative(ROOT_DIR, fullPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path must stay inside the project root.");
  }

  return fullPath;
}

async function runTool(name, args) {
  if (name === "read_directory") {
    const dirPath = resolvePath(args.dir);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return JSON.stringify(
      entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file"
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      null,
      2
    );
  }

  if (name === "read_file") {
    const filePath = resolvePath(args.file);
    const content = await fs.readFile(filePath, "utf8");
    return content;
  }

  if (name === "write_file") {
    const filePath = resolvePath(args.file);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, args.content, "utf8");
    return `Wrote ${args.content.length} characters to ${args.file}`;
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function createResponse(payload) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

function startThinking(message = "Thinking") {
  let frameIndex = 0;
  process.stdout.write(`\n${message} ${SPINNER_FRAMES[frameIndex]}`);

  const timer = setInterval(() => {
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
    process.stdout.write(`\r${message} ${SPINNER_FRAMES[frameIndex]}`);
  }, 120);

  return {
    stop(finalMessage = "Done") {
      clearInterval(timer);
      process.stdout.write(`\r${finalMessage}${" ".repeat(Math.max(message.length - finalMessage.length + 2, 2))}\n`);
    }
  };
}

function getToolTarget(name, args) {
  if (name === "read_directory") {
    return args.dir || ".";
  }

  if (name === "read_file" || name === "write_file") {
    return args.file || "";
  }

  return "";
}

function formatToolPreview(text) {
  if (typeof text !== "string") {
    return "";
  }

  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}

function getFunctionCalls(response) {
  return (response.output || []).filter((item) => item.type === "function_call");
}

function getTextFromResponse(response) {
  const chunks = [];

  for (const item of response.output || []) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function exitGracefully() {
  console.log("\ngoodbye");
  process.exit(0);
}

async function runAgentTurn(userInput, previousResponseId) {
  const model = getModel();
  let spinner = startThinking();
  let response;

  try {
    response = await createResponse({
      model,
      instructions: SYSTEM_PROMPT,
      tools,
      input: userInput,
      previous_response_id: previousResponseId
    });
    spinner.stop("Thought");
  } catch (error) {
    spinner.stop("Failed");
    throw error;
  }

  while (true) {
    const functionCalls = getFunctionCalls(response);

    if (functionCalls.length === 0) {
      return response;
    }

    const toolOutputs = [];

    for (const call of functionCalls) {
      let outputText;
      let args = {};

      try {
        args = JSON.parse(call.arguments || "{}");
        const target = getToolTarget(call.name, args);
        console.log(target ? `[tool] ${call.name} ${target}` : `[tool] ${call.name}`);
        outputText = await runTool(call.name, args);
        const preview = formatToolPreview(outputText);
        console.log(preview ? `[tool] ok ${preview}` : "[tool] ok");
      } catch (error) {
        const target = getToolTarget(call.name, args);
        console.log(target ? `[tool] ${call.name} ${target}` : `[tool] ${call.name}`);
        outputText = `Tool error: ${error.message}`;
        console.log(`[tool] error ${error.message}`);
      }

      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: outputText
      });
    }

    spinner = startThinking();

    try {
      response = await createResponse({
        model,
        instructions: SYSTEM_PROMPT,
        tools,
        input: toolOutputs,
        previous_response_id: response.id
      });
      spinner.stop("Thought");
    } catch (error) {
      spinner.stop("Failed");
      throw error;
    }
  }
}

async function main() {
  process.on("SIGINT", exitGracefully);

  dotenv.config({ path: path.join(SCRIPT_DIR, ".env"), quiet: true });

  if (SCRIPT_DIR !== ROOT_DIR) {
    dotenv.config({ path: path.join(ROOT_DIR, ".env"), override: false, quiet: true });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error(
      `Missing OPENAI_API_KEY. Checked ${path.join(SCRIPT_DIR, ".env")}` +
        (SCRIPT_DIR !== ROOT_DIR ? ` and ${path.join(ROOT_DIR, ".env")}` : "")
    );
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  const model = getModel();
  let previousResponseId;

  console.log(`Simple coding agent`);
  console.log(`Model: ${model}`);
  console.log(`Root: ${ROOT_DIR}`);
  console.log(`Type 'exit' to quit.\n`);

  try {
    while (true) {
      const userInput = (await rl.question("> ")).trim();

      if (!userInput) {
        continue;
      }

      if (userInput.toLowerCase() === "exit") {
        break;
      }

      try {
        const response = await runAgentTurn(userInput, previousResponseId);
        previousResponseId = response.id;
        const text = getTextFromResponse(response);
        console.log(`\n${text || "(no text response)"}\n`);
      } catch (error) {
        console.error(`\nError: ${error.message}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

main();
