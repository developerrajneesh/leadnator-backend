const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const mongoose = require("mongoose");

module.exports = async function connectDB() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  
if (process.env.DNS_SERVERS) {
  const servers = process.env.DNS_SERVERS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (servers.length > 0) {
    dns.setServers(servers);
    // MongoDB driver uses dns.promises.* internally in newer Node versions.
    if (dns.promises && typeof dns.promises.setServers === "function") {
      dns.promises.setServers(servers);
    }
    console.log(`Using custom DNS servers for lookups: ${servers.join(", ")}`);
  }
}
  if (!uri) {
    throw new Error("No MongoDB connection string found. Set MONGODB_URI (or MONGO_URI) in .env");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  console.log("🗄️  MongoDB connected:", mongoose.connection.name);
};

