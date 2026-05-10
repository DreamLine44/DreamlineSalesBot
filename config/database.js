import mongoose from "mongoose";
import { NODE_ENV, MONGODB_URI } from "./env.js";
import logger from "./logger.js";

export const connectToDB = async () => {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not defined. Check your .env file.");
  }
  try {
    await mongoose.connect(MONGODB_URI, {
      // [FIX-10] Essential connection options.
      // Without serverSelectionTimeoutMS, Mongoose hangs silently for 30s if
      // MongoDB is unreachable at startup — masking the real error. Without
      // bufferCommands:false, DB operations silently queue during connection
      // loss instead of failing fast and letting the error handler respond.
      serverSelectionTimeoutMS: 10_000, // Fail fast if DB is unreachable (10s)
      socketTimeoutMS:          45_000, // Abort slow queries after 45s
      bufferCommands:           false,  // Fail immediately on DB ops before connection
    });
    logger.info(`Connected to DB in ${NODE_ENV} mode`);
  } catch (error) {
    logger.error("Failed to connect to DB", { err: error.message });
    process.exit(1);
  }
};
