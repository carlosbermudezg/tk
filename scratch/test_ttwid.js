import { fetchTTWID } from "./node_modules/piratetok-live-js/dist/auth/ttwid.js";

async function run() {
  try {
    console.log("Fetching ttwid...");
    const ttwid = await fetchTTWID();
    console.log("Success! ttwid:", ttwid);
  } catch (e) {
    console.error("Error fetching ttwid:", e);
  }
}
run();
