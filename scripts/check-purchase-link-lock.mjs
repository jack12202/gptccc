#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PURCHASE_URL = 'https://fe.dtyuedan.cn/shop/jiage';
const ACTIVATION_URL = 'https://987ai.vip/recharge';
const URL_RE = /https?:\/\/[^"'`\s<>]+/g;
const PURCHASE_CTA_RE = /(立即购买|先购买|去购买|继续购买|购买\s*(?:ChatGPT\s*)?(?:Plus|AI)?\s*(?:激活码|卡密)|购买\s*(?:ChatGPT\s*)?(?:Plus|AI)|Plus\s*(?:月卡)?激活码\s*¥?\s*198|¥\s*198)/i;
const ACTIVATION_CTA_RE = /(已买|已购买|进入.*激活|去激活|激活中心|激活系统|自助充值|充值中心)/i;
const PROTECTED_HOST_RE = /^https:\/\/fe\.dtyuedan\.cn\//;
const RECHARGE_HOST_RE = /^https:\/\/987ai\.vip\//;

const staged = process.argv.includes('--staged');
const failures = [];
let purchaseUrlCount = 0;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function listFiles() {
  const output = git(['ls-files', '-z', '*.html', '*.js', '*.mjs', '*.md']);
  return output.split('\0').filter(Boolean);
}

function readIndexedFile(file) {
  try {
    return git(['show', `:${file}`]);
  } catch {
    return null;
  }
}

function readCurrentFile(file) {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

function stripHtml(value) {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function fail(file, line, message) {
  failures.push(`${file}:${line} ${message}`);
}

function normalizeUrl(url) {
  return url.replace(/[),.;，。；）]+$/g, '');
}

function checkProtectedUrl(file, line, url) {
  const normalized = normalizeUrl(url);
  if (normalized === PURCHASE_URL) {
    purchaseUrlCount += 1;
    return;
  }
  if (PROTECTED_HOST_RE.test(normalized)) {
    fail(file, line, `purchase host URL must stay exactly ${PURCHASE_URL}, got ${normalized}`);
  }
}

function checkUrlBinding(file, line, url, label) {
  const normalized = normalizeUrl(url);
  checkProtectedUrl(file, line, normalized);
  if (!PURCHASE_CTA_RE.test(label)) return;
  if (ACTIVATION_CTA_RE.test(label)) return;
  if (RECHARGE_HOST_RE.test(normalized)) {
    fail(file, line, `purchase CTA "${label}" must not link to the activation/recharge URL ${normalized}. Use ${PURCHASE_URL}.`);
  }
}

function scanElements(file, content) {
  const elementRe = /<(a|button)\b[\s\S]*?<\/\1>/gi;
  for (const match of content.matchAll(elementRe)) {
    const element = match[0];
    const line = lineOf(content, match.index || 0);
    const label = stripHtml(element);
    const attrRe = /\b(?:href|data-url|data-href|data-buy-url|data-purchase-url)=["']([^"']+)["']/gi;
    for (const attr of element.matchAll(attrRe)) {
      if (/^https?:\/\//.test(attr[1])) {
        checkUrlBinding(file, line, attr[1], label);
      }
    }
  }
}

function scanConstants(file, content) {
  const constantRe = /\b([A-Z0-9_]*(?:BUY|PURCHASE|CARD)[A-Z0-9_]*)\b\s*=\s*["'](https?:\/\/[^"']+)["']/g;
  for (const match of content.matchAll(constantRe)) {
    const line = lineOf(content, match.index || 0);
    const name = match[1];
    const url = normalizeUrl(match[2]);
    checkProtectedUrl(file, line, url);
    if (url !== PURCHASE_URL) {
      fail(file, line, `${name} is a purchase-related URL constant and must stay ${PURCHASE_URL}, got ${url}`);
    }
  }
}

function scanRawUrls(file, content) {
  for (const match of content.matchAll(URL_RE)) {
    checkProtectedUrl(file, lineOf(content, match.index || 0), match[0]);
  }
}

for (const file of listFiles()) {
  const content = staged ? readIndexedFile(file) : readCurrentFile(file);
  if (content == null) continue;
  scanElements(file, content);
  scanConstants(file, content);
  scanRawUrls(file, content);
}

if (purchaseUrlCount === 0) {
  failures.push(`No ${PURCHASE_URL} references found. Purchase flow may have been removed or replaced.`);
}

if (failures.length > 0) {
  console.error('Purchase link lock failed.');
  console.error(`Protected purchase URL: ${PURCHASE_URL}`);
  console.error(`Activation/recharge URL: ${ACTIVATION_URL}`);
  console.error('');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('');
  console.error('If the purchase URL really needs to change, get explicit owner confirmation first.');
  process.exit(1);
}

console.log(`Purchase link lock passed. Protected purchase URL remains ${PURCHASE_URL}.`);
