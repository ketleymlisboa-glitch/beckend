import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";

dotenv.config();

const app = express();
app.use(express.json());

// CORS: libera só o frontend
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST"],
}));

const accessToken = process.env.MP_ACCESS_TOKEN;
if (!accessToken) {
  console.error("ERRO: MP_ACCESS_TOKEN não definido no .env");
}
const client = new MercadoPagoConfig({ accessToken });
const preference = new Preference(client);

// Produtos (edite aqui como quiser)
const PRODUCTS = {
  p1: { title: "Produto 1 (Digital)", price: 19.90 },
  p2: { title: "Produto 2 (Digital)", price: 29.90 },
  p3: { title: "Produto 3 (Digital)", price: 49.90 }
};

// Upsell (edite)
const UPSELL = { title: "Upsell — Bônus Turbo", price: 14.90 };

// Helper
function asMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * Cria a preferência e retorna a URL do checkout (init_point)
 * body: { productId: "p1|p2|p3", withUpsell: true|false }
 */
app.post("/api/create-preference", async (req, res) => {
  try {
    const { productId, withUpsell } = req.body || {};
    const prod = PRODUCTS[productId];

    if (!prod) {
      return res.status(400).json({ error: "productId inválido" });
    }

    const items = [
      {
        title: prod.title,
        quantity: 1,
        currency_id: "BRL",
        unit_price: asMoney(prod.price)
      }
    ];

    if (withUpsell) {
      items.push({
        title: UPSELL.title,
        quantity: 1,
        currency_id: "BRL",
        unit_price: asMoney(UPSELL.price)
      });
    }

    // IMPORTANTÍSSIMO: URLs de retorno
    const frontend = process.env.FRONTEND_URL || "http://localhost:5500";

    const prefBody = {
      items,
      back_urls: {
        success: `${frontend}/success.html`,
        failure: `${frontend}/failure.html`,
        pending: `${frontend}/pending.html`
      },
      auto_return: "approved",
      statement_descriptor: "STA STORE",
      external_reference: `sta_${productId}_${withUpsell ? "upsell" : "no"}_${Date.now()}`,
      // notification_url: "https://SEU_DOMINIO.com/api/webhook"  // (opcional) webhook
    };

    const result = await preference.create({ body: prefBody });

    return res.json({
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Falha ao criar preferência" });
  }
});

/**
 * (Opcional) Webhook de pagamento — para confirmar “pago”.
 * Você precisa configurar notification_url e também ativar webhooks no painel.
 */
app.post("/api/webhook", async (req, res) => {
  try {
    // Mercado Pago manda eventos diferentes, muitas vezes vem payment id:
    const paymentId = req.query?.id || req.body?.data?.id;
    if (!paymentId) return res.sendStatus(200);

    const payment = new Payment(client);
    const data = await payment.get({ id: paymentId });

    // Aqui você salvaria em banco: status, valor, external_reference etc.
    console.log("WEBHOOK payment:", {
      id: data.id,
      status: data.status,
      status_detail: data.status_detail,
      transaction_amount: data.transaction_amount,
      external_reference: data.external_reference
    });

    res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK erro:", e);
    res.sendStatus(200);
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server rodando na porta ${port}`));
app.get("/api/test-email", async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) return res.status(400).send("Passe ?to=seuemail@gmail.com");

    await sendAccessEmail({ to, title: "Teste STA STORE", orderId: "TESTE123" });
    res.json({ ok: true, sentTo: to });
  } catch (e) {
    console.error("TEST EMAIL ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});