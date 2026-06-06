/**
 * Subscribe every WhatsApp WABA in the DB to this Meta app (webhooks).
 * Run: cd backend && npm run wa:subscribe-all
 */
require("dotenv").config();
const connectDB = require("../config/db");
const { subscribeAllWabaConnections } = require("../services/waSubscribe");

async function main() {
  await connectDB();
  const summary = await subscribeAllWabaConnections({ delayMs: 300 });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
