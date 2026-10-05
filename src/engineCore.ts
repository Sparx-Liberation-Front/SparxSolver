export interface InteractiveElement {
  data_ai_id: string;
  tag: string;
  role?: string;
  text: string;
  slot?: string;
  ariaLabel?: string;
  isTextInput?: boolean;
}

export const toolDeclarations = [
  {
    name: 'playwright_click',
    description: 'Click an element on the page using a CSS selector.',
    parameters: {
      type: 'OBJECT',
      properties: { selector: { type: 'STRING', description: 'The CSS selector of the element to click.' } },
      required: ['selector']
    }
  },
  {
    name: 'playwright_fill',
    description: 'Fill an answer slot with a value. The engine will automatically click the slot, then find and click the correct tile or keypad button. Use this for ALL answer slots - numbers, fractions, operators like +, -, etc.',
    parameters: {
      type: 'OBJECT',
      properties: {
        selector: { type: 'STRING', description: 'The CSS selector of the answer slot (e.g. [data-ai-id="15"]).' },
        value: { type: 'STRING', description: 'The value to enter, e.g. "5", "-22", "+", "-", "1/5".' }
      },
      required: ['selector', 'value']
    }
  },
  {
    name: 'calculate_answer',
    description: 'Use this tool to write out your step-by-step mathematical working, determine the final answer, and estimate a realistic time range in seconds (min and max) that an average human student would take to solve this specific question BEFORE you fill any slots.',
    parameters: {
      type: 'OBJECT',
      properties: {
        step_by_step_working: { type: 'STRING', description: 'Concise, correct working out with one step per line. Wrap every mathematical expression in $...$ for KaTeX. Include a final line beginning with "Check:" that substitutes the answer back into the original question.' },
        final_answer: { type: 'STRING', description: 'The final calculated answer.' },
        min_human_delay_seconds: { type: 'INTEGER', description: 'Minimum estimated seconds an average human student would take to solve this question (e.g. 10).' },
        max_human_delay_seconds: { type: 'INTEGER', description: 'Maximum estimated seconds an average human student would take to solve this question (e.g. 30).' }
      },
      required: ['step_by_step_working', 'final_answer', 'min_human_delay_seconds', 'max_human_delay_seconds']
    }
  },
  {
    name: 'get_bookwork_answer',
    description: 'Look up a previously saved answer for a given bookwork code. Call this FIRST on bookwork check screens before looking at tiles.',
    parameters: {
      type: 'OBJECT',
      properties: {
        bookwork_code: { type: 'STRING', description: 'The bookwork code shown on the page, e.g. "4B" or "12".' }
      },
      required: ['bookwork_code']
    }
  },
  {
    name: 'get_screenshot_and_html',
    description: 'Takes a screenshot and gets the interactive elements of the current page. ALWAYS call this first to see the screen and choose selectors.',
    parameters: {
      type: 'OBJECT',
      properties: {
        selector: { type: 'STRING', description: 'Optional CSS selector to scope the HTML.' }
      }
    }
  },
  {
    name: 'task_done',
    description: 'Call this when you have successfully solved the current screen.',
    parameters: {
      type: 'OBJECT',
      properties: {
        message: { type: 'STRING', description: 'A final summary of what was done.' },
        memory_for_next_part: { type: 'STRING', description: 'Important facts or answers to remember for the next part.' },
        bookwork_code: { type: 'STRING', description: 'The bookwork code (e.g. "34") shown on the page.' },
        answer: { type: 'STRING', description: 'The final answer you entered for this question.' }
      }
    }
  }
];

export const systemInstruction = [
  "You are a Sparx Maths agent. There are TWO types of screen you will encounter:",

  "-- TYPE 1: BOOKWORK CHECK --",
  "Detected when the page shows a bookwork code (e.g. '4B' or 'Bookwork check') asking 'Which of these answers did you write down for bookwork code 4B?'.",
  "How to handle:",
  "1) Call get_screenshot_and_html to view the screen.",
  "2) Read the bookwork code requested (e.g. '4B' or '12').",
  "3) Call get_bookwork_answer(bookwork_code) to retrieve the saved answer for that code.",
  "4) Compare the retrieved answer against all interactive elements / options on the screen. Match by value, LaTeX expression, or text (e.g. '5', 'x = 2', '1/2', '3.14').",
  "5) Click the button / option matching the saved answer using playwright_click.",
  "6) If a 'Submit' or 'Continue' button appears, click it with playwright_click.",
  "7) Call task_done only after the lookup returned found:true.",
  "IMPORTANT: Do NOT call calculate_answer on bookwork check screens. Always look up and select the stored bookwork answer. Never finish a check with an unverified or missing bookwork record.",

  "-- TYPE 2: NORMAL QUESTION --",
  "Detected when the page shows a new maths question to solve.",
  "GRAPH QUESTIONS: If a graph, chart, coordinate grid, canvas, SVG, or plotted image is visible, inspect the graph crop carefully. Read the axis labels, scale, origin, grid spacing, plotted points, intercepts, and line direction explicitly before calculating. Do not estimate from visual size alone; cross-check coordinates against tick spacing and state the coordinates in your working. If a label or point is unreadable, do not guess: inspect the DOM text or request another screenshot first.",
  "How to handle: 1) Call get_screenshot_and_html. 2) Call calculate_answer with full working AND realistic min/max estimated human solving time in seconds (e.g. min: 12, max: 25). 3) Use playwright_fill and playwright_click to enter the answer and submit it. 4) Call task_done with bookwork_code AND answer.",

  "-- FILLING SLOTS (playwright_fill rules) --",
  "The engine auto-handles clicking tiles or typing. For equations like y=mx+c, there are SEPARATE slots for gradient, sign (+/-), and intercept - fill each independently.",
  "If isTextInput:true appears in interactiveElements, it is a plain text box - call playwright_fill with the value.",
  "CRITICAL: Call playwright_fill EXACTLY ONCE per answer slot! DO NOT call playwright_fill again on a slot that has already been filled - doing so appends duplicate digits onto the existing answer.",
  "CRITICAL: Calling playwright_fill WILL interact with keypad/tiles automatically if the slot opens a virtual keypad. NEVER assume a question is done without filling all required slots!",
  "Use data-ai-id selectors (e.g. [data-ai-id=\"15\"]). WARNING: IDs regenerate on every get_screenshot_and_html call.",

  "-- task_done requirements --",
  "ALWAYS provide a non-empty bookwork_code and answer when finishing a normal question, so the answer is saved for future bookwork checks. If either is missing, inspect the screenshot again and recover it before calling task_done.",
  "FORMATTING: Format mathematical expressions in answer and working using KaTeX / LaTeX syntax, e.g. '$x = 2$', '$\\frac{1}{2}$', '$y = 3x + 5$', '$15.4$'. Keep working compact: one operation per line, no essay paragraphs, and finish with a 'Check:' substitution line."
].join('\n');

export const fallbackModels = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro'
];
