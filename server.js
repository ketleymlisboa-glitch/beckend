import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import { Resend } from "resend";

console.log("VERSAO NOVA DO SERVER ✅ 31/01 + AUTH (SEM MODELS)");

// -------------------- APP --------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

// -------------------- FRONTEND SAFE --------------------
const FRONTEND_URL = (process.env.FRONTEND_URL || "").trim();
const FRONTEND_SAFE =
  FRONTEND_URL && /^https?:\/\//i.test(FRONTEND_URL)
    ? FRONTEND_URL.replace(/\/+$/, "")
    : "https://legitsensi.shop";

// -------------------- CORS (deixa Hostinger/WWW funcionar) --------------------
function isAllowedOrigin(origin) {
  if (!origin) return true; // curl/postman

  // libera seu domínio e www
  if (origin === FRONTEND_SAFE) return true;
  if (origin === FRONTEND_SAFE.replace("://", "://www.")) return true;

  // libera localhost
  if (
    origin === "http://localhost:5173" ||
    origin === "http://localhost:3000" ||
    origin === "http://127.0.0.1:5500"
  ) return true;

  // libera subdomínios do seu domínio (caso use)
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith(".legitsensi.shop")) return true;
  } catch {}

  return false;
}

app.use(
  cors({
    origin: function (origin, callback) {
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error("CORS bloqueado para: " + origin), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// -------------------- MONGODB --------------------
async function connectMongo() {
  const uri = (process.env.MONGO_URI || "").trim();
  if (!uri) throw new Error("MONGO_URI não definido.");

  // dica: uri NÃO pode ter < > nem espaços
  await mongoose.connect(uri);
  console.log("MongoDB conectado ✅");
}

// -------------------- USER SCHEMA (NO MESMO ARQUIVO) --------------------
const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

const User = mongoose.models.User || mongoose.model("User", UserSchema);

// -------------------- AUTH HELPERS --------------------
function createToken(user) {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (!secret) throw new Error("JWT_SECRET não definido");
  return jwt.sign(
    { uid: String(user._id), email: user.email, name: user.name },
    secret,
    { expiresIn: "7d" }
  );
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sem token." });

  try {
    const payload = jwt.verify(token, (process.env.JWT_SECRET || "").trim());
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Token inválido." });
  }
}

// -------------------- EMAIL (RESEND) --------------------
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendAccessEmail({ to, title, orderId }) {
  const accessLink = `${FRONTEND_SAFE}/acesso?pedido=${encodeURIComponent(orderId)}`;

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
if (!accessToken) console.error("ERRO: MP_ACCESS_TOKEN não definido.");

const client = new MercadoPagoConfig({ accessToken });
const preference = new Preference(client);

// Produtos (exemplo)
const PRODUCTS = {
  p1: { title: "Produto 1 (Digital)", price: 0.01 },
  p2: { title: "Produto 2 (Digital)", price: 0.01 },
  p3: { title: "Produto 3 (Digital)", price: 0.01 },
};
const UPSELL = { title: "Upsell — Bônus Turbo", price: 0.01 };

function asMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

// -------------------- ROTAS BÁSICAS --------------------
app.get("/", (req, res) => res.send("API online ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------- AUTH: REGISTER --------------------
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Preencha nome, e-mail e senha." });
    }

    const emailNorm = String(email).toLowerCase().trim();
    const nameNorm = String(name).trim();
    const pass = String(password);

    if (nameNorm.length < 2) return res.status(400).json({ error: "Nome muito curto." });
    if (pass.length < 6) return res.status(400).json({ error: "Senha mínima: 6 caracteres." });

    const exists = await User.findOne({ email: emailNorm });
    if (exists) return res.status(409).json({ error: "E-mail já cadastrado." });

    const passwordHash = await bcrypt.hash(pass, 10);

    const user = await User.create({
      name: nameNorm,
      email: emailNorm,
      passwordHash,
    });

    const token = createToken(user);

    return res.json({
      ok: true,
      token,
      user: { name: user.name, email: user.email },
    });
  } catch (e) {
    console.error("REGISTER ERR:", e);
    return res.status(500).json({ error: "Erro no servidor." });
  }
});

// -------------------- AUTH: LOGIN --------------------
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Preencha e-mail e senha." });

    const emailNorm = String(email).toLowerCase().trim();
    const pass = String(password);

    const user = await User.findOne({ email: emailNorm });
    if (!user) return res.status(401).json({ error: "E-mail ou senha incorretos." });

    const ok = await bcrypt.compare(pass, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "E-mail ou senha incorretos." });

    const token = createToken(user);

    return res.json({
      ok: true,
      token,
      user: { name: user.name, email: user.email },
    });
  } catch (e) {
    console.error("LOGIN ERR:", e);
    return res.status(500).json({ error: "Erro no servidor." });
  }
});

// -------------------- AUTH: ME --------------------
app.get("/api/me", authRequired, (req, res) => {
  return res.json({ ok: true, user: req.user });
});

// -------------------- CHECKOUT: CRIAR PREFERÊNCIA --------------------
app.post("/api/create-preference", async (req, res) => {
  try {
    const { productId, withUpsell } = req.body || {};
    const prod = PRODUCTS[productId];
    if (!prod) return res.status(400).json({ error: "productId inválido" });

    const items = [
      { title: prod.title, quantity: 1, currency_id: "BRL", unit_price: asMoney(prod.price) },
    ];

    if (withUpsell) {
      items.push({ title: UPSELL.title, quantity: 1, currency_id: "BRL", unit_price: asMoney(UPSELL.price) });
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
      statement_descriptor: "STA STORE",
      external_reference: `sta_${productId}_${withUpsell ? "upsell" : "no"}_${Date.now()}`,
      notification_url: WEBHOOK_URL || undefined,
      payment_methods: {
        excluded_payment_types: [{ id: "account_money" }],
      },
    };

    const result = await preference.create({ body: prefBody });

    return res.json({
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
    });
  } catch (err) {
    console.error("create-preference erro:", err);
    return res.status(500).json({ error: "Falha ao criar preferência" });
  }
});

// -------------------- WEBHOOK --------------------
const sentPayments = new Set();

app.post("/api/webhook", async (req, res) => {
  try {
    const paymentId = req.query?.id || req.body?.data?.id;
    if (!paymentId) return res.sendStatus(200);
    if (sentPayments.has(String(paymentId))) return res.sendStatus(200);

    const payment = new Payment(client);
    const data = await payment.get({ id: paymentId });

    console.log("WEBHOOK payment:", {
      id: data.id,
      status: data.status,
      payer_email: data.payer?.email,
    });

    if (data.status === "approved" && data.payer?.email) {
      sentPayments.add(String(data.id));
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

// -------------------- START --------------------
const PORT = process.env.PORT || 10000;

connectMongo()
  .then(() => app.listen(PORT, () => console.log("Server rodando na porta", PORT)))
  .catch((e) => {
    console.error("Falha ao conectar no Mongo:", e?.message || e);
    app.listen(PORT, () => console.log("Server rodando (SEM MONGO) na porta", PORT));
  });