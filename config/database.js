import mongoose from "mongoose";
import { NODE_ENV, MONGODB_URI } from "./env.js";
import logger from "./logger.js";

export const connectToDB = async () => {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not defined. Check your .env file.");
  }
  try {
    await mongoose.connect(MONGODB_URI);
    logger.info(`Connected to DB in ${NODE_ENV} mode`);
  } catch (error) {
    logger.error("Failed to connect to DB", { err: error.message });
    process.exit(1);
  }
};
