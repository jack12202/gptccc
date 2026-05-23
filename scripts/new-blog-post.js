#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const SITE_URL = "https://www.gptc.cc";
const SITE_NAME = "嘉哥 GPTC.cc";
const BLOG_DIR = path.join(process.cwd(), "blog");
const BLOG_INDEX = path.join(BLOG_DIR, "index.html");
const SITEMAP = path.join(process.cwd(), "sitemap.xml");
const TODAY = new Date().toISOString().slice(0, 10);

const categories = ["全部", "充值教程", "支付失败", "银行卡问题", "到账异常", "安全避坑", "价格说明"];

const topicLinks = [
  { title: "GPT 充值", href: "/gpt-chongzhi/", desc: "了解国内用户开通、续费、到账和异常处理的完整流程。" },
  { title: "ChatGPT Plus 充值", href: "/blog/upgrade-guide-fast.html", desc: "聚焦 Plus 开通、支付方式和订阅状态确认。" },
  { title: "支付失败", href: "/blog/chatgpt-plus-zhifu-shibai.html", desc: "按扣款、处理中、银行卡被拒等状态排查。" },
  { title: "账号安全", href: "/blog/", desc: "下单前先确认哪些信息不能随便提供。" },
  { title: "平台选择", href: "/gpt-chongzhi/", desc: "从流程透明、凭证、售后和风险边界判断平台。" }
];

const fallbackRelated = [
  {
    title: "GPT充值完整指南：国内用户怎么开通 ChatGPT Plus",
    href: "/gpt-chongzhi/",
    desc: "先看充值流程、到账时间、账号安全和异常处理。"
  },
  {
    title: "ChatGPT Plus 开通后多久生效？先看正常和异常状态",
    href: "/blog/upgrade-guide-fast.html",
    desc: "开通后未生效时，先确认账号、刷新、订单和扣款状态。"
  },
  {
    title: "嘉哥 GPT 充值指南",
    href: "/blog/",
    desc: "继续查看支付失败、到账异常、银行卡被拒和安全避坑文章。"
  }
];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function slugify(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function json(value) {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

function readFile(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function extractMeta(file) {
  const html = readFile(file);
  const rel = `/${path.relative(process.cwd(), file).replace(/\\/g, "/")}`;
  const title = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "";
  const description = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] || "";
  const category = html.match(/分类：([^<｜]+)/)?.[1]?.trim() || html.match(/<span class="tag">([^<]+)<\/span>/i)?.[1] || "嘉哥指南";
  const updated = html.match(/(?:更新：|更新于 )(\d{4}-\d{2}-\d{2})/)?.[1] || TODAY;
  const readTime = html.match(/阅读时间：?([^<｜]+分钟)/)?.[1]?.trim() || html.match(/(\d+ 分钟阅读)/)?.[1]?.replace("阅读", "").trim() || "6 分钟";
  const tags = Array.from(html.matchAll(/<span class="pill">([^<]+)<\/span>/g)).map((m) => m[1]);

  return {
    title: stripHtml(title).replace(/｜嘉哥 GPTC\.cc$/, ""),
    description: stripHtml(description),
    category: stripHtml(category),
    updated,
    readTime,
    tags,
    href: rel
  };
}

function getExistingPosts(excludeHref = "") {
  if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });
  return fs.readdirSync(BLOG_DIR)
    .filter((name) => name.endsWith(".html") && name !== "index.html")
    .map((name) => extractMeta(path.join(BLOG_DIR, name)))
    .filter((post) => post.href !== excludeHref && post.title)
    .sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title));
}

function pickRelated(category, slug, limit = 3) {
  const currentHref = `/blog/${slug}.html`;
  const posts = getExistingPosts(currentHref);
  const sameCategory = posts.filter((post) => post.category === category);
  const picked = [...sameCategory, ...posts].filter((post, index, arr) => arr.findIndex((item) => item.href === post.href) === index);
  return [...picked, ...fallbackRelated].filter((post, index, arr) => arr.findIndex((item) => item.href === post.href) === index).slice(0, limit);
}

function keywordFromTitle(title, explicitKeyword) {
  if (explicitKeyword) return explicitKeyword;
  if (title.includes("ChatGPT Plus 支付失败")) return "ChatGPT Plus 支付失败";
  if (title.includes("GPT 充值失败")) return "GPT 充值失败";
  if (title.includes("银行卡")) return "GPT 充值银行卡被拒";
  if (title.includes("不到账")) return "GPT 充值不到账";
  if (title.includes("安全") || title.includes("密码")) return "ChatGPT Plus 账号安全";
  return title.replace(/[？?].*$/, "").slice(0, 18);
}

