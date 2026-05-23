/**
 * config/database.js — WhatSalesAgent2 (Production)
 *
 * Changes from dev:
 *  - Added mongoose event listeners for connection monitoring.
 *    In production, connection drops are logged immediately.
 *  - maxPoolSize set to 10 (good for single-process deployments).
 *  - heartbeatFrequencyMS ensures faster reconnection detection.
 */
import mongoose from 'mongoose';
import { NODE_ENV, MONGODB_URI } from './env.js';
import logger from './logger.js';

export const connectToDB = async () => {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not defined. Check your .env file.');
  }

  // Monitor connection events in production
  mongoose.connection.on('disconnected', () =>
    logger.warn('[DB] MongoDB disconnected — mongoose will auto-reconnect'));
  mongoose.connection.on('reconnected', () =>
    logger.info('[DB] MongoDB reconnected'));
  mongoose.connection.on('error', (err) =>
    logger.error('[DB] MongoDB connection error', { err: err.message }));

  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 25_000,  // Allow time for Atlas cold start on Railway
      socketTimeoutMS:          45_000,  // Abort slow queries
      bufferCommands:           false,   // Fail immediately on DB ops before connection
      maxPoolSize:              10,      // Connection pool size
      heartbeatFrequencyMS:     10_000,  // Detect dropouts within 10s
    });
    logger.info(`[DB] Connected to MongoDB (${NODE_ENV})`);
  } catch (error) {
    logger.error('[DB] Failed to connect to MongoDB', { err: error.message });
    process.exit(1);
  }
};
