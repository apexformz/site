import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({
  stdin: { contents: `import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {useVoiceCoaching} from './apps/frontend/src/hooks/useVoiceCoaching';
    function Harness() { window.voice = useVoiceCoaching(); return React.createElement('div', null, String(window.voice.isSpeaking)); }
    window.root = createRoot(document.getElementById('root'));
    window.root.render(React.createElement(Harness));`, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    window.utterances = [];
    window.cancelCount = 0;
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [],
      speak: utterance => {
        if (window.throwSpeech) throw new Error('Audio unavailable');
        window.utterances.push(utterance);
        utterance.onstart?.();
      },
      cancel: () => { window.cancelCount++; window.utterances.at(-1)?.onerror?.({ error: 'canceled' }); },
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.voice);
  await page.evaluate(() => {
    window.first = window.voice.announce('First cue');
    window.lateError = window.utterances.at(-1).onerror;
    window.second = window.voice.announce('Replacement cue');
    window.lateError({ error: 'interrupted' });
  });
  await page.waitForFunction(() => window.voice.isSpeaking);
  await page.evaluate(() => window.first);
  assert.equal(await page.evaluate(() => window.voice.isSpeaking), true);
  await page.evaluate(async () => { window.voice.stop(); await window.second; });
  await page.waitForFunction(() => !window.voice.isSpeaking);
  for (const error of ['canceled', 'interrupted', 'not-allowed', 'audio-busy', 'synthesis-failed']) {
    await page.evaluate(async error => {
      const done = window.voice.announce('Test failure');
      window.utterances.at(-1).onerror({ error });
      await done;
    }, error);
    await page.waitForFunction(() => !window.voice.isSpeaking);
  }
  await page.evaluate(async () => { window.throwSpeech = true; await window.voice.announce('Throws'); window.throwSpeech = false; });
  await page.evaluate(async () => {
    const done = window.voice.announce('Unmount');
    window.root.unmount();
    await done;
    if (window.utterances.at(-1).onerror !== null) throw new Error('Handlers leaked');
  });
  assert.deepEqual(errors, []);
  console.log('PASS: replacement, stale callbacks, mute, speech failures, thrown errors and unmount settle without console errors');
} finally { await browser.close(); }