function defaultDescription(title, keyword) {
  if (title.includes("支付失败")) {
    return "ChatGPT Plus 支付失败时，国内用户先按未扣款、已扣款、处理中、银行卡被拒和账号状态逐项排查，保存凭证后再决定是否重试或换方式开通。";
  }
  if (keyword.includes("不到账")) {
    return "GPT 充值不到账时，先核对账号、订单、扣款记录和到账提示，区分同步延迟、信息填错和订单异常，再决定是否联系客服处理。";
  }
  if (keyword.includes("银行卡被拒")) {
    return "GPT 充值银行卡被拒时，先排查境外支付权限、3DS 验证、账单地址、发卡行风控和账号环境，不要连续高频试卡。";
  }
  if (keyword.includes("续费失败")) {
    return "ChatGPT Plus 续费失败时，先确认订阅到期时间、扣款状态、原支付方式和账号邮箱，再决定更新付款方式或换开通方案。";
  }
  if (keyword.includes("充值失败")) {
    return "GPT 充值失败后，先按未扣款、处理中、已扣款未生效三种状态排查，保存凭证后再决定等待、重试或联系客服。";
  }
  return `${keyword}问题先确认账号、扣款、订单和页面提示，再决定等待、联系客服或换一种方式开通。`;
}

function defaultFaqs(keyword) {
  if (keyword.includes("银行卡被拒")) {
    return [
      {
        q: "GPT 充值银行卡被拒后可以继续换卡吗？",
        a: "可以先排查原因，但不建议短时间连续高频换卡。先确认境外支付权限、3DS 验证、账单地址和银行风控提示。"
      },
      {
        q: "银行卡被拒一定是卡不能用吗？",
        a: "不一定。也可能是发卡行风控、账单地址不匹配、验证失败、账号环境异常或订阅商户被拦截。"
      },
      {
        q: "银行卡被拒会扣款吗？",
        a: "多数失败不会最终扣款，但可能出现预授权或处理中记录。看到扣款或冻结记录时，先保存凭证并等待银行状态更新。"
      },
      {
        q: "一直被拒还能怎么开通 Plus？",
        a: "可以先看 GPT 充值完整流程，选择充值到自己账号、无需提供账号密码，并且有异常订单处理说明的方案。"
      }
    ];
  }

  if (keyword.includes("不到账")) {
    return [
      {
        q: "GPT 充值不到账可以马上再下一单吗？",
        a: "不建议。先确认是否已经扣款、订单是否处理中、账号邮箱是否填写正确，再联系平台核查。"
      },
      {
        q: "充值不到账通常是什么原因？",
        a: "常见原因包括账号填错、订单仍在处理、页面未刷新、订阅同步延迟、付款异常或平台需要人工核查。"
      },
      {
        q: "联系客服需要准备什么？",
        a: "建议准备付款时间、金额、订单号、账号邮箱、页面截图和扣款记录，方便快速定位订单状态。"
      },
      {
        q: "一直不到账怎么处理？",
        a: "先保留凭证并停止重复付款，再让平台核查订单。确认前一笔状态后，再决定退款、重试或换方式开通。"
      }
    ];
  }

  return [
    {
      q: `${keyword}后可以马上重复付款吗？`,
      a: "不建议马上重复付款。先确认是否已经扣款、订单是否处理中，以及账号是否填错，保存凭证后再继续处理。"
    },
    {
      q: "已经扣款但没有生效怎么办？",
      a: "先保存扣款记录、订单时间、账号邮箱和页面提示，再联系对应平台或客服核查。已扣款场景不要盲目连续下单。"
    },
    {
      q: "国内用户没有可用银行卡怎么办？",
      a: "如果官方支付长期失败，可以先了解 GPT 充值流程和风险边界，再选择充值到自己账号、无需提供密码的开通方式。"
    },
    {
      q: "找代充平台要注意什么？",
      a: "重点看是否充值到自己的账号、是否要求提供密码、是否有订单凭证和异常处理说明，不要只看低价。"
    }
  ];
}

