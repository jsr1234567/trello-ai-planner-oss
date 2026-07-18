import { runScheduledDelivery } from "./scheduler.js";
import { runDailyPlanning } from "./daily-planning.js";

const slot = process.argv[2];
if (!['morning', 'afternoon', 'weekly', 'daily-plan'].includes(slot)) {
  console.error("Usage: node src/job-runner.js <morning|afternoon|weekly|daily-plan>");
  process.exitCode = 1;
} else {
  try {
    const result = slot === 'daily-plan'
      ? await runDailyPlanning()
      : await runScheduledDelivery(slot);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Scheduled ${slot} delivery failed: ${error.message}`);
    process.exitCode = 1;
  }
}
