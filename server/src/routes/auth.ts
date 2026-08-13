import express from "express";
import z from "zod";
import jwt from "jsonwebtoken";
import argon2 from "argon2";

import { auth } from "../middlewares.js";
import { UserModel } from "../models/user.js";

const authRouter = express.Router();

authRouter.post("/register", async (req, res) => {
  const schema = z.object({
    name: z.string().min(3),
    email: z.email(),
    password: z.string().min(6).max(20),
  });
  const result = schema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      msg: "Malformed input",
    });
  }

  const isExisting = await UserModel.findOne({
    email: result.data?.email,
  });

  if (isExisting) {
    return res.status(400).json({
      msg: "User already exists",
    });
  }

  const hashedPassword = await argon2.hash(result.data?.password!);
  const user = await UserModel.create({
    ...result.data,
    password: hashedPassword,
  });

  const token = jwt.sign({ user_id: user.id }, process.env.JWT_SECRET!, {
    expiresIn: "7d",
  });
  res.cookie("user_auth", token, {
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
    httpOnly: true,
    sameSite: process.env.ENV === "production" ? "none" : "lax",
    secure: process.env.ENV === "production",
  });

  return res.json({
    msg: "User created and logged in successfully",
  });
});

authRouter.post("/login", async (req, res) => {
  const schema = z.object({
    email: z.email(),
    password: z.string().min(6),
  });
  const result = schema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      msg: "Malformed input",
    });
  }

  const user = await UserModel.findOne({
    email: result.data?.email,
  });

  if (!user) {
    return res.status(400).json({
      msg: "User not found",
    });
  }

  const isValidPassword = await argon2.verify(
    user?.password!,
    result.data?.password!,
  );

  if (!isValidPassword) {
    return res.status(400).json({
      msg: "Invalid credentials",
    });
  }

  const token = jwt.sign({ user_id: user?.id }, process.env.JWT_SECRET!, {
    expiresIn: "7d",
  });
  res.cookie("user_auth", token, {
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
    httpOnly: true,
    sameSite: process.env.ENV === "production"? "none" : "lax",
    secure: process.env.ENV === "production",
  });

  return res.json({
    msg: "Logged in successfully",
  });
});

authRouter.get("/me", auth, async (req, res) => {
  return res.json({
    userId: req.user?.id,
    userName: req.user?.name,
  });
});

authRouter.post("/logout", async (req, res) => {
  res.clearCookie("user_auth", {
    path: "/",
    sameSite: process.env.ENV === "production" ? "none" : "lax",
    httpOnly: true,
    secure: process.env.ENV === "production",
  });
  return res.json({
    msg: "Logged out successfully",
  });
});

export default authRouter;