function defaultSections(keyword) {
  if (keyword.includes("不到账")) {
    return [
      {
        h2: "一、先确认是不是同一个账号",
        body: [
          "GPT 充值不到账时，先别急着判断平台一定失败。最常见的情况之一，是下单时填写的邮箱、登录方式或 ChatGPT 账号，与正在查看的账号不是同一个。",
          "尤其是同时使用邮箱登录、Google 登录、Apple 登录时，要核对 ChatGPT 设置里的账号邮箱。账号不一致时，页面看不到 Plus 权限，但订单可能已经发到另一个账号。"
        ]
      },
      {
        h2: "二、再看订单和扣款状态",
        body: [
          "如果账号确认没错，再看订单状态和扣款状态。未扣款、已扣款、处理中、支付成功但未生效，对应的处理顺序不同。",
          "已扣款或处理中时，先保存付款记录、订单号、付款时间和页面截图，不要连续重复下单。重复付款会让后续核查更复杂。"
        ]
      },
      {
        h2: "三、排查页面刷新和订阅同步",
        body: [
          "有些到账问题只是页面没有刷新或订阅状态同步慢。可以退出 ChatGPT 后重新登录，换浏览器或无痕窗口查看订阅状态，再确认模型入口是否变化。",
          "如果仍然没有生效，再把账号邮箱、订单页面和扣款记录发给客服核查。嘉哥建议一次性给完整信息，不要只发一句“没到账”。"
        ]
      },
      {
        h2: "四、什么时候需要停止操作",
        body: [
          "只要订单已经扣款、显示处理中，或者你不确定账号是否填错，就先停止继续付款。先把前一笔状态查清楚，再决定等待、修正账号、退款或重新开通。",
          "如果官方支付和第三方订单都出现异常，优先处理已有订单，不要同时开多个未完成流程。"
        ]
      }
    ];
  }

  if (keyword.includes("银行卡被拒")) {
    return [
      {
        h2: "一、先看银行有没有给拒付提示",
        body: [
          "GPT 充值银行卡被拒，先看银行 App、短信或邮箱有没有拒付提示。发卡行是否允许境外线上交易、订阅商户、外币支付，是第一层判断。",
          "如果银行明确提示风险拦截或交易失败，继续在 OpenAI 页面重复提交通常意义不大，应该先处理银行卡权限或换方式。"
        ]
      },
      {
        h2: "二、检查 3DS 验证和账单地址",
        body: [
          "很多卡不是余额问题，而是 3DS 验证失败、验证码没有通过、账单地址不匹配，或浏览器环境导致验证页没有正常弹出。",
          "可以确认账单地址、邮编、卡片姓名、验证码流程是否完整。信息不一致时，系统可能只显示 payment failed，但背后原因是验证没有过。"
        ]
      },
      {
        h2: "三、不要短时间高频试卡",
        body: [
          "连续高频试卡可能触发更多风控，也可能让账号支付环境变得更敏感。嘉哥建议每次失败后先记录错误提示，再判断是否值得继续尝试。",
          "如果多张卡都被拒，就不要继续把问题简化成“换一张卡”。这时候更可能是商户、账号、环境或发卡行策略共同导致。"
        ]
      },
      {
        h2: "四、被拒后怎么选择替代方案",
        body: [
          "如果你不想继续试卡，可以回到 GPT 充值完整指南，选择充值到自己账号、无需提供账号密码、异常可协助处理的开通流程。",
          "替代方案也要看清风险边界：不要选择共享号、成品号或要求提供完整账号密码的流程。"
        ]
      }
    ];
  }

  if (keyword.includes("续费失败")) {
    return [
      {
        h2: "一、先确认 Plus 是否已经到期",
        body: [
          "ChatGPT Plus 续费失败时，先看订阅页显示的是即将到期、已经降级，还是仍在处理中。不同状态下，账号权限变化和处理窗口不一样。",
          "如果还没到期，可以先更新付款方式或准备替代开通方案；如果已经降级，再按新开通流程确认账号和支付状态。"
        ]
      },
      {
        h2: "二、检查原支付方式是否失效",
        body: [
          "续费失败常见原因包括原卡过期、余额不足、境外交易被关、发卡行风控、3DS 验证失败，或者订阅商户被银行拒绝。",
          "如果银行有拒付提示，先处理银行卡问题。没有明确提示时，再看 OpenAI 订阅页和邮箱通知，确认是否需要重新绑定付款方式。"
        ]
      },
      {
        h2: "三、已扣款但订阅没恢复怎么办",
        body: [
          "如果续费时已经扣款，但账号仍显示未续费或已降级，先保存扣款记录和订阅页截图，不要马上重复付款。",
          "这类问题需要核对账号邮箱、扣款时间、金额和订单状态。确认是同步延迟还是订单异常后，再决定等待或联系客服。"
        ]
      },
      {
        h2: "四、续费一直失败时的处理顺序",
        body: [
          "嘉哥建议先处理旧订阅状态，再决定是否换方式开通。不要在同一个账号上同时进行多个不确定订单。",
          "如果官方续费长期失败，可以选择充值到自己账号的开通方式，但前提是先确认没有未处理扣款。"
        ]
      }
    ];
  }

  if (keyword.includes("充值失败")) {
    return [
      {
        h2: "一、先把失败状态分成三类",
        body: [
          "GPT 充值失败先分三类：未扣款失败、订单处理中、已扣款但未生效。不要只看一个失败提示就马上重新付款。",
          "未扣款通常可以检查支付方式后谨慎重试；处理中要等待状态变化；已扣款未生效则要保存凭证并联系客服核查。"
        ]
      },
      {
        h2: "二、未扣款失败怎么排查",
        body: [
          "如果没有扣款，优先看付款方式是否可用、网络页面是否完整、账号信息是否填写正确，以及平台是否提示重新提交。",
          "官方支付失败时，还要看银行卡是否支持境外订阅、3DS 验证和账单地址是否匹配。"
        ]
      },
      {
        h2: "三、已扣款或处理中怎么处理",
        body: [
          "只要出现扣款、冻结或处理中，就先不要重复付款。保存付款时间、金额、订单号、账号邮箱和页面提示，再联系平台处理。",
          "很多重复付款问题，都是因为用户在第一笔还没确认前又开了第二笔。嘉哥建议先让一笔订单有明确结论。"
        ]
      },
      {
        h2: "四、什么时候考虑换开通方式",
        body: [
          "如果你确认没有未处理扣款，但官方支付或原平台连续失败，可以考虑换一种更适合国内用户的开通流程。",
          "换方式时仍要坚持基本原则：充值到自己的账号、无需提供账号密码、有订单凭证、异常可协助处理。"
        ]
      }
    ];
  }

  if (keyword.includes("支付失败")) {
    return [
      {
        h2: "一、先判断有没有真正扣款",
        body: [
          "遇到 ChatGPT Plus 支付失败，第一步不是继续换卡猛试，而是先看钱有没有出去。未扣款、预授权、已扣款未生效、订单处理中，对应的处理方式完全不同。",
          "如果银行 App 没有扣款，只看到 ChatGPT 页面提示失败，通常可以先检查卡片是否支持外币、3DS 验证、账单地址和网络环境。若已经扣款或显示处理中，就先停下来保存凭证。"
        ]
      },
      {
        h2: "二、国内用户常见失败原因",
        body: [
          "国内用户最常见的问题，是银行卡不支持海外订阅、发卡行风控拦截、3DS 验证失败、账单地址不匹配，或者账号地区和支付环境异常。页面只写 payment failed 时，不代表原因只有一个。",
          "嘉哥建议按顺序看：卡片是否支持国际支付，是否打开线上和境外交易，银行是否发来拒付短信，OpenAI 页面是否要求重新验证，以及当前账号是不是同一个常用账号。"
        ]
      },
      {
        h2: "三、已扣款但 Plus 没生效怎么处理",
        body: [
          "如果已经扣款，但 ChatGPT 里没有看到 Plus 权限，不要立刻重复付款。先刷新页面、退出重登、查看订阅页和邮箱收据，再核对是否登录了同一个 ChatGPT 账号。",
          "需要联系客服或平台协助时，把付款时间、金额、账号邮箱、失败截图、订单页面一起保存。信息越完整，越容易判断是同步延迟、订单异常还是账号填写问题。"
        ]
      },
      {
        h2: "四、什么时候适合换一种开通方式",
        body: [
          "如果你连续遇到银行卡被拒、官方支付页反复失败，或者不想再把多张卡放进高频尝试里，可以先看 GPT 充值完整指南，再选择更适合国内用户的开通流程。",
          "换方式前仍然要确认一件事：如果前一笔已经扣款或处理中，先处理完前一笔，不要让多个订单同时悬着。"
        ]
      }
    ];
  }

  return [
    {
      h2: `一、先确认${keyword}对应的状态`,
      body: ["先看账号、扣款、订单和页面提示。不同状态对应不同处理方式，不要只凭一个失败提示就重复操作。"]
    },
    {
      h2: "二、把凭证保存完整",
      body: ["建议保存付款时间、金额、订单页面、账号邮箱和错误提示。后续联系客服或核查订单时，这些信息会直接影响处理效率。"]
    },
    {
      h2: "三、再决定等待、重试还是换方式",
      body: ["未扣款可以检查设置后谨慎重试；已扣款或处理中应先等待和核查；长期失败时再考虑换一种开通方式。"]
    }
  ];
}

