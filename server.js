/**
 * NeuralMesh — Multi-Agent AI Pipeline (Groq Edition)
 * FREE API — No payment needed!
 *
 * SETUP:
 *   1. Go to https://console.groq.com → sign up → API Keys → Create key
 *   2. Run: GROQ_API_KEY=gsk_your_key_here node server.js
 *   3. Open:  http://localhost:3000
 *
 * Zero npm dependencies — pure Node.js built-ins only
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT    = process.env.PORT || 3000;
const ENV_KEY = process.env.GROQ_API_KEY || '';   // ← set via environment variable, never hardcode
const MODEL   = 'llama-3.3-70b-versatile';

if (!ENV_KEY) {
  console.warn('\x1b[33m⚠  GROQ_API_KEY not set.\x1b[0m');
  console.warn('   Get a FREE key at https://console.groq.com');
  console.warn('   Then run: GROQ_API_KEY=gsk_xxxx node server.js\n');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
};

function readBody(req) {
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
    req.on('error', rej);
  });
}

function callGroq(messages, systemPrompt, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: 0.7,
      max_tokens: 2048,
    });

    const opts = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization':  `Bearer ${apiKey}`,
      }
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error?.message || `Groq API error ${res.statusCode}`));
          } else {
            resolve(parsed.choices?.[0]?.message?.content || '');
          }
        } catch {
          reject(new Error('Failed to parse Groq response'));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const AGENTS = {
  orchestrator: `You are the Orchestrator agent in a 5-agent AI pipeline.
Analyse the user's query and return ONLY valid JSON — no markdown, no explanation:
{
  "intent": "one sentence describing what the user wants",
  "agents_needed": ["researcher","coder","analyst","writer"],
  "tasks": {
    "researcher": "specific research task or null",
    "coder": "specific coding task or null",
    "analyst": "specific analysis task or null",
    "writer": "how to synthesize the final response"
  }
}
Rules:
- Include "researcher" if the query needs facts, explanations, background
- Include "coder" if the query needs any code or implementation
- Include "analyst" if the query needs comparisons, trade-offs, pros/cons
- ALWAYS include "writer" for final synthesis
- Set task to null for agents not needed`,

  researcher: `You are the Researcher agent in a multi-agent AI pipeline.
Your job: provide accurate, comprehensive, well-structured factual information.
- Use clear markdown headers (##) and bullet points
- Explain concepts with real-world examples
- Cover background, mechanisms, and applications
- Be thorough but avoid unnecessary padding`,

  coder: `You are the Coder agent in a multi-agent AI pipeline.
Your job: write clean, working, well-documented code.
- Always use markdown fenced code blocks with language tag (e.g. \`\`\`python)
- Add clear comments explaining each section
- Include a usage example after the code
- Handle edge cases and errors properly
- Briefly explain your approach before the code`,

  analyst: `You are the Analyst agent in a multi-agent AI pipeline.
Your job: provide deep, structured analysis.
- Clear pros and cons with reasoning
- Trade-offs and when to use what
- Real-world considerations and edge cases
- Actionable recommendations
- Use markdown for clear structure (##, bullet points)`,

  writer: `You are the Writer/Synthesizer — the final stage of a 5-agent AI pipeline.
You receive outputs from specialist agents and must produce ONE unified, polished response.
Rules:
- Merge all inputs smoothly — don't just paste them together
- Remove any redundancy but preserve all important details
- Use clear markdown structure with headers where helpful
- The response should read as if from one expert, not multiple agents
- End with a brief summary or next steps if appropriate
- If only one agent contributed, just polish and format it clearly`,
};

async function handleChat(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  let body;
  try { body = await readBody(req); }
  catch {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }

  const apiKey = req.headers['x-api-key'] || ENV_KEY;
  if (!apiKey) {
    res.writeHead(500);
    return res.end(JSON.stringify({
      error: 'No Groq API key found. Get a FREE key at https://console.groq.com and paste it in the app banner.'
    }));
  }

  const { message, mode = 'full', history = [] } = body;
  if (!message) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'message is required' }));
  }

  try {
    const result = { steps: [], finalResponse: '', agentsUsed: [], plan: null };

    let plan = {
      intent: message,
      agents_needed: ['researcher', 'writer'],
      tasks: {
        researcher: message,
        coder: null,
        analyst: null,
        writer: 'Synthesize the research into a clear, helpful response.'
      }
    };

    if (mode === 'full') {
      result.steps.push({ agent: 'orchestrator', text: 'Analysing intent and planning agent routing…' });
      const orchRaw = await callGroq([{ role: 'user', content: message }], AGENTS.orchestrator, apiKey);
      try {
        plan = JSON.parse(orchRaw.replace(/```json|```/g, '').trim());
      } catch { /* use default plan */ }
      result.steps.push({
        agent: 'orchestrator',
        text: `Intent: "${plan.intent}" → routing to: ${(plan.agents_needed || []).join(', ')}`
      });
    }

    result.plan = plan;

    const specialists = {};
    let agentsToRun;
    if (mode === 'full')         agentsToRun = (plan.agents_needed || []).filter(a => a !== 'writer' && plan.tasks?.[a]);
    else if (mode === 'research') agentsToRun = ['researcher'];
    else if (mode === 'code')     agentsToRun = ['coder'];
    else if (mode === 'analyse')  agentsToRun = ['analyst'];
    else                          agentsToRun = ['researcher'];

    const baseHistory = history.slice(-6).map(h => ({ role: h.role, content: h.content }));

    await Promise.all(agentsToRun.map(async agentKey => {
      const task = mode === 'full' ? (plan.tasks?.[agentKey] || message) : message;
      result.steps.push({ agent: agentKey, text: `Working on: "${task.substring(0, 70)}…"` });
      result.agentsUsed.push(agentKey);
      const output = await callGroq([...baseHistory, { role: 'user', content: task }], AGENTS[agentKey] || AGENTS.researcher, apiKey);
      specialists[agentKey] = output;
      result.steps.push({ agent: agentKey, text: output.substring(0, 120) + (output.length > 120 ? '…' : '') });
    }));

    result.steps.push({ agent: 'writer', text: 'Synthesising all agent outputs into final response…' });
    result.agentsUsed.push('writer');

    let writerInput;
    if (Object.keys(specialists).length === 1) {
      writerInput = `The user asked: "${message}"\n\nSpecialist response to polish:\n\n${Object.values(specialists)[0]}`;
    } else {
      writerInput = `The user asked: "${message}"\n\n`;
      if (specialists.researcher) writerInput += `## Researcher Agent Output:\n${specialists.researcher}\n\n`;
      if (specialists.coder)      writerInput += `## Coder Agent Output:\n${specialists.coder}\n\n`;
      if (specialists.analyst)    writerInput += `## Analyst Agent Output:\n${specialists.analyst}\n\n`;
      writerInput += `Synthesis instructions: ${plan.tasks?.writer || 'Merge all the above into one excellent, unified response.'}`;
    }

    const finalResponse = await callGroq([{ role: 'user', content: writerInput }], AGENTS.writer, apiKey);
    result.finalResponse = finalResponse;
    result.steps.push({ agent: 'writer', text: 'Final response ready.' });

    res.writeHead(200);
    res.end(JSON.stringify(result));

  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message || 'Pipeline execution failed' }));
  }
}

const server = http.createServer((req, res) => {
  // ✅ WHATWG URL API — no deprecation warning
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
    res.writeHead(204);
    return res.end();
  }

  if (pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);

  if (pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok', apiKeySet: !!ENV_KEY, model: MODEL }));
  }

  const safePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const filePath = path.join(__dirname, 'public', safePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('404 Not Found'); }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(d2);
      });
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.writeHead(200);
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('\n\x1b[36m╔═══════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[36m║   NeuralMesh — Multi-Agent Pipeline (Groq)    ║\x1b[0m');
  console.log('\x1b[36m╚═══════════════════════════════════════════════╝\x1b[0m');
  console.log(`\x1b[32m  ✓  Server:  http://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[32m  ✓  Model:   ${MODEL} (FREE)\x1b[0m`);
  console.log(`\x1b[32m  ✓  API Key: ${ENV_KEY ? 'Configured ✓' : 'NOT SET — paste in app yellow banner'}\x1b[0m`);
  console.log('\x1b[90m─────────────────────────────────────────────────\x1b[0m\n');
});
