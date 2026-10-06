import express from 'express';
import path from 'path';
import { promises as fsPromises } from 'fs';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { BrowserContext, Page } from 'playwright';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';

const app = express();
app.use(cors());
app.use(express.json());
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);
const serverDir = path.resolve(process.cwd(), 'server');
const fallbackServerDir = path.resolve(__dirname, '../server');
app.use(express.static(serverDir));
if (serverDir !== fallbackServerDir) {
  app.use(express.static(fallbackServerDir));
}

app.get('/', (req, res) => {
  const indexFile = path.join(serverDir, 'index.html');
  if (require('fs').existsSync(indexFile)) {
    res.sendFile(indexFile);
  } else {
    res.sendFile(path.join(fallbackServerDir, 'index.html'));
  }
});

let browserContext: BrowserContext | null = null;
let automationRunning = false;

type AgentSettings = {
  minDelaySeconds: number;
  maxDelaySeconds: number;
  requestTimeoutSeconds: number;
  retryDelaySeconds: number;
  maxRequestAttempts: number;
};

let agentSettings: AgentSettings = {
  minDelaySeconds: 2,
  maxDelaySeconds: 20,
  requestTimeoutSeconds: 45,
  retryDelaySeconds: 2,
  maxRequestAttempts: 3
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function updateAgentSettings(input: any): AgentSettings {
  const minDelaySeconds = boundedNumber(input?.minDelaySeconds, agentSettings.minDelaySeconds, 0, 120);
  const maxDelaySeconds = boundedNumber(input?.maxDelaySeconds, agentSettings.maxDelaySeconds, minDelaySeconds, 300);
  agentSettings = {
    minDelaySeconds,
    maxDelaySeconds,
    requestTimeoutSeconds: boundedNumber(input?.requestTimeoutSeconds, agentSettings.requestTimeoutSeconds, 10, 300),
    retryDelaySeconds: boundedNumber(input?.retryDelaySeconds, agentSettings.retryDelaySeconds, 0, 60),
    maxRequestAttempts: Math.round(boundedNumber(input?.maxRequestAttempts, agentSettings.maxRequestAttempts, 1, 10))
  };
  return agentSettings;
}

export function setContext(context: BrowserContext) {
  browserContext = context;
}

app.post('/start', (req, res) => {
  console.log('[Server] Received /start POST request from extension.');
  const apiKeys = req.body.apiKeys;
  const apiKey = req.body.apiKey; // Fallback for backwards compatibility
  updateAgentSettings(req.body.settings || {});
  
  const keys = apiKeys || (apiKey ? [apiKey] : []);
  
  if (!keys || keys.length === 0) {
    console.log('[Server] No API keys provided in the request body.');
    res.status(400).send('No API keys provided');
    return;
  }
  
  if (automationRunning) {
    console.log('[Server] Automation is already running.');
    res.send('Already running');
    return;
  }
  
  console.log(`[Server] Starting automation loop with ${keys.length} API keys...`);
  automationRunning = true;
  res.send('Started');
  
  // start automation loop asynchronously
  startAutomation(keys).catch(console.error);
});

app.get('/stop', (req, res) => {
  console.log('[Server] Received /stop request.');
  automationRunning = false;
  res.send('Stopped');
});

app.get('/settings', (req, res) => {
  res.json({ settings: agentSettings });
});

app.post('/settings', (req, res) => {
  const settings = updateAgentSettings(req.body || {});
  console.log('[Server] AI settings updated:', settings);
  res.json({ settings });
});

import { toolDeclarations, systemInstruction, fallbackModels } from './engineCore';

const playwright_click = toolDeclarations.find(t => t.name === 'playwright_click') as any;
const playwright_fill = toolDeclarations.find(t => t.name === 'playwright_fill') as any;
const get_screenshot_and_html = toolDeclarations.find(t => t.name === 'get_screenshot_and_html') as any;
const task_done = toolDeclarations.find(t => t.name === 'task_done') as any;
const calculate_answer = toolDeclarations.find(t => t.name === 'calculate_answer') as any;
const get_bookwork_answer = toolDeclarations.find(t => t.name === 'get_bookwork_answer') as any;

const playwright_evaluate: FunctionDeclaration = {
  name: 'playwright_evaluate',
  description: 'Evaluate JavaScript in the page context and return the result as a string.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      script: { type: Type.STRING, description: 'The JavaScript string to evaluate.' }
    },
    required: ['script']
  }
};

async function getActivePage(): Promise<Page | null> {
  if (!browserContext) return null;
  const pages = browserContext.pages();
  let activePage = pages.find(p => p.url().includes('sparx'));
  return activePage || (pages.length > 0 ? pages[0] : null);
}

let currentStatus = { text: "Idle", level: "info" };
let hasCalculatedForCurrentQuestion = false;

app.get('/status', (req, res) => {
  res.json({ running: automationRunning, status: currentStatus });
});

function updateStatus(text: string, level: string = "info") {
  currentStatus = { text, level };
  console.log(`[Status] ${text}`);
}