function renderArticle({ title, slug, description, category, keyword, tags, readTime, date }) {
  const canonical = `${SITE_URL}/blog/${slug}.html`;
  const faqs = defaultFaqs(keyword);
  const sections = defaultSections(keyword);
  const sectionIds = sections.map((section, index) => slugify(section.h2) || `section-${index + 1}`);
  const related = pickRelated(category, slug, 3);
  const oneLineAnswer = `${keyword}时，先确认是否扣款、订单是否处理中、账号是否一致，再决定等待、重试、联系客服或换一种方式开通，已扣款场景不要连续重复付款。`;
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description,
    datePublished: date,
    dateModified: date,
    author: { "@type": "Organization", name: "嘉哥 GPTC.cc" },
    publisher: { "@type": "Organization", name: "GPTC.cc" },
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical }
  };
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: { "@type": "Answer", text: faq.a }
    }))
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}｜嘉哥 GPTC.cc</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<style>
  :root{--bg:#f8fafc;--panel:#fff;--text:#172033;--muted:#64748b;--line:#dbe4ee;--accent:#0f766e;--accent-2:#14b8a6;--soft:#ecfdf5;--ink:#082f2b}
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(180deg,#f8fafc 0%,#eef7f5 100%);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.75}
  a{color:var(--accent)}
  .wrap{width:min(1080px,calc(100% - 32px));margin:0 auto;padding:28px 0 64px}
  .nav{display:flex;justify-content:space-between;gap:16px;align-items:center;padding-bottom:18px;border-bottom:1px solid var(--line)}
  .brand{color:var(--text);text-decoration:none;font-weight:900}
  .home{color:#fff;background:var(--accent);text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:800;font-size:14px;white-space:nowrap}
  .crumb{color:var(--muted);font-size:14px;margin:22px 0 0}
  .layout{display:grid;grid-template-columns:minmax(0,820px) 220px;gap:28px;align-items:start}
  article{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:28px;box-shadow:0 18px 48px rgba(15,23,42,.08);margin-top:24px}
  h1{font-size:clamp(30px,5vw,44px);line-height:1.18;margin:0 0 12px;letter-spacing:0}
  h2{font-size:24px;margin:34px 0 12px;border-left:4px solid var(--accent);padding-left:12px}
  h3{font-size:19px;margin:24px 0 8px}
  p{margin:12px 0}
  ul{padding-left:22px}
  li{margin:8px 0}
  .meta{color:var(--muted);font-size:14px;margin-bottom:20px}
  .tags{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}
  .pill{background:#eef6f5;color:#0f766e;border-radius:999px;padding:4px 9px;font-size:13px;font-weight:750}
  .answer{background:var(--soft);border:1px solid #a7f3d0;border-radius:10px;padding:16px;margin:18px 0;color:#064e3b}
  .advice{background:var(--ink);color:#ecfeff;border-radius:12px;padding:18px;margin:24px 0}
  .advice strong{display:block;font-size:19px;margin-bottom:6px}
  .advice p{margin:0 0 14px;color:#ccfbf1}
  .button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 18px;border-radius:8px;background:#ecfeff;color:#064e3b!important;text-decoration:none;font-weight:900}
  .toc{position:sticky;top:20px;margin-top:24px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px}
  .toc strong{display:block;margin-bottom:8px}
  .toc a{display:block;text-decoration:none;color:#475569;font-size:14px;margin:8px 0}
  .related,.cta{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:28px}
  .related-card{display:block;text-decoration:none;border-top:1px solid var(--line);padding:12px 0;color:var(--text)}
  .related-card:first-of-type{border-top:0}
  .related-card span{display:block;color:var(--muted);font-size:14px;margin-top:4px}
  .cta{background:#082f2b;color:#ecfeff}
  .cta p{color:#ccfbf1}
  .cta a{color:#064e3b;background:#ecfeff;border-radius:8px;min-height:42px;padding:0 16px;display:inline-flex;align-items:center;text-decoration:none;font-weight:900}
  footer{margin-top:24px;color:var(--muted);font-size:14px}
  @media (max-width:920px){.layout{grid-template-columns:1fr}.toc{display:none}}
  @media (max-width:620px){article{padding:20px}.wrap{width:min(100% - 24px,1080px)}.nav{align-items:flex-start}}
</style>
<script type="application/ld+json">
${json(articleSchema)}
</script>
<script type="application/ld+json">
${json(faqSchema)}
</script>
</head>
<body>
<main class="wrap">
  <nav class="nav">
    <a class="brand" href="/">嘉哥 GPTC.cc</a>
    <a class="home" href="/">进入开通中心</a>
  </nav>

  <div class="crumb"><a href="/">首页</a> / <a href="/blog/">嘉哥指南</a> / ${escapeHtml(category)}</div>
  <div class="layout">
    <article>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">作者：嘉哥 / GPTC.cc ｜ 发布：${date} ｜ 更新：${date} ｜ 阅读时间：${escapeHtml(readTime)} ｜ 分类：${escapeHtml(category)}</div>
      <div class="tags">${tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}</div>

      <div class="answer"><strong>一句话答案：</strong>${escapeHtml(oneLineAnswer)}</div>

      <div class="advice">
        <strong>嘉哥建议</strong>
        <p>先保存扣款记录、订单页面和错误提示。只要已经扣款或显示处理中，就不要连续重复付款；确认状态后，再决定联系平台、等待同步，或回到 GPTC.cc 换一种开通方式。</p>
        <a class="button" href="/gpt-chongzhi/">先看 GPT 充值完整指南</a>
      </div>

      ${sections.map((section, index) => `<h2 id="${sectionIds[index]}">${escapeHtml(section.h2)}</h2>
      ${section.body.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n      ")}`).join("\n\n      ")}

      <h2 id="faq">FAQ</h2>
      ${faqs.map((faq) => `<h3>${escapeHtml(faq.q)}</h3>
      <p>${escapeHtml(faq.a)}</p>`).join("\n      ")}

      <div class="related">
        <strong>相关文章</strong>
        ${related.map((item) => `<a class="related-card" href="${item.href}">${escapeHtml(item.title)}<span>${escapeHtml(item.desc || item.description || "继续查看嘉哥整理的 GPT 充值排查指南。")}</span></a>`).join("\n        ")}
      </div>

      <div class="cta">
        <strong>需要换一种方式开通？</strong>
        <p>如果官方支付反复失败，先确认没有未处理扣款，再进入 GPTC.cc 查看充值到自己账号、无需提供账号密码的开通方案。</p>
        <a href="/">进入 GPTC.cc 开通中心</a>
      </div>
    </article>
    <aside class="toc" aria-label="文章目录">
      <strong>目录</strong>
      ${sections.map((section, index) => `<a href="#${sectionIds[index]}">${escapeHtml(section.h2.replace(/^.+?、/, ""))}</a>`).join("\n      ")}
      <a href="#faq">FAQ</a>
    </aside>
  </div>
  <footer>GPTC.cc 为第三方服务网站，并非 OpenAI 或 ChatGPT 官方网站。页面中提及的产品名称仅用于说明服务适配对象。</footer>
</main>
</body>
</html>
`;
}

function renderBlogIndex(posts) {
  const latest = posts
    .map((post) => `<a class="article" href="${post.href}">
      <span class="tag">${escapeHtml(post.category)}</span>
      <span class="title">${escapeHtml(post.title)}</span>
      <p class="desc">${escapeHtml(post.description)}</p>
      <span class="meta"><span>更新于 ${post.updated}</span><span>${escapeHtml(post.readTime)}阅读</span>${(post.tags.length ? post.tags : [post.category]).slice(0, 2).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}</span>
    </a>`)
    .join("\n    ");

  const hotQuestions = [
    { title: "ChatGPT Plus 支付失败怎么办？", href: "/blog/chatgpt-plus-zhifu-shibai.html" },
    { title: "ChatGPT Plus 怎么快速开通？", href: "/blog/upgrade-guide-fast.html" },
    { title: "国内用户没有海外卡怎么办？", href: "/blog/chatgpt-plus-zhifu-shibai.html" },
    { title: "GPT 充值要不要提供账号密码？", href: "/gpt-chongzhi/" },
    { title: "支付失败后可以重复付款吗？", href: "/blog/chatgpt-plus-zhifu-shibai.html" },
    { title: "低价 GPT Plus 为什么要谨慎？", href: "/blog/" }
  ];

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>嘉哥 GPT 充值指南｜ChatGPT Plus 开通、支付失败和到账问题</title>
<meta name="description" content="嘉哥 GPT 充值指南整理 ChatGPT Plus 开通、GPT 充值失败、银行卡被拒、续费异常、自动发卡、账号安全和到账问题的排查方法。">
<link rel="canonical" href="${SITE_URL}/blog/">
<meta property="og:title" content="嘉哥 GPT 充值指南｜ChatGPT Plus 开通、支付失败和到账问题">
<meta property="og:description" content="面向国内用户的 GPT 充值和 ChatGPT Plus 开通指南，先讲清风险、扣款状态和处理顺序，再引导到 GPTC.cc 自助开通。">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE_URL}/blog/">
<style>
  :root{--bg:#f8fafc;--panel:#fff;--text:#172033;--muted:#64748b;--line:#dbe4ee;--accent:#0f766e;--accent-2:#14b8a6;--soft:#ecfdf5;--shadow:0 18px 48px rgba(15,23,42,.08)}
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(180deg,#f8fafc 0%,#eef7f5 100%);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7}
  a{color:inherit}
  .wrap{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:28px 0 64px}
  .nav{display:flex;justify-content:space-between;align-items:center;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--line)}
  .brand{text-decoration:none;font-weight:900;color:var(--text)}
  .home{text-decoration:none;color:#fff;background:var(--accent);padding:9px 16px;border-radius:8px;font-weight:800;font-size:14px;white-space:nowrap}
  .hero{padding:42px 0 28px;display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:28px;align-items:end}
  .eyebrow{display:inline-flex;color:var(--accent);background:var(--soft);border:1px solid #a7f3d0;border-radius:999px;padding:6px 12px;font-size:13px;font-weight:800;margin-bottom:14px}
  h1{margin:0;font-size:clamp(32px,5vw,52px);line-height:1.1;letter-spacing:0}
  .intro{color:var(--muted);max-width:720px;margin:16px 0 0;font-size:17px}
  .hero-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:18px}
  .hero-card strong{display:block;margin-bottom:6px}.hero-card p{color:var(--muted);margin:0 0 14px;font-size:14px}
  .hero-card a{display:flex;align-items:center;justify-content:center;min-height:42px;color:#fff;background:var(--accent);border-radius:8px;text-decoration:none;font-weight:850}
  .categories{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 26px}
  .chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 12px;font-size:14px;color:#334155}
  .chip.active{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:800}
  .section-title{font-size:22px;margin:28px 0 14px}
  .question-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:28px}
  .question{display:block;text-decoration:none;background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px;color:#1f2937;font-weight:750}
  .question:hover,.article:hover{border-color:rgba(20,184,166,.75);transform:translateY(-2px)}
  .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
  .article{display:flex;flex-direction:column;min-height:230px;text-decoration:none;background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px;box-shadow:0 10px 28px rgba(15,23,42,.06);transition:.18s ease}
  .tag{color:var(--accent);font-size:13px;font-weight:850}.title{font-size:20px;line-height:1.35;font-weight:900;margin:8px 0 10px}.desc{color:var(--muted);margin:0;font-size:14px}
  .meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:auto;padding-top:16px;color:#789;font-size:13px}.pill{background:#eef6f5;color:#0f766e;border-radius:999px;padding:3px 8px;font-weight:750}
  .topics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.topic{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px;text-decoration:none}.topic strong{display:block}.topic span{display:block;color:var(--muted);font-size:13px;margin-top:4px}
  .plan{margin-top:28px;background:#082f2b;color:#ecfeff;border-radius:14px;padding:22px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center}
  .plan h2{margin:0 0 6px;font-size:22px}.plan p{margin:0;color:#ccfbf1}.plan a{color:#064e3b;background:#ecfeff;border-radius:8px;min-height:42px;padding:0 18px;display:flex;align-items:center;text-decoration:none;font-weight:900;white-space:nowrap}
  footer{margin-top:36px;color:var(--muted);font-size:14px;border-top:1px solid var(--line);padding-top:18px}
  @media (max-width:900px){.hero{grid-template-columns:1fr}.question-grid,.grid{grid-template-columns:1fr 1fr}.topics{grid-template-columns:1fr 1fr}}
  @media (max-width:620px){.wrap{width:min(100% - 24px,1120px);padding-top:18px}.nav{align-items:flex-start}.question-grid,.grid,.plan,.topics{grid-template-columns:1fr}.hero{padding-top:30px}}
</style>
<script type="application/ld+json">
${json({
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "嘉哥 GPT 充值指南",
  description: "ChatGPT Plus 开通、GPT 充值失败、银行卡被拒、续费异常、自动发卡和账号安全问题的排查指南。",
  url: `${SITE_URL}/blog/`,
  publisher: { "@type": "Organization", name: "GPTC.cc" }
})}
</script>
</head>
<body>
<main class="wrap">
  <nav class="nav">
    <a class="brand" href="/">嘉哥 GPTC.cc</a>
    <a class="home" href="/">进入开通中心</a>
  </nav>

  <section class="hero">
    <div>
      <div class="eyebrow">嘉哥 GPT 充值指南</div>
      <h1>支付失败、充值不到账，先把状态判断清楚</h1>
      <p class="intro">这里整理 ChatGPT Plus 开通、GPT 充值失败、银行卡被拒、续费异常、自动发卡、账号安全和到账问题。嘉哥会先帮你看清扣款状态和风险，再决定是否继续开通。</p>
    </div>
    <aside class="hero-card">
      <strong>不想继续试卡？</strong>
      <p>如果官方支付一直失败，可以先看充值完整指南，再选择 GPTC.cc 自助开通方案。</p>
      <a href="/gpt-chongzhi/">先看 GPT 充值指南</a>
    </aside>
  </section>

  <div class="categories" aria-label="内容分类">
    ${categories.map((item, index) => `<span class="chip${index === 0 ? " active" : ""}">${item}</span>`).join("\n    ")}
  </div>

  <h2 class="section-title">热门问题</h2>
  <section class="question-grid" aria-label="热门问题">
    ${hotQuestions.map((item) => `<a class="question" href="${item.href}">${item.title}</a>`).join("\n    ")}
  </section>

  <h2 class="section-title">最新指南</h2>
  <section class="grid" aria-label="文章列表">
    <a class="article" href="/gpt-chongzhi/">
      <span class="tag">核心指南</span>
      <span class="title">GPT充值完整指南：国内用户怎么开通 ChatGPT Plus</span>
      <p class="desc">先确认账号安全、充值流程、到账时间和异常处理，再决定是否下单开通。</p>
      <span class="meta"><span>更新于 ${TODAY}</span><span>8 分钟阅读</span><span class="pill">GPT 充值</span></span>
    </a>
    ${latest}
  </section>

  <h2 class="section-title">专题入口</h2>
  <section class="topics" aria-label="专题入口">
    ${topicLinks.map((topic) => `<a class="topic" href="${topic.href}"><strong>${topic.title}</strong><span>${topic.desc}</span></a>`).join("\n    ")}
  </section>

  <section class="plan">
    <div>
      <h2>嘉哥提醒</h2>
      <p>已经出现扣款、处理中或订阅没生效时，先保存凭证，不要连续重复付款。需要换一种方式开通时，再回到 GPTC.cc 选择方案。</p>
    </div>
    <a href="/">进入 GPTC.cc</a>
  </section>

  <footer>
    GPTC.cc 为第三方服务网站，并非 OpenAI 或 ChatGPT 官方网站。页面中提及的产品名称仅用于说明服务适配对象。
  </footer>
</main>
</body>
</html>
`;
}

function updateSitemap(posts) {
  const staticUrls = [
    { loc: `${SITE_URL}/`, priority: "1.0", changefreq: "weekly" },
    { loc: `${SITE_URL}/gpt-chongzhi/`, priority: "0.9", changefreq: "weekly" },
    { loc: `${SITE_URL}/blog/`, priority: "0.8", changefreq: "weekly" }
  ];
  const blogUrls = posts.map((post) => ({
    loc: `${SITE_URL}${post.href}`,
    priority: "0.7",
    changefreq: "monthly"
  }));
  const seen = new Set();
  const urls = [...staticUrls, ...blogUrls].filter((item) => {
    if (seen.has(item.loc)) return false;
    seen.add(item.loc);
    return true;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((item) => `  <url>
    <loc>${item.loc}</loc>
    <lastmod>${TODAY}</lastmod>
    <changefreq>${item.changefreq}</changefreq>
    <priority>${item.priority}</priority>
  </url>`).join("\n")}
</urlset>
`;
  fs.writeFileSync(SITEMAP, xml);
}

function main() {
  const args = parseArgs(process.argv);
  const title = args.title || "ChatGPT Plus 支付失败怎么办？国内用户排查指南";
  const slug = slugify(args.slug || "chatgpt-plus-zhifu-shibai");
  const keyword = keywordFromTitle(title, args.keyword);
  const description = args.description || defaultDescription(title, keyword);
  const category = args.category || "支付失败";
  const tags = (args.tags ? args.tags.split(",") : [keyword, "国内支付", "GPT 充值"]).map((tag) => tag.trim()).filter(Boolean);
  const readTime = args["read-time"] || "7 分钟";
  const date = args.date || TODAY;
  const articlePath = path.join(BLOG_DIR, `${slug}.html`);

  if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });
  if (fs.existsSync(articlePath) && !args.force) {
    throw new Error(`文章已存在：blog/${slug}.html。需要覆盖请加 --force`);
  }

  fs.writeFileSync(articlePath, renderArticle({ title, slug, description, category, keyword, tags, readTime, date }));
  const posts = getExistingPosts();
  fs.writeFileSync(BLOG_INDEX, renderBlogIndex(posts));
  updateSitemap(posts);

  console.log(`Created blog/${slug}.html`);
  console.log("Updated blog/index.html");
  console.log("Updated sitemap.xml");
}

main();
