import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import { Resend } from "resend";

const app = express();
app.use(express.json());

// CORS: libera só o frontend
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
  })
);

// ---------- EMAIL (RESEND) ----------
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendAccessEmail({ to, title, orderId }) {
  const accessLink = `https://legitsensi.shop/acesso?pedido=${orderId}`;

  await resend.emails.send({
    from: process.env.MAIL_FROM, // ex: "STA STORE <onboarding@resend.dev>"
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
}

// ---------- MERCADO PAGO ----------
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

// ---------- ROTAS ----------
app.get("/", (req, res) => res.send("API online ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * Cria preferência e retorna checkout
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
      // ✅ quando for usar webhook no MP, descomente:
      // notification_url: "https://beckend-evqc.onrender.com/api/webhook",
    };

    const result = await preference.create({ body: prefBody });

    return res.json({
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
    });
  } catch (err) {
    console.error("create-preference erro:", err);
    return res.status(500).json({ error: "Falha ao criar preferência" });
  }
});

/**
 * Webhook (opcional) — envia e-mail quando aprovado
 */
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

// Rota de teste de e-mail
app.get("/api/test-email", async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) return res.status(400).send("Passe ?to=seuemail@gmail.com");

    await sendAccessEmail({ to, title: "Teste STA STORE", orderId: "TESTE123" });
    return res.json({ ok: true, sentTo: to });
  } catch (e) {
    console.error("TEST EMAIL ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server rodando na porta", PORT));
