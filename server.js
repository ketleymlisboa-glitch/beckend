import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import { Resend } from "resend";

console.log("VERSAO NOVA DO SERVER ✅ 31/01");

// -------------------- APP --------------------
const app = express();
app.use(express.json());

// -------------------- CORS --------------------
const FRONTEND_URL = (process.env.FRONTEND_URL || "").trim();
const FRONTEND_SAFE =
  FRONTEND_URL && /^https?:\/\//i.test(FRONTEND_URL)
    ? FRONTEND_URL.replace(/\/+$/, "")
    : "https://legitsensi.shop";

// Se quiser travar CORS só no seu domínio, use FRONTEND_SAFE
app.use(
  cors({
    origin: FRONTEND_SAFE, // antes era "*" — mais seguro assim
    methods: ["GET", "POST"],
  })
);

// -------------------- EMAIL (RESEND) --------------------
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendAccessEmail({ to, title, orderId }) {
  const accessLink = `${FRONTEND_SAFE}/acesso?pedido=${encodeURIComponent(
    orderId
  )}`;

  const result = await resend.emails.send({
    from: process.env.MAIL_FROM,
    to,
    subject: `Seu acesso: ${title}`,
    html: `
      <h2>Pagamento confirmado ✅</h2>
      <p>Pedido: <b>${orderId}</b></p>
      <p>Aqui está seu acesso:</p>
      <p><a href="${accessLink}">${accessLink}</a></p>
      <p>Se tiver qualquer problema, responda este e-mail.</p>
    `,
  });

  console.log("RESEND RESULT:", result);
  return result;
}

// -------------------- MERCADO PAGO --------------------
const accessToken = (process.env.MP_ACCESS_TOKEN || "").trim();
if (!accessToken) {
  console.error("ERRO: MP_ACCESS_TOKEN não definido nas variáveis de ambiente.");
}

const client = new MercadoPagoConfig({ accessToken });
const preference = new Preference(client);

// ✅ Produtos (1 centavo cada)
const PRODUCTS = {
  p1: { title: "Produto 1 (Digital)", price: 0.01 },
  p2: { title: "Produto 2 (Digital)", price: 0.01 },
  p3: { title: "Produto 3 (Digital)", price: 0.01 },
};

// ✅ Upsell (1 centavo)
const UPSELL = { title: "Upsell — Bônus Turbo", price: 0.01 };

function asMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

// -------------------- ROTAS BÁSICAS --------------------
app.get("/", (req, res) => res.send("API online ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------- DEBUG TOKEN MP (CONFERE SE É VÁLIDO) --------------------
app.get("/api/mp-check", async (req, res) => {
  try {
    // Node 18+ tem fetch global. Se não tiver, isso vai falhar e cair no catch.
    const r = await fetch("https://api.mercadopago.com/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const j = await r.json();
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error:
        "Falha no fetch. Se estiver usando Node < 18, instale node-fetch ou atualize o Node. " +
        String(e?.message || e),
    });
  }
});

// -------------------- CHECKOUT: CRIAR PREFERÊNCIA (POST) --------------------
/**
 * body: { productId: "p1|p2|p3", withUpsell: true|false }
 */
app.post("/api/create-preference", async (req, res) => {
  try {
    const { productId, withUpsell } = req.body || {};
    const prod = PRODUCTS[productId];

    if (!prod) return res.status(400).json({ error: "productId inválido" });

    const items = [
      {
        title: prod.title,
        quantity: 1,
        currency_id: "BRL",
        unit_price: asMoney(prod.price),
      },
    ];

    if (withUpsell) {
      items.push({
        title: UPSELL.title,
        quantity: 1,
        currency_id: "BRL",
        unit_price: asMoney(UPSELL.price),
      });
    }

    const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").trim();

    const prefBody = {
      items,
      back_urls: {
        success: `${FRONTEND_SAFE}/success.html`,
        failure: `${FRONTEND_SAFE}/failure.html`,
        pending: `${FRONTEND_SAFE}/pending.html`,
      },
      auto_return: "approved",
      // descriptor: pode dar erro se tiver caracteres inválidos / tamanho
      statement_descriptor: "STA STORE",
      external_reference: `sta_${productId}_${withUpsell ? "upsell" : "no"}_${Date.now()}`,
      // ✅ webhook via variável (mais fácil trocar sem mexer no código)
      notification_url: WEBHOOK_URL || undefined,
    };

    console.log("PREF BODY:", prefBody);

    const result = await preference.create({ body: prefBody });

    return res.json({
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
    });
  } catch (err) {
    console.error("create-preference erro RAW:", err);

    const status = err?.status || err?.response?.status || null;
    const data = err?.response?.data || err?.cause || null;

    console.error("MP status:", status);
    console.error("MP data:", data);

    return res.status(500).json({
      error: "Falha ao criar preferência",
      mp_status: status,
      mp_error: data || String(err?.message || err),
    });
  }
});

// ✅ ATALHO DE TESTE (GET) — pra testar no navegador
app.get("/api/create-preference-test", async (req, res) => {
  try {
    const productId = req.query.productId || "p1";
    const withUpsell =
      req.query.withUpsell === "1" || req.query.withUpsell === "true";

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const r = await fetch(`${baseUrl}/api/create-preference`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, withUpsell }),
    });

    const j = await r.json();
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- WEBHOOK --------------------
// ✅ Evita enviar e-mail duplicado em re-tentativas do Mercado Pago
const sentPayments = new Set();

app.post("/api/webhook", async (req, res) => {
  try {
    const paymentId = req.query?.id || req.body?.data?.id;

    // MP pode mandar chamadas sem id útil; sempre responda 200
    if (!paymentId) return res.sendStatus(200);

    // Se já processamos esse pagamento, evita duplicar e-mail
    if (sentPayments.has(String(paymentId))) {
      return res.sendStatus(200);
    }

    const payment = new Payment(client);
    const data = await payment.get({ id: paymentId });

    console.log("WEBHOOK payment:", {
      id: data.id,
      status: data.status,
      status_detail: data.status_detail,
      transaction_amount: data.transaction_amount,
      external_reference: data.external_reference,
      payer_email: data.payer?.email,
    });

    if (data.status === "approved" && data.payer?.email) {
      sentPayments.add(String(data.id)); // marca como enviado

      await sendAccessEmail({
        to: data.payer.email,
        title: "STA STORE - Acesso",
        orderId: String(data.id),
      });
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK erro:", e);
    return res.sendStatus(200);
  }
});

// -------------------- TESTE DE EMAIL --------------------
app.get("/api/test-email", async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) return res.status(400).send("Passe ?to=seuemail@gmail.com");

    const r = await sendAccessEmail({
      to,
      title: "Teste STA STORE",
      orderId: "TESTE123",
    });

    return res.json({ ok: true, sentTo: to, resend: r });
  } catch (e) {
    console.error("TEST EMAIL ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- START --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server rodando na porta", PORT));
