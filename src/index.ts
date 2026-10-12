// Override process.versions.node check for Playwright in pkg environment
try {
  delete (process.versions as any).node;
  (process.versions as any).node = '20.0.0';
} catch (e) {
  try {
    Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true, writable: true });
  } catch (err) {}
}

import path from 'path';
import { setContext } from './server.ts';

(async () => {
  const { chromium } = require('playwright');
  let extensionPath = path.resolve(__dirname, '../extension/dist');
  const fs = await import('fs');
  if (!fs.existsSync(extensionPath)) {
    extensionPath = path.resolve(process.cwd(), 'extension/dist');
  }

  if (!fs.existsSync(extensionPath)) {
    console.log('[SparxSolver] Extension build not found at extension/dist. Building extension automatically...');
    try {
      const { execSync } = require('child_process');
      execSync('npm run build:extension', { stdio: 'inherit' });
    } catch (e) {
      console.error('[SparxSolver] Failed to build extension automatically:', e);
    }
  }

  const context = await chromium.launchPersistentContext('./browser-data', {
    headless: false,
    viewport: null,
    args: [
      '--start-maximized',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  setContext(context);
  const page = await context.newPage();

  console.log('[SparxSolver] Application started! Server running at http://localhost:3000');
  console.log('[SparxSolver] Keep this terminal window open. Closing it will exit the application.');

  // Handle browser closure -> exit application
  context.on('close', () => {
    console.log('[SparxSolver] Browser window closed. Shutting down application...');
    process.exit(0);
  });

  // Wait a short time to ensure the server is fully ready
  await new Promise(r => setTimeout(r, 1000));

  await page.goto('http://localhost:3000');

  const cleanup = async () => {
    console.log('[SparxSolver] Shutting down...');
    try { await context.close(); } catch (e) {}
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
})();