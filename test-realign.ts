import { RealignService } from "./apps/backend/src/modules/librarian/services/realign.js";

async function run() {
  try {
    const service = new RealignService();
    console.log("Starting scan...");
    const candidates = await service.scanLibrary();
    console.log(`Found ${candidates.length} candidates for realignment.`);
    if (candidates.length > 0) {
      console.log(candidates.slice(0, 3)); // preview first 3
    }
  } catch (err: any) {
    console.error("Scan failed:", err.message);
  }
}

run();
