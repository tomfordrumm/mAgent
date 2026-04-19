#!/usr/bin/env node
import dotenv from "dotenv";
import { exec as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// App configuration
// -----------------------------------------------------------------------------

const API_URL = "https://api.openai.com/v1/responses";
const exec = promisify(execCallback);
const PROJECT_ROOT = process.cwd();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const MAX_BASH_OUTPUT_LENGTH = 8_000;

const SYSTEM_PROMPT = [
  "You are a simple coding agent working inside a local codebase.",
  `The project root is: ${PROJECT_ROOT}`,
  "Use tools when you need to inspect or modify the codebase.",
  "Be careful with writes. Only change files that are necessary.",
  "Keep answers concise and practical."
].join("\n");

function getModelName() {
  return process.env.OPENAI_MODEL || "gpt-5.2";
}

function loadEnvironment() {
  const scriptEnvFile = path.join(SCRIPT_DIR, ".env");
  const rootEnvFile = path.join(PROJECT_ROOT, ".env");

  dotenv.config({ path: scriptEnvFile, quiet: true });

  if (SCRIPT_DIR !== PROJECT_ROOT) {
    dotenv.config({ path: rootEnvFile, override: false, quiet: true });
  }

  if (!process.env.OPENAI_API_KEY) {
    const checkedFiles =
      SCRIPT_DIR === PROJECT_ROOT
        ? scriptEnvFile
        : `${scriptEnvFile} and ${rootEnvFile}`;

    throw new Error(`Missing OPENAI_API_KEY. Checked ${checkedFiles}`);
  }
}

// -----------------------------------------------------------------------------
// Local file tools
// -----------------------------------------------------------------------------

function resolveProjectPath(relativePath) {
  const absolutePath = path.resolve(PROJECT_ROOT, relativePath);
  const pathFromRoot = path.relative(PROJECT_ROOT, absolutePath);

  if (pathFromRoot.startsWith("..") || path.isAbsolute(pathFromRoot)) {
    throw new Error("Path must stay inside the project root.");
  }

  return absolutePath;
}

async function listDirectory(relativeDir) {
  const directoryPath = resolveProjectPath(relativeDir);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  const simplifiedEntries = entries
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file"
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return JSON.stringify(simplifiedEntries, null, 2);
}

async function readProjectFile(relativeFile) {
  const filePath = resolveProjectPath(relativeFile);
  return fs.readFile(filePath, "utf8");
}

async function writeProjectFile(relativeFile, content) {
  const filePath = resolveProjectPath(relativeFile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return `Wrote ${content.length} characters to ${relativeFile}`;
}

function truncateText(text, maxLength = MAX_BASH_OUTPUT_LENGTH) {
  if (typeof text !== "string" || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...output truncated...`;
}

async function runBashCommand(command) {
  try {
    const { stdout, stderr } = await exec(command, {
      cwd: PROJECT_ROOT,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      shell: "/bin/bash"
    });

    return JSON.stringify(
      {
        ok: true,
        command,
        cwd: PROJECT_ROOT,
        stdout: truncateText(stdout),
        stderr: truncateText(stderr)
      },
      null,
      2
    );
  } catch (error) {
    return JSON.stringify(
      {
        ok: false,
        command,
        cwd: PROJECT_ROOT,
        stdout: truncateText(error.stdout || ""),
        stderr: truncateText(error.stderr || error.message),
        exitCode: error.code ?? null
      },
      null,
      2
    );
  }
}

const TOOL_DEFINITIONS = [
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
  },
  {
    type: "function",
    name: "run_bash",
    description: "Run a bash command in the project root and return stdout, stderr, and exit status.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Bash command to run inside the project root."
        }
      },
      required: ["command"],
      additionalProperties: false
    }
  }
];

const TOOL_HANDLERS = {
  read_directory: async ({ dir }) => listDirectory(dir),
  read_file: async ({ file }) => readProjectFile(file),
  write_file: async ({ file, content }) => writeProjectFile(file, content),
  run_bash: async ({ command }) => runBashCommand(command)
};

function getToolTarget(toolName, toolArgs) {
  if (toolName === "read_directory") {
    return toolArgs.dir || ".";
  }

  if (toolName === "read_file" || toolName === "write_file") {
    return toolArgs.file || "";
  }

  if (toolName === "run_bash") {
    return toolArgs.command || "";
  }

  return "";
}

async function executeTool(toolName, toolArgs) {
  const handler = TOOL_HANDLERS[toolName];

  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  return handler(toolArgs);
}

// -----------------------------------------------------------------------------
// OpenAI API helpers
// -----------------------------------------------------------------------------

async function createModelResponse(payload) {
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

function buildInitialRequest(userMessage, previousResponseId) {
  return {
    model: getModelName(),
    instructions: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS,
    input: userMessage,
    previous_response_id: previousResponseId
  };
}

function buildToolFollowUp(toolOutputs, previousResponseId) {
  return {
    model: getModelName(),
    instructions: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS,
    input: toolOutputs,
    previous_response_id: previousResponseId
  };
}

// -----------------------------------------------------------------------------
// Response parsing
// -----------------------------------------------------------------------------

function getFunctionCalls(response) {
  return (response.output || []).filter((item) => item.type === "function_call");
}

function getAssistantText(response) {
  const textChunks = [];

  for (const outputItem of response.output || []) {
    if (outputItem.type !== "message" || !Array.isArray(outputItem.content)) {
      continue;
    }

    for (const contentItem of outputItem.content) {
      if (contentItem.type === "output_text" && typeof contentItem.text === "string") {
        textChunks.push(contentItem.text);
      }
    }
  }

  return textChunks.join("\n").trim();
}

function formatToolPreview(toolOutput) {
  if (typeof toolOutput !== "string") {
    return "";
  }

  const singleLinePreview = toolOutput.replace(/\s+/g, " ").trim();
  return singleLinePreview.length > 120
    ? `${singleLinePreview.slice(0, 117)}...`
    : singleLinePreview;
}

// -----------------------------------------------------------------------------
// Terminal helpers
// -----------------------------------------------------------------------------

function createSpinner(message = "Thinking") {
  let frameIndex = 0;

  process.stdout.write(`\n${message} ${SPINNER_FRAMES[frameIndex]}`);

  const timer = setInterval(() => {
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
    process.stdout.write(`\r${message} ${SPINNER_FRAMES[frameIndex]}`);
  }, 120);

  return {
    stop(finalMessage = "Done") {
      clearInterval(timer);

      const padding = " ".repeat(Math.max(message.length - finalMessage.length + 2, 2));
      process.stdout.write(`\r${finalMessage}${padding}\n`);
    }
  };
}

function handleExitSignal() {
  console.log("\ngoodbye");
  process.exit(0);
}

function printBanner() {
  console.log("Simple coding agent");
  console.log(`Model: ${getModelName()}`);
  console.log(`Root: ${PROJECT_ROOT}`);
  console.log("Type 'exit' to quit.\n");
}

// -----------------------------------------------------------------------------
// Agent loop
// -----------------------------------------------------------------------------

async function runToolCallsUntilDone(response) {
  while (true) {
    const functionCalls = getFunctionCalls(response);

    if (functionCalls.length === 0) {
      return response;
    }

    const toolOutputs = [];

    for (const call of functionCalls) {
      let toolArgs = {};
      let toolOutput;

      try {
        toolArgs = JSON.parse(call.arguments || "{}");
        const toolTarget = getToolTarget(call.name, toolArgs);
        console.log(toolTarget ? `[tool] ${call.name} ${toolTarget}` : `[tool] ${call.name}`);

        toolOutput = await executeTool(call.name, toolArgs);

        const preview = formatToolPreview(toolOutput);
        console.log(preview ? `[tool] ok ${preview}` : "[tool] ok");
      } catch (error) {
        const toolTarget = getToolTarget(call.name, toolArgs);
        console.log(toolTarget ? `[tool] ${call.name} ${toolTarget}` : `[tool] ${call.name}`);

        toolOutput = `Tool error: ${error.message}`;
        console.log(`[tool] error ${error.message}`);
      }

      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: toolOutput
      });
    }

    const spinner = createSpinner();

    try {
      response = await createModelResponse(buildToolFollowUp(toolOutputs, response.id));
      spinner.stop("Thought");
    } catch (error) {
      spinner.stop("Failed");
      throw error;
    }
  }
}

async function runAgentTurn(userMessage, previousResponseId) {
  const spinner = createSpinner();
  let response;

  try {
    response = await createModelResponse(buildInitialRequest(userMessage, previousResponseId));
    spinner.stop("Thought");
  } catch (error) {
    spinner.stop("Failed");
    throw error;
  }

  return runToolCallsUntilDone(response);
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

async function startCli() {
  const terminal = readline.createInterface({ input, output });
  let previousResponseId;

  printBanner();

  try {
    while (true) {
      const userMessage = (await terminal.question("> ")).trim();

      if (!userMessage) {
        continue;
      }

      if (userMessage.toLowerCase() === "exit") {
        break;
      }

      try {
        const response = await runAgentTurn(userMessage, previousResponseId);
        previousResponseId = response.id;

        const assistantText = getAssistantText(response);
        console.log(`\n${assistantText || "(no text response)"}\n`);
      } catch (error) {
        console.error(`\nError: ${error.message}\n`);
      }
    }
  } finally {
    terminal.close();
  }
}

async function main() {
  process.on("SIGINT", handleExitSignal);
  loadEnvironment();
  await startCli();
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
