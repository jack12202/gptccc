#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const LOCK_CONFIG_FILE = 'purchase-link-lock.json';
const URL_RE = /https?:\/\/[^"'`\s<>]+/g;
const PURCHASE_CTA_RE = /(立即购买|先购买|去购买|继续购买|购买\s*(?:ChatGPT\s*)?(?:Plus|AI)?\s*(?:激活码|卡密)|购买\s*(?:ChatGPT\s*)?(?:Plus|AI)|Plus\s*(?:月卡)?激活码\s*¥?\s*198|¥\s*198)/i;
const ACTIVATION_CTA_RE = /(已买|已购买|进入.*激活|去激活|激活中心|激活系统|自助充值|充值中心)/i;

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

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readLockConfig() {
  const content = staged
    ? (readIndexedFile(LOCK_CONFIG_FILE) || readCurrentFile(LOCK_CONFIG_FILE))
    : readCurrentFile(LOCK_CONFIG_FILE);
  if (!content) {
    console.error(`Purchase link lock config missing: ${LOCK_CONFIG_FILE}`);
    process.exit(1);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    console.error(`Purchase link lock config is not valid JSON: ${LOCK_CONFIG_FILE}`);
    console.error(error.message);
    process.exit(1);
  }
}

function stringList(config, key) {
  if (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== 'string' || value.trim() === '')) {
    console.error(`Purchase link lock config key "${key}" must be a non-empty string array.`);
    process.exit(1);
  }
  return uniqueValues(config[key]);
}

const lockConfig = readLockConfig();
const PURCHASE_URLS = stringList(lockConfig, 'purchaseUrls').map(normalizeUrl);
const ACTIVATION_URLS = stringList(lockConfig, 'activationUrls').map(normalizeUrl);
const SITE_HOSTS = new Set(stringList(lockConfig, 'siteHosts'));
const PURCHASE_HOSTS = new Set(PURCHASE_URLS.map(hostOf).filter(Boolean));
const ACTIVATION_HOSTS = new Set(ACTIVATION_URLS.map(hostOf).filter(Boolean));

function isAllowedPurchaseUrl(url) {
  return PURCHASE_URLS.includes(normalizeUrl(url));
}

function isConfiguredPurchaseHostUrl(url) {
  return PURCHASE_HOSTS.has(hostOf(url));
}

function isActivationUrl(url) {
  const normalized = normalizeUrl(url);
  return ACTIVATION_URLS.includes(normalized) || ACTIVATION_HOSTS.has(hostOf(normalized));
}

function isSameSiteUrl(url) {
  return SITE_HOSTS.has(hostOf(url));
}

function checkProtectedUrl(file, line, url) {
  const normalized = normalizeUrl(url);
  if (isAllowedPurchaseUrl(normalized)) {
    purchaseUrlCount += 1;
    return;
  }
  if (isConfiguredPurchaseHostUrl(normalized)) {
    fail(file, line, `purchase host URL must be one of ${PURCHASE_URLS.join(', ')}, got ${normalized}`);
  }
}

function checkUrlBinding(file, line, url, label) {
  const normalized = normalizeUrl(url);
  checkProtectedUrl(file, line, normalized);
  if (!PURCHASE_CTA_RE.test(label)) return;
  if (ACTIVATION_CTA_RE.test(label)) return;
  if (isSameSiteUrl(normalized)) return;
  if (!isAllowedPurchaseUrl(normalized)) {
    const activationHint = isActivationUrl(normalized) ? ' This looks like an activation/recharge URL.' : '';
    fail(file, line, `purchase CTA "${label}" must use one configured purchase URL (${PURCHASE_URLS.join(', ')}), got ${normalized}.${activationHint}`);
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
    if (!isAllowedPurchaseUrl(url) && !isSameSiteUrl(url)) {
      fail(file, line, `${name} is a purchase-related URL constant and must use one configured purchase URL (${PURCHASE_URLS.join(', ')}), got ${url}`);
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
  failures.push(`No configured purchase URL references found (${PURCHASE_URLS.join(', ')}). Purchase flow may have been removed or replaced.`);
}

if (failures.length > 0) {
  console.error('Purchase link lock failed.');
  console.error(`Configured purchase URLs: ${PURCHASE_URLS.join(', ')}`);
  console.error(`Configured activation/recharge URLs: ${ACTIVATION_URLS.join(', ')}`);
  console.error('');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('');
  console.error(`If the purchase URL really needs to change, get explicit owner confirmation first, then update ${LOCK_CONFIG_FILE} and the purchase CTAs together.`);
  process.exit(1);
}

console.log(`Purchase link lock passed. Configured purchase URLs: ${PURCHASE_URLS.join(', ')}.`);
