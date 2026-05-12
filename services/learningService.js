import UserProfile from "../models/UserProfile.js";
import logger from "../config/logger.js";

// ================= GET OR CREATE USER =================
const getOrCreateUser = async (phone) => {
  // Use findOneAndUpdate with upsert to avoid the race condition where two
  // concurrent messages both hit findOne → null → create → E11000 duplicate key.
  return await UserProfile.findOneAndUpdate(
    { phone },
    {
      $setOnInsert: {
        phone,
        stats: { totalMessages: 0, totalOrders: 0, totalBookings: 0 },
        behavior: {
          style: "NORMAL",
          scores: { fast: 0, confused: 0, polite: 0, normal: 0, detailed: 0 }
        },
        preferences: { favoriteItems: [] },
        memory: {},
        learning: { confidenceScore: 0 },
        activity: {}
      }
    },
    { upsert: true, new: true }
  );
};

// ================= STYLE DETECTION =================
const detectStyle = (message = "") => {
  const text = message.trim().toLowerCase();

  if (text.length <= 4) return "FAST";
  if (text.length > 50) return "DETAILED";

  if (/please|kindly|thanks|thank you/.test(text)) return "POLITE";

  if (/what|huh|why|confused|don.?t understand/.test(text)) {
    return "CONFUSED";
  }

  if (/now|fast|quick|asap/.test(text)) return "FAST";

  return "NORMAL";
};

// ================= UPDATE BEHAVIOR =================
const updateBehavior = (user, style) => {
  if (!user.behavior || !user.behavior.scores) return;

  const key = style.toLowerCase();

  if (user.behavior.scores[key] !== undefined) {
    user.behavior.scores[key] += 1;
  }

  const scores = user.behavior.scores;
  const maxScore = Math.max(...Object.values(scores));

  if (maxScore === 0) {
    user.behavior.style = "NORMAL";
  } else {
    const dominant = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
    user.behavior.style = dominant.toUpperCase();
  }
};

// ================= UPDATE PREFERENCES =================
const updatePreferences = (user, item) => {
  if (!item) return;

  const existing = user.preferences.favoriteItems.find(
    (i) => i.name === item
  );

  if (existing) {
    existing.count += 1;
  } else {
    user.preferences.favoriteItems.push({
      name: item,
      count: 1
    });
  }
};

// ================= TRACK USER (MAIN ENTRY) =================
export const trackUser = async (
  phone,
  message,
  intent,
  extra = {}
) => {
  try {
    const user = await getOrCreateUser(phone);

    // ================= STATS =================
    user.stats.totalMessages += 1;

    if (intent === "ORDER") user.stats.totalOrders += 1;
    if (intent === "BOOKING") user.stats.totalBookings += 1;

    // ================= STYLE =================
    const style = detectStyle(message);
    updateBehavior(user, style);

    // ================= MEMORY =================
    user.memory.lastIntent = intent;
    user.memory.lastMessage = message;
    user.memory.lastFlow = intent;

    // ================= PREFERENCES =================
    if (extra.item) {
      updatePreferences(user, extra.item);
    }

    // ================= LEARNING =================
    user.learning.confidenceScore += 1;

    // ================= ACTIVITY =================
    user.activity.lastSeen = new Date();

    await user.save();

    return user;
  } catch (err) {
    logger.error("❌ trackUser error:", err);
    return null;
  }
};
