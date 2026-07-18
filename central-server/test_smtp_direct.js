import nodemailer from 'nodemailer';

const user = 'cbermudezg7@gmail.com';
const pass = 'gixl upga cmhu qomb';

async function test(p) {
  console.log(`Testing with password: "${p}"`);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: p }
  });

  try {
    await transporter.verify();
    console.log("✅ SMTP Verification successful!");
  } catch (e) {
    console.error("❌ SMTP Verification failed:", e.message);
  }
}

async function run() {
  await test(pass);
  await test(pass.replace(/\s+/g, ''));
}
run();
