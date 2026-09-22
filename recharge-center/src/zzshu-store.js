import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

export class ZzshuStore {
  constructor(file = config.zzshuDbFile) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payment_cards (id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, last_four TEXT NOT NULL,
        credential_ref TEXT NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
        max_success INTEGER NOT NULL DEFAULT 5, success_count INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0, last_failure TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vouchers (id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL, code_cipher TEXT NOT NULL,
        batch_id TEXT NOT NULL, source TEXT NOT NULL, product_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'unused',
        order_id TEXT, email TEXT, account_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, voucher_id TEXT NOT NULL UNIQUE REFERENCES vouchers(id),
        card_id TEXT NOT NULL REFERENCES payment_cards(id), email TEXT NOT NULL, account_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved', upstream_order_no TEXT, upstream_card_key TEXT,
        review_reason TEXT NOT NULL DEFAULT '', cancellation TEXT NOT NULL DEFAULT 'not_started',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS zzshu_card_active ON orders(card_id) WHERE status IN ('reserved','submitting','processing','needs_review');
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, order_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS card_roles (hifupay_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('h','zzshu')),
        h_order_id TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS h_card_claims (hifupay_id TEXT NOT NULL, order_id TEXT NOT NULL,
        PRIMARY KEY(hifupay_id,order_id));
      CREATE UNIQUE INDEX IF NOT EXISTS zzshu_hifupay_ref ON payment_cards(credential_ref) WHERE credential_ref LIKE 'hifupay:%';
    `);
    if (!this.db.prepare("PRAGMA table_info(payment_cards)").all().some(column => column.name === "payment_cipher"))
      this.db.exec("ALTER TABLE payment_cards ADD COLUMN payment_cipher TEXT");
    // Older databases made voucher_id unique in orders. A confirmed unpaid attempt
    // must remain in history while the same voucher can fund a later attempt.
    const ordersSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get()?.sql || "";
    if (/voucher_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(ordersSql)) {
      this.db.exec("PRAGMA foreign_keys=OFF");
      try {
        this.transaction(() => {
          this.db.exec("ALTER TABLE orders RENAME TO orders_old");
          this.db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, voucher_id TEXT NOT NULL REFERENCES vouchers(id),
            card_id TEXT NOT NULL REFERENCES payment_cards(id), email TEXT NOT NULL, account_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'reserved', upstream_order_no TEXT, upstream_card_key TEXT,
            review_reason TEXT NOT NULL DEFAULT '', cancellation TEXT NOT NULL DEFAULT 'not_started',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
          this.db.exec("INSERT INTO orders SELECT * FROM orders_old");
          this.db.exec("DROP TABLE orders_old");
          this.db.exec("CREATE UNIQUE INDEX zzshu_card_active ON orders(card_id) WHERE status IN ('reserved','submitting','processing','needs_review')");
          this.db.exec("CREATE UNIQUE INDEX zzshu_voucher_active ON orders(voucher_id) WHERE status IN ('reserved','submitting','processing','needs_review')");
        });
      } finally { this.db.exec("PRAGMA foreign_keys=ON"); }
    }
    this.db.exec("INSERT OR IGNORE INTO h_card_claims(hifupay_id,order_id) SELECT hifupay_id,h_order_id FROM card_roles WHERE h_order_id IS NOT NULL");
    this.db.exec("UPDATE card_roles SET h_order_id=NULL WHERE h_order_id IS NOT NULL");
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  hashes() { return new Set(this.db.prepare("SELECT fingerprint FROM payment_cards").all().map(row => row.fingerprint)); }
  role(hifupayId) {
    const id=String(hifupayId);
    const card=this.db.prepare("SELECT role FROM card_roles WHERE hifupay_id=?").get(id);
    const claim=this.db.prepare("SELECT order_id AS hOrderId FROM h_card_claims WHERE hifupay_id=? LIMIT 1").get(id);
    return {role:card?.role||"h",hOrderId:claim?.hOrderId||null};
  }
  hasHClaim(hifupayId, orderId) { return Boolean(this.db.prepare("SELECT 1 FROM h_card_claims WHERE hifupay_id=? AND order_id=?").get(String(hifupayId),String(orderId))); }
  hasHifupayAssignments() { return Boolean(this.db.prepare("SELECT 1 FROM card_roles WHERE role='zzshu' LIMIT 1").get()); }
  claimH(hifupayId, orderId) {
    return this.transaction(() => {
      const id=String(hifupayId), current=this.role(id);
      if (current.role !== "h") return false;
      this.db.prepare("INSERT OR IGNORE INTO card_roles(hifupay_id,role,h_order_id,updated_at) VALUES(?,'h',NULL,?)")
        .run(id,new Date().toISOString());
      this.db.prepare("INSERT OR IGNORE INTO h_card_claims(hifupay_id,order_id) VALUES(?,?)").run(id,orderId);
      return true;
    });
  }
  releaseH(hifupayId, orderId) {
    this.db.prepare("DELETE FROM h_card_claims WHERE hifupay_id=? AND order_id=?").run(String(hifupayId),String(orderId));
  }
  assignHifupay(card, role) {
    if (!["h","zzshu"].includes(role) || !card?.id || !/^\d{4}$/.test(String(card.lastFour || ""))) return {ok:false,reason:"卡片资料不完整"};
    return this.transaction(() => {
      const id=String(card.id), current=this.role(id), ref=`hifupay:${id}`;
      if (current.hOrderId) return {ok:false,reason:"嗨付订单仍占用此卡"};
      const payment=this.db.prepare("SELECT id FROM payment_cards WHERE credential_ref=?").get(ref);
      if (role === "h" && payment) {
        const pending=this.db.prepare("SELECT id FROM orders WHERE card_id=? AND status IN ('reserved','submitting','processing','needs_review') LIMIT 1").get(payment.id);
        if (pending) return {ok:false,reason:"吱吱鼠订单仍待确认"};
      }
      this.db.prepare("INSERT INTO card_roles(hifupay_id,role,h_order_id,updated_at) VALUES(?,?,NULL,?) ON CONFLICT(hifupay_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at")
        .run(id,role,new Date().toISOString());
      if (role === "zzshu" && !payment) this.db.prepare(`INSERT INTO payment_cards(id,fingerprint,last_four,credential_ref,source,note,enabled,max_success,created_at)
        VALUES(?,?,?,?,?,'',1,5,?)`).run(crypto.randomUUID(),crypto.createHash("sha256").update(ref).digest("hex"),String(card.lastFour),ref,"嗨付",new Date().toISOString());
      this.audit("card:"+id,"assignment_"+role,"管理员分配通道");
      return {ok:true,role};
    });
  }
  addPaymentCard(row, options) {
    return this.db.prepare(`INSERT OR IGNORE INTO payment_cards
      (id,fingerprint,last_four,credential_ref,source,note,enabled,max_success,created_at,payment_cipher) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), row.fingerprint, row.masked.slice(-4), options.credentialRef,
        options.source, options.note, options.enabled ? 1 : 0, options.maxSuccess, new Date().toISOString(), options.paymentCipher || null).changes === 1;
  }
  paymentCipher(ref) {
    return this.db.prepare("SELECT payment_cipher AS cipher FROM payment_cards WHERE credential_ref=?").get(ref)?.cipher || "";
  }
  listCards() {
    return this.db.prepare(`SELECT id,last_four AS lastFour,source,note,enabled,max_success AS maxSuccess,
      CASE WHEN credential_ref LIKE 'hifupay:%' THEN 'hifupay' ELSE 'manual' END AS credentialSource,
      MAX(0,max_success-success_count) AS remainingUses,
      success_count AS successCount,failures,paused,last_failure AS lastFailure,created_at AS createdAt,
      (SELECT id FROM orders WHERE card_id=payment_cards.id AND status IN ('reserved','submitting','processing','needs_review')) AS occupiedOrderId
      FROM payment_cards WHERE credential_ref NOT LIKE 'hifupay:%' OR EXISTS
        (SELECT 1 FROM card_roles WHERE hifupay_id=substr(payment_cards.credential_ref,9) AND role='zzshu')
      ORDER BY success_count DESC,created_at,id`).all();
  }
  updateCard(id, { enabled, note, maxSuccess, resume } = {}) {
    const card = this.db.prepare("SELECT * FROM payment_cards WHERE id=?").get(id);
    if (!card) return false;
    const cap = maxSuccess === undefined ? card.max_success : Number(maxSuccess);
    if (!Number.isInteger(cap) || cap < Math.max(1,card.success_count) || cap > 100) return false;
    this.db.prepare("UPDATE payment_cards SET enabled=?,note=?,max_success=?,paused=?,failures=? WHERE id=?")
      .run(enabled === undefined ? card.enabled : Number(Boolean(enabled)), note === undefined ? card.note : String(note).slice(0, 200), cap,
        resume ? 0 : card.paused, resume ? 0 : card.failures, id);
    return true;
  }
  createVouchers(count, source, productId, encrypt) {
    const batch = crypto.randomUUID(), output = [];
    this.transaction(() => {
      for (let i = 0; i < count; i++) {
        const code = `ZZPLUS${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
        const id = crypto.randomUUID();
        this.db.prepare("INSERT INTO vouchers(id,code_hash,code_cipher,batch_id,source,product_id,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(id, crypto.createHash("sha256").update(code).digest("hex"), encrypt(code), batch, source, productId, new Date().toISOString());
        output.push({ id, code, batchId: batch, source, productId, link: `https://www.gptc.cc/activate/?provider=zzshu&card=${encodeURIComponent(code)}` });
      }
    });
    return output;
  }
  voucher(code) { return this.db.prepare("SELECT id,status,order_id AS orderId,product_id AS productId,email,account_id AS accountId,batch_id AS batchId,source FROM vouchers WHERE code_hash=?")
    .get(crypto.createHash("sha256").update(code).digest("hex")); }
  listVouchers() { return this.db.prepare("SELECT id,batch_id AS batchId,source,product_id AS productId,status,order_id AS orderId,email,account_id AS accountId,created_at AS createdAt FROM vouchers ORDER BY created_at DESC LIMIT 500").all(); }
  reserve(code, email, accountId, allowedHifupayIds = null, allowManual = true) {
    return this.transaction(() => {
      const voucher = this.voucher(code);
      if (!voucher) return { ok: false, reason: "卡密不存在" };
      if (voucher.status !== "unused") return { ok: false, reason: voucher.status === "used" ? "卡密已使用" : "卡密处理中", orderId: voucher.email === email && voucher.accountId === accountId ? voucher.orderId : undefined };
      const active = this.db.prepare("SELECT count(*) AS n FROM orders WHERE status IN ('reserved','submitting','processing','needs_review')").get().n;
      if (active >= Math.max(1, config.zzshuConcurrency)) return { ok: false, reason: "通道处理量已满，请稍后再试" };
      const candidates = this.db.prepare(`SELECT * FROM payment_cards WHERE enabled=1 AND paused=0 AND success_count<max_success
        AND (credential_ref NOT LIKE 'hifupay:%' OR EXISTS (SELECT 1 FROM card_roles WHERE hifupay_id=substr(payment_cards.credential_ref,9) AND role='zzshu'))
        AND NOT EXISTS (SELECT 1 FROM orders WHERE card_id=payment_cards.id AND status IN ('reserved','submitting','processing','needs_review'))
        ORDER BY CASE WHEN success_count>0 THEN 0 ELSE 1 END,success_count DESC,created_at,id`).all();
      const card = candidates.find(item => item.credential_ref.startsWith("hifupay:")
        ? allowedHifupayIds?.has(item.credential_ref.slice(8)) : allowManual);
      if (!card) return { ok: false, reason: "暂无可用支付卡，兑换卡密未消耗" };
      const id = crypto.randomUUID(), at = new Date().toISOString();
      this.db.prepare("INSERT INTO orders(id,voucher_id,card_id,email,account_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(id,voucher.id,card.id,email,accountId,at,at);
      this.db.prepare("UPDATE vouchers SET status='reserved',order_id=?,email=?,account_id=? WHERE id=?").run(id,email,accountId,voucher.id);
      return { ok: true, orderId: id, credentialRef: card.credential_ref, lastFour: card.last_four };
    });
  }
  order(id) { return this.db.prepare(`SELECT o.*,c.last_four AS lastFour,v.batch_id AS batchId,v.source AS voucherSource,c.source AS paymentSource
    FROM orders o JOIN payment_cards c ON c.id=o.card_id JOIN vouchers v ON v.id=o.voucher_id WHERE o.id=?`).get(id); }
  listOrders() { return this.db.prepare(`SELECT o.id,o.email,o.account_id AS accountId,o.status,o.upstream_order_no AS upstreamOrderNo,
    o.review_reason AS reviewReason,o.cancellation,c.last_four AS lastFour,o.created_at AS createdAt,o.updated_at AS updatedAt
    FROM orders o JOIN payment_cards c ON c.id=o.card_id ORDER BY o.created_at DESC LIMIT 500`).all(); }
  recoverInterrupted(olderThanMs) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT id,status FROM orders WHERE status IN ('reserved','submitting') AND updated_at<?").all(cutoff);
      for (const row of rows) {
        const reason = row.status === "submitting"
          ? "服务中断于创建请求期间；上游是否已创建未知，禁止自动重发"
          : "服务中断于提交前；占用保留待管理员核查，禁止自动重发";
        this.db.prepare("UPDATE orders SET status='needs_review',review_reason=?,updated_at=? WHERE id=? AND status=?")
          .run(reason,new Date().toISOString(),row.id,row.status);
        this.audit(row.id,"interrupted_recovery",reason);
      }
      return rows.length;
    });
  }
  reconciliationIds(limit) {
    return this.db.prepare(`SELECT id FROM orders WHERE upstream_card_key IS NOT NULL AND
      (status IN ('processing','needs_review') OR (status='success' AND cancellation!='cancelled'))
      ORDER BY updated_at ASC,id LIMIT ?`).all(limit).map(row=>row.id);
  }
  markChecked(id) { this.db.prepare("UPDATE orders SET updated_at=? WHERE id=? AND status IN ('processing','needs_review','success')")
    .run(new Date().toISOString(),id); }
  markSubmitting(id) { this.db.prepare("UPDATE orders SET status='submitting',updated_at=? WHERE id=? AND status='reserved'").run(new Date().toISOString(),id); }
  created(id, orderNo, cardKey) {
    this.db.prepare("UPDATE orders SET status='processing',upstream_order_no=?,upstream_card_key=?,updated_at=? WHERE id=? AND status IN ('submitting','needs_review')")
      .run(orderNo,cardKey,new Date().toISOString(),id);
  }
  review(id, reason) { this.db.prepare("UPDATE orders SET status='needs_review',review_reason=?,updated_at=? WHERE id=? AND status NOT IN ('success','failed')")
    .run(reason,new Date().toISOString(),id); }
  abortBeforeSubmit(id, reason) {
    return this.transaction(() => {
      const order=this.order(id);
      if (!order || order.status !== "reserved") return false;
      this.audit(id,"pre_submit_aborted",reason);
      this.db.prepare("DELETE FROM orders WHERE id=?").run(id);
      this.db.prepare("UPDATE vouchers SET status='unused',order_id=NULL,email=NULL,account_id=NULL WHERE id=?").run(order.voucher_id);
      return true;
    });
  }
  settle(id, state, cancellation = "unconfirmed") {
    return this.transaction(() => {
      const order = this.order(id);
      if (!order || order.status === "success" || order.status === "failed") {
        if (order?.status === "success" && cancellation === "cancelled") this.db.prepare("UPDATE orders SET cancellation='cancelled',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
        return false;
      }
      if (state === "success") {
        this.db.prepare("UPDATE payment_cards SET success_count=success_count+1,failures=0 WHERE id=?").run(order.card_id);
        this.db.prepare("UPDATE vouchers SET status='used' WHERE id=?").run(order.voucher_id);
      } else if (state === "failed") {
        this.db.prepare("UPDATE payment_cards SET failures=failures+1,last_failure='上游明确未支付' WHERE id=?").run(order.card_id);
        this.db.prepare("UPDATE payment_cards SET paused=1 WHERE id=? AND failures>=?").run(order.card_id,Math.max(1,config.zzshuFailureThreshold));
        this.db.prepare("UPDATE vouchers SET status='unused',order_id=NULL,email=NULL,account_id=NULL WHERE id=? AND order_id=?")
          .run(order.voucher_id,id);
      }
      this.db.prepare("UPDATE orders SET status=?,cancellation=?,review_reason='',updated_at=? WHERE id=?")
        .run(state,state === "success" ? cancellation : "not_started",new Date().toISOString(),id);
      return true;
    });
  }
  audit(id, action, reason) { this.db.prepare("INSERT INTO audit(at,order_id,action,reason) VALUES(?,?,?,?)").run(new Date().toISOString(),id,action,reason); }
  manualResolve(id, outcome, reason) {
    if (!reason || reason.length < 8) return false;
    const order = this.order(id);
    if (!order || order.status !== "needs_review") return false;
    this.audit(id,`manual_${outcome}`,reason);
    if (outcome === "success") return this.settle(id,"success","unconfirmed");
    if (outcome === "unpaid") return this.settle(id,"failed");
    return false;
  }
}

export const sharedZzshuStore = new ZzshuStore();
