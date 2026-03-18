import * as core from "@actions/core";
import * as github from "@actions/github";
import { promises as fs } from "fs";
import { z } from "zod";

type PullRequestContext = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  baseRef: string;
};

type ChangedFile = {
  filename: string;
  status: string;
  patch?: string;
};

type ScanLog = {
  path: string;
  content: string;
};

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fetchProjectDoc(octokit: ReturnType<typeof github.getOctokit>, ctx: PullRequestContext, projectPath: string): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({
      owner: ctx.owner,
      repo: ctx.repo,
      path: projectPath,
      ref: ctx.baseRef,
    });

    if (!Array.isArray(res.data) && res.data.type === "file" && "content" in res.data && res.data.content) {
      const buff = Buffer.from(res.data.content, res.data.encoding as BufferEncoding | undefined ?? "base64");
      return buff.toString("utf8");
    }
    return null;
  } catch (error) {
    if ((error as any).status === 404) {
      return null;
    }
    throw error;
  }
}

async function fetchChangedFiles(octokit: ReturnType<typeof github.getOctokit>, ctx: PullRequestContext, maxFiles: number, maxHunkSize: number): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  const iterator = octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.number,
    per_page: 100,
  });

  for await (const page of iterator) {
    for (const file of page.data) {
      if (files.length >= maxFiles) {
        return files;
      }
      files.push({
        filename: file.filename,
        status: file.status,
        patch: file.patch ? file.patch.slice(0, maxHunkSize) : undefined,
      });
    }
  }

  return files;
}

async function readScanLogs(paths: string[]): Promise<ScanLog[]> {
  const logs: ScanLog[] = [];
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const content = await readFileSafe(trimmed);
    if (content) {
      logs.push({ path: trimmed, content });
    }
  }
  return logs;
}

function buildPrompt(projectDoc: string | null, pr: PullRequestContext, files: ChangedFile[], scanLogs: ScanLog[]): string {
  const parts: string[] = [];
  parts.push("You are a strict, senior reviewer for this repository. Be concise, actionable, and cite filenames/lines when possible. If unsure, state uncertainty.");
  parts.push("Project architecture / constraints:\n" + (projectDoc ?? "(project.md not found)"));
  parts.push(`PR intent:\nTitle: ${pr.title}\nBody: ${pr.body ?? "(none)"}`);

  const fileSummaries = files.map((f) => {
    const patch = f.patch ? f.patch : "(no patch provided)";
    return `- ${f.filename} [${f.status}]\n${patch}`;
  });
  parts.push("Changed files (truncated):\n" + (fileSummaries.join("\n\n") || "(none)"));

  if (scanLogs.length) {
    const scanText = scanLogs
      .map((log) => `# ${log.path}\n${log.content.slice(0, 4000)}`)
      .join("\n\n");
    parts.push("Scan findings (truncated):\n" + scanText);
  } else {
    parts.push("Scan findings: none provided");
  }

  parts.push(
    "Checklist: security, secrets, data integrity, concurrency, migrations, API contracts, logging/observability, input validation, error handling, performance, test coverage."
  );

  parts.push(
    "Output format:\n- Verdict: pass | flag | block (pick one)\n- Summary: short bullet list\n- Issues (max 5): file:line? -> issue -> why it matters -> fix\n- Tests to add/run: bullet list\n- If nothing critical, say so."
  );

  return parts.join("\n\n");
}

const LlmResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string(),
      }),
    })
  ),
});

async function callLlm(endpoint: string, apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a concise, cautious code reviewer." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 800,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM call failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const parsed = LlmResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Unexpected LLM response shape");
  }

  const message = parsed.data.choices[0]?.message?.content;
  if (!message) {
    throw new Error("LLM response missing content");
  }
  return message.trim();
}

async function postResult(
  octokit: ReturnType<typeof github.getOctokit>,
  ctx: PullRequestContext,
  mode: "comment" | "summary",
  body: string
) {
  if (mode === "summary") {
    await core.summary.addRaw(body).write();
    return;
  }

  await octokit.rest.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.number,
    body,
  });
}

async function run(): Promise<void> {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GITHUB_TOKEN is required");
    }

    const llmEndpoint = core.getInput("llm-endpoint", { required: true });
    const llmApiKey = core.getInput("llm-api-key", { required: true });
    const model = core.getInput("model") || "gpt-4o-mini";
    const projectPath = core.getInput("project-md-path") || "project.md";
    const scanPathsInput = core.getInput("scan-log-paths") || "";
    const maxFiles = Number(core.getInput("max-files")) || 50;
    const maxHunkSize = Number(core.getInput("max-hunk-size")) || 8000;
    const postMode = (core.getInput("post-mode") || "comment").toLowerCase() === "summary" ? "summary" : "comment";

    const context = github.context;
    const prPayload = context.payload.pull_request;
    if (!prPayload) {
      throw new Error("This action must run on a pull_request event");
    }

    const pr: PullRequestContext = {
      owner: context.repo.owner,
      repo: context.repo.repo,
      number: prPayload.number,
      title: prPayload.title || "(no title)",
      body: prPayload.body || null,
      baseRef: prPayload.base?.ref || prPayload.base?.sha || "HEAD",
    };

    const octokit = github.getOctokit(token);

    const [projectDoc, files, scanLogs] = await Promise.all([
      fetchProjectDoc(octokit, pr, projectPath),
      fetchChangedFiles(octokit, pr, maxFiles, maxHunkSize),
      readScanLogs(scanPathsInput.split(",")),
    ]);

    const prompt = buildPrompt(projectDoc, pr, files, scanLogs);
    core.info(`Built prompt with ${prompt.length} characters`);

    const llmOutput = await callLlm(llmEndpoint, llmApiKey, model, prompt);

    const header = `🤖 AI Review for PR #${pr.number}`;
    const body = `${header}\n\n${llmOutput}`;

    await postResult(octokit, pr, postMode, body);
    core.setOutput("comment", body);
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

run();
