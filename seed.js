require("dotenv").config();
const connectDB = require("./config/db");
const mongoose = require("mongoose");

const User = require("./models/User");
const Lead = require("./models/Lead");
const Campaign = require("./models/Campaign");
const MetaAccount = require("./models/MetaAccount");
const Ticket = require("./models/Ticket");
const Plan = require("./models/Plan");

const SOURCES = ["Meta Ads", "Google Ads", "Website", "Referral", "LinkedIn", "Manual", "Import"];
const STATUSES = ["new", "contacted", "qualified", "hot", "lost"];
const TAGS = ["warm", "enterprise", "startup", "b2b", "b2c", "priority"];
const FIRST = ["Aarav","Isha","Rohan","Priya","Karan","Neha","Ankit","Sneha","Rahul","Kavya","Vivek","Anjali","Arjun","Meera","Siddharth","Pooja","Nikhil","Tanya","Raj","Zoya"];
const LAST  = ["Sharma","Verma","Patel","Gupta","Singh","Khan","Mehta","Joshi","Kapoor","Reddy","Das","Iyer","Nair","Banerjee","Chopra","Malhotra"];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const phoneIN = () => "+91 " + (90000 + Math.floor(Math.random()*9999)) + " " + (10000 + Math.floor(Math.random()*89999));

async function run() {
  console.log("Connecting to DB…");
  await connectDB();

  console.log("Clearing existing data…");
  await Promise.all([
    User.deleteMany({}),
    Lead.deleteMany({}),
    Campaign.deleteMany({}),
    MetaAccount.deleteMany({}),
    Ticket.deleteMany({}),
    Plan.deleteMany({}),
  ]);

  // -------- USERS --------
  console.log("Seeding users…");
  const admin = await User.create({
    name: "Admin",
    email: "admin@gmail.com",
    password: "123456",
    role: "admin",
    plan: "Pro",
    status: "active",
  });
  const testUser = await User.create({
    name: "Test User",
    email: "test@gmail.com",
    password: "12345678",
    role: "user",
    plan: "Growth",
    status: "active",
  });
  const deepak = await User.create({
    name: "Deepak Sharma",
    email: "deepak.sharma@worksdelight.com",
    password: "demo1234",
    role: "user",
    plan: "Growth",
    status: "active",
  });
  const extras = await User.insertMany([
    { name: "Anita Desai",  email: "anita@acme.in",       password: await hashPassword("demo1234"), role: "user", plan: "Pro",     status: "active" },
    { name: "Rakesh Jain",  email: "rakesh@zenstore.com", password: await hashPassword("demo1234"), role: "user", plan: "Starter", status: "active" },
    { name: "Priya Kapoor", email: "priya@lotusco.in",    password: await hashPassword("demo1234"), role: "user", plan: "Growth",  status: "paused" },
    { name: "Mohit Khanna", email: "mohit@cloudplex.io",  password: await hashPassword("demo1234"), role: "user", plan: "Pro",     status: "active" },
  ]);

  // -------- PLANS (from the single source of truth: config/plans.js) --------
  console.log("Seeding plans…");
  const { dbPlanDocs } = require("./config/plans");
  await Plan.insertMany(dbPlanDocs());

  // -------- LEADS (shared between testUser + deepak) --------
  console.log("Seeding leads…");
  const ownerPool = [testUser._id, deepak._id];
  const leadDocs = Array.from({ length: 60 }).map((_, i) => {
    const first = pick(FIRST), last = pick(LAST);
    const name  = `${first} ${last}`;
    const daysAgo = Math.floor(Math.random() * 40);
    const tagsCount = 1 + Math.floor(Math.random() * 2);
    const tags = [...new Set(Array.from({ length: tagsCount }).map(() => pick(TAGS)))];
    return {
      owner: i < 42 ? testUser._id : pick(ownerPool),
      name,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
      phone: phoneIN(),
      source: pick(SOURCES),
      status: pick(STATUSES),
      tags,
      notes: i % 4 === 0 ? "Asked for pricing. Follow up next week." : "",
      value: 5000 + Math.floor(Math.random() * 95000),
      createdAt: new Date(Date.now() - daysAgo * 86400000),
    };
  });
  await Lead.insertMany(leadDocs);

  // -------- CAMPAIGNS --------
  console.log("Seeding campaigns…");
  await Campaign.insertMany([
    { owner: testUser._id, name: "Spring Sale Blast",    status: "active", sent: 2480, opens: 1320, clicks: 412 },
    { owner: testUser._id, name: "Welcome Drip",         status: "active", sent: 980,  opens: 720,  clicks: 215 },
    { owner: testUser._id, name: "Re-engage Cold Leads", status: "paused", sent: 540,  opens: 122,  clicks: 33  },
    { owner: testUser._id, name: "Pro Plan Upsell",      status: "draft",  sent: 0,    opens: 0,    clicks: 0   },
  ]);

  // -------- META ACCOUNTS --------
  console.log("Seeding Meta accounts…");
  await MetaAccount.insertMany([
    { name: "Leadnator Main Ad Account", connected: true,  spend: 18420, leads: 312 },
    { name: "Client - Acme Retail",      connected: true,  spend: 9200,  leads: 148 },
    { name: "Client - Zen Store",        connected: false, spend: 0,     leads: 0   },
  ]);

  // -------- TICKETS --------
  console.log("Seeding tickets…");
  await Ticket.insertMany([
    { code: "TK-3421", user: "Mohit Khanna",  subject: "Payment failed for Pro plan renewal", priority: "high",   status: "open",        category: "Billing" },
    { code: "TK-3420", user: "Anita Desai",   subject: "Cannot connect Meta Ads account",     priority: "medium", status: "in_progress", category: "Integration" },
    { code: "TK-3419", user: "Priya Kapoor",  subject: "WhatsApp template rejected",          priority: "low",    status: "in_progress", category: "WhatsApp" },
    { code: "TK-3418", user: "Rakesh Jain",   subject: "How to bulk import leads?",           priority: "low",    status: "resolved",    category: "How-to" },
    { code: "TK-3417", user: "Deepak Sharma", subject: "Email bounce rate high",              priority: "medium", status: "open",        category: "Email" },
  ]);

  console.log("");
  console.log("✅ Seed complete!");
  console.log("   Admin login: admin@gmail.com / 123456");
  console.log("   Test user:   test@gmail.com  / 12345678");
  console.log("   Demo user:   deepak.sharma@worksdelight.com / demo1234");
  console.log("   Leads:      ", await Lead.countDocuments(), "(most owned by test@gmail.com)");

  await mongoose.disconnect();
  process.exit(0);
}

async function hashPassword(plain) {
  const bcrypt = require("bcryptjs");
  return bcrypt.hash(plain, 10);
}

run().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
