import mongoose from "mongoose";

const MessageMongoSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      trim: true,
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Channel",
      index: true,
    },
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    reactions: [
      {
        emoji: { type: String, required: true },
        users: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      },
    ],
    file: {
      type: new mongoose.Schema(
        {
          name: String,
          type: String,
          size: Number,
          url: String,
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

MessageMongoSchema.index({ channelId: 1, createdAt: -1 });

export const MessageModel = mongoose.model("Message", MessageMongoSchema);
