import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import { Resend } from "resend";

const app = express();
app.use(express.json());

// -------------------- CORS --------------------
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
  })
);

// -------------------- EMAIL (RESEND) --------------------
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendAccessEmail({ to, title, orderId }) {
  const accessLink = `https://legitsensi.shop/acesso?pedido=${orderId}`;

  const result = await resend.emails.send({
    from: process.env.MAIL_FROM, // ex: "STA STORE <onboarding@resend.dev>" ou "STA STORE <vendas@legitsensi.shop>"
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
const accessToken = process.env.MP_ACCESS_TOKEN;
if (!accessToken) {
  console.error("ERRO: MP_ACCESS_TOKEN não definido nas variáveis de ambiente.");
}

const client = new MercadoPagoConfig({ accessToken });
const preference = new Preference(client);

// Produtos
const PRODUCTS = {
  p1: { title: "Produto 1 (Digital)", price: 19.9 },
  p2: { title: "Produto 2 (Digital)", price: 29.9 },
  p3: { title: "Produto 3 (Digital)", price: 49.9 },
};

// Upsell
const UPSELL = { title: "Upsell — Bônus Turbo", price: 14.9 };

// Helper
function asMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

// -------------------- ROTAS BÁSICAS --------------------
app.get("/", (req, res) => res.send("API online ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------- DEBUG TOKEN MP (CONFERE SE É VÁLIDO) --------------------
app.get("/api/mp-check", async (req, res) => {
  try {
    const r = await fetch("https://api.mercadopago.com/users/me", {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });
    const j = await r.json();
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- CHECKOUT: CRIAR PREFERÊNCIA --------------------
/**
 * body: { productId: "p1|p2|p3", withUpsell: true|false }
 */
app.post("/api/create-preference", async (req, res) => {
  try {
    const { productId, withUpsell } = req.body || {};
    const prod = PRODUCTS[productId];

    if (!prod) return res.status(400).json({ error: "productId inválido" });
// ✅ ATALHO DE TESTE (GET) — pra testar no navegador
app.get("/api/create-preference-test", async (req, res) => {
  try {
    const productId = req.query.productId || "p1";
    const withUpsell = req.query.withUpsell === "true";

    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 10000}/api/create-preference`, {
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

    // IMPORTANTE: coloque no Render: FRONTEND_URL=https://legitsensi.shop
    const frontend = process.env.FRONTEND_URL || "http://localhost:5500";

    const prefBody = {
      items,
      back_urls: {
        success: `${frontend}/success.html`,
        failure: `${frontend}/failure.html`,
        pending: `${frontend}/pending.html`,
      },
      auto_return: "approved",
      statement_descriptor: "STA STORE",
      external_reference: `sta_${productId}_${withUpsell ? "upsell" : "no"}_${Date.now()}`,

      // ✅ Quando ativar webhooks no painel do Mercado Pago, descomente:
      // notification_url: "https://beckend-evqc.onrender.com/api/webhook",
    };

    const result = await preference.create({ body: prefBody });

    return res.json({
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
    });
  } catch (err) {
    // ✅ AQUI MOSTRA O ERRO REAL DO MP
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

// -------------------- WEBHOOK (OPCIONAL) --------------------
app.post("/api/webhook", async (req, res) => {
  try {
    const paymentId = req.query?.id || req.body?.data?.id;
    if (!paymentId) return res.sendStatus(200);

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

    // Se aprovado e tiver e-mail do pagador, envia acesso
    if (data.status === "approved" && data.payer?.email) {
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

