import puppeteer from 'puppeteer';
import { startFlow, desktopConfig } from 'lighthouse';
import fs from 'fs';
import { launch } from 'chrome-launcher';
import * as axeCore from 'axe-core';
import validator from 'html-validator';


import cssstats from 'cssstats';
import fetch from 'node-fetch';





const BASE_URL = 'https://www.sust.edu/';
const MAX_PAGES = 8;
const MAX_DEPTH = 2;
const REQUEST_PAUSE_MS = 1500;
const REPORT_DIR = 'reports';

if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const visited = new Set();

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 200;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

async function tryInputAndClick(page) {
  const inputs = await page.$$('input[type="text"], input[type="search"], textarea');
  for (const input of inputs) {
    try {
      await input.focus();
      await page.keyboard.type('Test input text', { delay: 40 });
    } catch {}
  }
  const button = await page.$('button, input[type="submit"]');
  if (button) {
    try {
      await button.click();
      await sleep(800);
    } catch {}
  }
}

async function getInternalLinks(page, baseOrigin) {
  return await page.$$eval('a[href]', (anchors, base) => {
    const urls = anchors.map(a => a.getAttribute('href'))
      .filter(Boolean)
      .map(href => { try { return new URL(href, location.href).href } catch { return null } })
      .filter(Boolean);
    const unique = Array.from(new Set(urls.map(u => { try { const url = new URL(u); url.hash = ''; return url.href } catch { return null } }).filter(Boolean)));
    return unique.filter(u => { try { return new URL(u).origin === base } catch { return false } });
  }, baseOrigin);
}

function safeNameFromUrl(url) {
  return url.replace(/^https?:\/\//, '').replace(/[:?#\/]/g, '_').replace(/__+/g, '_');
}

// ---- Collectors ----

// ✅ axe-core with lightweight summary output
async function runAxeOnPage(page) {
  try {
    try {
      await page.addScriptTag({ content: axeCore.source });
    } catch {
      await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.1/axe.min.js' });
    }

    const full = await page.evaluate(async () => {
      if (typeof axe === 'undefined') return { error: 'axe not injected (CSP or blocked)' };
      return await axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }
      });
    });

    if (full.error) return full;

    // 🧩 Condense the output to save space
    const summary = {
      violationsCount: full.violations?.length || 0,
      passesCount: full.passes?.length || 0,
      incompleteCount: full.incomplete?.length || 0,
      inapplicableCount: full.inapplicable?.length || 0,
      violations: full.violations.map(v => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        nodesCount: v.nodes.length
      }))
    };

    return summary;
  } catch (err) {
    return { error: `axe.run failed: ${err.message}` };
  }
}

// ✅ Retry W3C validator on 429


/*async function validateHtmlWithW3C(html) {
  try {
    const result = await validator({ data: html, format: 'json' });
    return result;
  } catch (err) {
    if (err.message.includes('429')) {
      console.warn('⚠️ Remote validator rate-limited, skipping...');
      return { skipped: true, reason: 'Rate-limited (429)' };
    }
    return { error: `html-validator failed: ${err.message}` };
  }
}*/




async function validateHtmlWithW3C(html) {
  const options = {
    data: html,
    format: 'json',
    validator: 'http://localhost:8888'
  };

  try {
    const res = await validator(options);
    return res;
  } catch (err) {
    // fallback to online API if local one fails
    if (err.message.includes('ECONNREFUSED')) {
      console.warn('⚠️ Local validator not reachable, falling back to online service...');
      return await validator({ data: html, format: 'json' });
    }
    return { error: `html-validator failed: ${err.message}` };
  }
}





async function gatherCssText(page) {
  return await page.evaluate(() => {
    const styles = [];

    // Inline <style> elements
    document.querySelectorAll("style").forEach(el => {
      if (el.textContent) styles.push(el.textContent);
    });

    // Linked stylesheets
    for (const sheet of document.styleSheets) {
      try {
        if (sheet.cssRules) {
          const rules = Array.from(sheet.cssRules)
            .map(rule => rule.cssText)
            .join("\n");
          styles.push(rules);
        }
      } catch (e) {
        // Cross-origin stylesheet → skip it gracefully
        console.warn("Skipping cross-origin stylesheet:", sheet.href);
      }
    }

    return styles.join("\n");
  });
}


// ✅ Clean CSS for cssstats




