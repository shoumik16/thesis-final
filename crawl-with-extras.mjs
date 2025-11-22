import puppeteer from 'puppeteer';
import { startFlow, desktopConfig } from 'lighthouse';
import fs from 'fs';
import { launch } from 'chrome-launcher';
import * as axeCore from 'axe-core';
import validator from 'html-validator';


import cssstats from 'cssstats';
import fetch from 'node-fetch';


const BASE_URL = 'https://ecommerce-claudesonnet.vercel.app/';
const MAX_PAGES = 15;
const MAX_DEPTH = 3;
const REQUEST_PAUSE_MS = 1500;
const REPORT_DIR = 'reports';
const SUMMARY_DIR = 'summaries';
if (!fs.existsSync(SUMMARY_DIR)) fs.mkdirSync(SUMMARY_DIR, { recursive: true });

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
    // Wait until page is fully loaded (important!)
    await page.waitForLoadState?.('load') || await new Promise(r => setTimeout(r, 1000));

    // Inject metrics safely after page has loaded
    await page.evaluate(() => {
      if (!window.__metrics) {
        window.__metrics = {};
        window.__metricsPromise = new Promise(resolve => {
          // TTFB
          const navEntry = performance.getEntriesByType('navigation')[0];
          if (navEntry) window.__metrics.TTFB = navEntry.responseStart;

          // LCP
          new PerformanceObserver((entries) => {
            const last = entries.getEntries().pop();
            if (last) window.__metrics.LCP = last.startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true });

          // CLS
          new PerformanceObserver((entries) => {
            window.__metrics.CLS = entries.reduce((sum, e) => sum + e.value, 0);
          }).observe({ type: 'layout-shift', buffered: true });

          // INP
          new PerformanceObserver((entries) => {
            const last = entries.getEntries().pop();
            if (last) window.__metrics.INP = last.processingStart;
          }).observe({ type: 'event', buffered: true });

          // Resolve after short timeout
          setTimeout(() => resolve(window.__metrics), 3000);
        });
      }
    });

    // Wait for the metrics to be populated
    const metrics = await page.evaluate(() => window.__metricsPromise);
    return metrics;

  } catch (err) {
    console.error("Web Vitals collection failed:", err);
    return { error: err.message };
  }
}

async function getCarbonForUrl(url) {
  await sleep(1000);

  try {
    const resp = await fetch(`https://api.websitecarbon.com/site?url=${encodeURIComponent(url)}`);
    if (!resp.ok) {
      return null; // Return null on any HTTP error
    }

    const data = await resp.json();
    return {
      co2PerVisit: data?.statistics?.co2?.grid?.grams ?? null,
      green: data?.green ?? null,
      cleanerThan: data?.cleanerThan ?? null,
    };
  } catch {
    return null; // Return null on network or parsing error
  }
}




// Sleep helper


// Main function to get CO2 estimate

function scoreFromWebVitals(v) {
  if (!v) return 0;
  let score = 100;

  if (v.LCP && v.LCP > 4000) score -= 40;
  else if (v.LCP > 2500) score -= 20;

  if (v.CLS && v.CLS > 0.25) score -= 30;
  else if (v.CLS > 0.1) score -= 10;

  if (v.TTFB && v.TTFB > 1800) score -= 20;
  else if (v.TTFB > 800) score -= 10;

  if (v.INP && v.INP > 300) score -= 20;
  else if (v.INP > 200) score -= 10;

  return Math.max(0, score);
}

function scoreFromAxe(axe) {
  if (!axe || axe.violationsCount == null) return 0;
  if (axe.violationsCount === 0) return 100;
  return Math.max(0, 100 - axe.violationsCount * 10);
}

function scoreFromCss(css) {
  if (!css) return 0;
  if (css.status?.startsWith("⚠️")) return 60;
  return 100;
}

function scoreFromHtml(html) {
  if (!html?.messages) return 0;
  const errors = html.messages.filter(m => m.type === "error").length;
  return Math.max(0, 100 - errors * 10);
}

function scoreFromCarbon(carbon) {
  if (!carbon || carbon.co2PerVisit == null) return 0;
  if (carbon.co2PerVisit < 0.3) return 100;
  if (carbon.co2PerVisit < 1) return 80;
  if (carbon.co2PerVisit < 2) return 60;
  return 40;
}

function computeOverall(s) {
  const values = [
    s.axeScore,
    s.cssScore,
    s.htmlScore,
    s.webVitalsScore,
    s.carbonScore,
  ].filter(v => typeof v === "number");

  if (!values.length) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
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

    

    const cssStats =await analyzeCss(cssText || '');
    const lighthouseHtml = await flow.generateReport();
    // ---- SCORING ----
const scores = {
  axeScore: scoreFromAxe(axeRes),
  cssScore: scoreFromCss(cssStats),
  htmlScore: scoreFromHtml(htmlValidation),
  webVitalsScore: scoreFromWebVitals(webVitals),
  carbonScore: scoreFromCarbon(carbon),
};

scores.combinedOverall = computeOverall(scores);
//u
    const safe = safeNameFromUrl(url);
    const lhPath = `${REPORT_DIR}/${safe}-lighthouse.html`;
    const extraPath = `${REPORT_DIR}/${safe}-extras.json`;

    fs.writeFileSync(lhPath, lighthouseHtml, 'utf-8');
    fs.writeFileSync(
      extraPath,
      JSON.stringify(
        { url, timestamp: new Date().toISOString(), axe: axeRes, htmlValidation, cssStats, webVitals, carbon,scores  },
        null,
        2
      ),
      'utf-8'
    );

    console.log(`✅ Saved lightweight reports for ${url}`);
  if (!fs.existsSync(SUMMARY_DIR))
      fs.mkdirSync(SUMMARY_DIR, { recursive: true });

    const summary = {
      url,
      timestamp: new Date().toISOString(),
      scores,
      accessibilityViolations: axeRes?.violationsCount ?? null,
      htmlErrors:
        htmlValidation?.messages?.filter(m => m.type === 'error')?.length ??
        null,

      cssRules: cssStats?.rules ?? null,
      cssDeclarations: cssStats?.declarations ?? null,
      cssSize: cssStats?.length ?? null,

      lcp: webVitals?.LCP ?? null,
      cls: webVitals?.CLS ?? null,
      ttfb: webVitals?.TTFB ?? null,
      inp: webVitals?.INP ?? null,

      co2PerVisit: carbon?.co2PerVisit ?? null
    };

    const summaryPath = `${SUMMARY_DIR}/${safe}-summary.json`;
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

    console.log(`📊 Summary generated: ${summaryPath}`);
    console.log(`✅ Saved lightweight reports for ${url}`);

  }
catch (err) {
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
