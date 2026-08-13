import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import http from "http";
import { z } from "zod";
import authRouter from "./routes/auth.js";
import channelRouter from "./routes/channel.js";
import { initSocket } from "./socket.js";
import path from "node:path";

declare global {
  namespace Express {
    interface Request {
      user: {
        id: string;
        name: string;
      };
    }
  }
}

// ---- Environment validation ----
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().default(3000),
  MONGO_URI: z.string().min(1, "MONGO_URI is required"),
  // Comma-separated list, e.g. "https://app.example.com,https://admin.example.com"
  ALLOWED_ORIGINS: z.string().min(1, "ALLOWED_ORIGINS is required"),
  COOKIE_SECRET: z.string().min(1).optional(),
  GCS_BUCKET_NAME: z.string().min(1).optional(),
  GCS_PROJECT_ID: z.string().min(1).optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
});

const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) {
  console.error(
    "Invalid environment variables:",
    z.prettifyError(parsedEnv.error),
  );
  process.exit(1);
}
const env = parsedEnv.data;
const isProd = env.NODE_ENV === "production";

const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());

// ---- Database ----
try {
  await mongoose.connect(env.MONGO_URI);
  console.log("MongoDB connected");
} catch (error) {
  console.error("Failed to connect to MongoDB", error);
  process.exit(1);
}

const app = express();
export const server = http.createServer(app);

app.set("trust proxy", 1);

// ---- CORS: single source of truth, shared by Express and Socket.IO ----
export const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // Allow non-browser requests (curl, server-to-server, health checks) with no Origin header.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE"],
};

initSocket(server, corsOptions);

// ---- Security & core middleware ----
app.use(helmet({
  crossOriginResourcePolicy: {
    policy: "cross-origin",
  }
}));
app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(env.COOKIE_SECRET));

// Basic rate limiting — tune per route as needed (e.g. tighter on /auth).
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300000, //change
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20000,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/", (req, res) => {
  return res.json({ msg: "Hello world" });
});

// Lightweight health check for load balancers / uptime monitors — no DB dependency.
app.get("/health", (req, res) => {
  return res.json({
    status: "ok",
    mongoConnected: mongoose.connection.readyState === 1,
  });
});

app.use("/auth", authLimiter, authRouter);
app.use("/channels", channelRouter);

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// ---- 404 handler ----
app.use((req, res) => {
  res.status(404).json({ msg: "Not found" });
});

// ---- Global error handler (must be last, must have 4 args) ----
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error(err);
    if (
      err.message?.startsWith("Origin ") &&
      err.message.endsWith("not allowed by CORS")
    ) {
      return res.status(403).json({ msg: "Not allowed by CORS" });
    }
    res
      .status(500)
      .json({ msg: isProd ? "Internal server error" : err.message });
  },
);

const listener = server.listen(env.PORT, () => {
  console.log(`Listening on port ${env.PORT} (${env.NODE_ENV})`);
});

// ---- Graceful shutdown ----
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully`);
  listener.close(async () => {
    await mongoose.connection.close();
    console.log("Closed out remaining connections");
    process.exit(0);
  });
  // Force-exit if connections don't close in time.
  setTimeout(() => {
    console.error("Forcing shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
