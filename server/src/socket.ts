import z from "zod";
import http from "http";

import { ChannelModel } from "./models/channel.js";
import { checkUserAuth } from "./utils.js";
import { Server, Socket } from "socket.io";
import { MessageModel } from "./models/message.js";
import { CorsOptions } from "cors";
import {Redis} from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";

interface AppSocketData {
  user: { name: string; id: string };
  joinedChannels: Set<string>;
}

export let io: Server;
export const onlineUsersList = new Map<string, number>();

export function initSocket(server: http.Server, corsOptions: CorsOptions) {
  if (!process.env.REDIS_URL) {
    // throw new Error("REDIS_URL environment variable not set");
    io = new Server(server, {
      cors: corsOptions,
    });
    console.log("[socket] Redis adapter not initialized");
  } else {
    try {
      const pubClient = new Redis(process.env.REDIS_URL);
      const subClient = pubClient.duplicate();
      io = new Server(server, {
        cors: corsOptions,
        adapter: createAdapter(pubClient, subClient),
      });
      console.log("[socket] Redis adapter initialized");
    } catch (error) {
      console.error("[socket] Failed to initialize Redis adapter", error);
      io = new Server(server, {
        cors: corsOptions,
      });
    }
  }


  io.use(async (socket: Socket<any, any, any, AppSocketData>, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    if (!cookieHeader) {
      console.error("[socket] No cookies found on handshake");
      return next(new Error("UNAUTHORIZED: no cookies"));
    }

    // Parse cookies gracefully instead of reckless split chaining
    const cookies = Object.fromEntries(
      cookieHeader.split("; ").map((c) => {
        const [key, ...v] = c.split("=");
        return [key, v.join("=")];
      }),
    );

    const token = cookies["user_auth"];
    if (!token) {
      console.error("[socket] No auth token found in cookie");
      return next(new Error("UNAUTHORIZED: missing auth token"));
    }

    const { isValid, user } = await checkUserAuth(token);
    if (!isValid || !user) {
      console.error("[socket] Invalid or expired auth token");
      return next(new Error("UNAUTHORIZED: invalid token"));
    }

    socket.data.user = {
      id: user.id,
      name: user.name ?? "",
    };
    socket.data.joinedChannels = new Set<string>();
    next();
  });

  io.on("connection", async (socket) => {
    const { id, name } = socket.data.user;
    const wasOffline = !onlineUsersList.has(id);
    onlineUsersList.set(id, (onlineUsersList.get(id) || 0) + 1);

    // Notify all channels this user belongs to that they've come online
    if (wasOffline) {
      const userChannels = await ChannelModel.find({ members: id }).select({
        _id: 1,
      });
      for (const ch of userChannels) {
        io.to(ch._id.toString()).emit("user_presence", {
          userId: id,
          status: "online",
        });
      }
    }

    socket.on("disconnect", async () => {
      const count = onlineUsersList.get(id) || 0;
      if (count > 1) {
        onlineUsersList.set(id, count - 1);
      } else {
        onlineUsersList.delete(id);
        // Notify all channels this user belongs to that they've gone offline
        const userChannels = await ChannelModel.find({ members: id }).select({
          _id: 1,
        });
        for (const ch of userChannels) {
          io.to(ch._id.toString()).emit("user_presence", {
            userId: id,
            status: "offline",
          });
        }
      }
    });

    socket.on("join_channel", async (payload, callback) => {
      const schema = z.object({
        channelId: z.string(),
      });
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        if (typeof callback === "function") {
          callback({
            status: "ERROR",
            error: "Invalid channel",
          });
        }
        return;
      }

      const isMember = await ChannelModel.exists({
        _id: parsed.data.channelId,
        members: id,
      });
      if (!isMember) {
        if (typeof callback === "function") {
          callback({
            status: "ERROR",
            error: "UNAUTHORIZED",
          });
        }
        return;
      }

      socket.join(parsed.data.channelId);
      socket.data.joinedChannels.add(parsed.data.channelId);
      if (typeof callback === "function") {
        callback({
          status: "SUCCESS",
        });
      }
    });

    socket.on("chat_message", async (payload, callback) => {
      const schema = z.object({
        channelId: z.string(),
        content: z.string().optional(),
        replyTo: z.string().optional(),
        file: z
          .object({
            name: z.string(),
            type: z.string(),
            size: z.number(),
            url: z.string(),
          })
          .optional(),
      }).superRefine(({ content, file }, ctx) => {
        if (!file && content?.length === 0) {
          ctx.addIssue({
            path: ["content"],
            message: "Content is required when no file is provided",
            code: "custom",
          });
          return
        }
      })

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        callback({
          status: "ERROR",
          error: "Invalid message",
        });
        return;
      }

      try {
        const isMember = await ChannelModel.exists({
          _id: parsed.data.channelId,
          members: id,
        });
        if (!isMember) {
          if (typeof callback === "function")
            callback({ status: "ERROR", error: "UNAUTHORIZED" });
          return;
        }
        const newMsg = await MessageModel.create({
          author: id,
          channelId: parsed.data.channelId,
          content: parsed.data.content,
          replyTo: parsed.data.replyTo || null,
          ...(parsed.data.file && { file: parsed.data.file }),
        });

        // Populate replyTo for the broadcast
        let replyToData = null;
        if (newMsg.replyTo) {
          const parentMsg = await MessageModel.findById(newMsg.replyTo)
            .populate("author", "name")
            .select("content author");
          if (parentMsg) {
            replyToData = {
              _id: parentMsg._id,
              content: parentMsg.content,
              author: parentMsg.author,
            };
          }
        }

        socket.to(parsed.data.channelId).emit("channel_message", {
          _id: newMsg.id,
          content: newMsg.content,
          createdAt: newMsg.createdAt.toISOString(),
          author: {
            _id: id,
            name,
          },
          replyTo: replyToData,
          file: newMsg.file || null,
        });
        callback({
          status: "SUCCESS",
          messageId: newMsg.id,
          replyTo: replyToData,
          file: newMsg.file || null,
        });
      } catch (err) {
        if (typeof callback === "function") {
          console.log(parsed.data)
          callback({
            status: "ERROR",
            error: "Failed to sync message to database",
          });
        }
      }
    });

    socket.on("react_message", async (payload, callback) => {
      const schema = z.object({
        messageId: z.string(),
        emoji: z.string().min(1).max(10),
        channelId: z.string(),
      });
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        if (typeof callback === "function")
          callback({ status: "ERROR", error: "Invalid reaction" });
        return;
      }

      const { messageId, emoji, channelId } = parsed.data;

      try {
        const isMember = await ChannelModel.exists({
          _id: channelId,
          members: id,
        });
        if (!isMember) {
          if (typeof callback === "function")
            callback({ status: "ERROR", error: "UNAUTHORIZED" });
          return;
        }

        const removed = await MessageModel.updateOne(
          { _id: messageId, channelId, "reactions.emoji": emoji },
          { $pull: { "reactions.$.users": id } },
        );

        if (removed.modifiedCount > 0) {
          await MessageModel.updateOne(
            { _id: messageId },
            { $pull: { reactions: { users: { $size: 0 } } } },
          );
        } else {
          const added = await MessageModel.updateOne(
            { _id: messageId, channelId, "reactions.emoji": emoji },
            { $addToSet: { "reactions.$.users": id } },
          );
          if (added.matchedCount === 0) {
            await MessageModel.updateOne(
              { _id: messageId, channelId },
              { $push: { reactions: { emoji, users: [id] } } },
            );
          }
        }

        const message = await MessageModel.findOne({ _id: messageId })
          .select("reactions")
          .lean();
        io.to(channelId).emit("message_reaction", {
          messageId,
          reactions: message?.reactions || [],
        });
        if (typeof callback === "function") callback({ status: "SUCCESS" });
      } catch (err) {
        console.error("react_message error:", err);
        if (typeof callback === "function")
          callback({ status: "ERROR", error: "Failed to update reaction" });
      }
    });

    socket.on("typing", async (payload) => {
      const schema = z.object({
        channelId: z.string(),
        isTyping: z.boolean(),
      });
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return;
      }

      // console.log("Typing:", parsed.data);
      socket.to(parsed.data.channelId).emit("typing", {
        user: {
          id,
          name,
        },
        isTyping: parsed.data.isTyping,
      });
    });
  });
}