let currentModelIndex = 0;
type Bookwork = { code: string, answer: string, working?: string, info?: string, savedAt?: string };
let bookworks: Bookwork[] = [];
let currentCalculation: { working: string, answer: string } | null = null;
let deletedBookworks: Set<string> = new Set();

app.get('/bookwork', (req, res) => {
  res.json({ bookworks });
});

app.post('/bookwork', (req, res) => {
  if (Array.isArray(req.body.bookworks)) {
    const incoming = req.body.bookworks
      .filter((entry: any) => entry && typeof entry.code === 'string')
      .map((entry: any) => ({
        code: entry.code,
        answer: String(entry.answer ?? ''),
        working: typeof entry.working === 'string' ? entry.working : '',
        info: typeof entry.info === 'string' ? entry.info : '',
        savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : ''
      }));
    const merged = new Map(bookworks.map(entry => [entry.code.trim().toLowerCase(), entry]));
    incoming.forEach(entry => merged.set(entry.code.trim().toLowerCase(), {
      ...merged.get(entry.code.trim().toLowerCase()),
      ...entry,
      working: entry.working || merged.get(entry.code.trim().toLowerCase())?.working || '',
      info: entry.info || merged.get(entry.code.trim().toLowerCase())?.info || '',
      savedAt: entry.savedAt || merged.get(entry.code.trim().toLowerCase())?.savedAt || ''
    }));
    bookworks = [...merged.values()];
    console.log(`[Server] 📖 Bookwork store updated via POST. Total entries: ${bookworks.length}`);
  }
  res.json({ bookworks });
});

