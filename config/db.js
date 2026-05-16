const mongoose = require("mongoose");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

function parseDnsServers(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function mongoConnectOptions() {
  const opts = {
    serverSelectionTimeoutMS: 15000,
    family: 4,
  };
  // Windows / corporate proxies sometimes break Atlas TLS (unable to verify certificate).
  // Set MONGO_TLS_INSECURE=true in .env for local dev only — never in production.
  if (process.env.MONGO_TLS_INSECURE === "true") {
    opts.tlsAllowInvalidCertificates = true;
  }
  return opts;
}

function formatMongoError(err) {
  const msg = err?.message || String(err);
  if (/unable to verify the first certificate|certificate/i.test(msg)) {
    return [
      "MongoDB TLS certificate verification failed.",
      "Local fix: add MONGO_TLS_INSECURE=true to backend/.env (development only).",
      "Or set NODE_EXTRA_CA_CERTS to your system/corporate root CA bundle.",
    ].join(" ");
  }
  if (/whitelist|IP that isn't/i.test(msg)) {
    return [
      msg,
      "Add your current public IP in MongoDB Atlas → Network Access, or use 0.0.0.0/0 for dev.",
    ].join(" ");
  }
  return msg;
}

module.exports = async function connectDB() {
  if (process.env.DNS_SERVERS) {
    const servers = parseDnsServers(process.env.DNS_SERVERS);
    if (servers.length > 0) {
      dns.setServers(servers);
      if (dns.promises && typeof dns.promises.setServers === "function") {
        dns.promises.setServers(servers);
      }
      console.log(`Using custom DNS servers for lookups: ${servers.join(", ")}`);
    }
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error("No MongoDB connection string found. Set MONGODB_URI (or MONGO_URI) in .env");
  }

  mongoose.set("strictQuery", true);

  try {
    await mongoose.connect(uri, mongoConnectOptions());
  } catch (err) {
    throw new Error(formatMongoError(err));
  }

  if (process.env.MONGO_TLS_INSECURE === "true") {
    console.warn("⚠️  MongoDB connected with MONGO_TLS_INSECURE=true (dev only — disable in production)");
  }
  console.log("🗄️  MongoDB connected:", mongoose.connection.name);
};
