# Sparx Solver

An automated open-source homework assistant for Sparx Maths and Sparx Science powered by Google Gemini.

> [!IMPORTANT]
> **Disclaimer:** Sparx Liberation Front is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Sparx Learning.

## Setup Guide

### Prerequisites

Before setting up Sparx Solver, ensure you have **Node.js** installed on your system (newer/latest version recommended):

- [Download Node.js](https://nodejs.org/en/download)

### Installation & Execution

1. **Download the Repository:** Scroll to the top of this page, click the green **Code** button, and select **Download ZIP**.
2. **Extract Files:** Unzip the downloaded folder to a convenient location (e.g., your Desktop).
3. **Open Terminal / Command Prompt:** Navigate inside the unzipped project folder and open a command line interface in that directory.
4. **Install Dependencies & Build:** Run the following commands in exact order:

```bash
npm i
cd extension
npm i
npm run build
cd ..
npm start
```

### Troubleshooting

If you encounter launcher issues or missing browser dependencies, install Playwright manually:

```bash
npm i -g playwright
npx playwright install chromium
```

Once installed, restart the application:

```bash
npm start
```

## How to Use

Follow the on-screen instructions displayed in your browser window once the application starts up.