async function readVisibleBookworkCode(page: Page): Promise<string> {
  const text = await page.locator('body').innerText().catch(() => '');
  const patterns = [
    /bookwork\s*(?:code)?\s*[:#-]?\s*([0-9]{1,3}[A-Za-z]?)/i,
    /(?:code|bookwork)\s+([0-9]{1,3}[A-Za-z]?)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function escapeExportHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function exportMathMarkup(value: string): string {
  const escaped = escapeExportHtml(value);
  if (escaped.includes('$') || escaped.includes('\\(') || escaped.includes('\\[')) return escaped;
  if (/\\(frac|sqrt|times|cdot|pm|leq|geq|text)\b/.test(escaped)) return `$${escaped}$`;
  if (/=/.test(escaped) && !/^Check:/i.test(escaped)) return `$${escaped}$`;
  return escaped;
}

function bookworkMarkdown(): string {
  return bookworks.map(entry => [
    `## Bookwork ${entry.code}`,
    entry.savedAt ? `**Saved:** ${entry.savedAt}` : '',
    `**Answer:** ${entry.answer}`,
    '',
    '### Working',
    entry.working || 'Working not captured.',
    entry.info ? `\n### Notes\n${entry.info}` : ''
  ].join('\n')).join('\n\n') + '\n';
}

function bookworkHtml(): string {
  const sections = bookworks.map(entry => `
    <article>
      <h2>Bookwork ${escapeExportHtml(entry.code)}</h2>
      ${entry.savedAt ? `<p><strong>Saved:</strong> ${escapeExportHtml(entry.savedAt)}</p>` : ''}
      <p><strong>Answer:</strong> ${exportMathMarkup(entry.answer)}</p>
      <h3>Working</h3>
      <div>${(entry.working || 'Working not captured.').split(/\r?\n/).map(line => `<div>${exportMathMarkup(line)}</div>`).join('')}</div>
      ${entry.info ? `<h3>Notes</h3><p>${escapeExportHtml(entry.info).replace(/\n/g, '<br>')}</p>` : ''}
    </article>
  `).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Sparx bookwork</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css"><style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px}article{border-bottom:1px solid #ddd;padding:0 0 24px;margin-bottom:24px}.katex{font-size:1.05em}</style></head><body><main>${sections}</main><script src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"><\/script><script src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.js"><\/script><script>renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false},{left:'\\\\(',right:'\\\\)',display:false},{left:'\\\\[',right:'\\\\]',display:true}],throwOnError:false});<\/script></body></html>`;
}

async function saveBookworkExport(filename: string, content: string): Promise<string> {
  const downloadsDir = path.resolve(process.cwd(), 'Downloads');
  await fsPromises.mkdir(downloadsDir, { recursive: true });
  const outputPath = path.join(downloadsDir, filename);
  await fsPromises.writeFile(outputPath, content, 'utf8');
  return outputPath;
}

function exportConfirmation(filename: string, outputPath: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bookwork export saved</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 24px;color:#172033}code{display:block;padding:12px;background:#eef2f7;border-radius:6px;word-break:break-all}</style></head><body><h1>Export saved</h1><p><strong>${escapeExportHtml(filename)}</strong> was written to your Downloads folder.</p><code>${escapeExportHtml(outputPath)}</code><p>You can close this tab.</p></body></html>`;
}

function exportTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

app.get('/bookwork/export/markdown', async (req, res) => {
  try {
    const filename = `sparx-bookwork-${exportTimestamp()}.md`;
    const outputPath = await saveBookworkExport(filename, bookworkMarkdown());
    res.type('text/html').send(exportConfirmation(filename, outputPath));
  } catch (error) {
    console.error('[Server] Markdown export failed:', error);
    res.status(500).send('Could not save the Markdown export.');
  }
});

app.get('/bookwork/export/html', async (req, res) => {
  try {
    const filename = `sparx-bookwork-${exportTimestamp()}.html`;
    const outputPath = await saveBookworkExport(filename, bookworkHtml());
    res.type('text/html').send(exportConfirmation(filename, outputPath));
  } catch (error) {
    console.error('[Server] HTML export failed:', error);
    res.status(500).send('Could not save the HTML export.');
  }
});

const exportDirectory = path.resolve(process.cwd(), 'Downloads');
fsPromises.mkdir(exportDirectory, { recursive: true })
  .then(() => console.log(`[Server] Bookwork exports will be saved to: ${exportDirectory}`))
  .catch(error => console.error('[Server] Could not create the Downloads directory:', error));

app.delete('/bookwork', (req, res) => {
  bookworks.forEach(b => deletedBookworks.add(b.code.trim().toLowerCase()));
  bookworks = [];
  console.log(`[Server] 📖 Bookwork store CLEARED ALL.`);
  res.json({ status: 'cleared_all' });
});

app.delete('/bookwork/:code', (req, res) => {
  const code = req.params.code;
  deletedBookworks.add(code.trim().toLowerCase());
  bookworks = bookworks.filter(b => b.code.trim().toLowerCase() !== code.trim().toLowerCase());
  console.log(`[Server] 📖 Bookwork store CLEARED code "${code}". Remaining: ${bookworks.length}`);
  res.json({ status: 'cleared_single', code });
});





async function startAutomation(apiKeys: string[]) {
  console.log(`[Automation] Initializing Gemini Agent with ${apiKeys.length} API keys...`);
  
  let currentKeyIndex = 0;
  let ai = new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
  
  let previousMemory = "";
  
  while (automationRunning) {
    try {
      const activePage = await getActivePage();
      if (!activePage) {
        console.log('[Automation] No pages found. Waiting...');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      console.log('[Automation] Starting new session to solve the current question...');
      currentCalculation = null;
      let bookworkLookup: { code: string, found: boolean } | null = null;
      let isBookworkCheck = false;
      
      const config = {
        tools: [{ functionDeclarations: [playwright_click, playwright_fill, playwright_evaluate, get_screenshot_and_html, task_done, calculate_answer, get_bookwork_answer] }],
        systemInstruction: [
          "You are a Sparx Maths agent. There are TWO types of screen you will encounter:",

          "-- TYPE 1: BOOKWORK CHECK --",
          "Detected when the page shows a bookwork code (e.g. '4B' or 'Bookwork check') asking 'Which of these answers did you write down for bookwork code 4B?'.",
          "How to handle:",
          "1) Call get_screenshot_and_html to view the screen.",
          "2) Read the bookwork code requested (e.g. '4B' or '12').",
          "3) Call get_bookwork_answer(bookwork_code) to retrieve the saved answer for that code.",
          "4) Compare the retrieved answer against all interactive elements / options on the screen. Match by value, LaTeX expression, or text (e.g. '5', 'x = 2', '1/2', '3.14').",
          "5) Use playwright_click for the matching option and any visible Submit/Continue click.",
          "7) Call task_done.",
          "IMPORTANT: Do NOT call calculate_answer on bookwork check screens. Always look up and select the stored bookwork answer. Do not call task_done until get_bookwork_answer has returned found:true.",

          "-- TYPE 2: NORMAL QUESTION --",
          "Detected when the page shows a new maths question to solve.",
          "GRAPH QUESTIONS: If a graph, chart, coordinate grid, canvas, SVG, or plotted image is visible, inspect the graph crop carefully. Read the axis labels, scale, origin, grid spacing, plotted points, intercepts, and line direction explicitly before calculating. Do not estimate from visual size alone; cross-check coordinates against tick spacing and state the coordinates in your working. If a label or point is unreadable, do not guess: inspect the DOM text or request another screenshot first.",
          "How to handle: 1) Call get_screenshot_and_html. 2) Call calculate_answer with concise, line-by-line working, a final verification line beginning with 'Check:', and a random human-like delay range (min_human_delay_seconds, max_human_delay_seconds). Wrap every mathematical expression in $...$ for KaTeX. YOU MUST WAIT FOR THE SERVER TO FINISH THE DELAY. DO NOT call any other tool until the calculate_answer tool response returns successfully after the wait. 3) AFTER the calculate_answer wait, use playwright_fill and playwright_click to enter and submit the answer. 4) Call task_done with bookwork_code AND answer.",

          "-- FILLING SLOTS (playwright_fill rules) --",
          "The server auto-handles clicking tiles or typing. For equations like y=mx+c, there are SEPARATE slots for gradient, sign (+/-), and intercept - fill each independently.",
          "If isTextInput:true appears in interactiveElements, it is a plain text box - just call playwright_fill with the value.",
          "Use data-ai-id selectors (e.g. [data-ai-id=\"15\"]). WARNING: IDs regenerate on every get_screenshot_and_html call.",

          "-- DROPDOWNS --",
          "When playwright_click returns interactiveElements in its response, those IDs are FRESH and valid right now (the dropdown is open).",
          "DO NOT call get_screenshot_and_html after opening a dropdown - that will close it and reset all IDs, causing an infinite loop.",
          "Instead: read the interactiveElements list returned by playwright_click, find the dropdown option you want, and call playwright_click with its data-ai-id immediately.",

          "-- task_done requirements --",
          "Before task_done on EVERY normal question, verify that the bookwork code is visible and provide both bookwork_code and the exact final answer. The server will reject task_done if either is missing, so call get_screenshot_and_html again and recover the code rather than finishing without saving it.",
          "FORMATTING: Format mathematical expressions in answer and working using KaTeX / LaTeX syntax, e.g. '$x = 2$', '$\\frac{1}{2}$', '$y = 3x + 5$', '$15.4$'. Keep working compact: one operation per line, no essay paragraphs, and finish with a 'Check:' substitution line."
        ].join('\n')
      };
      
      let contents: any[] = [];
      let promptText = "Start the task. Call get_screenshot_and_html first. Determine whether this is a BOOKWORK CHECK or a NORMAL QUESTION, then follow the appropriate procedure from your instructions.";
      if (previousMemory) {
        promptText += `\n\nCRITICAL MEMORY FROM PREVIOUS PART OF QUESTION: ${previousMemory}`;
      }
      
      let prompt: any = [{ text: promptText }];
      let isDone = false;
      
      while (automationRunning && !isDone) {
        contents.push({ role: 'user', parts: prompt });
        
        let response: any;
        let success = false;
        let genericErrorAttempts = 0;

        while (automationRunning && !success && genericErrorAttempts < agentSettings.maxRequestAttempts) {
          try {
            genericErrorAttempts++;
            updateStatus(`Querying ${fallbackModels[currentModelIndex]} (Key ${currentKeyIndex + 1}/${apiKeys.length})...`, 'info');
            response = await Promise.race([
              ai.models.generateContent({
                model: fallbackModels[currentModelIndex],
                contents: contents,
                config: config
              }),
              new Promise((_, reject) => setTimeout(
                () => reject(new Error(`Gemini request timed out after ${agentSettings.requestTimeoutSeconds}s`)),
                agentSettings.requestTimeoutSeconds * 1000
              ))
            ]);
            success = true;
          } catch (e: any) {
            updateStatus(`Gemini request failed (${genericErrorAttempts}/${agentSettings.maxRequestAttempts}): ${e.message}`, 'warn');
            if (genericErrorAttempts >= agentSettings.maxRequestAttempts) break;
            currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
            if (currentKeyIndex === 0) {
              currentModelIndex = (currentModelIndex + 1) % fallbackModels.length;
              updateStatus(`Cycled keys. Switching to ${fallbackModels[currentModelIndex]}...`, 'warn');
            } else {
              updateStatus(`Key error. Switching to key ${currentKeyIndex + 1}/${apiKeys.length}...`, 'warn');
            }
            
            // Re-initialize AI with next key immediately
            ai = new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
            if (agentSettings.retryDelaySeconds > 0) {
              await new Promise(r => setTimeout(r, agentSettings.retryDelaySeconds * 1000));
            }
          }
        }

        if (!success) {
          updateStatus(`Gemini unavailable after ${agentSettings.maxRequestAttempts} attempts. Retrying this question later.`, 'warn');
          await new Promise(r => setTimeout(r, agentSettings.retryDelaySeconds * 1000));
          continue;
        }

        if (!automationRunning) break;
        
        const candidateContent = response.candidates?.[0]?.content;
        if (candidateContent) {
          contents.push(candidateContent);
        }

        const functionCalls = response.functionCalls;
        
        if (!functionCalls || functionCalls.length === 0) {
          console.log(`[Agent] Gemini responded with text:`, response.text);
          await new Promise(r => setTimeout(r, 1000));
          prompt = [{ text: "Please call a tool to interact with the page or task_done." }];
          continue;
        }

        const toolCall = functionCalls[0];
        updateStatus(`AI Tool: ${toolCall.name}(${JSON.stringify(toolCall.args || {})})`, 'action');
        
        if (!automationRunning) {
          console.log('[Automation] Stop flag detected before executing tool. Halting immediately.');
          break;
        }

        let toolResult: any;
        const page = await getActivePage();
        if (!page) throw new Error("Browser page lost.");

        try {
          if (toolCall.name === 'playwright_click') {
            const el = page.locator(toolCall.args.selector as string).first();
            if (await el.count() > 0) {
              await el.click({ force: true });
              // Wait for any dropdown/overlay animation to finish
              await page.waitForTimeout(600);

              // Re-inject data-ai-id ONLY on elements that don't already have one.
              // This preserves existing IDs from the last get_screenshot_and_html scan
              // (so subsequent playwright_fill calls still work), while giving fresh IDs
              // to any NEW elements that appeared after the click (e.g. dropdown items).
              const freshElements = await page.evaluate(() => {
                let idCounter = Date.now(); // Use timestamp to avoid collisions with existing numeric IDs
                const results: any[] = [];
                const clickables = document.querySelectorAll(
                  'button, [role="button"], [tabindex="0"], [tabindex="-1"], input, a, [role="option"], [role="listbox"] *, [role="menu"] *, [role="menuitem"]'
                );
                clickables.forEach((node) => {
                  // Preserve existing ID; only assign a new one to brand-new elements
                  let id = node.getAttribute('data-ai-id');
                  if (!id) {
                    id = `__new_${idCounter++}`;
                    node.setAttribute('data-ai-id', id);
                  }
                  const annotation = node.querySelector('.katex-mathml annotation');
                  let text = annotation
                    ? (annotation.textContent || '').trim()
                    : (node as HTMLElement).innerText?.trim().replace(/\n/g, ' ') || '';
                  const ariaLabel = node.getAttribute('aria-label') || '';
                  const role = node.getAttribute('role') || '';
                  const tag = node.tagName.toLowerCase();
                  if (text || ariaLabel) {
                    results.push({ data_ai_id: id, tag, role, text, ariaLabel });
                  }
                });
                return results;
              });

              toolResult = {
                status: 'Clicked successfully.',
                note: 'Some new elements appeared and have been assigned __new_ IDs (listed below). IMPORTANT: __new_ IDs are ONLY valid for playwright_click (e.g. to select a dropdown option). NEVER pass a __new_ ID to playwright_fill - that will hit a button instead of the answer slot and corrupt the input. For playwright_fill, always use the numeric IDs from the last get_screenshot_and_html call.',
                interactiveElements: freshElements
              };
            } else {
              toolResult = { error: `Selector ${toolCall.args.selector} not found.` };
            }
          }
          else if (toolCall.name === 'playwright_fill') {
            const val = String(toolCall.args.value).trim();
            const selectorArg = toolCall.args.selector as string;

            // Guard: __new_ IDs are assigned to elements that appeared after a click
            // (e.g. keypad buttons). Using them in playwright_fill would click a keypad
            // button instead of the answer slot, corrupting the input with extra digits.
            if (selectorArg.includes('__new_')) {
              toolResult = {
                error: 'Invalid selector: __new_ IDs may point to keypad buttons, not answer slots. Call get_screenshot_and_html first to get the correct numeric data-ai-id for the answer slot, then call playwright_fill again.',
              };
            } else {
            const el = page.locator(selectorArg).first();
            if (await el.count() === 0) {
              toolResult = { error: `Selector ${toolCall.args.selector} not found.` };
            } else {
              // -- Step 1: check if the TARGET element itself is a plain input/textarea --
              const tagName    = await el.evaluate((n: Element) => n.tagName.toLowerCase());
              const inputType  = await el.evaluate((n: Element) => (n as HTMLInputElement).type?.toLowerCase() || '');
              const isEditableEl = await el.evaluate((n: Element) =>
                (n as HTMLElement).isContentEditable ||
                (n.tagName.toLowerCase() === 'input' && ['text','number','search',''].includes((n as HTMLInputElement).type?.toLowerCase() || '')) ||
                n.tagName.toLowerCase() === 'textarea'
              );

              if (isEditableEl) {
                console.log(`[Agent] 🎹 Target is directly editable - typing "${val}" via keystrokes.`);
                // Blur whatever currently has focus FIRST - prevents the leading character
                // of the new value leaking into the previous field before focus moves.
                await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());
                await page.waitForTimeout(150);
                await el.click();
                // Wait long enough for the browser to fire blur on the old element and
                // focus on the new one - 400ms is safe across all tested browsers.
                await page.waitForTimeout(400);
                await page.keyboard.press('Control+a');
                await page.keyboard.press('Delete');
                await page.keyboard.type(val, { delay: 80 });
                await page.waitForTimeout(400);
                toolResult = { status: `Typed "${val}" directly into editable element.` };
              } else {
                // -- Step 2: Click the slot to open keypad/tile drawer --
                await el.click({ force: true });
                await page.waitForTimeout(700);

                // -- Step 3: Check if clicking focused a text input or contenteditable --
                const focusedIsTypeable = await page.evaluate(() => {
                  const f = document.activeElement as HTMLElement | null;
                  if (!f) return false;
                  const tag  = f.tagName.toLowerCase();
                  const type = (f as HTMLInputElement).type?.toLowerCase() || '';
                  return (
                    (tag === 'input' && ['text','number','search',''].includes(type)) ||
                    tag === 'textarea' ||
                    f.isContentEditable
                  );
                });

                if (focusedIsTypeable) {
                  console.log(`[Agent] 🎹 Slot opened a typeable element - typing "${val}" via keyboard.`);
                  await page.keyboard.press('Control+a');
                  await page.keyboard.press('Delete');
                  await page.keyboard.type(val, { delay: 70 });
                  await page.waitForTimeout(300);
                  toolResult = { status: `Typed "${val}" into focused editable after clicking slot.` };
                } else {
                  // -- Step 4: Scan for tile/keypad buttons --
                  const tiles = await page.evaluate(() => {
                    const results: { selector: string; text: string }[] = [];
                    const seen = new Set<Element>();
                    const candidates = document.querySelectorAll(
                      'button, [role="button"], [tabindex="0"], [tabindex="-1"]'
                    );
                    let idCounter = Date.now();
                    candidates.forEach((node) => {
                      if (seen.has(node)) return;
                      seen.add(node);
                      const annotation = node.querySelector('.katex-mathml annotation');
                      let text = annotation
                        ? (annotation.textContent || '').trim()
                        : (node as HTMLElement).innerText?.trim().replace(/\s+/g, '') || '';
                      if (!text) return;
                      const existingId = node.getAttribute('data-ai-id');
                      const id = existingId || `__t_${idCounter++}`;
                      if (!existingId) node.setAttribute('data-ai-id', id);
                      results.push({ selector: `[data-ai-id="${id}"]`, text });
                    });
                    return results;
                  });

                  console.log(`[Agent] Tiles found:`, tiles.map(t => t.text).join(', '));

                  const normalise = (s: string) => s
                    .replace(/\s+/g, '')
                    .replace(/\u2212/g, '-')
                    .replace(/\u2014/g, '-')
                    .replace(/^\{/, '').replace(/\}$/, '')
                    .replace(/\\frac\{(\d+)\}\{(\d+)\}/g, '$1/$2');
                  const normVal = normalise(val);
                  const exact   = tiles.find(t => normalise(t.text) === normVal);

                  if (exact) {
                    // -- Step 5a: Click matching tile --
                    console.log(`[Agent] ✅ Clicking tile "${exact.text}" for "${val}"`);
                    await page.locator(exact.selector).first().click({ force: true });
                    await page.waitForTimeout(400);
                    toolResult = { status: `Filled "${val}" by clicking tile.` };
                  } else {
                    // -- Step 5b: Try char-by-char button pressing --
                    console.log(`[Agent] No exact tile for "${val}". Trying char-by-char...`);
                    let allOk = true;
                    for (const char of val.split('')) {
                      const normChar = normalise(char);
                      const digitTile = tiles.find(t => normalise(t.text) === normChar);
                      if (digitTile) {
                        await page.locator(digitTile.selector).first().click({ force: true });
                        await page.waitForTimeout(180);
                      } else {
                        console.log(`[Agent] ⚠️ No button for '${char}'`);
                        allOk = false;
                      }
                    }

                    if (!allOk) {
                      // -- Step 5c: ID-based click fallback - re-scan with data-ai-id --
                      // Before touching the keyboard, try to find a tile that contains the
                      // full value (or a normalised form of it) by clicking its data-ai-id.
                      console.log(`[Agent] 🔎 Char-by-char incomplete - trying ID-based tile click for "${val}"`);

                      const idTiles = await page.evaluate(() => {
                        const results: { selector: string; text: string; id: string }[] = [];
                        const seen = new Set<Element>();
                        const candidates = document.querySelectorAll(
                          'button, [role="button"], [tabindex="0"], [tabindex="-1"]'
                        );
                        let idCounter = Date.now();
                        candidates.forEach((node) => {
                          if (seen.has(node)) return;
                          seen.add(node);
                          // Prefer LaTeX annotation text, fall back to innerText
                          const annotation = node.querySelector('.katex-mathml annotation');
                          let text = annotation
                            ? (annotation.textContent || '').trim()
                            : (node as HTMLElement).innerText?.trim().replace(/\s+/g, '') || '';
                          if (!text) return;
                          const existingId = node.getAttribute('data-ai-id');
                          const id = existingId || `__t_${idCounter++}`;
                          if (!existingId) node.setAttribute('data-ai-id', id);
                          results.push({ selector: `[data-ai-id="${id}"]`, text, id });
                        });
                        return results;
                      });

                      // Build a richer normalised set - strip LaTeX wrappers for comparison
                      const stripLatex = (s: string) => s
                        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '$1/$2')
                        .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
                        .replace(/\\left|\\right|\\cdot|\\times/g, '')
                        .replace(/[{}\\]/g, '')
                        .replace(/\s+/g, '');

                      const normValStripped = stripLatex(normalise(val));

                      // Try: exact normalised match → partial contains match
                      const idMatch =
                        idTiles.find(t => normalise(t.text) === normVal) ||
                        idTiles.find(t => stripLatex(normalise(t.text)) === normValStripped) ||
                        idTiles.find(t => stripLatex(normalise(t.text)).includes(normValStripped) && normValStripped.length > 1) ||
                        idTiles.find(t => normValStripped.includes(stripLatex(normalise(t.text))) && stripLatex(normalise(t.text)).length > 1);

                      if (idMatch) {
                        console.log(`[Agent] ✅ ID-click: found tile id="${idMatch.id}" text="${idMatch.text}" for "${val}"`);
                        await page.locator(idMatch.selector).first().click({ force: true });
                        await page.waitForTimeout(400);
                        toolResult = { status: `Filled "${val}" by ID-based tile click (id=${idMatch.id}).` };
                      } else {
                        // -- Step 5d: Absolute last resort - keyboard.type() --
                        console.log(`[Agent] 🎹 ID-click failed - falling back to keyboard.type("${val}")`);
                        await page.keyboard.press('Control+a');
                        await page.keyboard.press('Delete');
                        await page.keyboard.type(val, { delay: 70 });
                        await page.waitForTimeout(300);
                        toolResult = { status: `Typed "${val}" via keyboard (no matching tile found by text or ID).` };
                      }
                    } else {
                      toolResult = { status: `Filled "${val}" char-by-char via tile buttons.` };
                    }
                  }
                }
              }
            } 
          }
        } // end else (not a __new_ selector)
          else if (toolCall.name === 'playwright_evaluate') {
            const result = await page.evaluate(toolCall.args.script as string);
            toolResult = { result: String(result) };
          }
          else if (toolCall.name === 'calculate_answer') {
            const working = toolCall.args.step_by_step_working as string;
            const final = toolCall.args.final_answer as string;
            const requestedMin = Math.max(0, parseInt(toolCall.args.min_human_delay_seconds || '5', 10));
            const requestedMax = Math.max(requestedMin, parseInt(toolCall.args.max_human_delay_seconds || '15', 10));
            const minSec = Math.min(agentSettings.maxDelaySeconds, Math.max(agentSettings.minDelaySeconds, requestedMin));
            const maxSec = Math.min(agentSettings.maxDelaySeconds, Math.max(minSec, requestedMax));

            console.log(`[Agent] 🧮 Gemini Calculation:\nWorking: ${working}\nFinal Answer: ${final}`);

            if (!hasCalculatedForCurrentQuestion) {
              hasCalculatedForCurrentQuestion = true;
              const delaySec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
              console.log(`[Human Delay] ⏱️ AI calculated answer. Simulating average human solving time of ${delaySec}s (Range: ${minSec}-${maxSec}s)...`);

              for (let remaining = delaySec; remaining > 0; remaining--) {
                if (!automationRunning) break;
                updateStatus(`Simulating human thinking time... (${remaining}s remaining)`, 'info');
                await page.waitForTimeout(1000);
              }
              updateStatus(`Finished thinking (${delaySec}s). Executing answer entry...`, 'action');
            } else {
              console.log(`[Human Delay] Delay already applied for this question - skipping additional wait.`);
            }

            currentCalculation = { working, answer: final };
            toolResult = { status: "Calculation saved and verified. Now proceed to enter this exact answer using the correct button IDs." };
          }
          else if (toolCall.name === 'get_bookwork_answer') {
            isBookworkCheck = true;
            const code = String(toolCall.args.bookwork_code || '').trim();
            const entry = bookworks.find(b => b.code.trim().toLowerCase() === code.toLowerCase());
            if (entry) {
              bookworkLookup = { code, found: true };
              console.log(`[Agent] 📖 Bookwork lookup: code="${code}" → answer="${entry.answer}"`);
              toolResult = { found: true, bookwork_code: entry.code, answer: entry.answer };
            } else {
              bookworkLookup = { code, found: false };
              console.log(`[Agent] 📖 Bookwork lookup: code="${code}" - NOT FOUND in store (${bookworks.length} entries).`);
              // Return the full bookwork store so the agent can make an educated guess
              toolResult = {
                found: false,
                message: `No saved answer for bookwork code "${code}". You must solve it from the screenshot instead.`,
                all_saved_codes: bookworks.map(b => b.code)
              };
            }
          }
          else if (toolCall.name === 'get_screenshot_and_html') {
            const selector = toolCall.args.selector as string;
            const target = selector ? page.locator(selector).first() : page.locator('body').first();
            
            if (await target.count() === 0) {
              toolResult = { error: `Selector ${selector} not found.` };
            } else {
              // Inject data-ai-id and extract clean text/LaTeX representations
              const elementsSummary = await target.evaluate((el) => {
                let idCounter = 1;
                const results: any[] = [];
                const clickables = el.querySelectorAll('button, [role="button"], [tabindex="0"], input, a');
                
                clickables.forEach((node) => {
                  const id = String(idCounter++);
                  node.setAttribute('data-ai-id', id);
                  
                  // Extract LaTeX if available, otherwise innerText
                  const annotation = node.querySelector('.katex-mathml annotation');
                  let text = '';
                  if (annotation && annotation.textContent) {
                    text = annotation.textContent;
                  } else {
                    text = (node as HTMLElement).innerText?.trim().replace(/\n/g, ' ') || '';
                  }
                  
                  const slot = node.getAttribute('data-slot') || '';
                  const ariaLabel = node.getAttribute('aria-label') || '';
                  const tagName = node.tagName.toLowerCase();
                  
                  if (text || slot || ariaLabel || tagName === 'input') {
                    results.push({ data_ai_id: id, tag: tagName, text, slot, ariaLabel });
                  }
                });
                return results;
              });

              const screenshot = await page.screenshot({ type: 'png', fullPage: true });
              const graphScreenshots: Buffer[] = [];
              const graphTargets = target.locator('canvas, svg, img, [role="img"], [aria-label*="graph" i], [aria-label*="chart" i]');
              const graphCount = Math.min(await graphTargets.count(), 3);
              for (let index = 0; index < graphCount; index++) {
                const graph = graphTargets.nth(index);
                const box = await graph.boundingBox();
                if (box && box.width >= 120 && box.height >= 100) {
                  graphScreenshots.push(await graph.screenshot({ type: 'png' }));
                }
              }
              const visualText = graphScreenshots.length
                ? ' The full page screenshot is followed by high-resolution crops of each visible graph. For graph questions, use the crop to read labels and tick spacing.'
                : ' No separate graph element was detected, so inspect the full page screenshot carefully for a graph drawn in regular HTML.';
              
              prompt = [
                {
                  functionResponse: {
                    name: toolCall.name,
                    response: { interactiveElements: elementsSummary } 
                  }
                },
                { text: `Here is the current screenshot of the page, along with a list of interactive elements and their extracted LaTeX/text.${visualText}` },
                { inlineData: { data: screenshot.toString("base64"), mimeType: 'image/png' } },
                ...graphScreenshots.flatMap((graphImage, index) => [
                  { text: `Graph crop ${index + 1}: inspect this image at higher resolution. First transcribe its axes, scale, and key coordinates.` },
                  { inlineData: { data: graphImage.toString('base64'), mimeType: 'image/png' } }
                ])
              ];
              continue; 
            }
          }
          else if (toolCall.name === 'task_done') {
            previousMemory = toolCall.args.memory_for_next_part || "";
            
            let bwCode = String(toolCall.args.bookwork_code || '').trim();
            let bwAnswer = String(toolCall.args.answer || '').trim();
            if (!isBookworkCheck) {
              if (!bwCode) bwCode = await readVisibleBookworkCode(page);
              if (!bwAnswer && currentCalculation?.answer) bwAnswer = currentCalculation.answer;
            } else if (bookworkLookup?.found) {
              if (!bwCode) bwCode = bookworkLookup.code;
              if (!bwAnswer) {
                bwAnswer = bookworks.find(entry => entry.code.trim().toLowerCase() === bookworkLookup?.code.toLowerCase())?.answer || '';
              }
            }
            if (bookworkLookup && !bookworkLookup.found) {
              isDone = false;
              toolResult = {
                error: `Bookwork code "${bookworkLookup.code}" was not found in saved bookwork. Do not finish this check; solve/save the answer first or call get_screenshot_and_html again to identify the correct code.`
              };
            } else if (!isBookworkCheck && (!String(bwCode || '').trim() || !String(bwAnswer || '').trim())) {
              isDone = false;
              toolResult = {
                error: 'Bookwork was not saved. This normal question requires a non-empty bookwork_code and answer. Call get_screenshot_and_html, identify the code, then call task_done again with both values.'
              };
            } else {
              isDone = true;
            }

            if (isDone && bwCode && bwAnswer) {
              const codeLower = bwCode.trim().toLowerCase();
              if (deletedBookworks.has(codeLower)) {
                deletedBookworks.delete(codeLower); // Reset if re-solved newly
              }
              const existing = bookworks.find(b => b.code.trim().toLowerCase() === codeLower);
              const calculation = currentCalculation;
              const working = calculation ? calculation.working : '';
              if (existing) {
                existing.answer = bwAnswer;
                if (working) existing.working = working;
                existing.savedAt = new Date().toISOString();
              } else {
                bookworks.push({ code: bwCode, answer: bwAnswer, working, savedAt: new Date().toISOString() });
              }
              console.log(`[Agent] Saved Bookwork Code ${bwCode}: ${bwAnswer}`);
            }
            
            if (isDone) {
              toolResult = { status: "Task acknowledged as done. Bookwork was verified and saved." };
              console.log(`[Agent] Task completed according to Gemini. Reason:`, toolCall.args.message);
              if (previousMemory) {
                console.log(`[Agent] Saved memory for next part:`, previousMemory);
              } else {
                console.log(`[Agent] No memory saved. Question fully finished.`);
              }
            } else {
              console.warn('[Agent] Refused task_done because bookwork verification failed.');
            }
          }
          
          prompt = [{
            functionResponse: {
              name: toolCall.name,
              response: toolResult
            }
          }];

        } catch (e: any) {
          console.error(`[Agent] Tool execution failed:`, e);
          prompt = [{
            functionResponse: {
              name: toolCall.name,
              response: { error: e.message }
            }
          }];
        }
      }
      
      console.log('[Automation] Finished current loop iteration. Waiting 2 seconds before the next...');
      await new Promise(r => setTimeout(r, 2000));
      
    } catch (e) {
      console.error("[Automation] Error during agent loop:", e);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log('[Automation] Master loop stopped.');
}

app.listen(3000, () => {
  console.log('Running at http://localhost:3000');
});