async function analyzeCss(cssText) {
  try {
    if (!cssText || cssText.trim().length === 0) {
      return { skipped: true, reason: "No CSS found" };
    }

    if (cssText.length > 800000) {
      return { skipped: true, reason: "CSS too large", length: cssText.length };
    }

    // 🧹 Clean the CSS to avoid parsing errors
    const cleanedCss = cssText
      .replace(/@charset[^;]+;/gi, "")
      .replace(/url\(['"]?data:[^)]+['"]?\)/gi, "url()")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");

    console.log(`Analyzing CSS (${cleanedCss.length.toLocaleString()} chars)...`);

    const stats = cssstats(cleanedCss);

    // 📊 Extract key metrics
    const summary = {
      length: cleanedCss.length,
      rules: stats.rules.total,
      declarations: stats.declarations.total,
      selectors: stats.selectors.total,
      propertiesCount: Object.keys(stats.declarations.properties).length,
    };

    // 🧠 Set thresholds (best-practice)
    const thresholds = {
      rules: 1500,
      declarations: 10000,
      selectors: 2000,
      size: 250000, // 250 KB
    };

    // 🧾 Evaluate status
    const warnings = [];
    if (summary.rules > thresholds.rules)
      warnings.push(`Too many CSS rules (${summary.rules} > ${thresholds.rules})`);
    if (summary.declarations > thresholds.declarations)
      warnings.push(`Too many declarations (${summary.declarations} > ${thresholds.declarations})`);
    if (summary.selectors > thresholds.selectors)
      warnings.push(`Too many selectors (${summary.selectors} > ${thresholds.selectors})`);
    if (summary.length > thresholds.size)
      warnings.push(`CSS file too large (${summary.length} bytes > ${thresholds.size})`);

    // 🟢🔴 Set final status
    summary.status = warnings.length === 0 ? "✅ Within best-practice limits" : "⚠️ Issues found";
    summary.warnings = warnings;

    return summary;
  } catch (error) {
    console.error("❌ cssstats failed:", error.message);
    return { error: `cssstats failed: ${error.message}`, length: cssText.length };
  }
}




async function collectWebVitalsFromPage(page) {
  try {
    await page.addScriptTag({ url: 'https://unpkg.com/web-vitals@3/dist/web-vitals.iife.js' });
    await sleep(3000);
    return await page.evaluate(async () => {
      const results = {};
      const waitForMetric = (fn) => new Promise(resolve => {
        try { fn(metric => { results[metric.name] = metric.value; resolve(); }) } catch { resolve(); }
      });
      const tasks = [
        waitForMetric(webVitals.getLCP),
        waitForMetric(webVitals.getCLS),
        waitForMetric(webVitals.getFID).catch(()=>{}),
        waitForMetric(webVitals.getTTFB).catch(()=>{}),
        waitForMetric(webVitals.getINP).catch(()=>{})
      ].map(p => p.catch(()=>{}));
      await Promise.race([Promise.all(tasks), new Promise(r => setTimeout(r, 3000))]);
      return results;
    });
  } catch (err) {
    return { error: `web-vitals injection failed: ${err.message}` };
  }
}


async function getCarbonForUrl(url) {
  // Wait 1 second before each API request to avoid rate-limit
  await sleep(1000);

  try {
    const resp = await fetch(`https://api.websitecarbon.com/site?url=${encodeURIComponent(url)}`);
    if (!resp.ok) {
      if (resp.status === 429) {
        // Too many requests — back off more
        await sleep(5000);
        return { skipped: true, reason: 'Carbon API rate-limited (429) — backed off 5s.' };
      }
      return { error: `API error ${resp.status}` };
    }

    const data = await resp.json();
    return {
      co2PerVisit: data.statistics.co2.grid.grams,
      green: data.green,
      cleanerThan: data.cleanerThan,
    };
  } catch (err) {
    return { error: err.message };
  }
}


// ---- Audit ----
async function auditPageAndExtras(page, url) {
  console.log(`\n🔎 Auditing page: ${url}`);
  const flow = await startFlow(page, { config: desktopConfig });

  try {
    await flow.navigate(url, { stepName: `Navigate: ${url}` });
    await flow.startTimespan({ stepName: 'Scroll & interact' });
    await autoScroll(page);
    await tryInputAndClick(page);
    await flow.endTimespan();

    const html = await page.content();

    
      const axeRes = await runAxeOnPage(page);
await sleep(1000); // 1 second pause

const htmlValidation = await validateHtmlWithW3C(html);
//await sleep(10000); // another 1 second pause

const cssText = await gatherCssText(page);
const webVitals = await collectWebVitalsFromPage(page);
const carbon = await getCarbonForUrl(url);

    

    const cssStats = analyzeCss(cssText || '');
    const lighthouseHtml = await flow.generateReport();
    const safe = safeNameFromUrl(url);
    const lhPath = `${REPORT_DIR}/${safe}-lighthouse.html`;
    const extraPath = `${REPORT_DIR}/${safe}-extras.json`;

    fs.writeFileSync(lhPath, lighthouseHtml, 'utf-8');
    fs.writeFileSync(
      extraPath,
      JSON.stringify(
        { url, timestamp: new Date().toISOString(), axe: axeRes, htmlValidation, cssStats, webVitals, carbon },
        null,
        2
      ),
      'utf-8'
    );

    console.log(`✅ Saved lightweight reports for ${url}`);
  } catch (err) {
    console.error(`❌ Error auditing ${url}:`, err);
  } finally {
    try { await flow.disconnect(); } catch {}
  }
}

// ---- Recursive crawl ----
async function crawl(browserPage, baseUrl, url, depth = 0) {
  if (visited.has(url)) return;
  if (visited.size >= MAX_PAGES) return;
  if (depth > MAX_DEPTH) return;

  visited.add(url);
  console.log(`➡️  [${visited.size}] depth=${depth} ${url}`);

  try {
    await browserPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (err) {
    console.warn(`! navigation to ${url} failed: ${err.message}`);
  }

  await auditPageAndExtras(browserPage, url);
  await sleep(REQUEST_PAUSE_MS);

  const baseOrigin = new URL(baseUrl).origin;
  const links = await getInternalLinks(browserPage, baseOrigin);
  for (const link of links) {
    if (visited.size >= MAX_PAGES) break;
    await crawl(browserPage, baseUrl, link, depth + 1);
  }
}

// ---- Run ----
async function run() {
  const chrome = await launch({ chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'] });
  const browser = await puppeteer.connect({ browserURL: `http://localhost:${chrome.port}` });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');

  await crawl(page, BASE_URL, BASE_URL, 0);

  await page.close();
  await browser.close();
  await chrome.kill();
  console.log('\n✅ All done. Lightweight reports in:', REPORT_DIR);
}

run().catch(err => { console.error('Fatal error:', err); process.exit(1); });
